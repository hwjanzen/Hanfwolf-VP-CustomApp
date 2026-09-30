UPDATE "RopeConfiguratorSetup"
SET
    "haspelSurchargeMetafieldNamespace" = 'custom',
    "haspelSurchargeMetafieldKey" = 'haspel_surcharge'
WHERE
    "haspelSurchargeMetafieldNamespace" IS NULL
    AND "haspelSurchargeMetafieldKey" IS NULL;
