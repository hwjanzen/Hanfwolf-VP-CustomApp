import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { normalizeCustomerId } from "../services/price-resolver.server";
import {
  calculateRopeShippingPrice,
  calculateRopeUnitPrice,
  calculateRopeUnitWeight,
  convertWeightToKilograms,
  normalizeRopeCuts,
} from "../services/rope-draft-order.server";
import { adminGraphql } from "../services/shopify-graphql.server";

type VariantNode = {
  id: string;
  displayName: string;
  price: string;
  sku: string | null;
  taxable: boolean;
  inventoryItem: {
    measurement: {
      weight: { value: number; unit: string } | null;
    };
  };
  product: {
    id: string;
    title: string;
    productType: string;
    haspelSurcharge: { value: string } | null;
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.public.appProxy(request);

  if (!admin || !session) {
    return Response.json({ ok: false, error: "App-Proxy-Sitzung fehlt." }, { status: 401 });
  }

  let cuts;
  try {
    const body = await request.json();
    cuts = normalizeRopeCuts(body?.items);
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "Ungueltige Anfrage." },
      { status: 400 },
    );
  }

  const variantIds = [...new Set(cuts.map((cut) => cut.variantId))];
  const variantsResult = await adminGraphql<{
    shop: { currencyCode: string };
    nodes: Array<VariantNode | null>;
  }>(
    admin,
    `#graphql
    query RopeDraftOrderVariants($ids: [ID!]!) {
      shop {
        currencyCode
      }
      nodes(ids: $ids) {
        ... on ProductVariant {
          id
          displayName
          price
          sku
          taxable
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
            haspelSurcharge: metafield(namespace: "custom", key: "haspel_surcharge") {
              value
            }
          }
        }
      }
    }`,
    { ids: variantIds },
  );

  if (!variantsResult.ok) {
    return Response.json(
      { ok: false, error: "Produkte konnten nicht geladen werden.", details: variantsResult.errors },
      { status: 502 },
    );
  }

  const variants = new Map(
    variantsResult.data.nodes
      .filter((node): node is VariantNode => Boolean(node?.id))
      .map((node) => [node.id, node]),
  );
  const currencyCode = variantsResult.data.shop.currencyCode;

  let lineItems;
  try {
    lineItems = cuts.map((cut) => {
      const variant = variants.get(cut.variantId);
      if (!variant) {
        throw new Error(`Variante ${cut.variantId} wurde nicht gefunden.`);
      }
      if (variant.product.productType.trim().toLowerCase() !== "spezialseile") {
        throw new Error(`${variant.product.title} ist kein Produkt vom Typ Spezialseile.`);
      }

      const surcharge =
        cut.presentation === "Haspel" ? variant.product.haspelSurcharge?.value : "0";
      if (cut.presentation === "Haspel" && !surcharge) {
        throw new Error(
          `Fuer ${variant.product.title} fehlt das Produkt-Metafeld custom.haspel_surcharge.`,
        );
      }

      const weightPerMeter = variant.inventoryItem.measurement.weight;
      if (!weightPerMeter) {
        throw new Error(
          `Fuer ${variant.product.title} fehlt das Varianten-Gewicht pro Meter.`,
        );
      }
      const unitWeight = calculateRopeUnitWeight(
        weightPerMeter.value,
        cut.lengthMeters,
      );
      const totalWeight = Number((unitWeight * cut.quantity).toFixed(6));
      const unitWeightKilograms = Number(
        convertWeightToKilograms(unitWeight, weightPerMeter.unit).toFixed(6),
      );
      const totalWeightKilograms = Number(
        convertWeightToKilograms(totalWeight, weightPerMeter.unit).toFixed(6),
      );

      return {
        title: variant.displayName,
        quantity: cut.quantity,
        originalUnitPriceWithCurrency: {
          amount: calculateRopeUnitPrice(variant.price, cut.lengthMeters, surcharge),
          currencyCode,
        },
        weight: {
          value: unitWeight,
          unit: weightPerMeter.unit,
        },
        requiresShipping: true,
        taxable: variant.taxable,
        ...(variant.sku ? { sku: variant.sku } : {}),
        customAttributes: [
          { key: "Laenge", value: `${cut.lengthMeters} m` },
          { key: "Aufmachung", value: cut.presentation },
          { key: "Meterpreis", value: `${variant.price} ${currencyCode}/m` },
          {
            key: "Gewicht je Seil",
            value: `${unitWeightKilograms} kg`,
          },
          {
            key: "Gesamtgewicht",
            value: `${totalWeightKilograms} kg`,
          },
          { key: "_product_id", value: variant.product.id },
          { key: "_variant_id", value: variant.id },
        ],
      };
    });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "Preisberechnung fehlgeschlagen." },
      { status: 400 },
    );
  }

  const totalWeight = Number(
    lineItems
      .reduce(
        (sum, lineItem) =>
          sum +
          convertWeightToKilograms(
            lineItem.weight.value * lineItem.quantity,
            lineItem.weight.unit,
          ),
        0,
      )
      .toFixed(6),
  );
  const shippingPrice = calculateRopeShippingPrice(totalWeight);

  const url = new URL(request.url);
  const customerId = normalizeCustomerId(url.searchParams.get("logged_in_customer_id") || "");
  const draftResult = await adminGraphql<{
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
    mutation CreateRopeDraftOrder($input: DraftOrderInput!) {
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
          { key: "Gesamtgewicht", value: `${totalWeight} kg` },
          { key: "Versandstaffel", value: `${shippingPrice} ${currencyCode}` },
        ],
        note: "Konfektionierte Seile aus dem Onlineshop",
        tags: ["Konfektionierte Seile"],
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
      {
        ok: false,
        error: "Draft Order wurde von Shopify abgelehnt.",
        details: payload.userErrors.map((error) => error.message),
      },
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
};