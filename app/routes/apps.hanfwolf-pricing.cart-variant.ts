import { createHash } from "node:crypto";
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  calculateRopeUnitPrice,
  calculateRopeUnitWeight,
  createRopeCartConfigurationKey,
  isRopeProductType,
  normalizeRopeProductCut,
} from "../services/rope-draft-order.server";
import { adminGraphql } from "../services/shopify-graphql.server";

type SourceVariant = {
  id: string;
  price: string;
  sku: string | null;
  taxable: boolean;
  selectedOptions: Array<{ name: string; value: string }>;
  ropeConfiguration: { value: string } | null;
  inventoryItem: {
    measurement: {
      weight: { value: number; unit: string } | null;
    };
  };
};

type SourceProduct = {
  id: string;
  title: string;
  productType: string;
  options: Array<{ id: string; name: string }>;
  haspelSurcharge: { value: string } | null;
  variants: { nodes: SourceVariant[] };
};

type ExistingCartVariant = {
  id: string;
  sku: string | null;
  price: string;
  metafield: { value: string } | null;
  inventoryItem: {
    id: string;
    tracked: boolean;
    requiresShipping: boolean;
    measurement: { weight: { value: number; unit: string } | null } | null;
  };
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
          inventoryItem {
            id
            tracked
            requiresShipping
            measurement {
              weight {
                value
                unit
              }
            }
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

async function ensureRopeCartVariantInventorySettings(
  admin: unknown,
  productId: string,
  variant: ExistingCartVariant,
  weight: { value: number; unit: string },
) {
  const currentWeight = variant.inventoryItem.measurement?.weight;
  const weightMatches =
    currentWeight?.unit === weight.unit &&
    Math.abs(currentWeight.value - weight.value) < 0.000001;
  if (!variant.inventoryItem.tracked && variant.inventoryItem.requiresShipping && weightMatches) return;

  const result = await adminGraphql<{
    productVariantsBulkUpdate: {
      productVariants: Array<{
        id: string;
        inventoryItem: {
          tracked: boolean;
          requiresShipping: boolean;
          measurement: { weight: { value: number; unit: string } | null } | null;
        };
      }>;
      userErrors: Array<{ field: string[] | null; message: string }>;
    };
  }>(
    admin,
    `#graphql
    mutation UpdateRopeCartVariantInventorySettings($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants {
          id
          inventoryItem {
            tracked
            requiresShipping
            measurement {
              weight {
                value
                unit
              }
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
      productId,
      variants: [
        {
          id: variant.id,
          inventoryItem: {
            tracked: false,
            requiresShipping: true,
            measurement: { weight },
          },
        },
      ],
    },
  );

  if (!result.ok) {
    throw new Error(`Inventarverfolgung der Zuschnitt-Variante konnte nicht deaktiviert werden: ${result.errors.join(" | ")}`);
  }

  const payload = result.data.productVariantsBulkUpdate;
  if (payload.userErrors.length > 0) {
    throw new Error(`Versandgewicht der Zuschnitt-Variante konnte nicht gesetzt werden: ${payload.userErrors.map((error) => error.message).join("; ")}`);
  }
  const updatedInventoryItem = payload.productVariants[0]?.inventoryItem;
  if (
    updatedInventoryItem?.tracked !== false ||
    !updatedInventoryItem.requiresShipping ||
    updatedInventoryItem.measurement?.weight?.unit !== weight.unit ||
    Math.abs((updatedInventoryItem.measurement?.weight?.value ?? 0) - weight.value) >= 0.000001
  ) {
    throw new Error("Versandgewicht oder Versandpflicht der Zuschnitt-Variante wurde von Shopify nicht uebernommen.");
  }
}

async function publishRopeCartVariant(admin: unknown, variantId: string) {
  const publicationsResult = await adminGraphql<{
    publications: {
      nodes: Array<{ id: string; catalog: { title: string } | null }>;
    };
  }>(
    admin,
    `#graphql
    query RopeCartOnlineStorePublication {
      publications(first: 20) {
        nodes {
          id
          catalog {
            title
          }
        }
      }
    }`,
  );

  if (!publicationsResult.ok) {
    throw new Error(`Online-Store-Publikation konnte nicht geladen werden: ${publicationsResult.errors.join(" | ")}`);
  }

  const availablePublications = publicationsResult.data.publications.nodes;
  const publication = availablePublications.find(
    (node) => {
      const title = node.catalog?.title.trim().toLowerCase() || "";
      return title === "online store" || title.endsWith("for online store");
    },
  );
  if (!publication) {
    const titles = availablePublications
      .map((node) => node.catalog?.title)
      .filter((title): title is string => Boolean(title));
    throw new Error(
      `Shopify-Publikation 'Online Store' wurde nicht gefunden. Verfuegbare Kanaele: ${titles.join(", ") || "keine"}.`,
    );
  }

  const publishResult = await adminGraphql<{
    publishablePublish: {
      userErrors: Array<{ field: string[] | null; message: string }>;
    };
  }>(
    admin,
    `#graphql
    mutation PublishRopeCartVariant($id: ID!, $input: [PublicationInput!]!) {
      publishablePublish(id: $id, input: $input) {
        publishable {
          ... on ProductVariant {
            id
          }
        }
        userErrors {
          field
          message
        }
      }
    }`,
    {
      id: variantId,
      input: [{ publicationId: publication.id }],
    },
  );

  if (!publishResult.ok) {
    throw new Error(`Zuschnitt-Variante konnte nicht veröffentlicht werden: ${publishResult.errors.join(" | ")}`);
  }

  const userErrors = publishResult.data.publishablePublish.userErrors;
  if (userErrors.length > 0) {
    throw new Error(`Zuschnitt-Variante konnte nicht veröffentlicht werden: ${userErrors.map((error) => error.message).join("; ")}`);
  }
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
      cut = normalizeRopeProductCut(body?.item);
    } catch (error) {
      return Response.json(
        { ok: false, error: error instanceof Error ? error.message : "Ungueltige Anfrage." },
        { status: 400 },
      );
    }

    const sourceResult = await adminGraphql<{
      product: SourceProduct | null;
    }>(
      admin,
      `#graphql
      query RopeCartMasterProduct($productId: ID!) {
            product(id: $productId) {
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
              variants(first: 250) {
                nodes {
                  id
                  price
                  sku
                  taxable
                  selectedOptions {
                    name
                    value
                  }
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
                }
              }
            }
          }`,
          { productId: cut.productId },
        );

        if (!sourceResult.ok) {
          console.error("Rope cart master product lookup failed", {
            shop: session.shop,
            productId: cut.productId,
            errors: sourceResult.errors,
          });
          return Response.json(
            { ok: false, error: "Hauptprodukt konnte nicht geladen werden.", details: sourceResult.errors },
            { headers: { "Cache-Control": "no-store" } },
          );
        }

        const sourceProduct = sourceResult.data.product;
        if (!sourceProduct || !isRopeProductType(sourceProduct.productType)) {
          return Response.json(
            { ok: false, error: "Das ausgewaehlte Hauptprodukt ist kein Spezialseil." },
            { status: 400 },
          );
        }

        const source = sourceProduct.variants.nodes.find(
          (variant) => !variant.ropeConfiguration?.value,
        );
        if (!source) {
          return Response.json(
            { ok: false, error: `Fuer ${sourceProduct.title} wurde keine unveraenderte Stammdaten-Variante gefunden.` },
            { status: 400 },
          );
        }
        if (source.selectedOptions.length === 0 || source.selectedOptions.length !== sourceProduct.options.length) {
          return Response.json(
            { ok: false, error: "Das Hauptprodukt hat kein vollstaendiges Optionsmodell fuer Zuschnitt-Varianten." },
            { status: 400 },
          );
        }

        const surcharge = cut.presentation === "Haspel" ? sourceProduct.haspelSurcharge?.value : "0";
        if (cut.presentation === "Haspel" && !surcharge) {
          return Response.json(
            { ok: false, error: `Fuer ${sourceProduct.title} fehlt custom.haspel_surcharge.` },
            { status: 400 },
          );
        }

        const sourceWeight = source.inventoryItem.measurement.weight;
        if (!sourceWeight || !Number.isFinite(sourceWeight.value) || sourceWeight.value <= 0) {
          const measuredWeight = sourceWeight
            ? `${sourceWeight.value} ${sourceWeight.unit}`
            : "nicht gepflegt";
          return Response.json(
            {
              ok: false,
              error: `Fuer ${sourceProduct.title} muss ein positives Gewicht pro Meter gepflegt sein. Shopify liefert aktuell: ${measuredWeight}.`,
            },
            { status: 400 },
          );
        }

        const unitPrice = calculateRopeUnitPrice(source.price, cut.lengthMeters);
        const configuredWeight = calculateRopeUnitWeight(sourceWeight.value, cut.lengthMeters);
        const configurationKey = createRopeCartConfigurationKey(
          sourceProduct.id,
          cut.lengthMeters,
          source.price,
          sourceWeight.value,
          sourceWeight.unit,
        );
        const sku = createConfigurationSku(configurationKey);
        let cartVariant = await findRopeCartVariant(admin, sku, configurationKey);

        if (!cartVariant) {
          const configurationLabel = `Zuschnitt ${cut.lengthMeters} m ${sku.slice(-8)}`;
          const optionValues = source.selectedOptions.map((option, index) => ({
            optionName: option.name,
            name: index === source.selectedOptions.length - 1 ? configurationLabel : option.value,
          }));
          const createResult = await adminGraphql<{
            productVariantsBulkCreate: {
              productVariants: Array<{
                id: string;
                sku: string | null;
                price: string;
                inventoryItem: {
                  id: string;
                  tracked: boolean;
                  requiresShipping: boolean;
                  measurement: { weight: { value: number; unit: string } | null } | null;
                };
              }>;
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
                  inventoryItem {
                    id
                    tracked
                    requiresShipping
                    measurement {
                      weight {
                        value
                        unit
                      }
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
              productId: sourceProduct.id,
              variants: [
                {
                  price: unitPrice,
                  inventoryItem: {
                    sku,
                    tracked: false,
                    requiresShipping: true,
                    measurement: {
                      weight: {
                        value: configuredWeight,
                        unit: sourceWeight.unit,
                      },
                    },
                  },
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
            console.error("Rope cart variant creation request failed", {
              shop: session.shop,
              productId: sourceProduct.id,
              errors: createResult.errors,
            });
            return Response.json(
              { ok: false, error: "Zuschnitt-Variante konnte nicht angelegt werden.", details: createResult.errors },
              { headers: { "Cache-Control": "no-store" } },
            );
          }

          const payload = createResult.data.productVariantsBulkCreate;
          const createdVariant = payload.productVariants[0];
          cartVariant = createdVariant
            ? {
                ...createdVariant,
                metafield: { value: configurationKey },
              }
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

        await ensureRopeCartVariantInventorySettings(admin, sourceProduct.id, cartVariant, {
          value: configuredWeight,
          unit: sourceWeight.unit,
        });
        await publishRopeCartVariant(admin, cartVariant.id);

        return Response.json(
          {
            ok: true,
            cartVariantId: cartVariant.id,
            cartVariantNumericId: getNumericVariantId(cartVariant.id),
            quantity: cut.quantity,
            unitPrice,
            properties: {
              OriginalProductId: sourceProduct.id,
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
      { headers: { "Cache-Control": "no-store" } },
    );
  }
};