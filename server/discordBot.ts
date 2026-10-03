import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  ModalBuilder,
  PermissionFlagsBits,
  REST,
  Role,
  Routes,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { durationToMs } from "../shared/duration";
import { buildPlansDescription } from "../shared/plans";
import { ENV } from "./_core/env";
import { makeLoaderToken } from "./loaderTokens";
import {
  createAccessRuleIfAbsent,
  createBlacklist,
  createKeyAuditLog,
  createWarning,
  addTimeToLicense,
  deleteAccessRuleByDiscordId,
  getAccessRulesByOwner,
  createLicense,
  deleteLicenseByKeyCode,
  getKeyManagerRoleId,
  getHostedScriptByName,
  getHostedScriptById,
  getHostedScriptByOwnerId,
  getHostedScriptsByUser,
  getDiscordPanelsByOwner,
  getLicensesByOwner,
  getActiveLicensesByDiscordUserId,
  getApiKeyByDiscordUserId,
  ensureUserApiKey,
  linkDiscordIdentity,
  getBuyerRoleId,
  setBuyerRoleId,
  getUserByDiscordUserId,
  getUserById,
  getUserByOpenId,
  isDiscordUserBlacklistedForScript,
  redeemLicense,
  resetLicenseHwidByDiscordUserId,
  setKeyManagerRole,
} from "./db";
import { randomInt } from "node:crypto";

const PANEL_URL = "https://vanta-prot-hfw5hmym.manus.space";
export const GET_SCRIPT_COPY_BUTTON_LABEL = "Mobile View Script";
export const discordCommands = [
  new SlashCommandBuilder().setName("ping").setDescription("Verifica la latencia del bot").toJSON(),
  new SlashCommandBuilder().setName("panel").setDescription("Publica un panel existente de Vanta.vs Protector").addStringOption(o => o.setName("panel").setDescription("Panel existente").setAutocomplete(true).setRequired(true)).toJSON(),
  new SlashCommandBuilder().setName("stats").setDescription("Muestra el estado del acceso").toJSON(),
  new SlashCommandBuilder().setName("apikey").setDescription("Muestra la API key de tu cuenta vinculada").toJSON(),
  new SlashCommandBuilder().setName("getscript").setDescription("Obtiene el enlace de acceso al script").toJSON(),
  new SlashCommandBuilder().setName("getrole").setDescription("Configura el rol que recibirá un usuario con key activa").addRoleOption(o => o.setName("role").setDescription("Rol comprador").setRequired(true)).toJSON(),
  new SlashCommandBuilder().setName("redeem").setDescription("Canjea una key de acceso").addStringOption(o => o.setName("key").setDescription("Key alfanumérica de mínimo 32 caracteres").setRequired(true)).toJSON(),
  new SlashCommandBuilder().setName("generatekey").setDescription("Genera una key aleatoria para un script hosteado").addStringOption(o => o.setName("script").setDescription("Script hosteado").setAutocomplete(true).setRequired(true)).addStringOption(o => o.setName("duration").setDescription("Duración; vacío = forever").setRequired(false)).toJSON(),
  new SlashCommandBuilder().setName("deletekey").setDescription("Elimina una key").addStringOption(o => o.setName("key").setDescription("Key a eliminar").setRequired(true)).addUserOption(o => o.setName("user").setDescription("Usuario opcional").setRequired(false)).addRoleOption(o => o.setName("role").setDescription("Rol opcional").setRequired(false)).toJSON(),
  new SlashCommandBuilder().setName("whitelist").setDescription("Añade un usuario o rol a la whitelist").addStringOption(o => o.setName("script").setDescription("Script hosteado").setAutocomplete(true).setRequired(true)).addUserOption(o => o.setName("user").setDescription("Usuario del servidor").setRequired(false)).addRoleOption(o => o.setName("role").setDescription("Rol del servidor").setRequired(false)).toJSON(),
  new SlashCommandBuilder().setName("unwhitelist").setDescription("Retira un usuario o rol de la whitelist").addStringOption(o => o.setName("script").setDescription("Script hosteado").setAutocomplete(true).setRequired(true)).addUserOption(o => o.setName("user").setDescription("Usuario del servidor").setRequired(false)).addRoleOption(o => o.setName("role").setDescription("Rol del servidor").setRequired(false)).toJSON(),
  new SlashCommandBuilder().setName("blacklist").setDescription("Bloquea un usuario para un script").addStringOption(o => o.setName("script").setDescription("Script objetivo").setAutocomplete(true).setRequired(true)).addUserOption(o => o.setName("user").setDescription("Usuario obligatorio").setRequired(true)).addStringOption(o => o.setName("reason").setDescription("Razón").setRequired(false)).toJSON(),
  new SlashCommandBuilder().setName("resethwid").setDescription("Reinicia el HWID de un usuario").addStringOption(o => o.setName("script").setDescription("Script objetivo").setRequired(true)).addUserOption(o => o.setName("user").setDescription("Usuario obligatorio").setRequired(true)).toJSON(),
  new SlashCommandBuilder().setName("addtime").setDescription("Añade tiempo a una key").addStringOption(o => o.setName("key").setDescription("Key obligatoria").setRequired(true)).addStringOption(o => o.setName("duration").setDescription("Tiempo a añadir").setRequired(true)).toJSON(),
  new SlashCommandBuilder().setName("warn").setDescription("Advierte a un usuario").addUserOption(o => o.setName("user").setDescription("Usuario obligatorio").setRequired(true)).addStringOption(o => o.setName("reason").setDescription("Razón obligatoria").setRequired(true)).toJSON(),
  new SlashCommandBuilder().setName("dropkey").setDescription("Genera un drop de keys").addIntegerOption(o => o.setName("amount").setDescription("Cantidad de keys").setRequired(true).setMinValue(1).setMaxValue(50)).toJSON(),
  new SlashCommandBuilder().setName("prices").setDescription("Publica la información de precios").toJSON(),
  new SlashCommandBuilder().setName("updates").setDescription("Publica una actualización del proyecto").toJSON(),
  new SlashCommandBuilder().setName("generatekeyrol").setDescription("Configura el rol autorizado para gestionar keys").addRoleOption(o => o.setName("role").setDescription("Rol delegado").setRequired(true)).toJSON(),
];

let started = false;
let gatewayOnline = false;
const memberRoleCache = new Map<string, { roleIds: string[]; expiresAt: number }>();
const MEMBER_ROLE_CACHE_MS = 10_000;
let client: Client | null = null;
export function createReconnectGate(schedule: () => void, delayMs = 5_000) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    schedule() { if (timer) return false; timer = setTimeout(() => { timer = null; schedule(); }, delayMs); return true; },
    cancel() { if (timer) clearTimeout(timer); timer = null; },
    pending() { return timer !== null; },
  };
}
export function getDiscordGatewayStatus() { return { online: gatewayOnline, configured: Boolean(ENV.discordBotToken), username: client?.user?.username ?? null }; }
const reconnectGate = createReconnectGate(() => { if (!started) startDiscordBot(); });
function scheduleReconnect() { if (!ENV.discordBotToken) return false; return reconnectGate.schedule(); }
export function handleGatewayFailure(reason: string, reconnect: () => boolean = scheduleReconnect) {
  gatewayOnline = false;
  started = false;
  console.warn(`[Discord Bot] ${reason}; reintentando en 5 segundos.`);
  client?.destroy();
  client = null;
  return reconnect();
}
const keyActionTimestamps = new Map<string, number>();
const KEY_ACTION_COOLDOWN_MS = 10_000;
const respondedInteractions = new WeakSet<object>();
const processingInteractions = new WeakSet<object>();
const ownerAccountCache = new Map<string, { expiresAt: number; user: any }>();
const OWNER_ACCOUNT_CACHE_MS = 15_000;
const CONFIGURED_OWNER_DISCORD_ID = "1501316920975036611";
const scriptChoiceCache = new Map<number, { expiresAt: number; scripts: any[] }>();
const SCRIPT_CHOICE_CACHE_MS = 15_000;
const SCRIPT_CHOICE_TIMEOUT_MS = 2_500;

