import { describe, expect, it, vi } from "vitest";
import { checkDiscordChannel, getDiscordBotIdentity, sendDiscordChannelMessage } from "./discord";

describe("Discord bot configuration", () => {
  it("authenticates against Discord without exposing the token", async () => {
    const token = process.env.DISCORD_BOT_TOKEN;
    expect(token, "DISCORD_BOT_TOKEN no está configurado").toBeTruthy();

    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "123456789012345678", username: "vanta-bot" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const identity = await getDiscordBotIdentity();
    expect(identity).toEqual({ id: "123456789012345678", username: "vanta-bot" });
    expect(fetchMock).toHaveBeenCalledWith("https://discord.com/api/v10/users/@me", expect.objectContaining({ headers: { Authorization: `Bot ${token}` } }));
    expect(JSON.stringify(identity)).not.toContain(token);
    vi.unstubAllGlobals();
  });

  it("rejects malformed channel IDs without calling Discord", async () => {
    await expect(sendDiscordChannelMessage("not-a-channel", { title: "test", content: "test" })).resolves.toBe(false);
  });

  it("returns an actionable error for an unknown channel", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(checkDiscordChannel("1504617948482895893")).resolves.toMatchObject({ ok: false, status: 404, message: expect.stringContaining("devolvió 404") });
    vi.unstubAllGlobals();
  });

  it("retries a transient network failure and accepts the channel", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error("temporary network failure")).mockResolvedValueOnce(new Response(JSON.stringify({ id: "123456789012345678", type: 0 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(checkDiscordChannel("123456789012345678")).resolves.toEqual({ ok: true, channelId: "123456789012345678" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it("classifies invalid token and timeout instead of returning one generic permission error", async () => {
    const unauthorized = vi.fn().mockResolvedValue(new Response("{}", { status: 401 }));
    vi.stubGlobal("fetch", unauthorized);
    await expect(checkDiscordChannel("123456789012345678")).resolves.toMatchObject({ ok: false, status: 401, message: expect.stringContaining("token") });
    vi.unstubAllGlobals();
    const timeout = vi.fn().mockRejectedValue(Object.assign(new Error("timed out"), { name: "TimeoutError" }));
    vi.stubGlobal("fetch", timeout);
    await expect(checkDiscordChannel("123456789012345678")).resolves.toMatchObject({ ok: false, message: expect.stringContaining("tardó demasiado") });
    expect(timeout).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it("accepts an accessible channel", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "123456789012345678", type: 0 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(checkDiscordChannel("123456789012345678")).resolves.toEqual({ ok: true, channelId: "123456789012345678" });
    vi.unstubAllGlobals();
  });

  it("sends a bounded notification payload to a valid channel", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(sendDiscordChannelMessage("123456789012345678", { title: "Review", content: "Check" })).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://discord.com/api/v10/channels/123456789012345678/messages",
      expect.objectContaining({ method: "POST", body: expect.stringContaining("Review") }),
    );
    vi.unstubAllGlobals();
  });
});
