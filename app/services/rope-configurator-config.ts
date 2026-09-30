export type MetafieldMapping = {
  definitionId: string;
  namespace: string;
  key: string;
};

export type RopeShippingTier = {
  maxWeightGrams: number | null;
  priceCents: number;
};

export type RopeConfiguratorConfig = {
  minLengthHundredths: number;
  maxLengthHundredths: number;
  defaultLengthHundredths: number;
  minQuantity: number;
  maxQuantity: number;
  shippingTiers: RopeShippingTier[];
  packageQuantityMetafield: MetafieldMapping | null;
  haspelSurchargeMetafield: MetafieldMapping | null;
  ropeEligibilityMetafield: MetafieldMapping | null;
};

export const DEFAULT_ROPE_SHIPPING_TIERS: RopeShippingTier[] = [
  { maxWeightGrams: 10_000, priceCents: 1_500 },
  { maxWeightGrams: 50_000, priceCents: 3_000 },
  { maxWeightGrams: 200_000, priceCents: 5_000 },
  { maxWeightGrams: null, priceCents: 15_000 },
];

export const DEFAULT_ROPE_CONFIG: RopeConfiguratorConfig = {
  minLengthHundredths: 50,
  maxLengthHundredths: 50_000,
  defaultLengthHundredths: 100,
  minQuantity: 1,
  maxQuantity: 999,
  shippingTiers: DEFAULT_ROPE_SHIPPING_TIERS,
  packageQuantityMetafield: null,
  haspelSurchargeMetafield: {
    definitionId: "",
    namespace: "custom",
    key: "haspel_surcharge",
  },
  ropeEligibilityMetafield: null,
};

export function parseShippingTiers(value: string | null | undefined) {
  if (!value) return DEFAULT_ROPE_SHIPPING_TIERS;

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) return DEFAULT_ROPE_SHIPPING_TIERS;

    const tiers = parsed.map((tier, index) => {
      if (!tier || typeof tier !== "object") throw new Error("invalid tier");
      const input = tier as Record<string, unknown>;
      const maxWeightGrams = input.maxWeightGrams === null ? null : Number(input.maxWeightGrams);
      const priceCents = Number(input.priceCents);
      if (
        (maxWeightGrams !== null && (!Number.isSafeInteger(maxWeightGrams) || maxWeightGrams <= 0)) ||
        (maxWeightGrams === null && index !== parsed.length - 1) ||
        !Number.isSafeInteger(priceCents) ||
        priceCents < 0
      ) {
        throw new Error("invalid tier values");
      }
      return { maxWeightGrams, priceCents };
    });

    if (tiers.at(-1)?.maxWeightGrams !== null) return DEFAULT_ROPE_SHIPPING_TIERS;
    for (let index = 1; index < tiers.length - 1; index += 1) {
      if (tiers[index - 1].maxWeightGrams! >= tiers[index].maxWeightGrams!) {
        return DEFAULT_ROPE_SHIPPING_TIERS;
      }
    }
    return tiers;
  } catch {
    return DEFAULT_ROPE_SHIPPING_TIERS;
  }
}
