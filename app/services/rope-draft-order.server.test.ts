import { describe, expect, it } from "vitest";
import {
  createRopeCartConfigurationKey,
  calculateRopeUnitPrice,
  calculateRopeUnitWeight,
  convertWeightToKilograms,
  isRopeProduct,
  isRopeProductType,
  normalizeRopeCuts,
  parseRopeCartConfigurationKey,
  selectRopeMasterVariant,
} from "./rope-draft-order.server";

describe("rope draft order pricing", () => {
  it("recognizes singular and plural specialty-rope product types", () => {
    expect(isRopeProductType("Spezialseil")).toBe(true);
    expect(isRopeProductType("Spezialseile")).toBe(true);
    expect(isRopeProductType("Anschlagkette")).toBe(false);
  });

  it("uses the explicitly marked master variant when present", () => {
    const master = {
      id: "gid://shopify/ProductVariant/1",
      sku: "METER-1M",
      ropeConfiguration: null,
      isDefaultConfiguration: { value: "true" },
    };
    const generated = {
      id: "gid://shopify/ProductVariant/2",
      sku: "HW-RC-123",
      ropeConfiguration: { value: "v2|..." },
      isDefaultConfiguration: null,
    };

    expect(selectRopeMasterVariant([master, generated])).toEqual({
      ok: true,
      variant: master,
      needsMarking: false,
    });
  });

  it("marks a sole non-app variant as master and rejects ambiguous candidates", () => {
    const master = {
      id: "gid://shopify/ProductVariant/1",
      sku: null,
      ropeConfiguration: null,
      isDefaultConfiguration: null,
    };
    const generated = {
      id: "gid://shopify/ProductVariant/2",
      sku: "HW-RC-123",
      ropeConfiguration: { value: "v2|..." },
      isDefaultConfiguration: null,
    };

    expect(selectRopeMasterVariant([master, generated])).toEqual({
      ok: true,
      variant: master,
      needsMarking: true,
    });
    expect(selectRopeMasterVariant([master, { ...master, id: "gid://shopify/ProductVariant/3" }])).toEqual({
      ok: false,
      reason: "missing_or_ambiguous",
    });
    expect(
      selectRopeMasterVariant([
        { ...master, isDefaultConfiguration: { value: "true" } },
        { ...master, id: "gid://shopify/ProductVariant/4", isDefaultConfiguration: { value: "true" } },
      ]),
    ).toEqual({ ok: false, reason: "multiple_marked" });
  });

  it("rounds each configured rope up to full cents", () => {
    expect(calculateRopeUnitPrice("2.90", "12")).toBe("34.80");
    expect(calculateRopeUnitPrice("2.90", "1,3")).toBe("3.77");
    expect(calculateRopeUnitPrice("2.90", "7.75")).toBe("22.48");
    expect(calculateRopeUnitPrice("2.90", "7.75", "4.50")).toBe("26.98");
  });

  it("creates the same cart configuration key for equivalent decimal input", () => {
    expect(
      createRopeCartConfigurationKey(
        "gid://shopify/Product/123",
        "1,30",
        "10.00",
        0.35,
        "KILOGRAMS",
      ),
    ).toBe(
      createRopeCartConfigurationKey(
        "gid://shopify/Product/123",
        "1.3",
        "10",
        0.35,
        "KILOGRAMS",
      ),
    );
  });

  it("parses a product-based configuration with a price and weight snapshot", () => {
    expect(
      parseRopeCartConfigurationKey(
        createRopeCartConfigurationKey(
          "gid://shopify/Product/123",
          "1.3",
          "10.00",
          0.35,
          "KILOGRAMS",
        ),
      ),
    ).toEqual({
      version: "v2",
      productId: "gid://shopify/Product/123",
      lengthMeters: "1.3",
      meterPrice: "10.00",
      weightPerMeter: 0.35,
      weightUnit: "KILOGRAMS",
      unitPrice: "13.00",
    });
  });

  it("creates a new configuration key when the master price or weight changes", () => {
    const baseline = createRopeCartConfigurationKey(
      "gid://shopify/Product/123",
      "2.5",
      "10.00",
      0.35,
      "KILOGRAMS",
    );

    expect(
      createRopeCartConfigurationKey(
        "gid://shopify/Product/123",
        "2.5",
        "10.01",
        0.35,
        "KILOGRAMS",
      ),
    ).not.toBe(baseline);
    expect(
      createRopeCartConfigurationKey(
        "gid://shopify/Product/123",
        "2.5",
        "10.00",
        0.36,
        "KILOGRAMS",
      ),
    ).not.toBe(baseline);
  });

  it("continues to parse legacy v1 cart configurations", () => {
    expect(
      parseRopeCartConfigurationKey(
        "v1|gid://shopify/ProductVariant/123|1.3|Haspel|827",
      ),
    ).toEqual({
      version: "v1",
      variantId: "gid://shopify/ProductVariant/123",
      quantity: 1,
      lengthMeters: "1.3",
      presentation: "Haspel",
      unitPrice: "8.27",
    });
  });

  it("calculates the weight of each configured rope from weight per meter", () => {
    expect(calculateRopeUnitWeight(0.35, "12")).toBe(4.2);
    expect(calculateRopeUnitWeight(0.35, "1.3")).toBe(0.455);
    expect(calculateRopeUnitWeight(0.35, "7.75")).toBe(2.7125);
  });

  it("rejects variants without a positive weight per meter", () => {
    expect(() => calculateRopeUnitWeight(0, "12")).toThrow(
      "Gewicht pro Meter",
    );
  });

  it("normalizes Shopify weight units to kilograms", () => {
    expect(convertWeightToKilograms(350, "GRAMS")).toBe(0.35);
    expect(convertWeightToKilograms(0.35, "KILOGRAMS")).toBe(0.35);
    expect(convertWeightToKilograms(1, "POUNDS")).toBeCloseTo(0.45359237);
    expect(convertWeightToKilograms(1, "OUNCES")).toBeCloseTo(0.028349523125);
  });

  it("normalizes valid cuts", () => {
    expect(
      normalizeRopeCuts([
        {
          variantId: "gid://shopify/ProductVariant/123",
          quantity: 3,
          lengthMeters: "12,00",
          presentation: "Ring",
        },
      ]),
    ).toEqual([
      {
        variantId: "gid://shopify/ProductVariant/123",
        quantity: 3,
        lengthMeters: "12",
        presentation: "Ring",
      },
    ]);
  });

  it("rejects lengths outside the supported range", () => {
    expect(() =>
      normalizeRopeCuts([
        {
          variantId: "gid://shopify/ProductVariant/123",
          quantity: 1,
          lengthMeters: "0.49",
          presentation: "Ring",
        },
      ]),
    ).toThrow("zwischen 0,5 und 500 m");
  });

  it("uses configured length and quantity limits", () => {
    const limits = {
      minLengthHundredths: 100,
      maxLengthHundredths: 100_000,
      minQuantity: 2,
      maxQuantity: 20,
    };

    expect(
      normalizeRopeCuts([
        {
          variantId: "gid://shopify/ProductVariant/123",
          quantity: 2,
          lengthMeters: "750",
          presentation: "Ring",
        },
      ], limits)[0].lengthMeters,
    ).toBe("750");
  });

  it("uses the configured Shopify product type", () => {
    expect(isRopeProduct("Spezialseile", "Spezialseile")).toBe(true);
    expect(isRopeProduct("Andere Seile", "Spezialseile")).toBe(false);
    expect(isRopeProduct("Spezialseil", null)).toBe(true);
  });
});