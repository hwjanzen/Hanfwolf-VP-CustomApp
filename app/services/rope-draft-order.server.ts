import {
  DEFAULT_ROPE_CONFIG,
  type RopeConfiguratorConfig,
  type RopeShippingTier,
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
  eligibilityMetafield: { value: string } | null | undefined,
  hasEligibilityMapping: boolean,
) {
  return hasEligibilityMapping
    ? eligibilityMetafield?.value === "true"
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

export function normalizeRopeCuts(
  value: unknown,
  limits: RopeValidationLimits = DEFAULT_ROPE_CONFIG,
): RopeCut[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Mindestens ein Seil-Zuschnitt ist erforderlich.");
  }

  return value.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new Error(`Position ${index + 1} ist ungueltig.`);
    }

    const input = item as Record<string, unknown>;
    const variantId = String(input.variantId || "").trim();
    const quantity = Number(input.quantity);
    const lengthMeters = String(input.lengthMeters || "").trim();
    const presentation = String(input.presentation || "Ring");
    const lengthHundredths = parseScaledDecimal(
      lengthMeters,
      2,
      `Laenge in Position ${index + 1}`,
    );

    if (!/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(variantId)) {
      throw new Error(`Variant-ID in Position ${index + 1} ist ungueltig.`);
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
        `Laenge in Position ${index + 1} muss zwischen ${formatHundredths(limits.minLengthHundredths)} und ${formatHundredths(limits.maxLengthHundredths)} m liegen.`,
      );
    }
    if (presentation !== "Ring" && presentation !== "Haspel") {
      throw new Error(`Aufmachung in Position ${index + 1} ist ungueltig.`);
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
    throw new Error("Der Seil-Zuschnitt ist ungueltig.");
  }

  const input = value as Record<string, unknown>;
  const productId = String(input.productId || "").trim();
  const quantity = Number(input.quantity);
  const lengthMeters = String(input.lengthMeters || "").trim();
  const presentation = String(input.presentation || "Ring");
  const lengthHundredths = parseScaledDecimal(lengthMeters, 2, "Laenge");

  if (!/^gid:\/\/shopify\/Product\/\d+$/.test(productId)) {
    throw new Error("Produkt-ID des Seils ist ungueltig.");
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
      `Laenge muss zwischen ${formatHundredths(limits.minLengthHundredths)} und ${formatHundredths(limits.maxLengthHundredths)} m liegen.`,
    );
  }
  if (presentation !== "Ring" && presentation !== "Haspel") {
    throw new Error("Aufmachung ist ungueltig.");
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
  const lengthHundredths = parseScaledDecimal(lengthMeters, 2, "Laenge");
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
    throw new Error("Das Gewicht pro Meter muss groesser als 0 sein.");
  }
  if (!/^(GRAMS|KILOGRAMS|POUNDS|OUNCES)$/.test(weightUnit)) {
    throw new Error("Die Gewichtseinheit wird nicht unterstuetzt.");
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
      throw new Error("Die Zuschnitt-Variante hat keinen gueltigen Konfigurationsschluessel.");
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
      throw new Error("Die Zuschnitt-Variante hat einen ungueltigen Preis.");
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
      throw new Error("Die Produkt-Zuschnittvariante hat keinen gueltigen Konfigurationsschluessel.");
    }

    const normalizedCut = normalizeRopeProductCut({
      productId,
      quantity: 1,
      lengthMeters,
      presentation: "Ring",
    }, limits);
    if (!/^\d+$/.test(priceCents)) {
      throw new Error("Der Meterpreis im Konfigurationsschluessel ist ungueltig.");
    }
    const meterPrice = (Number(priceCents) / 100).toFixed(2);
    const weightPerMeter = Number(weightValue);
    if (!Number.isFinite(weightPerMeter) || weightPerMeter <= 0) {
      throw new Error("Das Gewicht im Konfigurationsschluessel ist ungueltig.");
    }
    if (!/^(GRAMS|KILOGRAMS|POUNDS|OUNCES)$/.test(weightUnit)) {
      throw new Error("Die Gewichtseinheit im Konfigurationsschluessel wird nicht unterstuetzt.");
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

  throw new Error("Die Version des Zuschnitt-Konfigurationsschluessels wird nicht unterstuetzt.");
}

export function calculateRopeUnitWeight(
  weightPerMeter: number,
  lengthMeters: string,
) {
  if (!Number.isFinite(weightPerMeter) || weightPerMeter <= 0) {
    throw new Error("An der Variante muss ein Gewicht pro Meter gepflegt sein.");
  }

  const lengthHundredths = parseScaledDecimal(lengthMeters, 2, "Laenge");
  return Number((weightPerMeter * (lengthHundredths / 100)).toFixed(6));
}

export function calculateRopeShippingPrice(
  totalWeightKilograms: number,
  tiers: RopeShippingTier[] = DEFAULT_ROPE_CONFIG.shippingTiers,
) {
  if (!Number.isFinite(totalWeightKilograms) || totalWeightKilograms <= 0) {
    throw new Error("Das Gesamtgewicht muss groesser als 0 kg sein.");
  }

  const totalWeightGrams = totalWeightKilograms * 1000;
  const tier = tiers.find(
    (candidate) =>
      candidate.maxWeightGrams === null || totalWeightGrams <= candidate.maxWeightGrams,
  );
  if (!tier) {
    throw new Error("Fuer das Gesamtgewicht ist keine Versandstaffel konfiguriert.");
  }
  return (tier.priceCents / 100).toFixed(2);
}

export function convertWeightToKilograms(value: number, unit: string) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Das Gewicht ist ungueltig.");
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
      throw new Error(`Nicht unterstuetzte Gewichtseinheit: ${unit}.`);
  }
}