const KEY_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
function keyCode() { let key = ""; for (let index = 0; index < 32; index += 1) key += KEY_ALPHABET[randomInt(0, KEY_ALPHABET.length)]; return key; }
function memberHasRole(interaction: ButtonInteraction | any, roleId: string | undefined) {
  if (!roleId) return false;
  const roles = interaction.member?.roles;
  return Array.isArray(roles) ? roles.includes(roleId) : Boolean(roles?.cache?.has(roleId));
}
export function hasKeyManagementAccess(input: { actorId: string; ownerId?: string | null; isAdministrator: boolean; hasManagerRole: boolean }) {
  const actorId = String(input.actorId ?? "").trim();
  const ownerId = String(input.ownerId ?? "").trim();
  return Boolean(ownerId && (actorId === ownerId || input.isAdministrator || input.hasManagerRole));
}
function normalizeDiscordId(value: unknown) {
  const id = String(value ?? "").trim();
  return /^\d{15,22}$/.test(id) ? id : null;
}

export function matchesWhitelistRule(rule: { kind: "user" | "role"; discordId: string; active?: number | null; hostedScriptId?: number | null }, discordUserId: string, roleIds: string[]) {
  if (Number(rule.active) === 0 || !rule.hostedScriptId) return false;
  const memberId = normalizeDiscordId(discordUserId);
  const ruleId = normalizeDiscordId(rule.discordId);
  if (!memberId || !ruleId) return false;
  return rule.kind === "user" ? ruleId === memberId : roleIds.some((roleId) => normalizeDiscordId(roleId) === ruleId);
}
export function isGuildOwner(input: { actorId: string; guildOwnerId?: string | null }) {
  return Boolean(input.guildOwnerId && input.actorId === input.guildOwnerId);
}
function normalizeDiscordIdentity(value: unknown) {
  const normalized = String(value ?? "").trim();
  return normalized || undefined;
}
export function isConfiguredOwnerId(input: { actorId: unknown; linkedDiscordUserId?: unknown | null }) {
  const actorId = normalizeDiscordIdentity(input.actorId);
  const linkedDiscordUserId = normalizeDiscordIdentity(input.linkedDiscordUserId);
  return Boolean(actorId && linkedDiscordUserId && actorId === linkedDiscordUserId);
}
function getPanelContext(interaction: any) {
  const parts = String(interaction?.customId ?? "").split(":");
  if (parts[0] !== "vanta" || !["redeem", "redeem-modal", "script", "role", "hwid", "stats", "copy-loader"].includes(parts[1])) return undefined;
  const ownerId = Number(parts[2]);
  if (!Number.isInteger(ownerId) || ownerId <= 0) return undefined;
  const hostedScriptId = Number(parts[3]);
  return { ownerId, hostedScriptId: Number.isInteger(hostedScriptId) && hostedScriptId > 0 ? hostedScriptId : undefined };
}
function panelActionId(action: string, ownerId?: number, hostedScriptId?: number) {
  return ownerId ? `vanta:${action}:${ownerId}${hostedScriptId ? `:${hostedScriptId}` : ""}` : `vanta:${action}`;
}

async function ownerAccount(interaction?: any) {
  const panelContext = getPanelContext(interaction);
  const actorId = normalizeDiscordIdentity(interaction?.user?.id);
  const cacheKey = panelContext ? `panel:${panelContext.ownerId}` : actorId ? `actor:${actorId}` : "configured";
  const cached = ownerAccountCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.user;
  let resolved;
  if (panelContext) resolved = await getUserById(panelContext.ownerId);
  if (!resolved && actorId) resolved = await getUserByDiscordUserId(actorId);
  if (!resolved && ENV.ownerOpenId) resolved = await getUserByOpenId(ENV.ownerOpenId);
  if (resolved) ownerAccountCache.set(cacheKey, { user: resolved, expiresAt: Date.now() + OWNER_ACCOUNT_CACHE_MS });
  return resolved;
}
async function configuredWorkspaceOwner(interaction?: any) {
  const configured = ENV.ownerOpenId ? await getUserByOpenId(ENV.ownerOpenId) : undefined;
  if (configured) return configured;
  const configuredIdentity = await getUserByDiscordUserId(CONFIGURED_OWNER_DISCORD_ID);
  if (configuredIdentity?.id) return getUserById(configuredIdentity.id);
  return ownerAccount(interaction);
}
async function warmScriptChoiceCache() {
  try {
    const owner = await ownerAccount();
    if (!owner) return;
    const scripts = await getHostedScriptsByUser(owner.id);
    scriptChoiceCache.set(owner.id, { expiresAt: Date.now() + SCRIPT_CHOICE_CACHE_MS, scripts });
    console.log(`[Discord Bot] Autocomplete de scripts listo: ${scripts.length} script(s) cargado(s).`);
  } catch (error) {
    console.warn("[Discord Bot] No se pudo precargar el autocomplete de scripts:", error instanceof Error ? error.message : "unknown error");
  }
}
async function isConfiguredOwner(interaction: any) {
  const owner = await configuredWorkspaceOwner(interaction);
  if (!owner) return false;
  const actorId = normalizeDiscordIdentity(interaction.user?.id);
  const linkedId = normalizeDiscordIdentity(owner.discordUserId);
  if (actorId === CONFIGURED_OWNER_DISCORD_ID && (!linkedId || linkedId === CONFIGURED_OWNER_DISCORD_ID)) {
    if (!linkedId) await linkDiscordIdentity(owner.id, CONFIGURED_OWNER_DISCORD_ID, interaction.user.globalName || interaction.user.username || "Discord owner", interaction.user.globalName || null, interaction.user.displayAvatarURL?.({ extension: "png", size: 128 }) ?? null);
    return true;
  }
  if (isConfiguredOwnerId({ actorId, linkedDiscordUserId: linkedId })) return true;
  // Bootstrap only when the owner account has not been linked yet. This keeps
  // whitelist administration owner-only without allowing an arbitrary member.
  if (!linkedId && isGuildOwner({ actorId: String(interaction.user?.id ?? ""), guildOwnerId: interaction.guild?.ownerId })) {
    await linkDiscordIdentity(owner.id, String(interaction.user.id), interaction.user.globalName || interaction.user.username || "Discord owner", interaction.user.globalName || null, interaction.user.displayAvatarURL?.({ extension: "png", size: 128 }) ?? null);
    return true;
  }
  return false;
}
async function canManageKeys(interaction: any) {
  // Key administration always belongs to the configured workspace owner. A
  // delegated manager usually has no web user row of their own, so resolving
  // the actor first can accidentally select the wrong workspace or return no
  // owner at all.
  const panelOwner = getPanelContext(interaction)?.ownerId;
  const configuredOwner = ENV.ownerOpenId ? await getUserByOpenId(ENV.ownerOpenId) : undefined;
  const owner = panelOwner ? await getUserById(panelOwner) : (configuredOwner ?? await ownerAccount(interaction));
  if (!owner) return { allowed: false, owner: undefined };
  const managerRole = await getKeyManagerRoleId(owner.id);
  const actorId = String(interaction.user?.id ?? "");
  const actorIsConfiguredOwner = await isConfiguredOwner(interaction);
  const actorIsGuildOwner = isGuildOwner({ actorId, guildOwnerId: interaction.guild?.ownerId });
  const isAdministrator = Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.Administrator));
  const hasManagerRole = memberHasRole(interaction, managerRole);
  const allowed = actorIsConfiguredOwner || actorIsGuildOwner || isAdministrator || hasManagerRole;
  return { allowed, owner };
}
export async function respond(interaction: any, payload: any) {
  const target = interaction as object;
  if (respondedInteractions.has(target)) return undefined;
  respondedInteractions.add(target);
  if (interaction.deferred && interaction.editReply) return interaction.editReply(payload);
  if (interaction.replied || interaction.deferred) return interaction.followUp(payload);
  return interaction.reply(payload);
}
async function prepareInteraction(interaction: any) {
  if (interaction.replied || interaction.deferred || !interaction.deferReply) return;
  // Autocomplete must answer with respond(), and redeem opens a modal; neither
  // can be deferred. Every other interaction gets an acknowledgement before DB
  // and Discord API work so Discord never displays “The application did not respond”.
  if (interaction.isAutocomplete?.() || (interaction.isButton?.() && String(interaction.customId ?? "").startsWith("vanta:redeem"))) return;
  const publicCommand = ["panel", "prices", "updates", "dropkey", "warn", "whitelist", "unwhitelist", "blacklist"].includes(String(interaction.commandName ?? ""));
  const ephemeral = interaction.isModalSubmit?.() || interaction.isButton?.() || !publicCommand;
  await interaction.deferReply({ ephemeral });
}
export function mobileViewScriptMessage(script: any, accessKey: string, licenseId: number) {
  return scriptRuntimeLoader(script, accessKey, licenseId);
}

