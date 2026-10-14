import { describe, expect, it } from "vitest";
import { hasAdminClaim, withAdminClaim } from "../src/utils/admin";

describe("hasAdminClaim", () => {
  it("is true only for admin === true", () => {
    expect(hasAdminClaim({ admin: true })).toBe(true);
    expect(hasAdminClaim({ admin: "true" })).toBe(false);
    expect(hasAdminClaim({ admin: false })).toBe(false);
    expect(hasAdminClaim({})).toBe(false);
  });
});

describe("withAdminClaim", () => {
  it("grants while keeping other claims", () => {
    expect(withAdminClaim({ plan: "pro" }, true)).toEqual({ plan: "pro", admin: true });
    expect(withAdminClaim(undefined, true)).toEqual({ admin: true });
  });

  it("revokes while keeping other claims", () => {
    expect(withAdminClaim({ plan: "pro", admin: true }, false)).toEqual({ plan: "pro" });
    expect(withAdminClaim(undefined, false)).toEqual({});
  });
});
