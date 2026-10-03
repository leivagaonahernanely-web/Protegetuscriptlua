export type SetupSettings = {
  script: string;
  permissions: string;
  trialDays: string;
  channel: string;
  guildId: string;
};

export const defaultSetup: SetupSettings = {
  script: "",
  permissions: "View Channels, Send Messages",
  trialDays: "3",
  channel: "",
  guildId: "",
};

export function parseDiscordChannelInput(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return { channelId: "", guildId: "" };
  if (/^\d{15,22}$/.test(trimmed)) return { channelId: trimmed, guildId: "" };
  try {
    const url = new URL(trimmed);
    if (url.hostname !== "discord.com" && url.hostname !== "www.discord.com" && url.hostname !== "discordapp.com") return null;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 3 || parts[0] !== "channels" || !/^\d{15,22}$/.test(parts[1]) || !/^\d{15,22}$/.test(parts[2])) return null;
    return { channelId: parts[2], guildId: parts[1] };
  } catch {
    return null;
  }
}

export function isValidDiscordChannelId(value: string) {
  return parseDiscordChannelInput(value) !== null;
}

export function loadSetupSettings(storage: Pick<Storage, "getItem">): SetupSettings {
  return {
    script: storage.getItem("vanta.setup.script") ?? defaultSetup.script,
    permissions: storage.getItem("vanta.setup.permissions") ?? defaultSetup.permissions,
    trialDays: storage.getItem("vanta.setup.trialDays") ?? defaultSetup.trialDays,
    channel: storage.getItem("vanta.setup.channel") ?? defaultSetup.channel,
    guildId: storage.getItem("vanta.setup.guild") ?? defaultSetup.guildId,
  };
}

export function saveSetupSettings(storage: Pick<Storage, "setItem">, settings: SetupSettings) {
  storage.setItem("vanta.setup.script", settings.script);
  storage.setItem("vanta.setup.permissions", settings.permissions);
  storage.setItem("vanta.setup.trialDays", settings.trialDays);
  storage.setItem("vanta.setup.channel", settings.channel);
  storage.setItem("vanta.setup.guild", settings.guildId);
}

export function getSetupStatus(channel: string, saved: boolean) {
  if (!isValidDiscordChannelId(channel)) return { kind: "invalid" as const, label: "Canal inválido" };
  if (saved) return { kind: "saved" as const, label: "Configuración guardada" };
  return { kind: "ready" as const, label: "Lista para guardar" };
}

export function getDiscordChannelUpdate(channel: string) {
  const parsed = parseDiscordChannelInput(channel);
  return { discordChannelId: parsed?.channelId || null };
}

export function clearRejectedDiscordChannel(storage: Pick<Storage, "setItem">, settings: SetupSettings) {
  const next = { ...settings, channel: "" };
  saveSetupSettings(storage, next);
  return next;
}
