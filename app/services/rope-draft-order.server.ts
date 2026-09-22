export type RopeCut = {
  variantId: string;
  quantity: number;
  lengthMeters: string;
  presentation: "Ring" | "Haspel";
};

function parseScaledDecimal(value: string, decimals: number, label: string) {
  const normalized = value.trim().replace(",", ".");
  const match = normalized.match(new RegExp(`^(\\d+)(?:\\.(\\d{1,${decimals}}))?$`));

  if (!match) {
    throw new Error(`${label} muss eine positive Zahl mit maximal ${decimals} Nachkommastellen sein.`);
  }

  const fraction = (match[2] || "").padEnd(decimals, "0");
  return Number(match[1]) * 10 ** decimals + Number(fraction || "0");
}

export function normalizeRopeCuts(value: unknown): RopeCut[] {
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
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 999) {
      throw new Error(`Menge in Position ${index + 1} muss zwischen 1 und 999 liegen.`);
    }
    if (lengthHundredths < 50 || lengthHundredths > 50_000) {
      throw new Error(`Laenge in Position ${index + 1} muss zwischen 0,5 und 500 m liegen.`);
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

export function calculateRopeShippingPrice(totalWeightKilograms: number) {
  if (!Number.isFinite(totalWeightKilograms) || totalWeightKilograms <= 0) {
    throw new Error("Das Gesamtgewicht muss groesser als 0 kg sein.");
  }

  if (totalWeightKilograms <= 10) return "15.00";
  if (totalWeightKilograms <= 50) return "30.00";
  if (totalWeightKilograms <= 200) return "50.00";
  return "150.00";
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