import { describe, expect, it, vi } from "vitest";
import { buildUpdatesPayload, hasUpdatesContent, submitUpdatesForm } from "./updates";

describe("Updates editor contract", () => {
  it("trims and maps the form into the Discord mutation payload", () => {
    expect(buildUpdatesPayload("  Nueva versión  ", "  Correcciones y mejoras.  ")).toEqual({ title: "Nueva versión", description: "Correcciones y mejoras." });
  });

  it("submits the form through the mutation contract", () => {
    const mutate = vi.fn();
    expect(submitUpdatesForm("  Release 1.2  ", "  Fixes and improvements.  ", mutate)).toBe(true);
    expect(mutate).toHaveBeenCalledWith({ title: "Release 1.2", description: "Fixes and improvements." });
  });

  it("requires both title and content", () => {
    expect(hasUpdatesContent("", "Contenido")).toBe(false);
    expect(hasUpdatesContent("Título", "")).toBe(false);
    expect(hasUpdatesContent("Título", "Contenido")).toBe(true);
  });
});
