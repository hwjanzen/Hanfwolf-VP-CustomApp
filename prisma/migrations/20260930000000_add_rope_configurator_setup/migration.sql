-- CreateTable
CREATE TABLE "RopeConfiguratorSetup" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "packageQuantityMetafieldDefinitionId" TEXT NOT NULL,
    "packageQuantityMetafieldNamespace" TEXT NOT NULL,
    "packageQuantityMetafieldKey" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);
