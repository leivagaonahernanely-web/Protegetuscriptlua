import { describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const mocks = vi.hoisted(() => ({
  createHostedScript: vi.fn(),
  getHostedScriptsByUser: vi.fn(),
  getHostedScriptSourceByUser: vi.fn(),
  getHostedScriptById: vi.fn(),
  getPublishedScriptsForOwnerReview: vi.fn(),
  getWorkspaceUsage: vi.fn().mockResolvedValue({ protections: 0, scripts: 0, keys: 0 }),
  updateHostedScript: vi.fn(),
  deleteHostedScript: vi.fn(),
  buildProtectionArtifact: vi.fn(() => ({ code: "-- protected artifact", status: "protected", checksum: "abc123", message: "OK" })),
}));

vi.mock("./db", () => ({
  createHostedScript: mocks.createHostedScript,
  getHostedScriptsByUser: mocks.getHostedScriptsByUser,
  getHostedScriptSourceByUser: mocks.getHostedScriptSourceByUser,
  getHostedScriptById: mocks.getHostedScriptById,
  getPublishedScriptsForOwnerReview: mocks.getPublishedScriptsForOwnerReview,
  getWorkspaceUsage: mocks.getWorkspaceUsage,
  updateHostedScript: mocks.updateHostedScript,
  deleteHostedScript: mocks.deleteHostedScript,
  createProtection: vi.fn(),
  getProtectionsByUser: vi.fn(),
  updateDiscordChannelId: vi.fn(),
}));
vi.mock("./protection", () => ({ getProviderStatus: vi.fn(() => ({ configured: true })), protectWithAdapter: vi.fn(async (...args: Parameters<typeof mocks.buildProtectionArtifact>) => mocks.buildProtectionArtifact(...args)) }));

import { appRouter } from "./routers";
import { ENV } from "./_core/env";

const user = { id: 12, openId: "host-user", name: "Host User", email: "host@example.com", loginMethod: "manus", role: "user" as const, discordChannelId: null, discordUserId: null, discordUsername: null, createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() };
function context(withUser = true, currentUser = user): TrpcContext {
  return { user: withUser ? currentUser : null, req: { protocol: "https", get: () => "vanta.test", headers: {} } as TrpcContext["req"], res: {} as TrpcContext["res"] };
}

const hostedRow = { id: 3, userId: 12, slug: "Abc123456789xyz", name: "demo.lua", description: "demo", ffaMode: 1, code: "-- protected artifact", sourceCode: "print('ok')", createdAt: new Date("2026-08-26T00:00:00Z"), updatedAt: new Date("2026-08-26T00:00:00Z") };

describe("hostedScripts router", () => {
  it("creates a hosted script and returns a stable URL and loader", async () => {
    mocks.createHostedScript.mockResolvedValue(hostedRow);
    const result = await appRouter.createCaller(context()).hostedScripts.create({ name: "demo.lua", description: "demo", source: "print('ok')", ffaMode: true, obfuscateSource: true });
    expect(result.url).toBe("https://vanta.test/scripts/hosted/Abc123456789xyz");
    expect(result.loader).toContain("script_key = \"trial\"");
    expect(result.loader).toContain("loadstring(game:HttpGet(\"https://vanta.test/scripts/hosted/Abc123456789xyz?key=trial\"))()");
    expect(mocks.createHostedScript).toHaveBeenCalledWith(expect.objectContaining({ userId: 12, name: "demo.lua", ffaMode: 1, code: "-- protected artifact", sourceCode: "print('ok')" }));
  });

  it("accepts a hosted source of exactly 2 MB", async () => {
    mocks.createHostedScript.mockResolvedValue(hostedRow);
    const source = "x".repeat(2_000_000);
    const result = await appRouter.createCaller(context()).hostedScripts.create({ name: "large.lua", source, ffaMode: true, obfuscateSource: true });
    expect(result.slug).toBe(hostedRow.slug);
    expect(mocks.createHostedScript).toHaveBeenCalledWith(expect.objectContaining({ sourceCode: source }));
  });

  it("updates a hosted script while preserving its stable slug", async () => {
    mocks.getHostedScriptById.mockResolvedValue(hostedRow);
    mocks.updateHostedScript.mockResolvedValue({ ...hostedRow, name: "updated.lua", sourceCode: "print('new')", code: "-- protected artifact" });
    const result = await appRouter.createCaller(context()).hostedScripts.update({ id: 3, name: "updated.lua", source: "print('new')", ffaMode: false, obfuscateSource: true });
    expect(result.slug).toBe(hostedRow.slug);
    expect(result.name).toBe("updated.lua");
    expect(mocks.updateHostedScript).toHaveBeenCalledWith(12, 3, expect.objectContaining({ name: "updated.lua", sourceCode: "print('new')", ffaMode: 0 }));
  });

  it("deletes only an authenticated owner's hosted script", async () => {
    mocks.getHostedScriptById.mockResolvedValue(hostedRow);
    const result = await appRouter.createCaller(context()).hostedScripts.remove({ id: 3 });
    expect(result).toEqual({ success: true });
    expect(mocks.deleteHostedScript).toHaveBeenCalledWith(12, 3);
  });

  it("rejects a non-owner from updating or deleting a hosted script", async () => {
    mocks.getHostedScriptById.mockResolvedValue(hostedRow);
    const otherUser = { ...user, id: 99, openId: "other-user" };
    const caller = appRouter.createCaller(context(true, otherUser));
    await expect(caller.hostedScripts.update({ id: 3, name: "x.lua", source: "return true", ffaMode: false, obfuscateSource: true })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller.hostedScripts.remove({ id: 3 })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("lists only the authenticated user's hosted scripts", async () => {
    mocks.getHostedScriptsByUser.mockResolvedValue([hostedRow]);
    const result = await appRouter.createCaller(context()).hostedScripts.list();
    expect(mocks.getHostedScriptsByUser).toHaveBeenCalledWith(12);
    expect(result[0]?.slug).toBe(hostedRow.slug);
    expect(result[0]?.loader).toContain("/scripts/hosted/");
  });

  it("returns original source only through the authenticated owner procedure", async () => {
    mocks.getHostedScriptSourceByUser.mockResolvedValue({ id: 3, name: "demo.lua", code: "print('original')" });
    const result = await appRouter.createCaller(context()).hostedScripts.source({ id: 3 });
    expect(result.code).toBe("print('original')");
    expect(mocks.getHostedScriptSourceByUser).toHaveBeenCalledWith(12, 3);
  });

  it("rejects an authenticated non-owner from reading source", async () => {
    mocks.getHostedScriptSourceByUser.mockResolvedValue(undefined);
    const otherUser = { ...user, id: 99, openId: "other-user" };
    await expect(appRouter.createCaller(context(true, otherUser)).hostedScripts.source({ id: 3 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mocks.getHostedScriptSourceByUser).toHaveBeenCalledWith(99, 3);
  });

  it("lists published TXT and source hash only for the configured owner", async () => {
    const ownerUser = { ...user, openId: ENV.ownerOpenId || "owner-open-id", role: "admin" as const };
    mocks.getPublishedScriptsForOwnerReview.mockResolvedValue([{ script: { ...hostedRow, sourceCode: "print('owner')" }, ownerName: "Owner", ownerOpenId: ownerUser.openId, discordUserId: "150000000000000001", discordUsername: "owner" }]);
    const result = await appRouter.createCaller(context(true, ownerUser)).owner.publishedScripts();
    expect(result[0]).toMatchObject({ name: "demo.lua", source: "print('owner')", sourceSize: 14, ownerName: "Owner" });
    expect(result[0]?.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(mocks.getPublishedScriptsForOwnerReview).toHaveBeenCalledOnce();
    await expect(appRouter.createCaller(context(true, user)).owner.publishedScripts()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects unauthenticated creation, listing and source access", async () => {
    const caller = appRouter.createCaller(context(false));
    await expect(caller.hostedScripts.list()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller.hostedScripts.create({ name: "demo.lua", source: "return true", ffaMode: false, obfuscateSource: true })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller.hostedScripts.source({ id: 3 })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller.hostedScripts.remove({ id: 3 })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
