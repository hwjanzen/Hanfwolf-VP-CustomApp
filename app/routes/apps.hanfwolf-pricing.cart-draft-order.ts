import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { normalizeCustomerId, normalizeVariantId } from "../services/price-resolver.server";
import {
  getRopeConfiguratorConfig,
  type RopeConfiguratorConfig,
} from "../services/rope-configurator-setup.server";
import {
  calculateRopeUnitPrice,
  calculateRopeUnitWeight,
  convertWeightToKilograms,
  isRopeProduct,
  parseRopeCartConfigurationKey,
  type RopeCartConfiguration,
} from "../services/rope-draft-order.server";
import { adminGraphql } from "../services/shopify-graphql.server";

type CartItem = {
  variantId: string;
  quantity: number;
  properties: Record<string, string>;
};

type VariantNode = {
  id: string;
  displayName: string;
  price: string;
  sku: string | null;
  taxable: boolean;
  ropeConfiguration: { value: string } | null;
  inventoryItem: {
    measurement: {
      weight: { value: number; unit: string } | null;
    };
  };
  product: {
    id: string;
    title: string;
    productType: string;
  };
};

type RopeProductNode = {
  id: string;
  title: string;
  productType: string;
  haspelSurcharge: { value: string } | null;
  variants: {
    nodes: Array<{
      id: string;
      sku: string | null;
      taxable: boolean;
      ropeConfiguration: { value: string } | null;
      isDefaultConfiguration: { value: string } | null;
    }>;
  };
};

function normalizeCartItems(value: unknown): CartItem[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new Error("Der Warenkorb muss zwischen 1 und 100 Positionen enthalten.");
  }

  return value.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new Error(`Warenkorbposition ${index + 1} ist ungueltig.`);
    }

    const input = item as Record<string, unknown>;
    const variantId = normalizeVariantId(String(input.variantId || ""));
    const quantity = Number(input.quantity);
    if (!variantId) {
      throw new Error(`Variant-ID in Warenkorbposition ${index + 1} ist ungueltig.`);
    }
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 999) {
      throw new Error(`Menge in Warenkorbposition ${index + 1} muss zwischen 1 und 999 liegen.`);
    }

    const rawProperties = input.properties;
    const properties: Record<string, string> = {};
    if (rawProperties && typeof rawProperties === "object" && !Array.isArray(rawProperties)) {
      for (const [key, propertyValue] of Object.entries(rawProperties)) {
        if (key.length <= 255 && typeof propertyValue === "string" && propertyValue.length <= 255) {
          properties[key] = propertyValue;
        }
      }
    }

    return { variantId, quantity, properties };
  });
}

async function loadVariants(
  admin: unknown,
  ids: string[],
) {
  const result = await adminGraphql<{
    nodes: Array<VariantNode | null>;
  }>(
    admin,
    `#graphql
    query RopeCartDraftOrderVariants($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on ProductVariant {
          id
          displayName
          price
          sku
          taxable
          ropeConfiguration: metafield(namespace: "hanfwolf", key: "rope_configuration") {
            value
          }
          inventoryItem {
            measurement {
              weight {
                value
                unit
              }
            }
          }
          product {
            id
            title
            productType
          }
        }
      }
    }`,
    { ids },
  );

  if (!result.ok) {
    throw new Error(`Varianten konnten nicht geladen werden: ${result.errors.join(" | ")}`);
  }

  return new Map(
    result.data.nodes
      .filter((node): node is VariantNode => Boolean(node?.id))
      .map((node) => [node.id, node]),
  );
}

