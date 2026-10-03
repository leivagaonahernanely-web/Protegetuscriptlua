import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const dbMocks = vi.hoisted(() => ({ updateDiscordChannelId: vi.fn(), updateDiscordContentChannels: vi.fn() }));
const discordMocks = vi.hoisted(() => ({ checkDiscordChannel: vi.fn() }));

vi.mock("./db", async () => ({ ...(await vi.importActual<typeof import("./db")>("./db")), ...dbMocks }));
vi.mock("./discord", async () => ({ ...(await vi.importActual<typeof import("./discord")>("./discord")), ...discordMocks }));

import { appRouter } from "./routers";

const user = { id: 7, openId: "channel-user", name: "Owner", email: "owner@example.com", loginMethod: "manus", role: "user" as const, discordChannelId: "1504617948482895893", discordUserId: null, discordUsername: null, createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() };
const context = { user, req: { protocol: "https", headers: {}, get: () => "vanta.test" } as TrpcContext["req"], res: {} as TrpcContext["res"] };

beforeEach(() => vi.clearAllMocks());

describe("discord.updateChannel", () => {
  it("clears a channel rejected as unknown without throwing a mutation error", async () => {
    discordMocks.checkDiscordChannel.mockResolvedValue({ ok: false, status: 404, message: "Canal no encontrado." });
    const result = await appRouter.createCaller(context).discord.updateChannel({ discordChannelId: "1504617948482895893" });
    expect(result).toEqual({ ok: false, status: 404, message: "Canal no encontrado." });
    expect(dbMocks.updateDiscordChannelId).toHaveBeenCalledWith(user.id, null);
  });

  it("clears a channel rejected for permissions without throwing a mutation error", async () => {
    discordMocks.checkDiscordChannel.mockResolvedValue({ ok: false, status: 403, message: "Permisos insuficientes." });
    const result = await appRouter.createCaller(context).discord.updateChannel({ discordChannelId: "1504617948482895893" });
    expect(result).toMatchObject({ ok: false, status: 403 });
    expect(dbMocks.updateDiscordChannelId).toHaveBeenCalledWith(user.id, null);
  });

  it("persists an accessible channel and returns success", async () => {
    discordMocks.checkDiscordChannel.mockResolvedValue({ ok: true, channelId: "123456789012345678" });
    const result = await appRouter.createCaller(context).discord.updateChannel({ discordChannelId: "123456789012345678" });
    expect(result).toEqual({ ok: true, channelId: "123456789012345678" });
    expect(dbMocks.updateDiscordChannelId).toHaveBeenCalledWith(user.id, "123456789012345678");
  });
});

describe("discord.updateContentChannels", () => {
  it("validates and persists Prices and Updates independently", async () => {
    discordMocks.checkDiscordChannel.mockResolvedValue({ ok: true, channelId: "123456789012345678" });
    const result = await appRouter.createCaller(context).discord.updateContentChannels({ pricesChannelId: "123456789012345678", updatesChannelId: "123456789012345679" });
    expect(result).toEqual({ ok: true, pricesChannelId: "123456789012345678", updatesChannelId: "123456789012345679" });
    expect(dbMocks.updateDiscordContentChannels).toHaveBeenCalledWith(user.id, { pricesChannelId: "123456789012345678", updatesChannelId: "123456789012345679" });
    expect(discordMocks.checkDiscordChannel).toHaveBeenCalledTimes(2);
  });

  it("does not persist a rejected content channel", async () => {
    discordMocks.checkDiscordChannel.mockResolvedValue({ ok: false, status: 404, message: "Canal no encontrado." });
    await expect(appRouter.createCaller(context).discord.updateContentChannels({ pricesChannelId: "123456789012345678" })).rejects.toThrow("Canal no encontrado.");
    expect(dbMocks.updateDiscordContentChannels).not.toHaveBeenCalled();
  });
});
