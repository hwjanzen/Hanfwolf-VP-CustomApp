import {
  DEFAULT_ROPE_CONFIG,
  type RopeConfiguratorConfig,
} from "./rope-configurator-config";

export type RopeCut = {
  variantId: string;
  quantity: number;
  lengthMeters: string;
  presentation: "Ring" | "Haspel";
};

export type RopeProductCut = {
  productId: string;
  quantity: number;
  lengthMeters: string;
  presentation: "Ring" | "Haspel";
};

export type RopeCartConfiguration =
  | {
      version: "v1";
      variantId: string;
      quantity: number;
      lengthMeters: string;
      presentation: "Ring" | "Haspel";
      unitPrice: string;
    }
  | {
      version: "v2";
      productId: string;
      lengthMeters: string;
      meterPrice: string;
      weightPerMeter: number;
      weightUnit: string;
      unitPrice: string;
    };

type RopeMasterVariantCandidate = {
  id: string;
  sku: string | null;
  ropeConfiguration: { value: string } | null;
  isDefaultConfiguration: { value: string } | null;
};

export type RopeMasterVariantSelection<T extends RopeMasterVariantCandidate> =
  | { ok: true; variant: T; needsMarking: boolean }
  | { ok: false; reason: "multiple_marked" | "missing_or_ambiguous" };

export function isRopeProductType(productType: string) {
  return productType.trim().toLowerCase().startsWith("spezialseil");
}

export function isRopeProduct(
  productType: string,
  configuredProductType: string | null,
) {
  return configuredProductType
    ? productType.trim().toLocaleLowerCase() === configuredProductType.trim().toLocaleLowerCase()
    : isRopeProductType(productType);
}

export function selectRopeMasterVariant<T extends RopeMasterVariantCandidate>(
  variants: T[],
): RopeMasterVariantSelection<T> {
  const markedVariants = variants.filter(
    (variant) => variant.isDefaultConfiguration?.value === "true",
  );
  if (markedVariants.length > 1) {
    return { ok: false, reason: "multiple_marked" };
  }
  if (markedVariants.length === 1) {
    return { ok: true, variant: markedVariants[0], needsMarking: false };
  }

  const candidates = variants.filter(
    (variant) =>
      !variant.ropeConfiguration?.value &&
      !variant.sku?.startsWith("HW-RC-"),
  );
  if (candidates.length !== 1) {
    return { ok: false, reason: "missing_or_ambiguous" };
  }

  return { ok: true, variant: candidates[0], needsMarking: true };
}

function parseScaledDecimal(value: string, decimals: number, label: string) {
  const normalized = value.trim().replace(",", ".");
  const match = normalized.match(new RegExp(`^(\\d+)(?:\\.(\\d{1,${decimals}}))?$`));

  if (!match) {
    throw new Error(`${label} muss eine positive Zahl mit maximal ${decimals} Nachkommastellen sein.`);
  }

  const fraction = (match[2] || "").padEnd(decimals, "0");
  return Number(match[1]) * 10 ** decimals + Number(fraction || "0");
}

type RopeValidationLimits = Pick<
  RopeConfiguratorConfig,
  "minLengthHundredths" | "maxLengthHundredths" | "minQuantity" | "maxQuantity"
>;

function formatHundredths(value: number) {
  return (value / 100).toString().replace(".", ",");
}

export function formatRopeLength(lengthMeters: string) {
  const lengthHundredths = parseScaledDecimal(lengthMeters, 2, "Länge");
  return `${(lengthHundredths / 100).toFixed(2).replace(".", ",")}m`;
}

