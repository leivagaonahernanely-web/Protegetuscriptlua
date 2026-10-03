import { describe, expect, it, vi } from "vitest";
import { buildPricesDescription, hasPriceContent, submitPricesForm } from "./prices";

describe("Prices editor contract", () => {
  it("builds Discord-ready sections from editable blocks", () => {
    expect(buildPricesDescription([
      { heading: "Duels Script", details: "$7 USD\n• 700 Robux — Lifetime" },
      { heading: "Lagger", details: "$5 USD" },
    ])).toBe("**Duels Script**\n$7 USD\n• 700 Robux — Lifetime\n\n**Lagger**\n$5 USD");
  });

  it("submits the title and structured description through the mutation contract", () => {
    const mutate = vi.fn();
    expect(submitPricesForm("  Vanta.vs APP  ", [{ heading: "Duels", details: "$7 USD" }], mutate)).toBe(true);
    expect(mutate).toHaveBeenCalledWith({ title: "Vanta.vs APP", description: "**Duels**\n$7 USD" });
  });

  it("ignores empty blocks and requires at least one populated section", () => {
    expect(buildPricesDescription([{ heading: "", details: "" }, { heading: "Payments", details: "PayPal" }])).toBe("**Payments**\nPayPal");
    expect(hasPriceContent([{ heading: "", details: "" }])).toBe(false);
    expect(hasPriceContent([{ heading: "Plans", details: "$7 USD" }])).toBe(true);
  });
});
