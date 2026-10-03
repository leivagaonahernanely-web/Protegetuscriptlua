import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  insertValues: vi.fn(),
  updateSet: vi.fn(),
  updateWhere: vi.fn(),
  selectFrom: vi.fn(),
  selectWhere: vi.fn(),
  selectOrderBy: vi.fn(),
  selectLimit: vi.fn(),
}));

vi.mock("drizzle-orm/mysql2", () => ({
  drizzle: vi.fn(() => ({
    insert: () => ({ values: database.insertValues }),
    update: () => ({ set: (value: unknown) => { database.updateSet(value); return { where: database.updateWhere }; } }),
    select: () => ({
      from: () => {
        database.selectFrom();
        return {
          where: () => {
            database.selectWhere();
            return {
              orderBy: () => {
                database.selectOrderBy();
                return { limit: database.selectLimit };
              },
              limit: database.selectLimit,
            };
          },
        };
      },
    }),
  })),
}));

import { createDiscordPanel, createProtection, ensureUserApiKey, getDiscordPanelsByOwner, getProtectionsByUser, redeemLicense, resetLicenseHwidByDiscordUserId, updateDiscordChannelId } from "./db";

const saved = {
  id: 4,
  userId: 9,
  name: "saved.lua",
  sourceSize: 10,
  status: "protected" as const,
  mode: "balanced" as const,
  obfuscateStrings: 1,
  addLoaderGuard: 1,
  checksum: "abcdef1234567890",
  resultCode: "return true",
  message: "ok",
  createdAt: new Date("2026-08-26T00:00:00.000Z"),
  updatedAt: new Date("2026-08-26T00:00:00.000Z"),
};

describe("database persistence helpers", () => {
  beforeEach(() => {
    process.env.DATABASE_URL = "mysql://test";
    database.insertValues.mockResolvedValue([{ insertId: 4 }]);
    database.updateWhere.mockResolvedValue(undefined);
    database.selectLimit.mockResolvedValue([saved]);
  });

  it("creates and persists an API key when the user does not have one", async () => {
    database.selectLimit.mockResolvedValueOnce([{ id: 9, apiKey: null }]).mockResolvedValueOnce([{ apiKey: "VANTA_persisted_key_value" }]);
    const result = await ensureUserApiKey(9);
    expect(result).toBe("VANTA_persisted_key_value");
    const update = database.updateSet.mock.calls.at(-1)?.[0] as { apiKey?: string };
    expect(update.apiKey).toMatch(/^VANTA-[A-Za-z0-9_-]{32,40}$/);
    expect(database.updateWhere).toHaveBeenCalled();
  });

  it("restricts panel license redemption to the panel owner and hosted script", async () => {
    database.selectLimit.mockResolvedValueOnce([{ id: 22, ownerId: 9, hostedScriptId: 12, keyCode: "license-key-123", status: "active", discordUserId: null, expiresAt: null }]);
    const result = await redeemLicense("license-key-123", "discord-user", { ownerId: 9, hostedScriptId: 12 });
    expect(result?.discordUserId).toBe("discord-user");
    expect(database.selectWhere).toHaveBeenCalled();
    expect(database.updateSet).toHaveBeenCalledWith({ discordUserId: "discord-user" });
  });

  it("blocks a repeated user HWID reset during the 24-hour cooldown", async () => {
    database.selectLimit.mockResolvedValueOnce([{ id: 4, hwidResetAt: new Date(Date.now() - 60 * 60 * 1000) }]);
    database.updateWhere.mockClear();
    const result = await resetLicenseHwidByDiscordUserId("discord-user");
    expect(result.reset).toBe(false);
    expect(result.reason).toBe("cooldown");
    expect(result.retryAt).toBeInstanceOf(Date);
    expect(database.updateWhere).not.toHaveBeenCalled();
  });

  it("resets an eligible user HWID and persists the reset timestamp", async () => {
    database.selectLimit.mockResolvedValueOnce([{ id: 4, hwidResetAt: null }]);
    const result = await resetLicenseHwidByDiscordUserId("discord-user");
    expect(result.reset).toBe(true);
    expect(database.updateSet).toHaveBeenCalledWith(expect.objectContaining({ hwid: null, hwidResetAt: expect.any(Date) }));
    expect(database.updateWhere).toHaveBeenCalled();
  });

  it("updates the channel preference for one user", async () => {
    await updateDiscordChannelId(9, "123456789012345678");
    expect(database.updateSet).toHaveBeenCalledWith({ discordChannelId: "123456789012345678" });
    expect(database.updateWhere).toHaveBeenCalled();
  });

  it("inserts and retrieves a saved protection", async () => {
    const result = await createProtection({ ...saved, id: undefined });
    expect(database.insertValues).toHaveBeenCalled();
    expect(result).toEqual(saved);
  });

  it("inserts a Discord panel with its owner and message metadata", async () => {
    const panel = { id: 12, ownerId: 9, name: "Custom Buyer Panel", description: "Buyer panel", channelId: "123456789012345678", targetScript: "main.lua", hwidHours: 24, messageId: "987654321098765432", createdAt: new Date(), updatedAt: new Date() };
    database.selectLimit.mockResolvedValueOnce([panel]);
    const result = await createDiscordPanel({ ...panel, id: undefined });
    expect(database.insertValues).toHaveBeenCalled();
    expect(result).toEqual(panel);
  });

  it("filters and orders Discord panels by owner", async () => {
    const result = await getDiscordPanelsByOwner(9);
    expect(database.selectWhere).toHaveBeenCalled();
    expect(database.selectOrderBy).toHaveBeenCalled();
    expect(result).toEqual([saved]);
  });

  it("filters and orders protection history by user", async () => {
    const result = await getProtectionsByUser(9);
    expect(database.selectWhere).toHaveBeenCalled();
    expect(database.selectOrderBy).toHaveBeenCalled();
    expect(result).toEqual([saved]);
  });
});
