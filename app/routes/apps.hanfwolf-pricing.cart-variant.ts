import { createHash } from "node:crypto";
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { ensureRopeDefaultConfigurationMetafieldDefinition } from "../services/pricing-bootstrap.server";
import {
  getRopeConfiguratorConfig,
  setPackageQuantityForVariant,
} from "../services/rope-configurator-setup.server";
import {
  calculateRopeUnitPrice,
  calculateRopeUnitWeight,
  createRopeCartConfigurationKey,
  isRopeProduct,
  normalizeRopeProductCut,
  selectRopeMasterVariant,
} from "../services/rope-draft-order.server";
import { adminGraphql } from "../services/shopify-graphql.server";

type SourceVariant = {
  id: string;
  price: string;
  sku: string | null;
  taxable: boolean;
  selectedOptions: Array<{ name: string; value: string }>;
  ropeConfiguration: { value: string } | null;
  isDefaultConfiguration: { value: string } | null;
  inventoryItem: {
    measurement: {
      weight: { value: number; unit: string } | null;
    };
  };
};

type SourceProduct = {
  id: string;
  handle: string;
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
  inventoryPolicy: "CONTINUE" | "DENY";
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
          inventoryPolicy
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
  if (
    variant.inventoryPolicy === "CONTINUE" &&
    !variant.inventoryItem.tracked &&
    variant.inventoryItem.requiresShipping &&
    weightMatches
  ) return;

  const result = await adminGraphql<{
    productVariantsBulkUpdate: {
      productVariants: Array<{
        id: string;
        inventoryPolicy: "CONTINUE" | "DENY";
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
          inventoryPolicy
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
          inventoryPolicy: "CONTINUE",
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
    payload.productVariants[0]?.inventoryPolicy !== "CONTINUE" ||
    !updatedInventoryItem.requiresShipping ||
    updatedInventoryItem.measurement?.weight?.unit !== weight.unit ||
    Math.abs((updatedInventoryItem.measurement?.weight?.value ?? 0) - weight.value) >= 0.000001
  ) {
    throw new Error("Verkaufbarkeit, Versandpflicht oder Versandgewicht der Zuschnitt-Variante wurde von Shopify nicht korrekt uebernommen.");
  }
}

async function publishRopeCartVariant(
  admin: unknown,
  productId: string,
  variantId: string,
) {
  const publicationsResult = await adminGraphql<{
    product: {
      resourcePublicationsV2: {
        nodes: Array<{
          publication: { id: string; name: string; catalog: { title: string } | null };
        }>;
      };
    } | null;
  }>(
    admin,
    `#graphql
    query RopeMasterProductPublications($productId: ID!) {
      product(id: $productId) {
        resourcePublicationsV2(first: 25) {
          nodes {
            publication {
              id
              name
              catalog {
                title
              }
            }
          }
        }
      }
    }`,
    { productId },
  );

  if (!publicationsResult.ok) {
    throw new Error(`Online-Store-Publikation konnte nicht geladen werden: ${publicationsResult.errors.join(" | ")}`);
  }

  const productPublications = publicationsResult.data.product?.resourcePublicationsV2.nodes ?? [];
  if (productPublications.length === 0) {
    throw new Error(
      "Das Hauptprodukt ist in keinem Verkaufskanal veröffentlicht.",
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
      input: productPublications.map(({ publication }) => ({
        publicationId: publication.id,
      })),
    },
  );

  if (!publishResult.ok) {
    throw new Error(`Zuschnitt-Variante konnte nicht veröffentlicht werden: ${publishResult.errors.join(" | ")}`);
  }

  const userErrors = publishResult.data.publishablePublish.userErrors;
  if (userErrors.length > 0) {
    throw new Error(`Zuschnitt-Variante konnte nicht veröffentlicht werden: ${userErrors.map((error) => error.message).join("; ")}`);
  }

  const onlineStorePublication = productPublications.find(({ publication }) => {
    const title = publication.catalog?.title.trim().toLowerCase() || "";
    const name = publication.name.trim().toLowerCase();
    return title === "online store" || title.endsWith("for online store") || name === "online store";
  });

  return (onlineStorePublication ?? productPublications[0]).publication.id;
}

async function assertRopeCartVariantAvailable(
  admin: unknown,
  variantId: string,
  publicationId: string,
) {
  const result = await adminGraphql<{
    productVariant: {
      id: string;
      availableForSale: boolean;
      inventoryPolicy: "CONTINUE" | "DENY";
      inventoryItem: { tracked: boolean };
      publishedOnPublication: boolean;
      product: { id: string; status: string; publishedAt: string | null };
    } | null;
  }>(
    admin,
    `#graphql
    query RopeCartVariantAvailability($variantId: ID!, $publicationId: ID!) {
      productVariant(id: $variantId) {
        id
        availableForSale
        inventoryPolicy
        inventoryItem {
          tracked
        }
        publishedOnPublication(publicationId: $publicationId)
        product {
          id
          status
          publishedAt
        }
      }
    }`,
    { variantId, publicationId },
  );

  if (!result.ok) {
    throw new Error(`Verfuegbarkeit der Zuschnitt-Variante konnte nicht gelesen werden: ${result.errors.join(" | ")}`);
  }

  const variant = result.data.productVariant;
  if (!variant) {
    throw new Error(`Shopify findet die Zuschnitt-Variante ${variantId} nach dem Anlegen nicht.`);
  }

  if (!variant.availableForSale) {
    throw new Error(
      `Shopify meldet die Zuschnitt-Variante als nicht verfuegbar (inventoryPolicy=${variant.inventoryPolicy}, tracked=${variant.inventoryItem.tracked}, publishedOnOnlineStore=${variant.publishedOnPublication}, productStatus=${variant.product.status}, publishedAt=${variant.product.publishedAt || "null"}).`,
    );
  }
}

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const { admin, session } = await authenticate.public.appProxy(request);
    if (!admin || !session) {
      return Response.json({ ok: false, error: "App-Proxy-Sitzung fehlt." }, { status: 401 });
    }

    await ensureRopeDefaultConfigurationMetafieldDefinition(admin);
    const config = await getRopeConfiguratorConfig(session.shop);

    let cut;
    try {
      const body = await request.json();
      cut = normalizeRopeProductCut(body?.item, config);
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
      query RopeCartMasterProduct(
        $productId: ID!
        $haspelNamespace: String!
        $haspelKey: String!
      ) {
            product(id: $productId) {
              id
              handle
              title
              productType
              options {
                id
                name
              }
              haspelSurcharge: metafield(namespace: $haspelNamespace, key: $haspelKey) {
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
                  isDefaultConfiguration: metafield(namespace: "$app", key: "is_default_configuration") {
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
          {
            productId: cut.productId,
            haspelNamespace: config.haspelSurchargeMetafield?.namespace ?? "$app",
            haspelKey: config.haspelSurchargeMetafield?.key ?? "unconfigured_haspel_surcharge",
          },
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
        if (
          !sourceProduct ||
          !isRopeProduct(
            sourceProduct.productType,
            config.ropeProductType,
          )
        ) {
          return Response.json(
            { ok: false, error: "Das ausgewaehlte Hauptprodukt ist kein Spezialseil." },
            { status: 400 },
          );
        }

        const masterSelection = selectRopeMasterVariant(sourceProduct.variants.nodes);
        if (!masterSelection.ok && masterSelection.reason === "multiple_marked") {
          return Response.json(
            {
              ok: false,
              error: `Fuer ${sourceProduct.title} sind mehrere Varianten als is_default_configuration markiert. Es darf genau eine Stammdaten-Variante geben.`,
            },
            { status: 400 },
          );
        }
        if (!masterSelection.ok) {
          return Response.json(
            {
              ok: false,
              error: `Fuer ${sourceProduct.title} fehlt eine Stammdaten-Variante oder es gibt mehrere unmarkierte Kandidaten. Markiere genau eine Variante mit is_default_configuration.`,
            },
            { status: 400 },
          );
        }

        const source = masterSelection.variant;
        if (masterSelection.needsMarking) {
          const markerResult = await adminGraphql<{
            metafieldsSet: {
              userErrors: Array<{ field: string[] | null; message: string }>;
            };
          }>(
            admin,
            `#graphql
            mutation MarkRopeMasterVariant($metafields: [MetafieldsSetInput!]!) {
              metafieldsSet(metafields: $metafields) {
                userErrors {
                  field
                  message
                }
              }
            }`,
            {
              metafields: [
                {
                  ownerId: source.id,
                  key: "is_default_configuration",
                  type: "boolean",
                  value: "true",
                },
              ],
            },
          );
          if (!markerResult.ok) {
            return Response.json(
              { ok: false, error: "Die Stammdaten-Variante konnte nicht markiert werden.", details: markerResult.errors },
              { headers: { "Cache-Control": "no-store" } },
            );
          }
          const markerErrors = markerResult.data.metafieldsSet.userErrors;
          if (markerErrors.length > 0) {
            return Response.json(
              { ok: false, error: "Die Stammdaten-Variante konnte nicht markiert werden.", details: markerErrors.map((error) => error.message) },
              { headers: { "Cache-Control": "no-store" } },
            );
          }
        }
        if (source.selectedOptions.length === 0 || source.selectedOptions.length !== sourceProduct.options.length) {
          return Response.json(
            { ok: false, error: "Das Hauptprodukt hat kein vollstaendiges Optionsmodell fuer Zuschnitt-Varianten." },
            { status: 400 },
          );
        }

        if (cut.presentation === "Haspel" && !config.haspelSurchargeMetafield) {
          return Response.json(
            { ok: false, error: "Im RopeConfigurator Setup fehlt die Zuordnung fuer den Haspel-Aufpreis." },
            { status: 400 },
          );
        }
        const surcharge = cut.presentation === "Haspel" ? sourceProduct.haspelSurcharge?.value : "0";
        if (cut.presentation === "Haspel" && !surcharge) {
          return Response.json(
            {
              ok: false,
              error: `Fuer ${sourceProduct.title} fehlt ${config.haspelSurchargeMetafield!.namespace}.${config.haspelSurchargeMetafield!.key}.`,
            },
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
          config,
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
                inventoryPolicy: "CONTINUE" | "DENY";
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
              productVariantsBulkCreate(
                productId: $productId
                variants: $variants
                strategy: PRESERVE_STANDALONE_VARIANT
              ) {
                productVariants {
                  id
                  sku
                  price
                  inventoryPolicy
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
                  inventoryPolicy: "CONTINUE",
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

        await setPackageQuantityForVariant(admin, session.shop, cartVariant.id, config);
        await ensureRopeCartVariantInventorySettings(admin, sourceProduct.id, cartVariant, {
          value: configuredWeight,
          unit: sourceWeight.unit,
        });
        const onlineStorePublicationId = await publishRopeCartVariant(
          admin,
          sourceProduct.id,
          cartVariant.id,
        );
        await assertRopeCartVariantAvailable(admin, cartVariant.id, onlineStorePublicationId);

        return Response.json(
          {
            ok: true,
            cartVariantId: cartVariant.id,
            cartVariantNumericId: getNumericVariantId(cartVariant.id),
            productHandle: sourceProduct.handle,
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