export function getScriptDisplayMessage(script: any, accessKey: string, licenseId: number) {
  return "📜 **" + script.name + "**\n\n```lua\n" + scriptRuntimeLoader(script, accessKey, licenseId) + "\n```";
}

export function scriptRuntimeLoader(script: any, accessKey?: string, licenseId?: number) {
  const url = `${PANEL_URL}/scripts/hosted/${script.slug}`;
  const runtimeKey = script.ffaMode ? "trial" : (accessKey || script.scriptKey);
  if (!script.ffaMode && accessKey && licenseId) {
    const compactUrl = `${PANEL_URL}/scripts/loaders/${makeLoaderToken(licenseId, accessKey)}`;
    return `script_key = "${accessKey}"\nloadstring(game:HttpGet("${compactUrl}"))()`;
  }
  const accessUrl = runtimeKey ? `${url}?key=${encodeURIComponent(runtimeKey)}` : url;
  const load = script.ffaMode || !runtimeKey
    ? `loadstring(game:HttpGet("${accessUrl}"))()`
    : `local hwid = game:GetService("RbxAnalyticsService"):GetClientId()\nloadstring(game:HttpGet("${accessUrl}&hwid=" .. hwid))()`;
  return !script.ffaMode && runtimeKey ? `script_key = "${runtimeKey}"\n${load}` : load;
}

export function panelMessage(context?: { ownerId?: number; hostedScriptId?: number }) {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("Vanta.vs Protector · Access Panel")
    .setDescription("Este panel de control es para el proyecto: **Vanta.vs Protector**\n\nSi eres comprador, utiliza los botones de abajo para canjear tu key, obtener el script autorizado o conseguir tu rol.")
    .setFooter({ text: "Vanta.vs Protector · Panel de acceso" })
    .setTimestamp();
  const rowOne = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(panelActionId("redeem", context?.ownerId, context?.hostedScriptId)).setLabel("🔑 Redeem Key").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(panelActionId("script", context?.ownerId, context?.hostedScriptId)).setLabel("📜 Get Script").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(panelActionId("role", context?.ownerId, context?.hostedScriptId)).setLabel("👤 Get Role").setStyle(ButtonStyle.Primary),
  );
  const rowTwo = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(panelActionId("hwid", context?.ownerId, context?.hostedScriptId)).setLabel("⚙️ Reset HWID").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(panelActionId("stats", context?.ownerId, context?.hostedScriptId)).setLabel("📊 Get Stats").setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [rowOne, rowTwo] };
}

export async function publishUpdatesMessage(channelId: string, config: { title: string; description: string }) {
  if (!client || !gatewayOnline) throw new Error("El Gateway Discord no está conectado.");
  const channel = await client.channels.fetch(channelId);
  if (!channel?.isTextBased() || !("send" in channel)) throw new Error("El canal Discord no permite mensajes.");
  const title = config.title.trim();
  const description = config.description.trim();
  if (!title || !description) throw new Error("El título y el contenido de la actualización son obligatorios.");
  const embed = new EmbedBuilder()
    .setColor(0xe93540)
    .setAuthor({ name: `${title} · APP` })
    .setTitle(title)
    .setDescription(description)
    .setFooter({ text: `Actualización · ${new Date().getFullYear()} | Vanta.vs Protector` })
    .setTimestamp();
  const sent = await channel.send({ embeds: [embed] });
  return { channelId, title, messageId: sent.id };
}

export async function publishPricesMessage(channelId: string, config: { title: string; description: string }) {
  if (!client || !gatewayOnline) throw new Error("El Gateway Discord no está conectado.");
  const channel = await client.channels.fetch(channelId);
  if (!channel?.isTextBased() || !("send" in channel)) throw new Error("El canal Discord no permite mensajes.");
  const title = config.title.trim();
  const description = config.description.trim();
  if (!title || !description) throw new Error("El nombre y la descripción de Prices son obligatorios.");
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setAuthor({ name: `${title} · APP` })
    .setTitle(title)
    .setDescription(description)
    .setFooter({ text: `Copyright © ${new Date().getFullYear()} | ${title}` })
    .setTimestamp();
  const sent = await channel.send({ embeds: [embed] });
  return { channelId, title, messageId: sent.id };
}

export async function publishDiscordPanel(channelId: string, config?: { name?: string; description?: string; script?: string; hwidHours?: number; ownerId?: number; hostedScriptId?: number }) {
  if (!client || !gatewayOnline) throw new Error("El Gateway Discord no está conectado.");
  const channel = await client.channels.fetch(channelId);
  if (!channel?.isTextBased() || !("send" in channel)) throw new Error("El canal Discord no permite mensajes.");
  const base = panelMessage({ ownerId: config?.ownerId, hostedScriptId: config?.hostedScriptId });
  const embed = new EmbedBuilder().setColor(0x5865f2).setTitle(config?.name?.trim() || "Vanta.vs Protector · Access Panel").setDescription(config?.description?.trim() || "Este panel permite canjear tu key, obtener el script autorizado y conseguir tu rol.").setFooter({ text: config?.script ? `Script: ${config.script}` : "Vanta.vs Protector · Panel de acceso" }).setTimestamp();
  const sent = await channel.send({ embeds: [embed], components: base.components });
  return { channelId, title: config?.name?.trim() || "Vanta.vs Protector · Access Panel", messageId: sent.id };
}

export async function deletePublishedPanel(channelId: string, messageId: string) {
  if (!client || !gatewayOnline) throw new Error("El Gateway Discord no está conectado.");
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased() || !("messages" in channel)) throw new Error("El canal Discord no permite administrar mensajes.");
    const message = await channel.messages.fetch(messageId);
    await message.delete();
  } catch (error: any) {
    if (error?.code === 10008 || /unknown message/i.test(String(error?.message ?? ""))) return;
    throw error;
  }
}

export function startDiscordBot() {
  if (started || !ENV.discordBotToken) {
    if (!ENV.discordBotToken) console.warn("[Discord Bot] DISCORD_BOT_TOKEN no está configurado; el Gateway no se inicia.");
    return;
  }
  started = true;
  client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
  client.once(Events.ClientReady, async (readyClient) => {
    gatewayOnline = true;
    try {
      const rest = new REST({ version: "10" }).setToken(ENV.discordBotToken);
      await rest.put(Routes.applicationCommands(readyClient.application.id), { body: [] });
      await Promise.all(Array.from(readyClient.guilds.cache.keys()).map((guildId) => rest.put(Routes.applicationGuildCommands(readyClient.application.id, guildId), { body: discordCommands })));
      console.log(`[Discord Bot] Online como ${readyClient.user.tag}; comandos slash sincronizados por servidor sin duplicados.`);
      void warmScriptChoiceCache();
    } catch (error) {
      const detail = error && typeof error === "object" && "rawError" in error ? JSON.stringify((error as { rawError?: unknown }).rawError) : error instanceof Error ? error.message : String(error);
      console.error("[Discord Bot] No se pudieron sincronizar los comandos slash; el Gateway sigue online:", detail);
    }
  });
  client.on(Events.InteractionCreate, handleInteraction);
  client.on(Events.Error, (error) => { console.error("[Discord Bot] Gateway error:", error); handleGatewayFailure("Gateway error"); });
  client.on(Events.ShardDisconnect, () => { handleGatewayFailure("Gateway desconectado"); });
  client.login(ENV.discordBotToken).catch((error) => { started = false; gatewayOnline = false; console.error("[Discord Bot] No se pudo iniciar el Gateway:", error instanceof Error ? error.message : "error desconocido"); scheduleReconnect(); });
}