async function loadRopeProducts(
  admin: unknown,
  ids: string[],
  config: RopeConfiguratorConfig,
) {
  if (ids.length === 0) return new Map<string, RopeProductNode>();

  const result = await adminGraphql<{
    nodes: Array<RopeProductNode | null>;
  }>(
    admin,
    `#graphql
    query RopeCartDraftOrderProducts(
      $ids: [ID!]!
      $haspelNamespace: String!
      $haspelKey: String!
    ) {
      nodes(ids: $ids) {
        ... on Product {
          id
          title
          productType
          haspelSurcharge: metafield(namespace: $haspelNamespace, key: $haspelKey) {
            value
          }
          variants(first: 250) {
            nodes {
              id
              sku
              taxable
              ropeConfiguration: metafield(namespace: "hanfwolf", key: "rope_configuration") {
                value
              }
              isDefaultConfiguration: metafield(namespace: "$app", key: "is_default_configuration") {
                value
              }
            }
          }
        }
      }
    }`,
    {
      ids,
      haspelNamespace: config.haspelSurchargeMetafield?.namespace ?? "$app",
      haspelKey: config.haspelSurchargeMetafield?.key ?? "unconfigured_haspel_surcharge",
    },
  );

  if (!result.ok) {
    throw new Error(`Hauptprodukte konnten nicht geladen werden: ${result.errors.join(" | ")}`);
  }

  return new Map(
    result.data.nodes
      .filter((node): node is RopeProductNode => Boolean(node?.id))
      .map((node) => [node.id, node]),
  );
}

