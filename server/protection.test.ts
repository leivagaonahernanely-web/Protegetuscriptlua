import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import { buildProtectionArtifact, getProtectionAdapterStatus, getProviderStatus, registerOfficialProtectionAdapter } from "./protection";
import type { TrpcContext } from "./_core/context";

function createPublicContext(): TrpcContext {
  return {
    user: null,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
}

describe("protection configuration", () => {
  it("exposes only safe provider metadata through the API", async () => {
    const caller = appRouter.createCaller(createPublicContext());
    const status = await caller.protections.providerStatus();

    expect(status).toEqual({
      configured: expect.any(Boolean),
      hasClientId: expect.any(Boolean),
      hasClientSecret: expect.any(Boolean),
      adapter: { official: false, provider: "local-runtime-wrapper" },
    });
    expect(JSON.stringify(status)).not.toContain(process.env.VANTA_CLIENT_SECRET ?? "__missing_secret__");
  });

  it("creates a readable Lua artifact without returning server credentials", () => {
    const artifact = buildProtectionArtifact("print('hello')", {
      mode: "balanced",
      obfuscateStrings: true,
      addLoaderGuard: true,
    });

    expect(artifact.code).toContain("Vanta.vs Protector");
    expect(artifact.code).toContain("__vanta_payload");
    expect(artifact.code).not.toContain(process.env.VANTA_CLIENT_SECRET ?? "__missing_secret__");
    expect(artifact.checksum).toMatch(/^[a-f0-9]{16}$/);
  });

  it("reports whether the server-side integration is configured", () => {
    const status = getProviderStatus();
    expect(status.hasClientId).toBe(Boolean(process.env.VANTA_CLIENT_ID));
    expect(status.hasClientSecret).toBe(Boolean(process.env.VANTA_CLIENT_SECRET));
  });

  it("distinguishes an official adapter when one is registered", () => {
    registerOfficialProtectionAdapter({ name: "licensed-provider", protect: async () => buildProtectionArtifact("return true", { mode: "balanced", obfuscateStrings: true, addLoaderGuard: true }) });
    expect(getProtectionAdapterStatus()).toEqual({ provider: "licensed-provider", official: true });
  });
});

describe("protection validation", () => {
  it("rejects an empty script", () => {
    expect(() => buildProtectionArtifact("   ", {
      mode: "balanced",
      obfuscateStrings: true,
      addLoaderGuard: true,
    })).toThrow("El script Lua está vacío.");
  });

  it("accepts a source of exactly 2 MB and rejects larger UTF-8 payloads", () => {
    const exactLimit = "x".repeat(2_000_000);
    expect(() => buildProtectionArtifact(exactLimit, {
      mode: "fast",
      obfuscateStrings: false,
      addLoaderGuard: false,
    })).not.toThrow();
    expect(() => buildProtectionArtifact(`${exactLimit}x`, {
      mode: "fast",
      obfuscateStrings: false,
      addLoaderGuard: false,
    })).toThrow("2 MB");
  });

  it("preserves emoji source within the UTF-8 byte limit", () => {
    const source = "print('✅ Vanta.vs 🚀')";
    const artifact = buildProtectionArtifact(source, {
      mode: "fast",
      obfuscateStrings: false,
      addLoaderGuard: false,
    });
    expect(artifact.code).toContain("Vanta.vs");
  });
});

describe("protection options", () => {
  const base = {
    mode: "balanced" as const,
    addLoaderGuard: true,
  };

  it("changes the artifact when string obfuscation is enabled", () => {
    const plain = buildProtectionArtifact('print("hello")', { ...base, obfuscateStrings: false });
    const obfuscated = buildProtectionArtifact('print("hello")', { ...base, obfuscateStrings: true });
    expect(obfuscated.code).not.toBe(plain.code);
    expect(obfuscated.code).toContain("string.reverse");
  });

  it("changes the runtime checks for fortified mode", () => {
    const balanced = buildProtectionArtifact("return true", { ...base, obfuscateStrings: false, mode: "balanced" });
    const fortified = buildProtectionArtifact("return true", { ...base, obfuscateStrings: false, mode: "fortified" });
    expect(fortified.code).not.toBe(balanced.code);
    expect(fortified.code).toContain("VANTA_SOURCE");
    expect(fortified.status).toBe("review");
  });
});