export async function targetChoices(interaction: any) {
  const focused = interaction.options.getFocused?.(true);
  const query = String(focused?.value ?? "").toLowerCase();
  if (focused?.name === "panel") {
    const owner = await ownerAccount(interaction);
    if (!owner) return [];
    const panels = await getDiscordPanelsByOwner(owner.id);
    return panels.filter((panel: any) => !query || `${panel.name} ${panel.channelId} ${panel.targetScript}`.toLowerCase().includes(query)).slice(0, 25).map((panel: any) => ({ name: `${panel.name} · ${panel.targetScript}`.slice(0, 100), value: `panel:${panel.id}` }));
  }
  if (focused?.name === "script") {
    const owner = await ownerAccount(interaction);
    if (!owner) return [];
    const cached = scriptChoiceCache.get(owner.id);
    let scripts = cached && cached.expiresAt > Date.now() ? cached.scripts : undefined;
    if (!scripts) {
      try {
        scripts = await Promise.race([
          getHostedScriptsByUser(owner.id),
          new Promise<any[]>((_, reject) => setTimeout(() => reject(new Error("script autocomplete timeout")), SCRIPT_CHOICE_TIMEOUT_MS)),
        ]);
        scriptChoiceCache.set(owner.id, { expiresAt: Date.now() + SCRIPT_CHOICE_CACHE_MS, scripts });
      } catch (error) {
        console.warn("[Discord Bot] Script autocomplete unavailable:", error instanceof Error ? error.message : "unknown error");
        scripts = cached?.scripts ?? [];
      }
    }
    return scripts.filter((script: any) => !query || `${script.name} ${script.id}`.toLowerCase().includes(query)).slice(0, 25).map((script: any) => ({ name: `${script.name} · #${script.id}`.slice(0, 100), value: `script:${script.id}` }));
  }
  const kind = interaction.options.getString("kind") ?? "user";
  return kind === "role"
    ? [...(interaction.guild?.roles?.cache?.values?.() ?? [])].filter((role: Role) => role.id !== interaction.guildId && (!query || role.name.toLowerCase().includes(query))).slice(0, 25).map((role: Role) => ({ name: `@${role.name}`.slice(0, 100), value: `role:${role.id}` }))
    : [...(interaction.guild?.members?.cache?.values?.() ?? [])].filter((member: any) => !member.user?.bot && (!query || `${member.displayName} ${member.user?.username}`.toLowerCase().includes(query))).slice(0, 25).map((member: any) => ({ name: `@${member.displayName || member.user.username}`.slice(0, 100), value: `user:${member.user.id}` }));
}

export async function handleInteraction(interaction: any) {
  const interactionTarget = interaction as object;
  if (processingInteractions.has(interactionTarget) || interaction.replied) return;
  processingInteractions.add(interactionTarget);
  try {
    if (interaction.isAutocomplete?.()) {
      try {
        if (interaction.responded) return;
        return await interaction.respond(await targetChoices(interaction));
      } catch (error: any) {
        if (error?.code === 40060 || /already been acknowledged/i.test(String(error?.message ?? ""))) return;
        console.error("[Discord Bot] Autocomplete failed:", error);
        if (!interaction.responded) return interaction.respond([]).catch(() => undefined);
      }
    }
    try {
      await prepareInteraction(interaction);
    } catch (error: any) {
      if (error?.code === 10062 || error?.code === 40060 || /unknown interaction|already been acknowledged/i.test(String(error?.message ?? ""))) return;
      throw error;
    }
    if (interaction.isModalSubmit()) return handleModal(interaction);
    if (interaction.isButton()) return handleButton(interaction);
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName === "ping") return respond(interaction, { content: `Pong · ${Math.round(client?.ws.ping ?? 0)}ms`, ephemeral: true });
    if (interaction.commandName === "panel") {
      if (!(await isConfiguredOwner(interaction))) return respond(interaction, { content: "⛔ Solo el owner vinculado desde la web puede publicar el panel.", ephemeral: true });
      const owner = await ownerAccount(interaction);
      const selected = interaction.options.getString("panel", true);
      const panelId = Number(selected.replace(/^panel:/, ""));
      const panels = owner ? await getDiscordPanelsByOwner(owner.id) : [];
      const panel = panels.find((item: any) => item.id === panelId);
      if (!owner || !panel) return respond(interaction, { content: "❌ Selecciona un panel existente de tu workspace.", ephemeral: true });
      const script = await getHostedScriptByName(owner.id, panel.targetScript);
      if (!script) return respond(interaction, { content: "❌ El script asociado a ese panel ya no pertenece a tu workspace.", ephemeral: true });
      return respond(interaction, { content: `✅ Panel **${panel.name}** colocado con **${script.name}**.`, ephemeral: false, ...panelMessage({ ownerId: owner.id, hostedScriptId: script.id }) });
    }
    if (interaction.commandName === "prices") return prices(interaction);
    if (interaction.commandName === "updates") return updates(interaction);
    if (interaction.commandName === "stats") return respond(interaction, { content: "Vanta.vs Protector está conectado. Usa el dashboard web para consultar scripts, licencias y actividad.", ephemeral: true });
    if (interaction.commandName === "apikey") return apiKeyForUser(interaction);
    if (interaction.commandName === "getscript") return getScriptForUser(interaction);
    if (interaction.commandName === "getrole") return configureBuyerRole(interaction, interaction.options.getRole("role", true));
    if (interaction.commandName === "redeem") return redeem(interaction, interaction.options.getString("key", true));
    if (interaction.commandName === "resethwid") return resetHwidCommand(interaction);
    if (interaction.commandName === "generatekeyrol") return configureKeyRole(interaction, interaction.options.getRole("role", true));
    if (interaction.commandName === "generatekey") return generate(interaction, interaction.options.getString("script", true), interaction.options.getString("duration"));
    if (interaction.commandName === "deletekey") return remove(interaction, interaction.options.getString("key", true));
    if (interaction.commandName === "addtime") return addTime(interaction, interaction.options.getString("key", true), interaction.options.getString("duration", true));
    if (interaction.commandName === "warn") return warn(interaction, interaction.options.getUser("user", true), interaction.options.getString("reason", true));
    if (interaction.commandName === "dropkey") return dropKeys(interaction, interaction.options.getInteger("amount", true));
    if (interaction.commandName === "blacklist") return blacklistCommand(interaction);
    if (interaction.commandName === "whitelist") return whitelistCommand(interaction);
    if (interaction.commandName === "unwhitelist") return unwhitelistCommand(interaction);
    return respond(interaction, { content: "❌ Este comando ya no está disponible. Escribe `/` de nuevo para cargar la lista actual.", ephemeral: true });
  } catch (error: any) {
    const alreadyAcknowledged = error?.code === 40060 || /already been acknowledged/i.test(String(error?.message ?? ""));
    if (!alreadyAcknowledged) console.error("[Discord Bot] Interaction handler failed:", error);
    const currentInteraction = interaction as any;
    // Discord has already accepted the acknowledgement in this case; trying
    // to reply again only creates a second 40060 and hides the real outcome.
    if (alreadyAcknowledged || currentInteraction.replied || currentInteraction.deferred || respondedInteractions.has(currentInteraction)) return;
    try {
      await respond(currentInteraction, { content: "No se pudo completar la acción. Revisa la configuración del panel.", ephemeral: true });
    } catch (responseError: any) {
      if (responseError?.code !== 40060 && !/already been acknowledged/i.test(String(responseError?.message ?? ""))) {
        console.error("[Discord Bot] Could not send interaction error response:", responseError);
      }
    }
  }
}

