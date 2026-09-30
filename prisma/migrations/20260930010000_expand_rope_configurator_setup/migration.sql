PRAGMA foreign_keys=OFF;

CREATE TABLE "new_RopeConfiguratorSetup" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "packageQuantityMetafieldDefinitionId" TEXT,
    "packageQuantityMetafieldNamespace" TEXT,
    "packageQuantityMetafieldKey" TEXT,
    "haspelSurchargeMetafieldDefinitionId" TEXT,
    "haspelSurchargeMetafieldNamespace" TEXT,
    "haspelSurchargeMetafieldKey" TEXT,
    "ropeEligibilityMetafieldDefinitionId" TEXT,
    "ropeEligibilityMetafieldNamespace" TEXT,
    "ropeEligibilityMetafieldKey" TEXT,
    "minLengthHundredths" INTEGER NOT NULL DEFAULT 50,
    "maxLengthHundredths" INTEGER NOT NULL DEFAULT 50000,
    "defaultLengthHundredths" INTEGER NOT NULL DEFAULT 100,
    "minQuantity" INTEGER NOT NULL DEFAULT 1,
    "maxQuantity" INTEGER NOT NULL DEFAULT 999,
    "shippingTiersJson" TEXT NOT NULL DEFAULT '[{"maxWeightGrams":10000,"priceCents":1500},{"maxWeightGrams":50000,"priceCents":3000},{"maxWeightGrams":200000,"priceCents":5000},{"maxWeightGrams":null,"priceCents":15000}]',
    "updatedAt" DATETIME NOT NULL
);

INSERT INTO "new_RopeConfiguratorSetup" (
    "shop",
    "packageQuantityMetafieldDefinitionId",
    "packageQuantityMetafieldNamespace",
    "packageQuantityMetafieldKey",
    "updatedAt"
)
SELECT
    "shop",
    "packageQuantityMetafieldDefinitionId",
    "packageQuantityMetafieldNamespace",
    "packageQuantityMetafieldKey",
    "updatedAt"
FROM "RopeConfiguratorSetup";

DROP TABLE "RopeConfiguratorSetup";
ALTER TABLE "new_RopeConfiguratorSetup" RENAME TO "RopeConfiguratorSetup";

PRAGMA foreign_keys=ON;
