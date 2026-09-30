import { useEffect } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  getRopeConfiguratorConfig,
  saveRopeConfiguratorSetup,
  type VariantMetafieldDefinition,
} from "../services/rope-configurator-setup.server";
import type { MetafieldMapping } from "../services/rope-configurator-config";
import { adminGraphql } from "../services/shopify-graphql.server";

const NO_METAFIELD_MAPPING = "__none__";

async function loadMetafieldDefinitions(admin: unknown, ownerType: "PRODUCT" | "PRODUCTVARIANT") {
  const result = await adminGraphql<{
    metafieldDefinitions: { nodes: VariantMetafieldDefinition[] };
  }>(
    admin,
    `#graphql
    query RopeConfiguratorMetafieldDefinitions($ownerType: MetafieldOwnerType!) {
      metafieldDefinitions(first: 250, ownerType: $ownerType) {
        nodes {
          id
          name
          namespace
          key
          type {
            name
          }
        }
      }
    }`,
    { ownerType },
  );

  if (!result.ok) {
    throw new Error(result.errors.join(" | "));
  }

  return result.data.metafieldDefinitions.nodes.sort((left, right) =>
    left.name.localeCompare(right.name, "de"),
  );
}

async function loadProductTypes(admin: unknown) {
  const result = await adminGraphql<{
    productTypes: { nodes: string[] };
  }>(
    admin,
    `#graphql
    query RopeConfiguratorProductTypes {
      productTypes(first: 250) {
        nodes
      }
    }`,
  );

  if (!result.ok) {
    throw new Error(result.errors.join(" | "));
  }

  return result.data.productTypes.nodes
    .map((productType) => productType.trim())
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right, "de"));
}

function parseScaledDecimal(value: FormDataEntryValue | null, decimals: number, label: string) {
  const normalized = String(value || "").trim().replace(",", ".");
  const match = normalized.match(new RegExp(`^(\\d+)(?:\\.(\\d{1,${decimals}}))?$`));
  if (!match) throw new Error(`${label} ist ungueltig.`);
  return Number(match[1]) * 10 ** decimals + Number((match[2] || "").padEnd(decimals, "0"));
}

function formatScaledDecimal(value: number, decimals: number) {
  return (value / 10 ** decimals).toFixed(decimals).replace(/\.?0+$/, "") || "0";
}

function resolveMapping(
  submittedValue: FormDataEntryValue | null,
  definitions: VariantMetafieldDefinition[],
  label: string,
): MetafieldMapping | null {
  const rawValue = typeof submittedValue === "string" ? submittedValue.trim() : "";
  if (!rawValue || rawValue === NO_METAFIELD_MAPPING) return null;

  let value = rawValue;
  try {
    value = decodeURIComponent(rawValue);
  } catch {
    // Keep the original value when it is not URI encoded.
  }

  const definition = definitions.find(
    (candidate) =>
      candidate.id === value ||
      `${candidate.namespace}.${candidate.key}` === value ||
      `${candidate.namespace}:${candidate.key}` === value,
  );
  if (!definition) {
    throw new Error(
      `${label}: Das ausgewaehlte Metafeld ist nicht mehr verfuegbar. Bitte die Seite neu laden und erneut auswaehlen.`,
    );
  }
  return {
    definitionId: definition.id,
    namespace: definition.namespace,
    key: definition.key,
  };
}

function mappingOptionValue(definition: VariantMetafieldDefinition) {
  return `${definition.namespace}:${definition.key}`;
}

