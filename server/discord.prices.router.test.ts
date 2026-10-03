import { describe, expect, it, vi } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

const botMocks = vi.hoisted(() => ({ publishPricesMessage: vi.fn(), publishUpdatesMessage: vi.fn() }));
const channelId = "123456789012345678";
const discordMocks = vi.hoisted(() => ({ checkDiscordChannel: vi.fn() }));

vi.mock("./discordBot", async () => ({ ...(await vi.importActual<typeof import("./discordBot")>("./discordBot")), ...botMocks }));
vi.mock("./discord", async () => ({ ...(await vi.importActual<typeof import("./discord")>("./discord")), ...discordMocks }));

const context = {
  user: {
    id: 7,
    openId: "prices-user",
    name: "Owner",
    email: "owner@example.com",
    loginMethod: "manus",
    role: "user" as const,
    discordChannelId: "123456789012345678",
    discordUserId: "111222333444555666",
    discordUsername: "owner",
    discordDisplayName: "Owner",
    discordAvatarUrl: null,
    discordGlobalName: "Owner",
    discordNickname: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  },
  req: { protocol: "https", headers: {}, get: () => "vanta.test" } as TrpcContext["req"],
  res: {} as TrpcContext["res"],
};

describe("discord prices publishing", () => {
  it("publishes the custom title and description to the configured channel", async () => {
    discordMocks.checkDiscordChannel.mockResolvedValue({ ok: true, status: 200, message: "Canal accesible." });
    botMocks.publishPricesMessage.mockResolvedValue({ channelId: context.user.discordChannelId, title: "Vanta.vs APP", messageId: "prices-message" });

    const result = await appRouter.createCaller(context).discord.publishPrices({ title: "Vanta.vs APP", description: "Accepted Payments\n\n• $7 USD\n• 700 Robux — Lifetime", channelId });

    expect(discordMocks.checkDiscordChannel).toHaveBeenCalledWith(context.user.discordChannelId);
    expect(botMocks.publishPricesMessage).toHaveBeenCalledWith(context.user.discordChannelId, { title: "Vanta.vs APP", description: "Accepted Payments\n\n• $7 USD\n• 700 Robux — Lifetime" });
    expect(result).toEqual({ channelId: context.user.discordChannelId, title: "Vanta.vs APP", messageId: "prices-message" });
  });

  it("publishes updates through the configured channel", async () => {
    discordMocks.checkDiscordChannel.mockResolvedValue({ ok: true, status: 200, message: "Canal accesible." });
    botMocks.publishUpdatesMessage.mockResolvedValue({ channelId: context.user.discordChannelId, title: "Nueva versión", messageId: "updates-message" });

    const result = await appRouter.createCaller(context).discord.publishUpdates({ title: "Nueva versión", description: "Correcciones y mejoras importantes.", channelId });

    expect(discordMocks.checkDiscordChannel).toHaveBeenCalledWith(context.user.discordChannelId);
    expect(botMocks.publishUpdatesMessage).toHaveBeenCalledWith(context.user.discordChannelId, { title: "Nueva versión", description: "Correcciones y mejoras importantes." });
    expect(result).toEqual({ channelId: context.user.discordChannelId, title: "Nueva versión", messageId: "updates-message" });
  });

  it("requires an explicitly selected channel", async () => {
    botMocks.publishPricesMessage.mockClear();
    await expect(appRouter.createCaller(context).discord.publishPrices({ title: "Prices", description: "Contenido" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(botMocks.publishPricesMessage).not.toHaveBeenCalled();
  });
});

