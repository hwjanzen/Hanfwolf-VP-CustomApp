export type MetafieldMapping = {
  definitionId: string;
  namespace: string;
  key: string;
};

export type RopeConfiguratorConfig = {
  minLengthHundredths: number;
  maxLengthHundredths: number;
  defaultLengthHundredths: number;
  minQuantity: number;
  maxQuantity: number;
  packageQuantityMetafield: MetafieldMapping | null;
  haspelSurchargeMetafield: MetafieldMapping | null;
  ropeProductType: string | null;
};

export const DEFAULT_ROPE_CONFIG: RopeConfiguratorConfig = {
  minLengthHundredths: 50,
  maxLengthHundredths: 50_000,
  defaultLengthHundredths: 100,
  minQuantity: 1,
  maxQuantity: 999,
  packageQuantityMetafield: null,
  haspelSurchargeMetafield: {
    definitionId: "",
    namespace: "custom",
    key: "haspel_surcharge",
  },
  ropeProductType: null,
};
