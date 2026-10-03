import { describe, expect, beforeEach, it, vi } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

const dbMocks = vi.hoisted(() => ({
  getDiscordPanelsByOwner: vi.fn(),
  getHostedScriptByName: vi.fn().mockResolvedValue({ id: 4, userId: 7, name: "main.lua" }),
  createDiscordPanel: vi.fn(),
  deleteDiscordPanel: vi.fn(),
}));
const botMocks = vi.hoisted(() => ({
  publishDiscordPanel: vi.fn(),
  deletePublishedPanel: vi.fn(),
}));

vi.mock("./db", async () => ({ ...(await vi.importActual<typeof import("./db")>("./db")), ...dbMocks }));
vi.mock("./discordBot", async () => ({ ...(await vi.importActual<typeof import("./discordBot")>("./discordBot")), ...botMocks }));

const panel = { id: 12, ownerId: 7, name: "Custom Buyer Panel", description: "Buyer panel", channelId: "123456789012345678", targetScript: "main.lua", hwidHours: 24, messageId: "987654321098765432", createdAt: new Date(), updatedAt: new Date() };
const user = { id: 7, openId: "panel-user", name: "Owner", email: "owner@example.com", loginMethod: "manus", role: "user" as const, discordChannelId: panel.channelId, discordUserId: "111222333444555666", discordUsername: "owner", discordDisplayName: "Owner", discordAvatarUrl: null, discordGlobalName: "Owner", discordNickname: null, createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() };
const context = { user, req: { protocol: "https", headers: {}, get: () => "vanta.test" } as TrpcContext["req"], res: {} as TrpcContext["res"] };

beforeEach(() => { vi.clearAllMocks(); dbMocks.getDiscordPanelsByOwner.mockImplementation(async (ownerId: number) => ownerId === user.id ? [panel] : []); botMocks.publishDiscordPanel.mockResolvedValue({ channelId: panel.channelId, title: panel.name, messageId: "new-message" }); });

describe("discord panel management", () => {
  it("republishes an owner panel with its saved configuration", async () => {
    const result = await appRouter.createCaller(context).discord.republishPanel({ id: panel.id });
    expect(botMocks.publishDiscordPanel).toHaveBeenCalledWith(panel.channelId, { name: panel.name, description: panel.description, script: panel.targetScript, hwidHours: panel.hwidHours, ownerId: user.id, hostedScriptId: 4 });
    expect(result.messageId).toBe("new-message");
  });

  it("deletes the Discord message and then the owner panel record", async () => {
    const result = await appRouter.createCaller(context).discord.deletePanel({ id: panel.id });
    expect(botMocks.deletePublishedPanel).toHaveBeenCalledWith(panel.channelId, panel.messageId);
    expect(dbMocks.deleteDiscordPanel).toHaveBeenCalledWith(user.id, panel.id);
    expect(result).toEqual({ success: true });
  });

  it("rejects a different authenticated owner from managing the panel", async () => {
    const otherContext = { ...context, user: { ...user, id: 8, openId: "other-user" } };
    await expect(appRouter.createCaller(otherContext).discord.republishPanel({ id: panel.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(appRouter.createCaller(otherContext).discord.deletePanel({ id: panel.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects unauthenticated management and missing panels", async () => {
    const unauthenticated = { ...context, user: null } as unknown as TrpcContext;
    await expect(appRouter.createCaller(unauthenticated).discord.republishPanel({ id: panel.id })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    dbMocks.getDiscordPanelsByOwner.mockResolvedValueOnce([]);
    await expect(appRouter.createCaller(context).discord.deletePanel({ id: panel.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