export function normalizeRopeCuts(
  value: unknown,
  limits: RopeValidationLimits = DEFAULT_ROPE_CONFIG,
): RopeCut[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Mindestens ein Seil-Zuschnitt ist erforderlich.");
  }

  return value.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new Error(`Position ${index + 1} ist ungültig.`);
    }

    const input = item as Record<string, unknown>;
    const variantId = String(input.variantId || "").trim();
    const quantity = Number(input.quantity);
    const lengthMeters = String(input.lengthMeters || "").trim();
    const presentation = String(input.presentation || "Ring");
    const lengthHundredths = parseScaledDecimal(
      lengthMeters,
      2,
      `Länge in Position ${index + 1}`,
    );

    if (!/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(variantId)) {
      throw new Error(`Variant-ID in Position ${index + 1} ist ungültig.`);
    }
    if (
      !Number.isSafeInteger(quantity) ||
      quantity < limits.minQuantity ||
      quantity > limits.maxQuantity
    ) {
      throw new Error(
        `Menge in Position ${index + 1} muss zwischen ${limits.minQuantity} und ${limits.maxQuantity} liegen.`,
      );
    }
    if (
      lengthHundredths < limits.minLengthHundredths ||
      lengthHundredths > limits.maxLengthHundredths
    ) {
      throw new Error(
        `Länge in Position ${index + 1} muss zwischen ${formatHundredths(limits.minLengthHundredths)} und ${formatHundredths(limits.maxLengthHundredths)} m liegen.`,
      );
    }
    if (presentation !== "Ring" && presentation !== "Haspel") {
      throw new Error(`Aufmachung in Position ${index + 1} ist ungültig.`);
    }

    return {
      variantId,
      quantity,
      lengthMeters: (lengthHundredths / 100).toString(),
      presentation,
    };
  });
}

export function normalizeRopeProductCut(
  value: unknown,
  limits: RopeValidationLimits = DEFAULT_ROPE_CONFIG,
): RopeProductCut {
  if (!value || typeof value !== "object") {
    throw new Error("Der Seil-Zuschnitt ist ungültig.");
  }

  const input = value as Record<string, unknown>;
  const productId = String(input.productId || "").trim();
  const quantity = Number(input.quantity);
  const lengthMeters = String(input.lengthMeters || "").trim();
  const presentation = String(input.presentation || "Ring");
  const lengthHundredths = parseScaledDecimal(lengthMeters, 2, "Länge");

  if (!/^gid:\/\/shopify\/Product\/\d+$/.test(productId)) {
    throw new Error("Produkt-ID des Seils ist ungültig.");
  }
  if (
    !Number.isSafeInteger(quantity) ||
    quantity < limits.minQuantity ||
    quantity > limits.maxQuantity
  ) {
    throw new Error(
      `Menge muss zwischen ${limits.minQuantity} und ${limits.maxQuantity} liegen.`,
    );
  }
  if (
    lengthHundredths < limits.minLengthHundredths ||
    lengthHundredths > limits.maxLengthHundredths
  ) {
    throw new Error(
      `Länge muss zwischen ${formatHundredths(limits.minLengthHundredths)} und ${formatHundredths(limits.maxLengthHundredths)} m liegen.`,
    );
  }
  if (presentation !== "Ring" && presentation !== "Haspel") {
    throw new Error("Aufmachung ist ungültig.");
  }

  return {
    productId,
    quantity,
    lengthMeters: (lengthHundredths / 100).toString(),
    presentation,
  };
}

export function calculateRopeUnitPrice(
  meterPrice: string,
  lengthMeters: string,
  surcharge = "0",
) {
  const meterPriceCents = parseScaledDecimal(meterPrice, 2, "Meterpreis");
  const lengthHundredths = parseScaledDecimal(lengthMeters, 2, "Länge");
  const surchargeCents = parseScaledDecimal(surcharge, 2, "Aufpreis");
  const unitPriceCents =
    Math.ceil((meterPriceCents * lengthHundredths) / 100) + surchargeCents;

  return (unitPriceCents / 100).toFixed(2);
}

