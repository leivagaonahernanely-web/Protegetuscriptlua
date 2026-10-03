import { describe, expect, it, vi } from "vitest";
import { createReconnectGate, discordCommands, formatWhitelistDiagnostic, GET_SCRIPT_COPY_BUTTON_LABEL, getScriptDisplayMessage, handleGatewayFailure, handleInteraction, hasKeyManagementAccess, isConfiguredOwnerId, isGuildOwner, matchesWhitelistRule, mobileViewScriptMessage, panelMessage, parseDuration, respond, resolveScriptSelection, scriptRuntimeLoader, targetChoices } from "./discordBot";
import * as db from "./db";

describe("Discord access panel", () => {
  it("parses key durations in days, months and years", () => {
    expect(parseDuration("30d")).toBe(30 * 86_400_000);
    expect(parseDuration("3months")).toBe(3 * 2_592_000_000);
    expect(parseDuration("1year")).toBe(31_536_000_000);
    expect(parseDuration("forever")).toBeUndefined();
  });
  it("builds FFA and protected runtime loaders according to the panel access rule", () => {
    const ffa = scriptRuntimeLoader({ slug: "ffa-script", ffaMode: true, scriptKey: "1234567890" });
    const protectedLoader = scriptRuntimeLoader({ slug: "protected-script", ffaMode: false, scriptKey: "1234567890" });
    expect(ffa).not.toContain("script_key");
    expect(ffa).toContain("/scripts/hosted/ffa-script");
    expect(protectedLoader).toContain('script_key = "1234567890"');
    expect(protectedLoader).toContain("?key=1234567890");
    expect(protectedLoader).toContain("RbxAnalyticsService");
  });

  it("labels the Get Script copy action for mobile users", () => {
    expect(GET_SCRIPT_COPY_BUTTON_LABEL).toBe("Mobile View Script");
  });

  it("uses the active license key when building a protected Get Script loader", () => {
    const loader = scriptRuntimeLoader({ slug: "bound-script", ffaMode: false, scriptKey: "internal-script-key" }, "86vC3ZULuEQpOImpm5VBB6oLROAQmPLe");
    expect(loader).toContain('script_key = "86vC3ZULuEQpOImpm5VBB6oLROAQmPLe"');
    expect(loader).toContain("?key=86vC3ZULuEQpOImpm5VBB6oLROAQmPLe");
    expect(loader).not.toContain("internal-script-key");
    expect(loader).toContain("&hwid=\" .. hwid");
  });

  it("keeps Get Script visually formatted while Mobile View stays compact", () => {
    const display = getScriptDisplayMessage({ name: "Vanta.vs", slug: "display-script", ffaMode: false }, "mbe2krjut4gdyiggoqc3t47zq3eaxnkl", 42);
    expect(display).toContain("📜 **Vanta.vs**");
    expect(display).toContain("```lua");
    expect(display).toContain("loadstring(game:HttpGet(");
    expect(display).toContain("\n```");
  });

  it("builds Mobile View Script as only the two loader lines", () => {
    const loader = scriptRuntimeLoader({ slug: "mobile-script", ffaMode: false, scriptKey: "internal-key" }, "mbe2krjut4gdyiggoqc3t47zq3eaxnkl", 42);
    const message = mobileViewScriptMessage({ name: "Vanta.vs", slug: "mobile-script", ffaMode: false }, "mbe2krjut4gdyiggoqc3t47zq3eaxnkl", 42);
    expect(loader.split("\n")).toHaveLength(2);
    expect(loader).toContain('/scripts/loaders/');
    expect(loader).not.toContain("RbxAnalyticsService");
    expect(loader).not.toContain("/scripts/hosted/");
    expect(message).toBe(loader);
    expect(message.split("\n")).toHaveLength(2);
    expect(message).not.toContain("Vanta.vs");
    expect(message).not.toContain("```");
    expect(message).not.toContain("```lua");
  });

  it("builds the requested two-row action layout", () => {
    const message = panelMessage();
    const ids = message.components.flatMap((row: any) => row.components.map((button: any) => button.data.custom_id));
    expect(ids).toEqual(["vanta:redeem", "vanta:script", "vanta:role", "vanta:hwid", "vanta:stats"]);
    expect(discordCommands.some((command: any) => command.name === "apikey")).toBe(true);
    expect(message.embeds[0].data.title).toBe("Vanta.vs Protector · Access Panel");
    expect(message.embeds[0].data.color).toBe(0x5865f2);
    expect(message.embeds[0].data.description).toContain("Vanta.vs Protector");
    expect(message.embeds[0].data.description).toContain("canjear tu key");
    expect((message as any).ephemeral).not.toBe(true);
  });

  it("schedules only one post-disconnect reconnect and clears its pending state", () => {
    vi.useFakeTimers();
    const reconnect = vi.fn();
    const gate = createReconnectGate(reconnect, 5000);
    expect(gate.schedule()).toBe(true);
    expect(gate.schedule()).toBe(false);
    expect(gate.pending()).toBe(true);
    vi.advanceTimersByTime(4999);
    expect(reconnect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(gate.pending()).toBe(false);
    expect(gate.schedule()).toBe(true);
    gate.cancel();
    vi.useRealTimers();
  });

  it("routes both Gateway error and shard disconnect through one recovery callback", () => {
    const reconnect = vi.fn(() => true);
    expect(handleGatewayFailure("Gateway error", reconnect)).toBe(true);
    expect(handleGatewayFailure("Gateway desconectado", reconnect)).toBe(true);
    expect(reconnect).toHaveBeenCalledTimes(2);
  });

  it("uses followUp after acknowledgement and reply only once when public", async () => {
    const reply = vi.fn();
    const followUp = vi.fn();
    await respond({ replied: false, deferred: false, reply, followUp }, { content: "panel" });
    expect(reply).toHaveBeenCalledTimes(1);
    expect(followUp).not.toHaveBeenCalled();
    await respond({ replied: true, deferred: false, reply, followUp }, { content: "second" });
    expect(followUp).toHaveBeenCalledTimes(1);
    const concurrent = { replied: false, deferred: false, reply: vi.fn(() => new Promise((resolve) => setTimeout(resolve, 1))), followUp: vi.fn() };
    await Promise.all([respond(concurrent, { content: "once" }), respond(concurrent, { content: "once" })]);
    expect(concurrent.reply).toHaveBeenCalledTimes(1);
    expect(concurrent.followUp).not.toHaveBeenCalled();
  });

  it("rejects /panel when the Discord owner is not linked", async () => {
    const reply = vi.fn();
    const interaction = { isModalSubmit: () => false, isButton: () => false, isChatInputCommand: () => true, commandName: "panel", user: { id: "not-linked" }, replied: false, deferred: false, reply };
    await handleInteraction(interaction);
    expect(reply).toHaveBeenCalledTimes(1);
    const payload = reply.mock.calls[0][0];
    expect(payload.ephemeral).toBe(true);
    expect(payload.content).toContain("owner vinculado");
  });

  it("acknowledges slash commands before work and edits the deferred reply", async () => {
    const editReply = vi.fn().mockResolvedValue(undefined);
    let interaction: any;
    const deferReply = vi.fn(async () => { interaction.deferred = true; });
    interaction = { isModalSubmit: () => false, isButton: () => false, isChatInputCommand: () => true, commandName: "stats", replied: false, deferred: false, deferReply, editReply };
    await handleInteraction(interaction);
    expect(deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("está conectado") }));
  });

  it("ignores duplicate delivery of the same interaction", async () => {
    const editReply = vi.fn().mockResolvedValue(undefined);
    let interaction: any;
    const deferReply = vi.fn(async () => { interaction.deferred = true; });
    interaction = { isModalSubmit: () => false, isButton: () => false, isChatInputCommand: () => true, commandName: "stats", replied: false, deferred: false, deferReply, editReply };
    await handleInteraction(interaction);
    await handleInteraction(interaction);
    expect(deferReply).toHaveBeenCalledTimes(1);
    expect(editReply).toHaveBeenCalledTimes(1);
  });

  it("runs /updates as a public styled embed", async () => {
    const reply = vi.fn();
    const interaction = { isModalSubmit: () => false, isButton: () => false, isChatInputCommand: () => true, commandName: "updates", replied: false, deferred: false, reply };
    await handleInteraction(interaction);
    expect(reply).toHaveBeenCalledTimes(1);
    const embed = reply.mock.calls[0][0].embeds[0].data;
    expect(embed.title).toBe("Project Updates");
    expect(embed.color).toBe(0xe93540);
  });

  it("registers slash commands for every panel action", () => {
    const names = discordCommands.map((command: any) => command.name);
    expect(names).toEqual(["ping", "panel", "stats", "apikey", "getscript", "getrole", "redeem", "generatekey", "deletekey", "whitelist", "unwhitelist", "blacklist", "resethwid", "addtime", "warn", "dropkey", "prices", "updates", "generatekeyrol"]);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("getscript");
    expect(names).not.toContain("getkey");
    expect(names).toContain("getrole");
    expect(names).toContain("stats");
    expect(names).toContain("apikey");
    expect(names).toContain("redeem");
    expect(names).toContain("updates");
  });

  it("exposes the requested required and optional slash options", () => {
    const command = (name: string) => discordCommands.find((item: any) => item.name === name) as any;
    const options = (name: string) => command(name).options;
    expect(options("panel").find((item: any) => item.name === "panel").required).toBe(true);
    expect(options("panel").find((item: any) => item.name === "panel").autocomplete).toBe(true);
    expect(options("generatekey").find((item: any) => item.name === "script").required).toBe(true);
    expect(options("generatekey").find((item: any) => item.name === "duration").required).toBe(false);
    expect(options("getrole")).toHaveLength(1);
    expect(options("getrole")[0].name).toBe("role");
    expect(options("getrole")[0].type).toBe(8);
    expect(options("getrole")[0].required).toBe(true);
    expect(options("deletekey").find((item: any) => item.name === "key").required).toBe(true);
    expect(options("deletekey").find((item: any) => item.name === "user").required).toBe(false);
    expect(options("whitelist")).toHaveLength(3);
    expect(options("whitelist").find((item: any) => item.name === "script").autocomplete).toBe(true);
    expect(options("whitelist").find((item: any) => item.name === "script").required).toBe(true);
    expect(options("whitelist").find((item: any) => item.name === "user").required).toBe(false);
    expect(options("whitelist").find((item: any) => item.name === "role").required).toBe(false);
    expect(options("whitelist")).not.toContainEqual(expect.objectContaining({ name: "kind" }));
    expect(options("whitelist")).not.toContainEqual(expect.objectContaining({ name: "target" }));
    expect(options("unwhitelist")).toHaveLength(3);
    expect(options("unwhitelist").find((item: any) => item.name === "script").autocomplete).toBe(true);
    expect(options("unwhitelist").find((item: any) => item.name === "user").required).toBe(false);
    expect(options("unwhitelist").find((item: any) => item.name === "role").required).toBe(false);
    expect(options("blacklist").find((item: any) => item.name === "script").required).toBe(true);
    expect(options("blacklist").find((item: any) => item.name === "script").autocomplete).toBe(true);
    expect(options("blacklist").find((item: any) => item.name === "user").required).toBe(true);
    expect(options("resethwid").find((item: any) => item.name === "script").required).toBe(true);
    expect(options("resethwid").find((item: any) => item.name === "user").required).toBe(true);
    expect(options("addtime").every((item: any) => item.required)).toBe(true);
    expect(options("warn").every((item: any) => item.required)).toBe(true);
    expect(options("dropkey").find((item: any) => item.name === "amount").required).toBe(true);
  });

  it("autocompletes existing panels for the linked workspace", async () => {
    vi.spyOn(db, "getUserByDiscordUserId").mockResolvedValue({ id: 7, discordUserId: "owner-id" } as any);
    vi.spyOn(db, "getDiscordPanelsByOwner").mockResolvedValue([{ id: 21, name: "Panel principal", targetScript: "Vanta Script", channelId: "123456789012345678" }] as any);
    const interaction = { options: { getFocused: () => ({ name: "panel", value: "principal" }) }, user: { id: "owner-id" } };
    await expect(targetChoices(interaction)).resolves.toEqual([{ name: "Panel principal · Vanta Script", value: "panel:21" }]);
  });

  it("autocompletes hosted scripts for the owner with cache support", async () => {
    const scripts = [{ id: 1, name: "Vanta Script" }];
    vi.spyOn(db, "getUserByOpenId").mockResolvedValue({ id: 1, discordUserId: "owner-id" } as any);
    vi.spyOn(db, "getHostedScriptsByUser").mockResolvedValue(scripts as any);
    const interaction = { options: { getFocused: () => ({ name: "script", value: "vanta" }) }, user: { id: "owner-id" } };
    const results = await targetChoices(interaction);
    expect(results).toEqual([{ name: "Vanta Script · #1", value: "script:1" }]);
  });

  it("autocompletes guild users and roles based on the selected kind", async () => {
    const members = new Map([
      ["1501316920975036611", { user: { id: "1501316920975036611", username: "hernan" }, displayName: "Hernán" }],
      ["1501316920975036612", { user: { id: "1501316920975036612", username: "other" }, displayName: "Other" }],
    ]);
    const roles = new Map([
      ["1501316920975036613", { id: "1501316920975036613", name: "Premium" }],
      ["1501316920975036614", { id: "1501316920975036614", name: "Staff" }],
    ]);
    const make = (kind: string, focused: string) => ({ guildId: "1501316920975036615", options: { getString: () => kind, getFocused: () => ({ name: "target", value: focused }) }, guild: { members: { cache: members }, roles: { cache: roles } } });
    expect(await targetChoices(make("user", "hern"))).toEqual([{ name: "@Hernán", value: "user:1501316920975036611" }]);
    expect(await targetChoices(make("role", "prem"))).toEqual([{ name: "@Premium", value: "role:1501316920975036613" }]);
  });

  it("recognizes the Discord guild owner independently from the linked database identity", () => {
    expect(isGuildOwner({ actorId: "guild-owner", guildOwnerId: "guild-owner" })).toBe(true);
    expect(isGuildOwner({ actorId: "other-user", guildOwnerId: "guild-owner" })).toBe(false);
    expect(isGuildOwner({ actorId: "guild-owner", guildOwnerId: null })).toBe(false);
  });

  it("resolves script autocomplete selections by exact owner-scoped script id", async () => {
    const lookup = vi.spyOn(db, "getHostedScriptByOwnerId").mockResolvedValue({ id: 240002, userId: 1, name: "Vanta anti tp bat" } as any);
    const script = await resolveScriptSelection(1, "script:240002");
    expect(lookup).toHaveBeenCalledWith(1, 240002);
    expect(script?.id).toBe(240002);
    lookup.mockRestore();
  });

  it("formats a safe whitelist diagnostic with guild, member, roles and script context", () => {
    const diagnostic = formatWhitelistDiagnostic({ guildId: "1500000000000000001", memberId: "1500000000000000002", roleIds: ["1500000000000000003"], ownerId: 7, panelScriptId: 9, activeRuleIds: ["role:1500000000000000003@9"] });
    expect(diagnostic).toContain("guild=1500000000000000001");
    expect(diagnostic).toContain("roles=1500000000000000003");
    expect(diagnostic).toContain("script=9");
    expect(diagnostic).not.toContain("keyCode");
  });

  it("matches active whitelist rules against the member Discord identity and roles", () => {
    expect(matchesWhitelistRule({ kind: "user", discordId: "1501316920975036611", hostedScriptId: 7, active: 1 }, "1501316920975036611", [])).toBe(true);
    expect(matchesWhitelistRule({ kind: "role", discordId: "1501316920975036613", hostedScriptId: 7, active: 1 }, "1501316920975036612", ["1501316920975036613"])).toBe(true);
    expect(matchesWhitelistRule({ kind: "role", discordId: "1501316920975036613", hostedScriptId: 7, active: 1 }, "1501316920975036612", ["1501316920975036614"])).toBe(false);
    expect(matchesWhitelistRule({ kind: "role", discordId: "1501316920975036613", hostedScriptId: 7, active: 0 }, "1501316920975036612", ["1501316920975036613"])).toBe(false);
    expect(matchesWhitelistRule({ kind: "user", discordId: "1501316920975036611", hostedScriptId: 7, active: 1 }, "1501316920975036611", [])).toBe(true);
  });

  it("keeps panel buttons scoped to the owning account and script", () => {
    const message = panelMessage({ ownerId: 42, hostedScriptId: 7 });
    const ids = message.components.flatMap((row: any) => row.components.map((button: any) => button.data.custom_id));
    expect(ids).toEqual(["vanta:redeem:42:7", "vanta:script:42:7", "vanta:role:42:7", "vanta:hwid:42:7", "vanta:stats:42:7"]);
  });

  it("recognizes the linked owner identity using normalized Discord IDs", () => {
    expect(isConfiguredOwnerId({ actorId: " 1501316920975036611 ", linkedDiscordUserId: "1501316920975036611" })).toBe(true);
    expect(isConfiguredOwnerId({ actorId: "1501316920975036611", linkedDiscordUserId: "other" })).toBe(false);
    expect(isConfiguredOwnerId({ actorId: "1501316920975036611", linkedDiscordUserId: null })).toBe(false);
  });

  it("allows key management only to the owner, an administrator or the configured role", () => {
    expect(hasKeyManagementAccess({ actorId: "owner", ownerId: "owner", isAdministrator: false, hasManagerRole: false })).toBe(true);
    expect(hasKeyManagementAccess({ actorId: "admin", ownerId: "owner", isAdministrator: true, hasManagerRole: false })).toBe(true);
    expect(hasKeyManagementAccess({ actorId: "manager", ownerId: "owner", isAdministrator: false, hasManagerRole: true })).toBe(true);
    expect(hasKeyManagementAccess({ actorId: "buyer", ownerId: "owner", isAdministrator: false, hasManagerRole: false })).toBe(false);
  });
});