async function apiKeyForUser(interaction: any) {
  let result = await getApiKeyByDiscordUserId(interaction.user.id);
  const owner = await ownerAccount(interaction);
  if (!result && owner && (interaction.guild?.ownerId === interaction.user.id || owner.discordUserId === interaction.user.id)) {
    if (owner) {
      const displayName = interaction.user.globalName || interaction.user.username || "Discord owner";
      await linkDiscordIdentity(owner.id, interaction.user.id, displayName, interaction.user.globalName || null, interaction.user.displayAvatarURL?.({ extension: "png", size: 128 }) ?? null);
      await ensureUserApiKey(owner.id);
      result = await getApiKeyByDiscordUserId(interaction.user.id);
    }
  }
  if (!result?.apiKey) return respond(interaction, { content: "❌ No hay una cuenta web vinculada a este usuario de Discord. Vincula Discord desde Vanta.vs Protector e inténtalo otra vez.", ephemeral: true });
  const copyRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`vanta:copy-api-key:${result.apiKey}`).setLabel("Copiar API key").setStyle(ButtonStyle.Secondary),
  );
  return respond(interaction, { content: `🔐 **Tu API key de Vanta.vs Protector**\n\`${result.apiKey}\`\n\nEsta key identifica tu cuenta vinculada.`, components: [copyRow], ephemeral: true });
}

async function getUserLicenses(discordUserId: string, ownerId?: number, hostedScriptId?: number) {
  const [user, rawLicenses] = await Promise.all([
    getUserByDiscordUserId(discordUserId),
    getActiveLicensesByDiscordUserId(discordUserId, ownerId),
  ]);
  const licenses = rawLicenses.filter((license: any) => (!hostedScriptId || Number(license.hostedScriptId) === hostedScriptId) && (!license.expiresAt || license.expiresAt.getTime() > Date.now()));
  const ownerIds = Array.from(new Set(licenses.map((license: any) => Number(license.ownerId)).filter((id) => Number.isInteger(id) && id > 0)));
  const scriptRows = await Promise.all(ownerIds.map((ownerId) => getHostedScriptsByUser(ownerId)));
  const scripts = scriptRows.flat();
  return { user, licenses, scripts };
}

async function whitelistMemberContext(interaction: any) {
  const guildId = String(interaction.guildId ?? interaction.guild?.id ?? "").trim();
  const memberId = String(interaction.user?.id ?? "").trim();
  const cacheKey = guildId && memberId ? `${guildId}:${memberId}` : "";
  const cached = cacheKey ? memberRoleCache.get(cacheKey) : undefined;
  if (cached && cached.expiresAt > Date.now()) return { member: interaction.member, roleIds: cached.roleIds };
  // Guild button interactions already include the member role IDs. Use them
  // immediately; only fall back to REST when Discord did not include roles.
  if (Array.isArray(interaction.member?.roles)) {
    const roleIds = interaction.member.roles.map((roleId: unknown) => String(roleId).trim()).filter(Boolean);
    if (cacheKey) memberRoleCache.set(cacheKey, { roleIds, expiresAt: Date.now() + MEMBER_ROLE_CACHE_MS });
    return { member: interaction.member, roleIds };
  }
  let member = interaction.member;
  if (interaction.guild?.members?.fetch) {
    try { member = await interaction.guild.members.fetch({ user: interaction.user.id, force: true }); } catch (error) { console.warn("[Discord Bot] Could not fetch member roles for whitelist", error); }
  }
  const roleIds = (Array.isArray(member?.roles) ? member.roles : Array.from(member?.roles?.cache?.keys?.() ?? []))
    .map((roleId: unknown) => String(roleId).trim()).filter(Boolean);
  if (cacheKey) memberRoleCache.set(cacheKey, { roleIds, expiresAt: Date.now() + MEMBER_ROLE_CACHE_MS });
  return { member, roleIds };
}

export function formatWhitelistDiagnostic(input: { guildId?: string | null; memberId: string; roleIds: string[]; ownerId?: number; panelScriptId?: number; activeRuleIds: string[] }) {
  return `Diagnóstico · guild=${input.guildId || "none"} · member=${input.memberId} · roles=${input.roleIds.length ? input.roleIds.join(",") : "none"} · owner=${input.ownerId ?? "none"} · script=${input.panelScriptId ?? "none"} · rules=${input.activeRuleIds.length ? input.activeRuleIds.join(",") : "none"}`;
}

async function getWhitelistScriptForMember(interaction: any, knownOwner?: any) {
  const owner = knownOwner ?? await ownerAccount(interaction);
  if (!owner) return undefined;
  const panelScriptId = getPanelContext(interaction)?.hostedScriptId;
  const [{ roleIds }, allRules] = await Promise.all([
    whitelistMemberContext(interaction),
    getAccessRulesByOwner(owner.id),
  ]);
  const scopedRules = allRules.filter((rule: any) => (!panelScriptId || Number(rule.hostedScriptId) === panelScriptId) && matchesWhitelistRule(rule, interaction.user.id, roleIds));
  if (!scopedRules.length) return undefined;
  const scriptIds = Array.from(new Set(scopedRules.map((rule: any) => Number(rule.hostedScriptId)).filter((id) => Number.isInteger(id) && id > 0)));
  const scripts = await Promise.all(scriptIds.map((id) => getHostedScriptByOwnerId(owner.id, id)));
  const script = scripts.find(Boolean);
  return script ? { owner, script } : undefined;
}

async function whitelistDiagnostic(interaction: any) {
  const owner = await ownerAccount(interaction);
  const { roleIds } = await whitelistMemberContext(interaction);
  const panelScriptId = getPanelContext(interaction)?.hostedScriptId;
  const rules = owner ? await getAccessRulesByOwner(owner.id) : [];
  const activeRuleIds = rules.filter((rule: any) => Number(rule.active) !== 0 && (!panelScriptId || Number(rule.hostedScriptId) === panelScriptId)).map((rule: any) => `${rule.kind}:${rule.discordId}@${rule.hostedScriptId ?? "none"}`);
  return formatWhitelistDiagnostic({ guildId: interaction.guildId, memberId: String(interaction.user?.id ?? "unknown"), roleIds, ownerId: owner?.id, panelScriptId, activeRuleIds });
}

async function getKeyForWhitelistedUser(interaction: any) {
  const match = await getWhitelistScriptForMember(interaction);
  if (!match) return respond(interaction, { content: "❌ No tienes un usuario o rol whitelisted para ningún script. Pide al owner que te añada y vuelve a pulsar Get Key.", ephemeral: true });
  const existing = (await getActiveLicensesByDiscordUserId(interaction.user.id)).find((license: any) => Number(license.ownerId) === match.owner.id && Number(license.hostedScriptId) === match.script.id && (!license.expiresAt || license.expiresAt.getTime() > Date.now()));
  const license = existing ?? await createLicense({ ownerId: match.owner.id, hostedScriptId: match.script.id, keyCode: keyCode(), type: "license", status: "active", discordUserId: interaction.user.id, hwid: null, expiresAt: null });
  if (!license) return respond(interaction, { content: "❌ No se pudo crear tu key automática. Inténtalo de nuevo.", ephemeral: true });
  return respond(interaction, { content: `✅ **Whitelist verificada** para **${match.script.name}**.\n\nTu key automática:\n\`${license.keyCode}\`\n\nEsta key queda vinculada a tu cuenta de Discord y al script autorizado.`, ephemeral: true });
}

async function panelAccess(interaction: any) {
  const owner = await ownerAccount(interaction);
  const panelContext = getPanelContext(interaction);
  if (!owner) return { owner, script: undefined, license: undefined, blocked: false };
  // Keep the hot path small: Get Script only needs this member's active
  // licenses and the single script bound to the selected panel.
  const panelScript = panelContext?.hostedScriptId ? await getHostedScriptByOwnerId(owner.id, panelContext.hostedScriptId) : undefined;
  const rawLicenses = await getActiveLicensesByDiscordUserId(interaction.user.id, owner.id);
  const licenses = rawLicenses.filter((license: any) => !license.expiresAt || license.expiresAt.getTime() > Date.now());
  const license = panelContext?.hostedScriptId
    ? licenses.find((item: any) => Number(item.hostedScriptId) === panelContext.hostedScriptId)
    : licenses[0];
  const script = panelScript ?? (license?.hostedScriptId ? await getHostedScriptByOwnerId(owner.id, license.hostedScriptId) : undefined);
  if (script && await isDiscordUserBlacklistedForScript(owner.id, script.id, interaction.user.id)) return { owner, script, license: undefined, blocked: true };
  if (!license) {
    const match = await getWhitelistScriptForMember(interaction, owner);
    if (match) {
      const created = await createLicense({ ownerId: match.owner.id, hostedScriptId: match.script.id, keyCode: keyCode(), type: "license", status: "active", discordUserId: interaction.user.id, hwid: null, expiresAt: null });
      return { owner, script: match.script, license: created };
    }
  }
  return { owner, script, license, blocked: false };
}