function selectedMappingValue(
  mapping: MetafieldMapping | null,
  definitions: VariantMetafieldDefinition[],
) {
  if (!mapping) return NO_METAFIELD_MAPPING;
  const definition = definitions.find(
    (definition) =>
      definition.id === mapping.definitionId ||
      (definition.namespace === mapping.namespace && definition.key === mapping.key),
  );
  return definition ? mappingOptionValue(definition) : NO_METAFIELD_MAPPING;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const [allVariantDefinitions, allProductDefinitions, productTypes, config] = await Promise.all([
    loadMetafieldDefinitions(admin, "PRODUCTVARIANT"),
    loadMetafieldDefinitions(admin, "PRODUCT"),
    loadProductTypes(admin),
    getRopeConfiguratorConfig(session.shop),
  ]);

  return {
    variantDefinitions: allVariantDefinitions.filter(
      (definition) => definition.type.name === "single_line_text_field",
    ),
    surchargeDefinitions: allProductDefinitions.filter((definition) =>
      ["number_decimal", "single_line_text_field"].includes(definition.type.name),
    ),
    productTypes,
    config,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  try {
    const [allVariantDefinitions, allProductDefinitions, productTypes] = await Promise.all([
      loadMetafieldDefinitions(admin, "PRODUCTVARIANT"),
      loadMetafieldDefinitions(admin, "PRODUCT"),
      loadProductTypes(admin),
    ]);
    const variantDefinitions = allVariantDefinitions.filter(
      (definition) => definition.type.name === "single_line_text_field",
    );
    const surchargeDefinitions = allProductDefinitions.filter((definition) =>
      ["number_decimal", "single_line_text_field"].includes(definition.type.name),
    );
    const submittedProductType = String(formData.get("ropeProductType") || "").trim();
    const ropeProductType =
      !submittedProductType || submittedProductType === NO_METAFIELD_MAPPING
        ? null
        : productTypes.find((productType) => productType === submittedProductType) ?? null;
    if (
      submittedProductType &&
      submittedProductType !== NO_METAFIELD_MAPPING &&
      !ropeProductType
    ) {
      throw new Error(
        "Seil-Produkttyp: Der ausgewaehlte Produkttyp ist nicht mehr verfuegbar. Bitte die Seite neu laden.",
      );
    }

    const minLengthHundredths = parseScaledDecimal(formData.get("minLengthMeters"), 2, "Minimale Laenge");
    const maxLengthHundredths = parseScaledDecimal(formData.get("maxLengthMeters"), 2, "Maximale Laenge");
    const defaultLengthHundredths = parseScaledDecimal(formData.get("defaultLengthMeters"), 2, "Vorgabelaenge");
    const minQuantity = Number(formData.get("minQuantity"));
    const maxQuantity = Number(formData.get("maxQuantity"));
    if (minLengthHundredths <= 0 || maxLengthHundredths < minLengthHundredths) {
      throw new Error("Der Laengenbereich ist ungueltig.");
    }
    if (
      defaultLengthHundredths < minLengthHundredths ||
      defaultLengthHundredths > maxLengthHundredths
    ) {
      throw new Error("Die Vorgabelaenge muss innerhalb des Laengenbereichs liegen.");
    }
    if (
      !Number.isSafeInteger(minQuantity) ||
      !Number.isSafeInteger(maxQuantity) ||
      minQuantity < 1 ||
      maxQuantity < minQuantity
    ) {
      throw new Error("Der Mengenbereich ist ungueltig.");
    }

    await saveRopeConfiguratorSetup(session.shop, {
      minLengthHundredths,
      maxLengthHundredths,
      defaultLengthHundredths,
      minQuantity,
      maxQuantity,
      packageQuantityMetafield: resolveMapping(
        formData.get("packageQuantityMetafieldDefinitionId"),
        variantDefinitions,
        "Menge pro Verpackungseinheit",
      ),
      haspelSurchargeMetafield: resolveMapping(
        formData.get("haspelSurchargeMetafieldDefinitionId"),
        surchargeDefinitions,
        "Haspel-Aufpreis",
      ),
      ropeProductType,
    });

    return { ok: true, message: "Setup wurde gespeichert." };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Setup konnte nicht gespeichert werden.",
    };
  }
};

