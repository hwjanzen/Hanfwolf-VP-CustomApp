ALTER TABLE "RopeConfiguratorSetup" ADD COLUMN "ropeProductType" TEXT;
ALTER TABLE "RopeConfiguratorSetup" DROP COLUMN "ropeEligibilityMetafieldDefinitionId";
ALTER TABLE "RopeConfiguratorSetup" DROP COLUMN "ropeEligibilityMetafieldNamespace";
ALTER TABLE "RopeConfiguratorSetup" DROP COLUMN "ropeEligibilityMetafieldKey";
