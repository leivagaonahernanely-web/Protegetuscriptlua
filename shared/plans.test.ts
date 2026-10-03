import { describe, expect, it } from "vitest";
import { PLAN_DEFINITIONS, buildPlansDescription, formatPlanLimit } from "./plans";

describe("plan catalog", () => {
  it("contains the requested Free, Pro and Premium quotas", () => {
    expect(PLAN_DEFINITIONS).toEqual([
      expect.objectContaining({ id: "free", obfuscations: 20, scripts: 6, keys: 500 }),
      expect.objectContaining({ id: "pro", obfuscations: 120, scripts: 15, keys: 5000 }),
      expect.objectContaining({ id: "premium", obfuscations: 1000, scripts: 30, keys: "unlimited" }),
    ]);
  });

  it("renders readable unlimited and numeric limits", () => {
    expect(formatPlanLimit("unlimited")).toBe("Ilimitadas");
    expect(buildPlansDescription()).toContain("**Pro Plan**");
    expect(buildPlansDescription()).toContain("5,000 keys");
  });
});
