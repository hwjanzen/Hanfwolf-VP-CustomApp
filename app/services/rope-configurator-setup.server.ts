import prisma from "../db.server";
import { adminGraphql } from "./shopify-graphql.server";
import {
  DEFAULT_ROPE_CONFIG,
  parseShippingTiers,
  type MetafieldMapping,
  type RopeConfiguratorConfig,
} from "./rope-configurator-config";

export type {
  MetafieldMapping,
  RopeConfiguratorConfig,
  RopeShippingTier,
} from "./rope-configurator-config";

export type VariantMetafieldDefinition = {
  id: string;
  name: string;
  namespace: string;
  key: string;
  type: { name: string };
};

function createMapping(
  definitionId: string | null | undefined,
  namespace: string | null | undefined,
  key: string | null | undefined,
): MetafieldMapping | null {
  return namespace && key ? { definitionId: definitionId ?? "", namespace, key } : null;
}

export async function getRopeConfiguratorSetup(shop: string) {
  return prisma.ropeConfiguratorSetup.findUnique({ where: { shop } });
}

export async function getRopeConfiguratorConfig(shop: string): Promise<RopeConfiguratorConfig> {
  const setup = await getRopeConfiguratorSetup(shop);
  if (!setup) return DEFAULT_ROPE_CONFIG;

  return {
    minLengthHundredths: setup.minLengthHundredths,
    maxLengthHundredths: setup.maxLengthHundredths,
    defaultLengthHundredths: setup.defaultLengthHundredths,
    minQuantity: setup.minQuantity,
    maxQuantity: setup.maxQuantity,
    shippingTiers: parseShippingTiers(setup.shippingTiersJson),
    packageQuantityMetafield: createMapping(
      setup.packageQuantityMetafieldDefinitionId,
      setup.packageQuantityMetafieldNamespace,
      setup.packageQuantityMetafieldKey,
    ),
    haspelSurchargeMetafield: createMapping(
      setup.haspelSurchargeMetafieldDefinitionId,
      setup.haspelSurchargeMetafieldNamespace,
      setup.haspelSurchargeMetafieldKey,
    ),
    ropeEligibilityMetafield: createMapping(
      setup.ropeEligibilityMetafieldDefinitionId,
      setup.ropeEligibilityMetafieldNamespace,
      setup.ropeEligibilityMetafieldKey,
    ),
  };
}

export async function saveRopeConfiguratorSetup(
  shop: string,
  config: RopeConfiguratorConfig,
) {
  const data = {
    packageQuantityMetafieldDefinitionId: config.packageQuantityMetafield?.definitionId ?? null,
    packageQuantityMetafieldNamespace: config.packageQuantityMetafield?.namespace ?? null,
    packageQuantityMetafieldKey: config.packageQuantityMetafield?.key ?? null,
    haspelSurchargeMetafieldDefinitionId: config.haspelSurchargeMetafield?.definitionId ?? null,
    haspelSurchargeMetafieldNamespace: config.haspelSurchargeMetafield?.namespace ?? null,
    haspelSurchargeMetafieldKey: config.haspelSurchargeMetafield?.key ?? null,
    ropeEligibilityMetafieldDefinitionId: config.ropeEligibilityMetafield?.definitionId ?? null,
    ropeEligibilityMetafieldNamespace: config.ropeEligibilityMetafield?.namespace ?? null,
    ropeEligibilityMetafieldKey: config.ropeEligibilityMetafield?.key ?? null,
    minLengthHundredths: config.minLengthHundredths,
    maxLengthHundredths: config.maxLengthHundredths,
    defaultLengthHundredths: config.defaultLengthHundredths,
    minQuantity: config.minQuantity,
    maxQuantity: config.maxQuantity,
    shippingTiersJson: JSON.stringify(config.shippingTiers),
  };

  return prisma.ropeConfiguratorSetup.upsert({
    where: { shop },
    create: { shop, ...data },
    update: data,
  });
}

export async function savePackageQuantityMetafield(
  shop: string,
  definition: VariantMetafieldDefinition,
) {
  return prisma.ropeConfiguratorSetup.upsert({
    where: { shop },
    create: {
      shop,
      packageQuantityMetafieldDefinitionId: definition.id,
      packageQuantityMetafieldNamespace: definition.namespace,
      packageQuantityMetafieldKey: definition.key,
    },
    update: {
      packageQuantityMetafieldDefinitionId: definition.id,
      packageQuantityMetafieldNamespace: definition.namespace,
      packageQuantityMetafieldKey: definition.key,
    },
  });
}

export async function clearPackageQuantityMetafield(shop: string) {
  await prisma.ropeConfiguratorSetup.updateMany({
    where: { shop },
    data: {
      packageQuantityMetafieldDefinitionId: null,
      packageQuantityMetafieldNamespace: null,
      packageQuantityMetafieldKey: null,
    },
  });
}

export async function setPackageQuantityForVariant(
  admin: unknown,
  shop: string,
  variantId: string,
  config?: RopeConfiguratorConfig,
) {
  const mapping = (config ?? await getRopeConfiguratorConfig(shop)).packageQuantityMetafield;
  if (!mapping) return "not_configured" as const;

  const result = await adminGraphql<{
    metafieldsSet: {
      metafields: Array<{ id: string; value: string }>;
      userErrors: Array<{ field: string[] | null; message: string }>;
    };
  }>(
    admin,
    `#graphql
    mutation SetRopePackageQuantity($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields {
          id
          value
        }
        userErrors {
          field
          message
        }
      }
    }`,
    {
      metafields: [
        {
          ownerId: variantId,
          namespace: mapping.namespace,
          key: mapping.key,
          type: "single_line_text_field",
          value: "1",
        },
      ],
    },
  );

  if (!result.ok) {
    throw new Error(
      `Menge pro Verpackungseinheit konnte nicht gesetzt werden: ${result.errors.join(" | ")}`,
    );
  }

  const userErrors = result.data.metafieldsSet.userErrors;
  if (userErrors.length > 0) {
    throw new Error(
      `Menge pro Verpackungseinheit konnte nicht gesetzt werden: ${userErrors.map((error) => error.message).join("; ")}`,
    );
  }

  if (result.data.metafieldsSet.metafields[0]?.value !== "1") {
    throw new Error("Shopify hat die Menge pro Verpackungseinheit nicht bestaetigt.");
  }

  return "set" as const;
}
