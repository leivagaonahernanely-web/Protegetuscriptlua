import { beforeEach, describe, expect, it, vi } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

const dbMocks = vi.hoisted(() => ({
  createLicense: vi.fn(),
  getWorkspaceUsage: vi.fn().mockResolvedValue({ protections: 0, scripts: 0, keys: 0 }),
  getLicensesByOwner: vi.fn().mockResolvedValue([]),
  getHostedScriptById: vi.fn().mockResolvedValue({ id: 4, userId: 7 }),
  getHostedScriptByOwnerId: vi.fn().mockResolvedValue({ id: 4, userId: 7 }),
  getHostedScriptByName: vi.fn().mockResolvedValue({ id: 4, userId: 7, name: "main.lua" }),
  createBlacklist: vi.fn(),
  getBlacklistsByOwner: vi.fn().mockResolvedValue([]),
  createAccessRule: vi.fn(),
  getAccessRulesByOwner: vi.fn().mockResolvedValue([]),
  resetLicenseHwid: vi.fn().mockResolvedValue({ reset: true, resetAt: new Date() }),
  revokeLicense: vi.fn(),
  deleteLicense: vi.fn(),
  redeemPlanKey: vi.fn(),
}));

vi.mock("./db", async () => {
  const actual = await vi.importActual<typeof import("./db")>("./db");
  return { ...actual, ...dbMocks };
});

const user = { id: 7, openId: process.env.OWNER_OPEN_ID || "access-user", name: "Owner", email: "owner@example.com", loginMethod: "manus", role: "admin" as const, discordChannelId: null, discordUserId: null, discordUsername: null, createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() };
const context = { user, req: { protocol: "https", headers: {}, get: () => "vanta.test" } as TrpcContext["req"], res: {} as TrpcContext["res"] };

beforeEach(() => vi.clearAllMocks());

