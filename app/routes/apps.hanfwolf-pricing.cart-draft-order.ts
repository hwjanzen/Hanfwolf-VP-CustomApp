import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { normalizeCustomerId, normalizeVariantId } from "../services/price-resolver.server";
import {
  calculateRopeShippingPrice,
  calculateRopeUnitWeight,
  convertWeightToKilograms,
  parseRopeCartConfigurationKey,
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

async function loadVariants(admin: unknown, ids: string[]) {
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
          parseRopeCartConfigurationKey(variant.ropeConfiguration.value),
        );
      } catch (error) {
        return Response.json(
          { ok: false, error: error instanceof Error ? error.message : "Ungueltige Zuschnitt-Variante." },
          { status: 400 },
        );
      }
    }

    const originalVariants = await loadVariants(
      admin,
      [...new Set([...ropeConfigurations.values()].map((configuration) => configuration.variantId))],
    );
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
        if (cartVariant.product.productType.trim().toLowerCase() === "spezialseile") {
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

      const originalVariant = originalVariants.get(configuration.variantId);
      if (!originalVariant) {
        return Response.json(
          { ok: false, error: "Die Originalvariante des Seil-Zuschnitts wurde nicht gefunden." },
          { status: 400 },
        );
      }
      if (originalVariant.product.productType.trim().toLowerCase() !== "spezialseile") {
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

    const shippingPrice = calculateRopeShippingPrice(totalWeightKilograms);
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
          shippingLine: {
            title: "Standard",
            price: shippingPrice,
          },
          customAttributes: [
            { key: "Gesamtgewicht", value: `${totalWeightKilograms.toFixed(6)} kg` },
            { key: "Versandstaffel", value: `${shippingPrice} ${currencyCode}` },
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