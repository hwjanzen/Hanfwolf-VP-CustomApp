import { createHash } from "node:crypto";
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  calculateRopeUnitPrice,
  createRopeCartConfigurationKey,
  normalizeRopeCuts,
} from "../services/rope-draft-order.server";
import { adminGraphql } from "../services/shopify-graphql.server";

type SourceVariant = {
  id: string;
  price: string;
  sku: string | null;
  taxable: boolean;
  selectedOptions: Array<{ name: string; value: string }>;
  product: {
    id: string;
    title: string;
    productType: string;
    options: Array<{ id: string; name: string }>;
    haspelSurcharge: { value: string } | null;
  };
};

type ExistingCartVariant = {
  id: string;
  sku: string | null;
  price: string;
  metafield: { value: string } | null;
};

function createConfigurationSku(configurationKey: string) {
  return `HW-RC-${createHash("sha256").update(configurationKey).digest("hex").slice(0, 24)}`;
}

function getNumericVariantId(variantId: string) {
  return variantId.split("/").at(-1) || variantId;
}

async function findRopeCartVariant(
  admin: unknown,
  sku: string,
  configurationKey: string,
) {
  const result = await adminGraphql<{
    productVariants: { nodes: ExistingCartVariant[] };
  }>(
    admin,
    `#graphql
    query FindRopeCartVariant($skuQuery: String!) {
      productVariants(first: 1, query: $skuQuery) {
        nodes {
          id
          sku
          price
          metafield(namespace: "hanfwolf", key: "rope_configuration") {
            value
          }
        }
      }
    }`,
    { skuQuery: `sku:${sku}` },
  );

  if (!result.ok) {
    throw new Error(`Konfigurationsvariante konnte nicht gesucht werden: ${result.errors.join(" | ")}`);
  }

  return result.data.productVariants.nodes.find(
    (variant) => variant.metafield?.value === configurationKey,
  );
}

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const { admin, session } = await authenticate.public.appProxy(request);
    if (!admin || !session) {
      return Response.json({ ok: false, error: "App-Proxy-Sitzung fehlt." }, { status: 401 });
    }

    let cut;
    try {
      const body = await request.json();
      cut = normalizeRopeCuts([body?.item])[0];
    } catch (error) {
      return Response.json(
        { ok: false, error: error instanceof Error ? error.message : "Ungueltige Anfrage." },
        { status: 400 },
      );
    }

    const sourceResult = await adminGraphql<{
      productVariant: SourceVariant | null;
    }>(
      admin,
      `#graphql
      query RopeCartSourceVariant($variantId: ID!) {
        productVariant(id: $variantId) {
          id
          price
          sku
          taxable
          selectedOptions {
            name
            value
          }
          product {
            id
            title
            productType
            options {
              id
              name
            }
            haspelSurcharge: metafield(namespace: "custom", key: "haspel_surcharge") {
              value
            }
          }
        }
      }`,
      { variantId: cut.variantId },
    );

    if (!sourceResult.ok) {
      return Response.json(
        { ok: false, error: "Originalvariante konnte nicht geladen werden.", details: sourceResult.errors },
        { status: 502 },
      );
    }

    const source = sourceResult.data.productVariant;
    if (!source || source.product.productType.trim().toLowerCase() !== "spezialseile") {
      return Response.json(
        { ok: false, error: "Die ausgewaehlte Variante ist kein Spezialseil." },
        { status: 400 },
      );
    }
    if (source.selectedOptions.length === 0 || source.selectedOptions.length !== source.product.options.length) {
      return Response.json(
        { ok: false, error: "Das Produkt hat kein vollstaendiges Optionsmodell fuer Zuschnitt-Varianten." },
        { status: 400 },
      );
    }

    const surcharge = cut.presentation === "Haspel" ? source.product.haspelSurcharge?.value : "0";
    if (cut.presentation === "Haspel" && !surcharge) {
      return Response.json(
        { ok: false, error: `Fuer ${source.product.title} fehlt custom.haspel_surcharge.` },
        { status: 400 },
      );
    }

    const unitPrice = calculateRopeUnitPrice(source.price, cut.lengthMeters, surcharge);
    const configurationKey = createRopeCartConfigurationKey(
      source.id,
      cut.lengthMeters,
      cut.presentation,
      unitPrice,
    );
    const sku = createConfigurationSku(configurationKey);
    let cartVariant = await findRopeCartVariant(admin, sku, configurationKey);

    if (!cartVariant) {
      const configurationLabel = `Konfiguration ${sku.slice(-8)}`;
      const optionValues = source.selectedOptions.map((option, index) => ({
        optionName: option.name,
        name: index === source.selectedOptions.length - 1 ? configurationLabel : option.value,
      }));
      const createResult = await adminGraphql<{
        productVariantsBulkCreate: {
          productVariants: Array<{ id: string; sku: string | null; price: string }>;
          userErrors: Array<{ field: string[] | null; message: string }>;
        };
      }>(
        admin,
        `#graphql
        mutation CreateRopeCartVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkCreate(productId: $productId, variants: $variants) {
            productVariants {
              id
              sku
              price
            }
            userErrors {
              field
              message
            }
          }
        }`,
        {
          productId: source.product.id,
          variants: [
            {
              price: unitPrice,
              sku,
              taxable: source.taxable,
              optionValues,
              metafields: [
                {
                  namespace: "hanfwolf",
                  key: "rope_configuration",
                  type: "single_line_text_field",
                  value: configurationKey,
                },
              ],
            },
          ],
        },
      );

      if (!createResult.ok) {
        return Response.json(
          { ok: false, error: "Zuschnitt-Variante konnte nicht angelegt werden.", details: createResult.errors },
          { status: 502 },
        );
      }

      const payload = createResult.data.productVariantsBulkCreate;
      const createdVariant = payload.productVariants[0];
      cartVariant = createdVariant
        ? { ...createdVariant, metafield: { value: configurationKey } }
        : undefined;
      if (!cartVariant) {
        return Response.json(
          {
            ok: false,
            error: "Shopify hat die Zuschnitt-Variante abgelehnt.",
            details: payload.userErrors.map((error) => error.message),
          },
          { status: 400 },
        );
      }
    }

    return Response.json(
      {
        ok: true,
        cartVariantId: cartVariant.id,
        cartVariantNumericId: getNumericVariantId(cartVariant.id),
        quantity: cut.quantity,
        unitPrice,
        properties: {
          OriginalVariantId: source.id,
          Laenge: `${cut.lengthMeters} m`,
          Aufmachung: cut.presentation,
          _hanfwolf_rope_configuration: configurationKey,
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("Unexpected rope cart variant error", error);
    return Response.json(
      {
        ok: false,
        error: "Unerwarteter Serverfehler beim Anlegen der Zuschnitt-Variante.",
        details: [error instanceof Error ? error.message : String(error)],
      },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
};