async function getScriptForUser(interaction: any) {
  const panel = await panelAccess(interaction);
  if (panel.blocked) return respond(interaction, { content: `⛔ Estás bloqueado para **${panel.script?.name ?? "este script"}**. No puedes obtener el script ni ejecutar su loader.`, ephemeral: true });
  if (!panel.license) return respond(interaction, { content: "❌ No tienes una key activa ni una autorización whitelist válida para este script. Pide al owner que te autorice y vuelve a pulsar Get Script.", ephemeral: true });
  if (!panel.script) return respond(interaction, { content: "❌ Tu acceso está activo, pero todavía no hay un script asignado.", ephemeral: true });
  const copyRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(panelActionId("copy-loader", panel.owner?.id, panel.script.id)).setLabel(GET_SCRIPT_COPY_BUTTON_LABEL).setStyle(ButtonStyle.Secondary),
  );
  return respond(interaction, { content: scriptRuntimeLoader(panel.script, panel.license.keyCode, panel.license.id), components: [copyRow], ephemeral: true });
}

async function copyScriptForUser(interaction: any) {
  const panel = await panelAccess(interaction);
  if (panel.blocked) return respond(interaction, { content: `⛔ Estás bloqueado para **${panel.script?.name ?? "este script"}**.`, ephemeral: true });
  if (!panel.license) return respond(interaction, { content: "❌ Tu usuario o rol no está en la whitelist de este script.", ephemeral: true });
  if (!panel.script) return respond(interaction, { content: "❌ Tu acceso está activo, pero no hay un script asignado.", ephemeral: true });
  return respond(interaction, { content: getScriptDisplayMessage(panel.script, panel.license.keyCode, panel.license.id), ephemeral: true });
}

async function configureBuyerRole(interaction: any, role: { id: string }) {
  const owner = await ownerAccount(interaction);
  if (!owner || !(await isConfiguredOwner(interaction))) return respond(interaction, { content: "⛔ Solo el owner vinculado puede configurar el rol comprador.", ephemeral: true });
  await setBuyerRoleId(owner.id, role.id);
  return respond(interaction, { content: `✅ Rol comprador configurado: <@&${role.id}>. Los usuarios con una key activa podrán obtenerlo desde Get Role.`, ephemeral: true });
}

async function getRoleForUser(interaction: any) {
  const panel = await panelAccess(interaction);
  if (!panel.license) return respond(interaction, { content: "👤 Tu usuario o rol no está en la whitelist de este script.", ephemeral: true });
  const roleId = panel.owner ? await getBuyerRoleId(panel.owner.id) : undefined;
  if (!roleId) return respond(interaction, { content: "👤 Tu key está activa, pero el owner todavía no ha configurado el rol comprador con /getrole.", ephemeral: true });
  if (!interaction.guild?.members?.fetch) return respond(interaction, { content: "❌ Este botón solo puede usarse dentro del servidor de Discord.", ephemeral: true });
  try {
    const member = await interaction.guild.members.fetch(interaction.user.id);
    await member.roles.add(roleId);
    return respond(interaction, { content: `✅ Rol comprador asignado: <@&${roleId}>`, ephemeral: true });
  } catch (error) {
    console.error("[Discord Bot] Buyer role assignment failed:", error);
    return respond(interaction, { content: "❌ No pude asignar el rol. Verifica que el bot tenga Manage Roles y que su rol esté por encima del rol comprador.", ephemeral: true });
  }
}

async function handleButton(interaction: ButtonInteraction) {
  const panelAction = String(interaction.customId).split(":").slice(0, 2).join(":");
  const requiresPanelContext = ["vanta:redeem", "vanta:script", "vanta:role", "vanta:hwid", "vanta:stats", "vanta:copy-loader"].includes(panelAction);
  if (requiresPanelContext && !getPanelContext(interaction)) {
    return respond(interaction, { content: "⚠️ Este panel es antiguo o no está vinculado a un script. Pide al owner que lo vuelva a publicar desde el dashboard.", ephemeral: true });
  }
  if (panelAction === "vanta:redeem") {
    const panelContext = getPanelContext(interaction);
    const modal = new ModalBuilder().setCustomId(panelActionId("redeem-modal", panelContext?.ownerId, panelContext?.hostedScriptId)).setTitle("Redeem Key");
    const input = new TextInputBuilder().setCustomId("key").setLabel("Key alfanumérica").setStyle(TextInputStyle.Short).setMinLength(32).setMaxLength(64).setRequired(true);
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
    return interaction.showModal(modal);
  }
  if (interaction.customId === "vanta:get-key") return getKeyForWhitelistedUser(interaction);
  if (panelAction === "vanta:script") return getScriptForUser(interaction);
  if (panelAction === "vanta:copy-loader") {
    const updatedRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(interaction.customId).setLabel(GET_SCRIPT_COPY_BUTTON_LABEL).setStyle(ButtonStyle.Secondary),
    );
    if (interaction.message?.edit) await interaction.message.edit({ components: [updatedRow] }).catch(() => undefined);
    return copyScriptForUser(interaction);
  }
  if (interaction.customId.startsWith("vanta:copy-key:")) {
    const key = interaction.customId.slice("vanta:copy-key:".length).trim();
    if (!/^[A-Za-z0-9-]{1,64}$/.test(key)) return respond(interaction, { content: "❌ Esta key ya no es válida.", ephemeral: true });
    return respond(interaction, { content: `\`${key}\``, ephemeral: true });
  }
  if (interaction.customId.startsWith("vanta:copy-api-key:")) {
    const key = interaction.customId.slice("vanta:copy-api-key:".length).trim();
    if (!/^VANTA-[A-Za-z0-9_-]{20,64}$/.test(key)) return respond(interaction, { content: "❌ Esta API key ya no es válida.", ephemeral: true });
    return respond(interaction, { content: `\`${key}\``, ephemeral: true });
  }
  if (panelAction === "vanta:role") return getRoleForUser(interaction);
  if (panelAction === "vanta:hwid") {
    const panel = await panelAccess(interaction);
    if (!panel.license) return respond(interaction, { content: "❌ Tu usuario o rol no está en la whitelist de este script.", ephemeral: true });
    const reset = await resetLicenseHwidByDiscordUserId(interaction.user.id, false, { ownerId: panel.owner?.id, hostedScriptId: panel.script?.id });
    if (reset.reason === "not_found") return respond(interaction, { content: "❌ No tienes una key activa vinculada a tu Discord.", ephemeral: true });
    if (reset.reason === "cooldown") return respond(interaction, { content: `⏳ El HWID ya fue reiniciado. Podrás volver a hacerlo <t:${Math.floor(reset.retryAt.getTime() / 1000)}:R>.`, ephemeral: true });
    return respond(interaction, { content: "✅ HWID reiniciado correctamente. El próximo reset estará disponible en 24 horas.", ephemeral: true });
  }
  if (panelAction === "vanta:stats") {
    const panel = await panelAccess(interaction);
    const license = panel.license;
    if (!license) return respond(interaction, { content: "📊 Tu usuario o rol no está en la whitelist de este script.", ephemeral: true });
    const expires = license.expiresAt ? `<t:${Math.floor(license.expiresAt.getTime() / 1000)}:R>` : "never";
    return respond(interaction, { content: `📊 **Access Stats**\nKey: \`${license.keyCode}\`\nExpires: ${expires}\nHWID bound: ${license.hwid ? "yes" : "no (unbound)"}\nNext user reset: gestionado por el cooldown del panel.`, ephemeral: true });
  }
}
async function handleModal(interaction: any) {
  if (interaction.customId === "vanta:redeem-modal" || String(interaction.customId).startsWith("vanta:redeem-modal:")) return redeem(interaction, interaction.fields.getTextInputValue("key"), getPanelContext(interaction));
}
async function redeem(interaction: any, rawKey: string, panelContext?: { ownerId?: number; hostedScriptId?: number }) {
  const license = await redeemLicense(rawKey.trim(), interaction.user.id, panelContext);
  return respond(interaction, license ? { content: `✅ Key canjeada correctamente: **${license.keyCode}**.`, ephemeral: true } : { content: "❌ Key inválida, expirada o ya vinculada a otra cuenta.", ephemeral: true });
}
async function configureKeyRole(interaction: any, role: { id: string }) {
  const owner = await configuredWorkspaceOwner(interaction);
  if (!owner || !(await isConfiguredOwner(interaction))) return respond(interaction, { content: "⛔ Solo el owner vinculado desde la web puede configurar Generate Key Role.", ephemeral: true });
  await setKeyManagerRole(owner.id, role.id);
  return respond(interaction, { content: `✅ El rol <@&${role.id}> ahora puede usar "/generatekey" y "/deletekey".`, ephemeral: true });
}
export async function resolveScriptSelection(ownerId: number, selection: string) {
  const raw = selection.trim();
  if (raw.startsWith("script:")) {
    const id = Number(raw.slice("script:".length));
    if (Number.isInteger(id) && id > 0) return getHostedScriptByOwnerId(ownerId, id);
  }
  return getHostedScriptByName(ownerId, raw);
}

