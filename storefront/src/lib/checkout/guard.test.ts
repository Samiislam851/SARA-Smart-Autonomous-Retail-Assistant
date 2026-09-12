import { describe, expect, it } from "vitest";
import { isCheckoutStep, requiredStepFor } from "./guard";

describe("isCheckoutStep", () => {
  it("accepts the 4 real steps", () => {
    expect(isCheckoutStep("address")).toBe(true);
    expect(isCheckoutStep("delivery")).toBe(true);
    expect(isCheckoutStep("payment")).toBe(true);
    expect(isCheckoutStep("review")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isCheckoutStep("checkout")).toBe(false);
    expect(isCheckoutStep("")).toBe(false);
    expect(isCheckoutStep("Address")).toBe(false);
  });
});

describe("requiredStepFor", () => {
  it("always allows address, regardless of what's missing", () => {
    expect(requiredStepFor("address", false, false)).toBeNull();
  });

  it("sends delivery/payment/review back to address when there is none", () => {
    expect(requiredStepFor("delivery", false, false)).toBe("address");
    expect(requiredStepFor("payment", false, false)).toBe("address");
    expect(requiredStepFor("review", false, false)).toBe("address");
  });

  it("allows delivery once there's an address", () => {
    expect(requiredStepFor("delivery", true, false)).toBeNull();
  });

  it("sends payment/review back to delivery when there's an address but no delivery method", () => {
    expect(requiredStepFor("payment", true, false)).toBe("delivery");
    expect(requiredStepFor("review", true, false)).toBe("delivery");
  });

  it("allows payment and review once both address and delivery are set", () => {
    expect(requiredStepFor("payment", true, true)).toBeNull();
    expect(requiredStepFor("review", true, true)).toBeNull();
  });
});
