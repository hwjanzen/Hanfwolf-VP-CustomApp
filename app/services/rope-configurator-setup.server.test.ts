import { beforeEach, describe, expect, it, vi } from "vitest";

const { findUnique, adminGraphql } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  adminGraphql: vi.fn(),
}));

vi.mock("../db.server", () => ({
  default: {
    ropeConfiguratorSetup: {
      findUnique,
    },
  },
}));

vi.mock("./shopify-graphql.server", () => ({ adminGraphql }));

import { setPackageQuantityForVariant } from "./rope-configurator-setup.server";

describe("Rope Configurator setup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not write a metafield when no mapping is configured", async () => {
    findUnique.mockResolvedValue(null);

    await expect(
      setPackageQuantityForVariant({}, "shop.myshopify.com", "gid://shopify/ProductVariant/1"),
    ).resolves.toBe("not_configured");
    expect(adminGraphql).not.toHaveBeenCalled();
  });

  it("writes the mapped package quantity with value one", async () => {
    findUnique.mockResolvedValue({
      shop: "shop.myshopify.com",
      packageQuantityMetafieldDefinitionId: "gid://shopify/MetafieldDefinition/1",
      packageQuantityMetafieldNamespace: "custom",
      packageQuantityMetafieldKey: "package_quantity",
      updatedAt: new Date(),
    });
    adminGraphql.mockResolvedValue({
      ok: true,
      data: {
        metafieldsSet: {
          metafields: [{ id: "gid://shopify/Metafield/1", value: "1" }],
          userErrors: [],
        },
      },
    });

    await expect(
      setPackageQuantityForVariant({}, "shop.myshopify.com", "gid://shopify/ProductVariant/2"),
    ).resolves.toBe("set");
    expect(adminGraphql).toHaveBeenCalledWith(
      {},
      expect.stringContaining("mutation SetRopePackageQuantity"),
      {
        metafields: [
          {
            ownerId: "gid://shopify/ProductVariant/2",
            namespace: "custom",
            key: "package_quantity",
            type: "single_line_text_field",
            value: "1",
          },
        ],
      },
    );
  });
});
