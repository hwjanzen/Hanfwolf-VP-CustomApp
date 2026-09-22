import { describe, expect, it } from "vitest";
import {
  calculateRopeShippingPrice,
  calculateRopeUnitPrice,
  calculateRopeUnitWeight,
  convertWeightToKilograms,
  normalizeRopeCuts,
} from "./rope-draft-order.server";

describe("rope draft order pricing", () => {
  it("rounds each configured rope up to full cents", () => {
    expect(calculateRopeUnitPrice("2.90", "12")).toBe("34.80");
    expect(calculateRopeUnitPrice("2.90", "1,3")).toBe("3.77");
    expect(calculateRopeUnitPrice("2.90", "7.75")).toBe("22.48");
    expect(calculateRopeUnitPrice("2.90", "7.75", "4.50")).toBe("26.98");
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

  it("selects shipping by total order weight", () => {
    expect(calculateRopeShippingPrice(10)).toBe("15.00");
    expect(calculateRopeShippingPrice(10.0001)).toBe("30.00");
    expect(calculateRopeShippingPrice(50)).toBe("30.00");
    expect(calculateRopeShippingPrice(50.0001)).toBe("50.00");
    expect(calculateRopeShippingPrice(200)).toBe("50.00");
    expect(calculateRopeShippingPrice(200.0001)).toBe("150.00");
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
});