async function whitelist(interaction: any, discordId: string, kind: "user" | "role", scriptName: string) {
  const owner = await configuredWorkspaceOwner(interaction);
  if (!owner || !(await isConfiguredOwner(interaction))) return respond(interaction, { content: "⛔ Solo el owner vinculado puede modificar la whitelist.", ephemeral: true });
  const script = await resolveScriptSelection(owner.id, scriptName);
  if (!script) return respond(interaction, { content: "❌ Selecciona un script hosteado válido de tu workspace.", ephemeral: true });
  let canonicalId = normalizeDiscordId(discordId);
  let roleName = "Buyer role";
  if (kind === "role") {
    if (!interaction.guild?.roles?.fetch) return respond(interaction, { content: "❌ Selecciona el rol desde un servidor Discord; no se puede usar un ID de canal o panel como whitelist.", ephemeral: true });
    try {
      const role = await interaction.guild.roles.fetch(canonicalId ?? discordId.trim());
      if (!role) return respond(interaction, { content: "❌ Ese ID no corresponde a un rol del servidor actual. Selecciona el rol desde el desplegable de Discord.", ephemeral: true });
      canonicalId = normalizeDiscordId(role.id);
      roleName = role.name;
    } catch {
      return respond(interaction, { content: "❌ No pude encontrar ese rol en el servidor actual. Selecciona el rol desde el desplegable de Discord.", ephemeral: true });
    }
  }
  if (!canonicalId) return respond(interaction, { content: "❌ El destino debe ser un usuario o rol válido de Discord.", ephemeral: true });
  const counts = await createAccessRuleIfAbsent({ ownerId: owner.id, hostedScriptId: script.id, kind, discordId: canonicalId, label: kind === "role" ? roleName : "Buyer user" });
  const rules = await getAccessRulesByOwner(owner.id);
  const channel = interaction.channelId ? `<#${interaction.channelId}>` : "canal actual";
  const panels = await getDiscordPanelsByOwner(owner.id);
  const panel = panels.find((item: any) => item.targetScript === script.name);
  const accessChannel = panel?.channelId ? `<#${panel.channelId}>` : channel;
  const mention = kind === "role" ? `<@&${canonicalId}>` : `<@${canonicalId}>`;
  const embed = new EmbedBuilder().setColor(0x57f287).setTitle(`${mention} You have been whitelisted!`).setDescription(`**${mention}** You have been whitelisted!\n\nAccess the script via this message --> ${accessChannel}\n\nScript: **${script.name}**\nAdded: ${counts.added} · Already whitelisted: ${counts.alreadyWhitelisted} · Failed: ${counts.failed}`).setFooter({ text: `Reglas activas: ${rules.length}` });
  return respond(interaction, { embeds: [embed] });
}
async function unwhitelist(interaction: any, discordId: string, scriptName: string) {
  const owner = await configuredWorkspaceOwner(interaction);
  if (!owner || !(await isConfiguredOwner(interaction))) return respond(interaction, { content: "⛔ Solo el owner vinculado puede modificar la whitelist.", ephemeral: true });
  const script = await resolveScriptSelection(owner.id, scriptName);
  if (!script) return respond(interaction, { content: "❌ Selecciona un script hosteado válido de tu workspace.", ephemeral: true });
  const removed = await deleteAccessRuleByDiscordId(owner.id, discordId.trim(), script.id);
  return respond(interaction, { content: removed ? `✅ Whitelist retirada para **${discordId.trim()}** en **${script.name}**.` : "No se encontró una regla activa para ese script y destino.", ephemeral: true });
}
export function parseDuration(raw: string) {
  const match = raw.trim().match(/^(\d+)\s*(m|min|h|d|day|days|w|week|weeks|mo|month|months|y|year|years)$/i);
  if (!match) return undefined;
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === "m" || unit === "min") return value * 60_000;
  if (unit === "h") return value * 3_600_000;
  if (["d", "day", "days"].includes(unit)) return durationToMs(value, "days");
  if (["w", "week", "weeks"].includes(unit)) return durationToMs(value * 7, "days");
  if (["mo", "month", "months"].includes(unit)) return durationToMs(value, "months");
  if (["y", "year", "years"].includes(unit)) return durationToMs(value, "years");
  return undefined;
}

async function prices(interaction: any) {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setAuthor({ name: "Vanta.vs Protector · APP" })
    .setTitle("Vanta.vs Protector · Plans")
    .setDescription(`${buildPlansDescription()}\n\nFFA / Trial global: acceso para todos sin key individual.\nModo protegido: requiere una key activa.`)
    .setFooter({ text: `Copyright © ${new Date().getFullYear()} | Vanta.vs Protector` })
    .setTimestamp();
  return respond(interaction, { embeds: [embed] });
}

async function updates(interaction: any) {
  const embed = new EmbedBuilder()
    .setColor(0xe93540)
    .setAuthor({ name: "Vanta.vs Protector · APP" })
    .setTitle("Project Updates")
    .setDescription("Consulta el dashboard para ver las novedades, cambios de protección y avisos importantes del proyecto.")
    .setFooter({ text: `Actualización · ${new Date().getFullYear()} | Vanta.vs Protector` })
    .setTimestamp();
  return respond(interaction, { embeds: [embed] });
}

async function resetHwidCommand(interaction: any) {
  const target = interaction.options.getUser("user", true);
  const result = await canManageKeys(interaction);
  if (!result.allowed) return respond(interaction, { content: "⛔ Solo el propietario, un administrador o el rol delegado puede reiniciar HWID.", ephemeral: true });
  const reset = await resetLicenseHwidByDiscordUserId(target.id);
  if (reset.reason === "not_found") return respond(interaction, { content: "❌ No se encontraron keys activas para ese usuario.", ephemeral: true });
  if (reset.reason === "cooldown") return respond(interaction, { content: `⏳ Ese usuario ya reinició su HWID. Podrá volver a hacerlo <t:${Math.floor(reset.retryAt.getTime() / 1000)}:R>.`, ephemeral: true });
  return respond(interaction, { content: `✅ HWID reiniciado para <@${target.id}> en el script indicado. El próximo reset estará disponible en 24 horas.`, ephemeral: true });
}

