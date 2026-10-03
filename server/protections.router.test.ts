import { describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const mocks = vi.hoisted(() => ({
  createProtection: vi.fn(),
  getProtectionsByUser: vi.fn(),
  getWorkspaceUsage: vi.fn().mockResolvedValue({ protections: 0, scripts: 0, keys: 0 }),
  updateDiscordChannelId: vi.fn(),
  notifyOwner: vi.fn().mockResolvedValue(true),
  sendDiscordChannelMessage: vi.fn().mockResolvedValue(true),
}));

vi.mock("./db", () => ({
  createProtection: mocks.createProtection,
  getProtectionsByUser: mocks.getProtectionsByUser,
  getWorkspaceUsage: mocks.getWorkspaceUsage,
  updateDiscordChannelId: mocks.updateDiscordChannelId,
}));
vi.mock("./_core/notification", () => ({ notifyOwner: mocks.notifyOwner }));
vi.mock("./discord", () => ({ sendDiscordChannelMessage: mocks.sendDiscordChannelMessage }));

import { appRouter } from "./routers";

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    userId: 7,
    name: "demo.lua",
    sourceSize: 12,
    status: "protected" as const,
    mode: "balanced" as const,
    obfuscateStrings: 1,
    addLoaderGuard: 1,
    checksum: "1234567890abcdef",
    resultCode: "return true",
    message: "ok",
    createdAt: new Date("2026-08-26T00:00:00.000Z"),
    updatedAt: new Date("2026-08-26T00:00:00.000Z"),
    ...overrides,
  };
}

function context(): TrpcContext {
  return {
    user: {
      id: 7,
      openId: "discord-user",
      email: "user@example.com",
      name: "Discord User",
      loginMethod: "discord",
      role: "user",
      discordChannelId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    },
    req: {} as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
}

describe("protections router", () => {
  it("lists only the authenticated user's history", async () => {
    mocks.getProtectionsByUser.mockResolvedValue([row()]);
    const result = await appRouter.createCaller(context()).protections.history();
    expect(mocks.getProtectionsByUser).toHaveBeenCalledWith(7);
    expect(result[0]).toMatchObject({ id: 1, name: "demo.lua", status: "protected" });
  });

  it("persists a protected result and a submitted channel preference", async () => {
    mocks.createProtection.mockImplementation(async (input: Record<string, unknown>) => row(input));
    const result = await appRouter.createCaller(context()).protections.create({
      name: "demo.lua",
      source: "return true",
      mode: "balanced",
      obfuscateStrings: true,
      addLoaderGuard: true,
      discordChannelId: "123456789012345678",
    });
    expect(result.status).toBe("protected");
    expect(mocks.updateDiscordChannelId).toHaveBeenCalledWith(7, "123456789012345678");
    expect(mocks.createProtection).toHaveBeenCalled();
  });

  it("returns review for fortified scripts and sends an alert", async () => {
    mocks.createProtection.mockImplementation(async (input: Record<string, unknown>) => row({ ...input, status: "review" }));
    const result = await appRouter.createCaller(context()).protections.create({
      name: "fortified.lua",
      source: "return true",
      mode: "fortified",
      obfuscateStrings: false,
      addLoaderGuard: true,
    });
    expect(result.status).toBe("review");
    expect(mocks.notifyOwner).toHaveBeenCalled();
  });

  it("records a failed protection without throwing to the user", async () => {
    mocks.createProtection.mockImplementation(async (input: Record<string, unknown>) => row({ ...input, status: "failed", resultCode: null }));
    const result = await appRouter.createCaller(context()).protections.create({
      name: "empty.lua",
      source: "   ",
      mode: "fast",
      obfuscateStrings: false,
      addLoaderGuard: false,
    });
    expect(result.status).toBe("failed");
    expect(result.code).toBe("");
    expect(mocks.notifyOwner).toHaveBeenCalled();
  });
});
