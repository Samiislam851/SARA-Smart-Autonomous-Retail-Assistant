import { describe, expect, it } from "vitest";
import { formatPrice } from "./format";

describe("formatPrice", () => {
  it("formats whole dollars and cents", () => {
    expect(formatPrice(1999, "USD")).toBe("$19.99");
  });

  it("formats zero", () => {
    expect(formatPrice(0, "USD")).toBe("$0.00");
  });

  it("formats a single cent", () => {
    expect(formatPrice(1, "USD")).toBe("$0.01");
  });

  it("formats amounts over one thousand with a grouping separator", () => {
    expect(formatPrice(123456, "USD")).toBe("$1,234.56");
  });

  it("formats a zero-decimal currency (JPY) without minor units", () => {
    expect(formatPrice(1000, "JPY")).toBe("¥1,000");
  });

  it("throws on a non-integer amount", () => {
    expect(() => formatPrice(19.99, "USD")).toThrow(TypeError);
  });
});