async function addTime(interaction: any, key: string, rawDuration: string) {
  const result = await canManageKeys(interaction);
  if (!result.allowed || !result.owner) return respond(interaction, { content: "⛔ No tienes permiso para añadir tiempo.", ephemeral: true });
  const durationMs = parseDuration(rawDuration);
  if (!durationMs) return respond(interaction, { content: "❌ Usa una duración como `30d`, `12h`, `4weeks`, `3months` o `1year`.", ephemeral: true });
  const license = await addTimeToLicense(result.owner.id, key.trim(), durationMs);
  if (!license) return respond(interaction, { content: "❌ No se encontró esa key.", ephemeral: true });
  return respond(interaction, { content: `✅ Se añadieron **${rawDuration}** a **${key.trim()}**.\nScript objetivo: ${license.hostedScriptId ? `#${license.hostedScriptId}` : "todos los accesos de la key"}.`, ephemeral: true });
}

async function warn(interaction: any, user: { id: string }, reason: string) {
  const owner = await ownerAccount(interaction);
  if (!owner || (!(await isConfiguredOwner(interaction)) && !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator))) return respond(interaction, { content: "⛔ Solo el propietario o un administrador puede advertir usuarios.", ephemeral: true });
  await createWarning({ ownerId: owner.id, discordUserId: user.id, reason: reason.trim(), hostedScriptId: null });
  return respond(interaction, { content: `⚠️ <@${user.id}> recibió una advertencia.\nRazón: ${reason.trim()}` });
}

async function dropKeys(interaction: any, amount: number) {
  const result = await canManageKeys(interaction);
  if (!result.allowed || !result.owner) return respond(interaction, { content: "⛔ No tienes permiso para hacer un drop.", ephemeral: true });
  const keys: string[] = [];
  for (let i = 0; i < amount; i++) { const row = await createLicense({ ownerId: result.owner.id, keyCode: keyCode(), type: "license", status: "active", discordUserId: null, hwid: null, expiresAt: null, hostedScriptId: null }); if (row) { keys.push(row.keyCode); await createKeyAuditLog({ ownerId: result.owner.id, actorDiscordId: interaction.user.id, action: "generate", keyCode: row.keyCode }); } }
  await respond(interaction, { content: "# Key drop!!\\n@everyone" });
  for (let index = amount; index > 0; index--) await interaction.followUp({ content: `${index}` });
  await interaction.followUp({ content: "# GO!!" });
  for (const generatedKey of keys) await interaction.followUp({ content: generatedKey });
  return undefined;
}
async function blacklistCommand(interaction: any) {
  const owner = await ownerAccount(interaction);
  const user = interaction.options.getUser("user", true);
  const scriptSelection = interaction.options.getString("script", true);
  const reason = interaction.options.getString("reason") ?? "Sin razón indicada";
  const manager = await canManageKeys(interaction);
  if (!owner || !manager.allowed || !manager.owner) return respond(interaction, { content: "⛔ Solo el propietario, un administrador o el rol delegado puede usar blacklist.", ephemeral: true });
  const script = await resolveScriptSelection(manager.owner.id, scriptSelection);
  if (!script) return respond(interaction, { content: "❌ Selecciona un script hosteado válido de tu workspace.", ephemeral: true });
  await createBlacklist({ ownerId: manager.owner.id, hostedScriptId: script.id, discordUserId: user.id, reason, active: 1 });
  const panel = (await getDiscordPanelsByOwner(manager.owner.id)).find((item: any) => item.targetScript === script.name);
  const accessChannel = panel?.channelId ? `<#${panel.channelId}>` : "el canal donde se publicó el panel";
  return respond(interaction, { content: `⛔ **Blacklist aplicada**\nUsuario: <@${user.id}>\nScript: **${script.name}**\nRazón: ${reason}\n\nEl acceso queda bloqueado para este script.`, ephemeral: false });
}

function selectedTarget(interaction: any) {
  const raw = interaction.options.getString("target");
  if (raw?.includes(":")) { const [kind, rawId] = raw.split(":", 2); const id = normalizeDiscordId(rawId); if ((kind === "user" || kind === "role") && id) return { kind, id }; }
  const targetUser = interaction.options.getUser?.("user");
  const targetRole = interaction.options.getRole?.("role");
  const userId = normalizeDiscordId(targetUser?.id);
  const roleId = normalizeDiscordId(targetRole?.id);
  if (userId) return { kind: "user", id: userId };
  if (roleId) return { kind: "role", id: roleId };
  return undefined;
}
function nativeWhitelistTarget(interaction: any) {
  const user = interaction.options.getUser?.("user");
  const role = interaction.options.getRole?.("role");
  if (user && role) return { error: "❌ Selecciona solo un destino: usuario o rol, no ambos." };
  if (user) return { kind: "user" as const, id: normalizeDiscordId(user.id), label: `<@${user.id}>` };
  if (role) return { kind: "role" as const, id: normalizeDiscordId(role.id), label: `<@&${role.id}>` };
  return { error: "❌ Selecciona un usuario o un rol del servidor en las opciones nativas." };
}
async function whitelistCommand(interaction: any) {
  const target = nativeWhitelistTarget(interaction);
  const scriptName = interaction.options.getString("script", true).trim();
  if ("error" in target) return respond(interaction, { content: target.error, ephemeral: true });
  if (!target.id) return respond(interaction, { content: "❌ El destino seleccionado no tiene un ID Discord válido.", ephemeral: true });
  return whitelist(interaction, target.id, target.kind, scriptName);
}
async function unwhitelistCommand(interaction: any) {
  const target = nativeWhitelistTarget(interaction);
  const scriptName = interaction.options.getString("script", true).trim();
  if ("error" in target) return respond(interaction, { content: target.error, ephemeral: true });
  if (!target.id) return respond(interaction, { content: "❌ El destino seleccionado no tiene un ID Discord válido.", ephemeral: true });
  return unwhitelist(interaction, target.id, scriptName);
}

async function generate(interaction: any, scriptName: string, rawDuration?: string | null) {
  const result = await canManageKeys(interaction);
  if (!canPerformKeyAction(interaction.user.id)) return respond(interaction, { content: "⏳ Espera unos segundos antes de gestionar otra key.", ephemeral: true });
  if (!result.allowed || !result.owner) return respond(interaction, { content: "⛔ No tienes permiso para generar keys.", ephemeral: true });
  const script = await resolveScriptSelection(result.owner.id, scriptName);
  if (!script) return respond(interaction, { content: `❌ No se encontró el script **${scriptName}** en tu workspace.`, ephemeral: true });
  const durationMs = rawDuration ? parseDuration(rawDuration) : undefined;
  if (rawDuration && !durationMs) return respond(interaction, { content: "❌ Usa `30d`, `12h`, `4weeks`, `3months` o `1year`, o déjala vacía para forever.", ephemeral: true });
  const row = await createLicense({ ownerId: result.owner.id, keyCode: keyCode(), type: "license", status: "active", discordUserId: null, hwid: null, expiresAt: durationMs ? new Date(Date.now() + durationMs) : null, hostedScriptId: script.id });
  if (row) await createKeyAuditLog({ ownerId: result.owner.id, actorDiscordId: interaction.user.id, action: "generate", keyCode: row.keyCode });
  if (!row) return respond(interaction, { content: "No se pudo generar la key.", ephemeral: true });
  const copyRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`vanta:copy-key:${row.keyCode}`).setLabel("Copiar key").setStyle(ButtonStyle.Secondary),
  );
  return respond(interaction, { content: `✅ Key generada para **${script.name}**:\n\`${row.keyCode}\``, components: [copyRow], ephemeral: true });
}
async function remove(interaction: any, value: string) {
  const result = await canManageKeys(interaction);
  if (!result.allowed || !result.owner) return respond(interaction, { content: "⛔ No tienes permiso para eliminar keys.", ephemeral: true });
  if (!canPerformKeyAction(interaction.user.id)) return respond(interaction, { content: "⏳ Espera unos segundos antes de gestionar otra key.", ephemeral: true });
  const removed = await deleteLicenseByKeyCode(result.owner.id, value.trim());
  if (removed) await createKeyAuditLog({ ownerId: result.owner.id, actorDiscordId: interaction.user.id, action: "delete", keyCode: value.trim() });
  return respond(interaction, { content: removed ? `🗑️ Key **${value.trim()}** eliminada.` : "No se encontró esa key en tu workspace.", ephemeral: true });
}
function canPerformKeyAction(actorId: string) {
  const now = Date.now();
  const last = keyActionTimestamps.get(actorId) ?? 0;
  if (now - last < KEY_ACTION_COOLDOWN_MS) return false;
  keyActionTimestamps.set(actorId, now);
  return true;
}