export default function RopeConfiguratorSetupPage() {
  const { variantDefinitions, surchargeDefinitions, productTypes, config } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const isSubmitting = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) {
      shopify.toast.show(fetcher.data.message, { isError: !fetcher.data.ok });
    }
  }, [fetcher.data, fetcher.state, shopify]);

  return (
    <s-page heading="RopeConfigurator Setup" inlineSize="base">
      <fetcher.Form method="post">
        <s-section heading="Metafeld-Zuordnung">
          <s-stack direction="block" gap="base">
            {variantDefinitions.length === 0 ? (
              <s-banner heading="Kein passendes Metafeld vorhanden" tone="warning">
                Lege zuerst in Shopify eine Varianten-Metafelddefinition vom Typ
                Einzeiliger Text an.
              </s-banner>
            ) : null}

            <s-select
              label="Menge pro Verpackungseinheit"
              name="packageQuantityMetafieldDefinitionId"
              value={selectedMappingValue(config.packageQuantityMetafield, variantDefinitions)}
              disabled={variantDefinitions.length === 0}
            >
              <s-option value={NO_METAFIELD_MAPPING}>Nicht zugeordnet</s-option>
              {variantDefinitions.map((definition) => (
                <s-option key={definition.id} value={mappingOptionValue(definition)}>
                  {definition.name} ({definition.namespace}.{definition.key})
                </s-option>
              ))}
            </s-select>

            <s-select
              label="Haspel-Aufpreis"
              name="haspelSurchargeMetafieldDefinitionId"
              value={selectedMappingValue(config.haspelSurchargeMetafield, surchargeDefinitions)}
            >
              <s-option value={NO_METAFIELD_MAPPING}>Nicht zugeordnet</s-option>
              {surchargeDefinitions.map((definition) => (
                <s-option key={definition.id} value={mappingOptionValue(definition)}>
                  {definition.name} ({definition.namespace}.{definition.key})
                </s-option>
              ))}
            </s-select>

            <s-select
              label="Seil-Produkttyp"
              name="ropeProductType"
              value={config.ropeProductType ?? NO_METAFIELD_MAPPING}
            >
              <s-option value={NO_METAFIELD_MAPPING}>Automatisch: Produkttyp beginnt mit Spezialseil</s-option>
              {productTypes.map((productType) => (
                <s-option key={productType} value={productType}>
                  {productType}
                </s-option>
              ))}
            </s-select>

            <s-paragraph color="subdued">
              Beim Anlegen oder Wiederverwenden einer Zuschnitt-Variante schreibt
              die App den Wert 1 in das zugeordnete Metafeld.
            </s-paragraph>
          </s-stack>
        </s-section>

        <s-section heading="Grenzwerte">
          <s-grid gridTemplateColumns="repeat(2, minmax(0, 1fr))" gap="base">
            <s-number-field label="Minimale Laenge (m)" name="minLengthMeters" min={0.01} step={0.01} value={formatScaledDecimal(config.minLengthHundredths, 2)} required></s-number-field>
            <s-number-field label="Maximale Laenge (m)" name="maxLengthMeters" min={0.01} step={0.01} value={formatScaledDecimal(config.maxLengthHundredths, 2)} required></s-number-field>
            <s-number-field label="Vorgabelaenge (m)" name="defaultLengthMeters" min={0.01} step={0.01} value={formatScaledDecimal(config.defaultLengthHundredths, 2)} required></s-number-field>
            <s-number-field label="Minimale Menge" name="minQuantity" min={1} step={1} value={String(config.minQuantity)} required></s-number-field>
            <s-number-field label="Maximale Menge" name="maxQuantity" min={1} step={1} value={String(config.maxQuantity)} required></s-number-field>
          </s-grid>
        </s-section>

        <s-stack direction="inline" gap="base">
          <s-button
            type="submit"
            variant="primary"
            icon="save"
            loading={isSubmitting}
            disabled={isSubmitting}
          >
            Speichern
          </s-button>
        </s-stack>
      </fetcher.Form>
    </s-page>
  );
}
