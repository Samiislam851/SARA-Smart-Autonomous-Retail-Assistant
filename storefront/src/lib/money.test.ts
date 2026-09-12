import { describe, expect, it } from "vitest";
import { minorUnitsToPriceInput, parsePriceToMinorUnits } from "./money";

describe("parsePriceToMinorUnits", () => {
  it("parses a plain decimal amount", () => {
    expect(parsePriceToMinorUnits("19.99", "USD")).toBe(1999);
  });

  it("parses a whole-dollar amount with no decimal point", () => {
    expect(parsePriceToMinorUnits("20", "USD")).toBe(2000);
  });

  it("parses a single decimal digit as the tenths place", () => {
    expect(parsePriceToMinorUnits("19.9", "USD")).toBe(1990);
  });

  it("parses zero", () => {
    expect(parsePriceToMinorUnits("0", "USD")).toBe(0);
    expect(parsePriceToMinorUnits("0.00", "USD")).toBe(0);
  });

  it("avoids classic float drift (19.99 * 100 !== 1999 in naive float math)", () => {
    // Sanity check the failure mode this function exists to avoid.
    expect(19.99 * 100).not.toBe(1999);
    expect(parsePriceToMinorUnits("19.99", "USD")).toBe(1999);
  });

  it("handles a large price without losing precision", () => {
    expect(parsePriceToMinorUnits("123456.78", "USD")).toBe(12345678);
  });

  it("strips leading zeros", () => {
    expect(parsePriceToMinorUnits("007.50", "USD")).toBe(750);
  });

  it("rejects a negative amount", () => {
    expect(parsePriceToMinorUnits("-5.00", "USD")).toBeNull();
  });

  it("rejects too many decimal places for a 2-exponent currency", () => {
    expect(parsePriceToMinorUnits("19.999", "USD")).toBeNull();
  });

  it("rejects non-numeric input", () => {
    expect(parsePriceToMinorUnits("abc", "USD")).toBeNull();
    expect(parsePriceToMinorUnits("NaN", "USD")).toBeNull();
    expect(parsePriceToMinorUnits("Infinity", "USD")).toBeNull();
    expect(parsePriceToMinorUnits("1e10", "USD")).toBeNull();
  });

  it("rejects empty/whitespace input", () => {
    expect(parsePriceToMinorUnits("", "USD")).toBeNull();
    expect(parsePriceToMinorUnits("   ", "USD")).toBeNull();
  });

  it("handles a zero-exponent currency (JPY): rejects any decimal point", () => {
    expect(parsePriceToMinorUnits("1000", "JPY")).toBe(1000);
    expect(parsePriceToMinorUnits("1000.00", "JPY")).toBeNull();
  });

  it("handles a 3-exponent currency (BHD)", () => {
    expect(parsePriceToMinorUnits("1.234", "BHD")).toBe(1234);
    expect(parsePriceToMinorUnits("1.2345", "BHD")).toBeNull();
  });
});

describe("minorUnitsToPriceInput", () => {
  it("formats a plain amount", () => {
    expect(minorUnitsToPriceInput(1999, "USD")).toBe("19.99");
  });

  it("pads a sub-dollar amount with a leading zero", () => {
    expect(minorUnitsToPriceInput(5, "USD")).toBe("0.05");
  });

  it("formats zero", () => {
    expect(minorUnitsToPriceInput(0, "USD")).toBe("0.00");
  });

  it("formats a zero-exponent currency with no decimal point", () => {
    expect(minorUnitsToPriceInput(1000, "JPY")).toBe("1000");
  });

  it("round-trips through parsePriceToMinorUnits", () => {
    for (const amount of [0, 1, 50, 1999, 123456, 999999]) {
      const asInput = minorUnitsToPriceInput(amount, "USD");
      expect(parsePriceToMinorUnits(asInput, "USD")).toBe(amount);
    }
  });
});
