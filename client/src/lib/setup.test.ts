import { describe, expect, it } from "vitest";
import { clearRejectedDiscordChannel, defaultSetup, getDiscordChannelUpdate, getSetupStatus, isValidDiscordChannelId, loadSetupSettings, parseDiscordChannelInput, saveSetupSettings } from "./setup";

function storageMock() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

describe("Setup settings", () => {
  it("persists and loads script, permissions, trial and channel together", () => {
    const storage = storageMock();
    const settings = { script: "main.lua", permissions: "View Channels, Send Messages", trialDays: "7", channel: "123456789012345678", guildId: "" };
    saveSetupSettings(storage, settings);
    expect(loadSetupSettings(storage)).toEqual(settings);
  });

  it("accepts an empty channel or a valid Discord snowflake, and rejects malformed values", () => {
    expect(isValidDiscordChannelId(defaultSetup.channel)).toBe(true);
    expect(isValidDiscordChannelId("123456789012345678")).toBe(true);
    expect(isValidDiscordChannelId("channel-id")).toBe(false);
  });

  it("parses full Discord channel links and keeps numeric IDs compatible", () => {
    expect(parseDiscordChannelInput("https://discord.com/channels/1504617948482895893/1534226803856638032")).toEqual({ guildId: "1504617948482895893", channelId: "1534226803856638032" });
    expect(parseDiscordChannelInput("1534226803856638032")).toEqual({ guildId: "", channelId: "1534226803856638032" });
    expect(parseDiscordChannelInput("https://discord.com/channels/1504617948482895893/not-a-channel")).toBeNull();
  });

  it("exposes the saved, ready and invalid Setup labels", () => {
    expect(getSetupStatus("", false)).toEqual({ kind: "ready", label: "Lista para guardar" });
    expect(getSetupStatus("123456789012345678", true)).toEqual({ kind: "saved", label: "Configuración guardada" });
    expect(getSetupStatus("invalid", false)).toEqual({ kind: "invalid", label: "Canal inválido" });
  });

  it("clears a rejected channel while preserving the other Setup fields", () => {
    const storage = storageMock();
    const result = clearRejectedDiscordChannel(storage, { script: "main.lua", permissions: "View Channels", trialDays: "3", channel: "1504617948482895893", guildId: "1504617948482895893" });
    expect(result.channel).toBe("");
    expect(loadSetupSettings(storage)).toEqual({ script: "main.lua", permissions: "View Channels", trialDays: "3", channel: "", guildId: "1504617948482895893" });
  });

  it("maps a valid channel to its Discord mutation payload and clears it with null", () => {
    expect(getDiscordChannelUpdate(" 123456789012345678 ")).toEqual({ discordChannelId: "123456789012345678" });
    expect(getDiscordChannelUpdate("https://discord.com/channels/1504617948482895893/1534226803856638032")).toEqual({ discordChannelId: "1534226803856638032" });
    expect(getDiscordChannelUpdate("   ")).toEqual({ discordChannelId: null });
  });
});
