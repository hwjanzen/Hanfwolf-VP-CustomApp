import { describe, expect, it } from "vitest";
import {
  isDateInRangeISO,
  normalizeCompanyId,
  normalizeHeaderId,
  normalizeProductId,
  normalizeVariantId,
  parsePriceListLines,
  pickWinningLine,
} from "./price-resolver.server";

describe("ID normalization", () => {
  it("normalizes numeric company id to GID", () => {
    expect(normalizeCompanyId("20636336463")).toBe(
      "gid://shopify/Company/20636336463",
    );
  });

  it("normalizes numeric variant id to GID", () => {
    expect(normalizeVariantId("58365144793423")).toBe(
      "gid://shopify/ProductVariant/58365144793423",
    );
  });

  it("normalizes numeric header id to GID", () => {
    expect(normalizeHeaderId("536372248911")).toBe(
      "gid://shopify/Metaobject/536372248911",
    );
  });

  it("normalizes numeric product id to GID", () => {
    expect(normalizeProductId("88990011")).toBe(
      "gid://shopify/Product/88990011",
    );
  });
});

describe("Date validity", () => {
  it("includes date boundaries", () => {
    expect(isDateInRangeISO("2026-08-01", "2026-08-01", "2026-12-31")).toBe(
      true,
    );
    expect(isDateInRangeISO("2026-12-31", "2026-08-01", "2026-12-31")).toBe(
      true,
    );
  });

  it("returns false outside range", () => {
    expect(isDateInRangeISO("2027-01-01", "2026-08-01", "2026-12-31")).toBe(
      false,
    );
  });
});

describe("Price line parsing and tier selection", () => {
  const headerId = "gid://shopify/Metaobject/536372248911";
  const productId = "gid://shopify/Product/88990011";
  const variantId = "gid://shopify/ProductVariant/58365144793423";

  const lines = parsePriceListLines([
    {
      id: "gid://shopify/Metaobject/1",
      headerField: { reference: { id: headerId } },
      variantField: { reference: { id: variantId } },
      quantityField: { value: "1" },
      unitPriceField: { value: "9" },
    },
    {
      id: "gid://shopify/Metaobject/2",
      headerField: { reference: { id: headerId } },
      variantField: { reference: { id: variantId } },
      quantityField: { value: "10" },
      unitPriceField: { value: "8.5" },
    },
    {
      id: "gid://shopify/Metaobject/3",
      headerField: { reference: { id: headerId } },
      productField: { reference: { id: productId } },
      quantityField: { value: "1" },
      unitPriceField: { value: "590" },
    },
  ]);

  it("keeps valid lines", () => {
    expect(lines).toHaveLength(3);
  });

  it("selects highest quantity tier that is <= requested quantity", () => {
    const lineFor9 = pickWinningLine({
      lines,
      headerId,
      variantId,
      quantity: 9,
      isHeaderValid: true,
    });

    const lineFor12 = pickWinningLine({
      lines,
      headerId,
      variantId,
      quantity: 12,
      isHeaderValid: true,
    });

    expect(lineFor9?.quantity).toBe(1);
    expect(lineFor12?.quantity).toBe(10);
  });

  it("returns null when header is not valid", () => {
    const result = pickWinningLine({
      lines,
      headerId,
      variantId,
      quantity: 20,
      isHeaderValid: false,
    });

    expect(result).toBeNull();
  });

  it("matches product-based line when variant line is empty", () => {
    const result = pickWinningLine({
      lines,
      headerId,
      productId,
      quantity: 2,
      isHeaderValid: true,
    });

    expect(result?.productId).toBe(productId);
    expect(result?.variantId).toBe("");
    expect(result?.unitPrice).toBe(590);
  });
});