function getWeightKilograms(variant: VariantNode, quantity: number) {
  const weight = variant.inventoryItem.measurement.weight;
  if (!weight) {
    throw new Error(`Fuer ${variant.product.title} fehlt das Varianten-Gewicht.`);
  }

  return Number(convertWeightToKilograms(weight.value * quantity, weight.unit).toFixed(6));
}

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const { admin, session } = await authenticate.public.appProxy(request);
    if (!admin || !session) {
      return Response.json({ ok: false, error: "App-Proxy-Sitzung fehlt." }, { status: 401 });
    }
    const config = await getRopeConfiguratorConfig(session.shop);

    let cartItems: CartItem[];
    try {
      const body = await request.json();
      cartItems = normalizeCartItems(body?.items);
    } catch (error) {
      return Response.json(
        { ok: false, error: error instanceof Error ? error.message : "Ungueltige Warenkorbanfrage." },
        { status: 400 },
      );
    }

    const cartVariants = await loadVariants(
      admin,
      [...new Set(cartItems.map((item) => item.variantId))],
    );
    const ropeConfigurations = new Map<string, ReturnType<typeof parseRopeCartConfigurationKey>>();

    for (const item of cartItems) {
      const variant = cartVariants.get(item.variantId);
      if (!variant) {
        return Response.json(
          { ok: false, error: `Variante ${item.variantId} wurde nicht gefunden.` },
          { status: 400 },
        );
      }
      if (!variant.ropeConfiguration?.value) continue;

      try {
        ropeConfigurations.set(
          variant.id,
          parseRopeCartConfigurationKey(variant.ropeConfiguration.value, config),
        );
      } catch (error) {
        return Response.json(
          { ok: false, error: error instanceof Error ? error.message : "Ungueltige Zuschnitt-Variante." },
          { status: 400 },
        );
      }
    }

    const configurations = [...ropeConfigurations.values()];
    const legacyVariantIds = configurations
      .filter((configuration): configuration is Extract<RopeCartConfiguration, { version: "v1" }> => configuration.version === "v1")
      .map((configuration) => configuration.variantId);
    const ropeProductIds = configurations
      .filter((configuration): configuration is Extract<RopeCartConfiguration, { version: "v2" }> => configuration.version === "v2")
      .map((configuration) => configuration.productId);
    const [originalVariants, ropeProducts] = await Promise.all([
      loadVariants(admin, [...new Set(legacyVariantIds)]),
      loadRopeProducts(admin, [...new Set(ropeProductIds)], config),
    ]);
    const shopResult = await adminGraphql<{ shop: { currencyCode: string } }>(
      admin,
      `#graphql
      query RopeCartDraftOrderShop {
        shop {
          currencyCode
        }
      }`,
    );
    if (!shopResult.ok) {
      return Response.json(
        { ok: false, error: "Shop-Waehrung konnte nicht geladen werden.", details: shopResult.errors },
        { status: 502 },
      );
    }
    const currencyCode = shopResult.data.shop.currencyCode;
    const lineItems: Array<Record<string, unknown>> = [];
    let totalWeightKilograms = 0;

    for (const item of cartItems) {
      const cartVariant = cartVariants.get(item.variantId)!;
      const configuration = ropeConfigurations.get(cartVariant.id);

      if (!configuration) {
        if (isRopeProduct(
          cartVariant.product.productType,
          config.ropeProductType,
        )) {
          return Response.json(
            { ok: false, error: "Spezialseile muessen ueber den Zuschnitt-Konfigurator in den Warenkorb gelegt werden." },
            { status: 400 },
          );
        }

        totalWeightKilograms += getWeightKilograms(cartVariant, item.quantity);
        lineItems.push({
          variantId: cartVariant.id,
          quantity: item.quantity,
          customAttributes: Object.entries(item.properties)
            .filter(([key]) => !key.startsWith("_hanfwolf_"))
            .map(([key, value]) => ({ key, value })),
        });
        continue;
      }

      if (item.quantity < config.minQuantity || item.quantity > config.maxQuantity) {
        return Response.json(
          {
            ok: false,
            error: `Die Seilmenge muss zwischen ${config.minQuantity} und ${config.maxQuantity} liegen.`,
          },
          { status: 400 },
        );
      }

      if (configuration.version === "v2") {
        const product = ropeProducts.get(configuration.productId);
        if (
          !product ||
          !isRopeProduct(
            product.productType,
            config.ropeProductType,
          )
        ) {
          return Response.json(
            { ok: false, error: "Das Hauptprodukt des Seil-Zuschnitts wurde nicht gefunden oder ist kein Spezialseil." },
            { status: 400 },
          );
        }

        const presentation = item.properties.Aufmachung;
        if (presentation !== "Ring" && presentation !== "Haspel") {
          return Response.json(
            { ok: false, error: "Aufmachung fehlt oder ist ungueltig. Bitte den Zuschnitt erneut konfigurieren." },
            { status: 400 },
          );
        }

        const baseUnitPrice = calculateRopeUnitPrice(
          configuration.meterPrice,
          configuration.lengthMeters,
        );
        if (Number(cartVariant.price).toFixed(2) !== baseUnitPrice) {
          return Response.json(
            { ok: false, error: "Der Cart-Preis passt nicht mehr zum gespeicherten Produktpreis. Bitte den Zuschnitt erneut hinzufuegen." },
            { status: 400 },
          );
        }

        if (presentation === "Haspel" && !config.haspelSurchargeMetafield) {
          return Response.json(
            { ok: false, error: "Im RopeConfigurator Setup fehlt die Zuordnung fuer den Haspel-Aufpreis." },
            { status: 400 },
          );
        }
        const surcharge = presentation === "Haspel" ? product.haspelSurcharge?.value : "0";
        if (presentation === "Haspel" && !surcharge) {
          return Response.json(
            {
              ok: false,
              error: `Fuer ${product.title} fehlt ${config.haspelSurchargeMetafield!.namespace}.${config.haspelSurchargeMetafield!.key}.`,
            },
            { status: 400 },
          );
        }

        const unitPrice = calculateRopeUnitPrice(
          configuration.meterPrice,
          configuration.lengthMeters,
          surcharge,
        );
        const unitWeight = calculateRopeUnitWeight(
          configuration.weightPerMeter,
          configuration.lengthMeters,
        );
        const unitWeightKilograms = Number(
          convertWeightToKilograms(unitWeight, configuration.weightUnit).toFixed(6),
        );
        totalWeightKilograms += Number((unitWeightKilograms * item.quantity).toFixed(6));

        const masterVariant = product.variants.nodes.find(
          (variant) => variant.isDefaultConfiguration?.value === "true",
        );
        if (!masterVariant) {
          return Response.json(
            { ok: false, error: `Fuer ${product.title} wurde keine Variante mit is_default_configuration gefunden.` },
            { status: 400 },
          );
        }

        lineItems.push({
          title: product.title,
          quantity: item.quantity,
          originalUnitPriceWithCurrency: {
            amount: unitPrice,
            currencyCode,
          },
          weight: {
            value: unitWeight,
            unit: configuration.weightUnit,
          },
          requiresShipping: true,
          taxable: masterVariant.taxable,
          ...(masterVariant.sku ? { sku: masterVariant.sku } : {}),
          customAttributes: [
            { key: "Laenge", value: `${configuration.lengthMeters} m` },
            { key: "Aufmachung", value: presentation },
            { key: "Hauptprodukt", value: product.id },
            { key: "_hanfwolf_rope_configuration", value: cartVariant.ropeConfiguration!.value },
          ],
        });
        continue;
      }

      const originalVariant = originalVariants.get(configuration.variantId);
      if (!originalVariant) {
        return Response.json(
          { ok: false, error: "Die Originalvariante des Seil-Zuschnitts wurde nicht gefunden." },
          { status: 400 },
        );
      }
      if (!isRopeProduct(
        originalVariant.product.productType,
        config.ropeProductType,
      )) {
        return Response.json(
          { ok: false, error: "Die Originalvariante des Zuschnitts ist kein Spezialseil." },
          { status: 400 },
        );
      }
      if (Number(cartVariant.price).toFixed(2) !== configuration.unitPrice) {
        return Response.json(
          { ok: false, error: "Der Preis der Zuschnitt-Variante stimmt nicht mit ihrer Konfiguration ueberein." },
          { status: 400 },
        );
      }

      const weight = originalVariant.inventoryItem.measurement.weight;
      if (!weight) {
        return Response.json(
          { ok: false, error: `Fuer ${originalVariant.product.title} fehlt das Varianten-Gewicht pro Meter.` },
          { status: 400 },
        );
      }
      const unitWeight = calculateRopeUnitWeight(weight.value, configuration.lengthMeters);
      const unitWeightKilograms = Number(convertWeightToKilograms(unitWeight, weight.unit).toFixed(6));
      const lineWeightKilograms = Number((unitWeightKilograms * item.quantity).toFixed(6));
      totalWeightKilograms += lineWeightKilograms;

      lineItems.push({
        title: originalVariant.displayName,
        quantity: item.quantity,
        originalUnitPriceWithCurrency: {
          amount: configuration.unitPrice,
          currencyCode,
        },
        weight: {
          value: unitWeight,
          unit: weight.unit,
        },
        requiresShipping: true,
        taxable: originalVariant.taxable,
        ...(originalVariant.sku ? { sku: originalVariant.sku } : {}),
        customAttributes: [
          { key: "Laenge", value: `${configuration.lengthMeters} m` },
          { key: "Aufmachung", value: configuration.presentation },
          { key: "Originalvariante", value: originalVariant.id },
          { key: "_hanfwolf_rope_configuration", value: cartVariant.ropeConfiguration!.value },
        ],
      });
    }

    const url = new URL(request.url);
    const customerId = normalizeCustomerId(url.searchParams.get("logged_in_customer_id") || "");
    const draftResult = await adminGraphql<{
      shop: { currencyCode: string };
      draftOrderCreate: {
        draftOrder: {
          id: string;
          invoiceUrl: string;
          totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
        } | null;
        userErrors: Array<{ field: string[] | null; message: string }>;
      };
    }>(
      admin,
      `#graphql
      mutation CreateCartDraftOrder($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) {
          draftOrder {
            id
            invoiceUrl
            totalPriceSet {
              shopMoney {
                amount
                currencyCode
              }
            }
          }
          userErrors {
            field
            message
          }
        }
      }`,
      {
        input: {
          ...(customerId ? { customerId } : {}),
          lineItems,
          customAttributes: [
            { key: "Gesamtgewicht", value: `${totalWeightKilograms.toFixed(6)} kg` },
          ],
          note: "Warenkorb aus dem Onlineshop",
          tags: ["Warenkorb", "Konfektionierte Seile"],
        },
      },
    );

    if (!draftResult.ok) {
      return Response.json(
        { ok: false, error: "Draft Order konnte nicht erstellt werden.", details: draftResult.errors },
        { status: 502 },
      );
    }

    const payload = draftResult.data.draftOrderCreate;
    if (!payload.draftOrder) {
      return Response.json(
        { ok: false, error: "Draft Order wurde von Shopify abgelehnt.", details: payload.userErrors.map((error) => error.message) },
        { status: 400 },
      );
    }

    return Response.json(
      {
        ok: true,
        draftOrderId: payload.draftOrder.id,
        checkoutUrl: payload.draftOrder.invoiceUrl,
        total: payload.draftOrder.totalPriceSet.shopMoney,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("Unexpected cart draft order error", error);
    return Response.json(
      {
        ok: false,
        error: "Unerwarteter Serverfehler beim Finalisieren des Warenkorbs.",
        details: [error instanceof Error ? error.message : String(error)],
      },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
};