describe("access management", () => {
  it("generates an automatic normal license key with 32 alphanumeric characters for a script", async () => {
    dbMocks.createLicense.mockResolvedValue({ id: 1, ownerId: 7, keyCode: "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6", type: "license", status: "active", hostedScriptId: 4, discordUserId: null, hwid: null, expiresAt: new Date(), createdAt: new Date(), updatedAt: new Date() });
    const result = await appRouter.createCaller(context).licenseKeys.generate({ type: "license", hostedScriptId: 4, trialDays: 3 });
    expect(result.keyCode).toMatch(/^[a-z0-9]{32}$/);
    expect(dbMocks.createLicense).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 7, hostedScriptId: 4, type: "license", status: "active", keyCode: expect.stringMatching(/^[a-z0-9]{32}$/) }));
  });

  it("generates a separate prefixed Plan Key only when requested", async () => {
    dbMocks.createLicense.mockResolvedValue({ id: 3, ownerId: 7, keyCode: "PREMIUM-kksuy702hsb12345", type: "license", status: "active", hostedScriptId: null, discordUserId: null, hwid: null, expiresAt: null, createdAt: new Date(), updatedAt: new Date() });
    const result = await appRouter.createCaller(context).licenseKeys.generate({ type: "license", plan: "premium", keyKind: "plan", trialDays: 3 });
    expect(result.keyCode).toMatch(/^PREMIUM-[a-z0-9]{16}$/);
    expect(dbMocks.createLicense).toHaveBeenCalledWith(expect.objectContaining({ keyCode: expect.stringMatching(/^PREMIUM-[a-z0-9]{16}$/) }));
  });

  it("uses the free tier for an automatic script key", async () => {
    dbMocks.createLicense.mockResolvedValue({ id: 2, ownerId: 7, plan: "free", keyCode: "1234567890", type: "license", status: "active", hostedScriptId: 4, discordUserId: null, hwid: null, expiresAt: null, createdAt: new Date(), updatedAt: new Date() });
    await appRouter.createCaller(context).licenseKeys.generate({ type: "license", hostedScriptId: 4, durationValue: 1, durationUnit: "years" });
    expect(dbMocks.createLicense).toHaveBeenCalledWith(expect.objectContaining({ plan: "free", hostedScriptId: 4 }));
  });

  it("redeems a plan key and returns the activated plan", async () => {
    dbMocks.redeemPlanKey.mockResolvedValue({ plan: "premium", keyCode: "PREMIUM-kksuy702hsb12345" });
    const result = await appRouter.createCaller(context).plans.redeem({ keyCode: "premium-kksuy702hsb12345" });
    expect(result).toEqual({ plan: "premium", keyCode: "PREMIUM-kksuy702hsb12345" });
    expect(dbMocks.redeemPlanKey).toHaveBeenCalledWith(7, "PREMIUM-KKSUY702HSB12345");
  });

  it("rejects an invalid owner key format before redemption", async () => {
    await expect(appRouter.createCaller(context).plans.redeem({ keyCode: "1234567890" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(dbMocks.redeemPlanKey).not.toHaveBeenCalled();
  });

  it("enforces the free key quota server-side", async () => {
    dbMocks.getWorkspaceUsage.mockResolvedValue({ protections: 0, scripts: 0, keys: 500 });
    await expect(appRouter.createCaller(context).licenseKeys.generate({ type: "license", plan: "free", hostedScriptId: 4, durationValue: 1, durationUnit: "days" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("allows a regular authenticated user to generate a normal key for their own script", async () => {
    const regularUser = { ...user, id: 8, openId: "another-user", role: "user" as const };
    dbMocks.getWorkspaceUsage.mockResolvedValue({ protections: 0, scripts: 0, keys: 0 });
    dbMocks.getHostedScriptByOwnerId.mockResolvedValue({ id: 4, userId: regularUser.id });
    dbMocks.createLicense.mockResolvedValue({ id: 4, ownerId: regularUser.id, keyCode: "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6", hostedScriptId: 4, type: "license", status: "active" });
    const result = await appRouter.createCaller({ ...context, user: regularUser }).licenseKeys.generate({ type: "license", hostedScriptId: 4, trialDays: 3 });
    expect(result.keyCode).toMatch(/^[a-z0-9]{32}$/);
    expect(dbMocks.createLicense).toHaveBeenCalledWith(expect.objectContaining({ ownerId: regularUser.id, hostedScriptId: 4, plan: "free" }));
  });

  it("rejects generating a normal key for another user's script", async () => {
    const regularUser = { ...user, id: 8, openId: "another-user", role: "user" as const };
    dbMocks.getHostedScriptByOwnerId.mockResolvedValue({ id: 4, userId: 999 });
    await expect(appRouter.createCaller({ ...context, user: regularUser }).licenseKeys.generate({ type: "license", hostedScriptId: 4, trialDays: 3 })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("keeps Plan Key generation restricted to the configured owner", async () => {
    const otherAdmin = { ...user, openId: "another-admin" };
    await expect(appRouter.createCaller({ ...context, user: otherAdmin }).licenseKeys.generate({ type: "license", plan: "premium", keyKind: "plan", trialDays: 3 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects Plan Key generation for a regular user", async () => {
    const regularUser = { ...user, role: "user" as const };
    await expect(appRouter.createCaller({ ...context, user: regularUser }).licenseKeys.generate({ type: "license", plan: "premium", keyKind: "plan", trialDays: 3 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("requires authentication for license management", async () => {
    const unauthenticated = { ...context, user: null } as unknown as TrpcContext;
    await expect(appRouter.createCaller(unauthenticated).licenseKeys.generate({ type: "license", plan: "free", trialDays: 3 })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("resets HWID, revokes, and deletes only through owner-scoped mutations", async () => {
    const caller = appRouter.createCaller(context);
    await caller.licenseKeys.resetHwid({ id: 9 });
    await caller.licenseKeys.revoke({ id: 9 });
    await caller.licenseKeys.remove({ id: 9 });
    expect(dbMocks.resetLicenseHwid).toHaveBeenCalledWith(7, 9);
    expect(dbMocks.revokeLicense).toHaveBeenCalledWith(7, 9);
    expect(dbMocks.deleteLicense).toHaveBeenCalledWith(7, 9);
  });

  it("blocks a web HWID reset while its 24-hour cooldown is active", async () => {
    dbMocks.resetLicenseHwid.mockResolvedValue({ reset: false, reason: "cooldown", retryAt: new Date(Date.now() + 60_000) });
    await expect(appRouter.createCaller(context).licenseKeys.resetHwid({ id: 9 })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS", message: expect.stringContaining("El HWID ya fue reiniciado") });
  });

  it("creates blacklist and whitelist rules for the authenticated owner", async () => {
    dbMocks.createBlacklist.mockResolvedValue({ id: 3, ownerId: 7, hostedScriptId: 4, discordUserId: "123456789012345678", reason: "abuse", active: 1 });
    dbMocks.createAccessRule.mockResolvedValue({ id: 4, ownerId: 7, kind: "role", discordId: "123456789012345679", label: "VIP", active: 1 });
    await appRouter.createCaller(context).access.blacklist.add({ hostedScriptId: 4, discordUserId: "123456789012345678", reason: "abuse" });
    await appRouter.createCaller(context).access.whitelist.add({ hostedScriptId: 4, kind: "role", discordId: "123456789012345679", label: "VIP" });
    expect(dbMocks.createBlacklist).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 7, discordUserId: "123456789012345678" }));
    expect(dbMocks.createAccessRule).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 7, hostedScriptId: 4, kind: "role" }));
  });
});
