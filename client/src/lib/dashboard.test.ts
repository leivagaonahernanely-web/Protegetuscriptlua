import { describe, expect, it } from "vitest";
import { dashboardNavItems, getDashboardNavLabels, getOverviewCopy } from "./dashboard";

describe("dashboard navigation contract", () => {
  it("contains each workspace destination once", () => {
    const labels = getDashboardNavLabels();
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).toEqual([
      "Overview",
      "Scripts",
      "Obfuscator",
      "API key",
      "License keys",
      "Plan keys",
      "HWID bans",
      "Logs",
      "Plans",
      "Create New Panel",
      "Manage Panels",
      "Prices",
      "Updates",
      "Published TXT",
    ]);
  });

  it("keeps administrative destinations outside Overview", () => {
    expect(dashboardNavItems.find((item) => item.label === "Overview")?.group).toBe("Workspace");
    expect(dashboardNavItems.filter((item) => item.group !== "Workspace").map((item) => item.label)).not.toContain("Overview");
  });

  it("exposes only informational Overview copy", () => {
    expect(getOverviewCopy()).toEqual({
      title: "Vanta.vs Protector",
      description: "Protección y entrega controlada de scripts Lua.",
      purpose: "Protección, alojamiento y control de acceso para scripts Lua.",
    });
  });
});