export function createRopeCartConfigurationKey(
  productId: string,
  lengthMeters: string,
  meterPrice: string,
  weightPerMeter: number,
  weightUnit: string,
  limits: RopeValidationLimits = DEFAULT_ROPE_CONFIG,
) {
  const normalizedCut = normalizeRopeProductCut({
    productId,
    quantity: 1,
    lengthMeters,
    presentation: "Ring",
  }, limits);
  const priceCents = parseScaledDecimal(meterPrice, 2, "Meterpreis");
  if (!Number.isFinite(weightPerMeter) || weightPerMeter <= 0) {
    throw new Error("Das Gewicht pro Meter muss größer als 0 sein.");
  }
  if (!/^(GRAMS|KILOGRAMS|POUNDS|OUNCES)$/.test(weightUnit)) {
    throw new Error("Die Gewichtseinheit wird nicht unterstützt.");
  }

  return [
    "v2",
    normalizedCut.productId,
    normalizedCut.lengthMeters,
    priceCents,
    weightPerMeter.toString(),
    weightUnit,
  ].join("|");
}

export function parseRopeCartConfigurationKey(
  value: string,
  limits: RopeValidationLimits = DEFAULT_ROPE_CONFIG,
): RopeCartConfiguration {
  const [version, ...parts] = value.split("|");

  if (version === "v1") {
    const [variantId, lengthMeters, presentation, priceCents] = parts;
    if (!variantId || !lengthMeters || !presentation || !priceCents) {
      throw new Error("Die Zuschnitt-Variante hat keinen gültigen Konfigurationsschlüssel.");
    }

    const normalizedCut = normalizeRopeCuts([
      {
        variantId,
        quantity: 1,
        lengthMeters,
        presentation,
      },
    ], limits)[0];
    if (!/^\d+$/.test(priceCents)) {
      throw new Error("Die Zuschnitt-Variante hat einen ungültigen Preis.");
    }

    return {
      version: "v1",
      ...normalizedCut,
      unitPrice: (Number(priceCents) / 100).toFixed(2),
    };
  }

  if (version === "v2") {
    const [productId, lengthMeters, priceCents, weightValue, weightUnit] = parts;
    if (!productId || !lengthMeters || !priceCents || !weightValue || !weightUnit) {
      throw new Error("Die Produkt-Zuschnittvariante hat keinen gültigen Konfigurationsschlüssel.");
    }

    const normalizedCut = normalizeRopeProductCut({
      productId,
      quantity: 1,
      lengthMeters,
      presentation: "Ring",
    }, limits);
    if (!/^\d+$/.test(priceCents)) {
      throw new Error("Der Meterpreis im Konfigurationsschlüssel ist ungültig.");
    }
    const meterPrice = (Number(priceCents) / 100).toFixed(2);
    const weightPerMeter = Number(weightValue);
    if (!Number.isFinite(weightPerMeter) || weightPerMeter <= 0) {
      throw new Error("Das Gewicht im Konfigurationsschlüssel ist ungültig.");
    }
    if (!/^(GRAMS|KILOGRAMS|POUNDS|OUNCES)$/.test(weightUnit)) {
      throw new Error("Die Gewichtseinheit im Konfigurationsschlüssel wird nicht unterstützt.");
    }

    return {
      version: "v2",
      productId: normalizedCut.productId,
      lengthMeters: normalizedCut.lengthMeters,
      meterPrice,
      weightPerMeter,
      weightUnit,
      unitPrice: calculateRopeUnitPrice(meterPrice, normalizedCut.lengthMeters),
    };
  }

  throw new Error("Die Version des Zuschnitt-Konfigurationsschlüssels wird nicht unterstützt.");
}

export function calculateRopeUnitWeight(
  weightPerMeter: number,
  lengthMeters: string,
) {
  if (!Number.isFinite(weightPerMeter) || weightPerMeter <= 0) {
    throw new Error("An der Variante muss ein Gewicht pro Meter gepflegt sein.");
  }

  const lengthHundredths = parseScaledDecimal(lengthMeters, 2, "Länge");
  return Number((weightPerMeter * (lengthHundredths / 100)).toFixed(6));
}

export function convertWeightToKilograms(value: number, unit: string) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Das Gewicht ist ungültig.");
  }

  switch (unit) {
    case "KILOGRAMS":
      return value;
    case "GRAMS":
      return value / 1000;
    case "POUNDS":
      return value * 0.45359237;
    case "OUNCES":
      return value * 0.028349523125;
    default:
      throw new Error(`Nicht unterstützte Gewichtseinheit: ${unit}.`);
  }
}