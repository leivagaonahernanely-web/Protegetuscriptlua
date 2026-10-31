// Bot de Discord para Vantarmor (estilo Luarmor).
// Comparte la base SQLite de server.js: recibe `db` y crea sus tablas con ensureBotSchema().
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import crypto from 'crypto';

const KEY_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const HWID_RESET_COOLDOWN_S = 24 * 3600;
const ACTION_COOLDOWN_MS = 5_000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const UNIT_SECONDS = { h: 3600, d: 86400, w: 604800, mo: 2592000, y: 31536000 };

export function parseDuration(raw) {
  const m = String(raw ?? '').trim().toLowerCase().match(/^(\d{1,4})(h|d|w|mo|y)$/);
  return m ? Number(m[1]) * UNIT_SECONDS[m[2]] : null;
}

const makeKey = () => Array.from(crypto.randomBytes(32), b => KEY_ALPHABET[b % KEY_ALPHABET.length]).join('');
const now = () => Math.floor(Date.now() / 1000);
const WORKSPACE = 'workspace'; // clave de ajustes del workspace (rol comprador, rol gestor)

// ==========================================
// Esquema del bot (se llama desde server.js al arrancar)
// ==========================================
export function ensureBotSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bot_panels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      script_id INTEGER, channel_id TEXT, message_id TEXT, created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS bot_access_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      script_id INTEGER, kind TEXT, discord_id TEXT, label TEXT,
      UNIQUE(script_id, kind, discord_id)
    );
    CREATE TABLE IF NOT EXISTS bot_blacklist (
      script_id INTEGER, discord_id TEXT, reason TEXT, created_at INTEGER,
      PRIMARY KEY (script_id, discord_id)
    );
    CREATE TABLE IF NOT EXISTS bot_blacklist_roles (
      script_id INTEGER, role_id TEXT, reason TEXT, created_at INTEGER,
      PRIMARY KEY (script_id, role_id)
    );
    CREATE TABLE IF NOT EXISTS bot_settings (
      owner TEXT, name TEXT, value TEXT, PRIMARY KEY (owner, name)
    );
    CREATE TABLE IF NOT EXISTS plan_keys (
      key TEXT PRIMARY KEY, plan TEXT NOT NULL,
      used_by TEXT, used_at INTEGER, created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS bot_ticket_settings (
      guild_id TEXT PRIMARY KEY, category_id TEXT, staff_roles TEXT
    );
    CREATE TABLE IF NOT EXISTS bot_tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT, channel_id TEXT UNIQUE, user_id TEXT,
      status TEXT DEFAULT 'open', created_at INTEGER, closed_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS bot_warnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      discord_id TEXT, reason TEXT, created_at INTEGER
    );
  `);
  // Migración: la whitelist puede ser por tiempo (expires_at NULL = permanente)
  if (!db.prepare("SELECT 1 FROM pragma_table_info('bot_ticket_settings') WHERE name = 'log_channel_id'").get()) {
    db.exec('ALTER TABLE bot_ticket_settings ADD COLUMN log_channel_id TEXT');
  }
  const hasExp = db.prepare("SELECT 1 FROM pragma_table_info('bot_access_rules') WHERE name = 'expires_at'").get();
  if (!hasExp) db.exec('ALTER TABLE bot_access_rules ADD COLUMN expires_at INTEGER');
  // Último vencimiento avisado por DM (si la key se renueva, vuelve a avisar)
  if (!db.prepare("SELECT 1 FROM pragma_table_info('keys') WHERE name = 'expiry_notified_for'").get()) {
    db.exec('ALTER TABLE keys ADD COLUMN expiry_notified_for INTEGER');
  }
}

// ==========================================
// Comandos slash
// ==========================================
const scriptOpt = (o, desc = 'Script') => o.setName('script').setDescription(desc).setRequired(true).setAutocomplete(true);
const userOpt = (o, required = false) => o.setName('user').setDescription('Usuario de Discord').setRequired(required);
const roleOpt = (o, required = false) => o.setName('role').setDescription('Rol del servidor').setRequired(required);
const durationOpt = (o, required = false) => o.setName('duration').setDescription('30d, 12h, 1w, 1mo, 1y. Vacío = forever').setRequired(required);

export const commands = [
  new SlashCommandBuilder().setName('ping').setDescription('Verifica que el bot responde'),
  new SlashCommandBuilder().setName('panel').setDescription('Publica el panel de acceso de un script en este canal')
    .addStringOption(o => scriptOpt(o))
    .addStringOption(o => o.setName('descripcion').setDescription('Descripción del panel (opcional, usa \\n para saltos de línea)').setMaxLength(800)),
  new SlashCommandBuilder().setName('stats').setDescription('Muestra tus keys'),
  new SlashCommandBuilder().setName('hostproyect').setDescription('Ofusca un archivo .lua con tu plan, sin publicarlo en la web')
    .addAttachmentOption(o => o.setName('archivo').setDescription('Archivo .lua a ofuscar').setRequired(true))
    .addStringOption(o => o.setName('ofuscador').setDescription('Ofuscador a usar (por defecto el 4)')
      .addChoices({ name: 'Ofuscador 1', value: 'real' }, { name: 'Ofuscador 2', value: 'obscura' })),
  new SlashCommandBuilder().setName('redeem').setDescription('Canjea una key')
    .addStringOption(o => o.setName('key').setDescription('Tu key').setRequired(true).setMinLength(32).setMaxLength(64)),
  new SlashCommandBuilder().setName('generatekey').setDescription('Genera keys para un script (dueño o gestor)')
    .addStringOption(o => scriptOpt(o))
    .addIntegerOption(o => o.setName('amount').setDescription('Cantidad (1-50)').setMinValue(1).setMaxValue(50))
    .addStringOption(o => durationOpt(o)),
  new SlashCommandBuilder().setName('deletekey').setDescription('Elimina una key o las keys vinculadas a un usuario (creador o gestor)')
    .addStringOption(o => o.setName('key').setDescription('Key a eliminar').setRequired(false))
    .addUserOption(o => userOpt(o, false))
    .addStringOption(o => scriptOpt(o, 'Script (opcional: si no eliges, aplica a todos los tuyos)').setRequired(false)),
  new SlashCommandBuilder().setName('dropkey').setDescription('Sortea keys en el canal con cuenta regresiva (creador o gestor)')
    .addStringOption(o => scriptOpt(o))
    .addIntegerOption(o => o.setName('amount').setDescription('Cantidad de keys (1-50)').setMinValue(1).setMaxValue(50).setRequired(true)),
  new SlashCommandBuilder().setName('logs').setDescription('Elige el canal donde se registran los usos de tus scripts')
    .addChannelOption(o => o.setName('canal').setDescription('Canal de logs (opcional: si no eliges, uso o creo #logs-bot)').setRequired(false)),
  new SlashCommandBuilder().setName('addtime').setDescription('Añade tiempo a una key (dueño o gestor)')
    .addStringOption(o => o.setName('key').setDescription('Key').setRequired(true))
    .addStringOption(o => durationOpt(o, true)),
  new SlashCommandBuilder().setName('resethwid').setDescription('Reinicia el HWID de una key')
    .addStringOption(o => scriptOpt(o))
    .addUserOption(o => userOpt(o)),
  new SlashCommandBuilder().setName('whitelist').setDescription('Añade un usuario o rol a la whitelist')
    .addStringOption(o => scriptOpt(o))
    .addUserOption(o => userOpt(o))
    .addRoleOption(o => roleOpt(o))
    .addStringOption(o => durationOpt(o)),
  new SlashCommandBuilder().setName('cookiegame').setDescription('Juego de la galleta: el primero que haga click gana la whitelist')
    .addStringOption(o => scriptOpt(o))
    .addStringOption(o => durationOpt(o)),
  new SlashCommandBuilder().setName('unwhitelist').setDescription('Quita un usuario o rol de la whitelist')
    .addStringOption(o => scriptOpt(o))
    .addUserOption(o => userOpt(o))
    .addRoleOption(o => roleOpt(o)),
  new SlashCommandBuilder().setName('blacklist').setDescription('Bloquea a un usuario o a un rol en un script')
    .addUserOption(o => userOpt(o, false))
    .addRoleOption(o => roleOpt(o, false))
    .addStringOption(o => scriptOpt(o))
    .addStringOption(o => o.setName('reason').setDescription('Razón')),
  new SlashCommandBuilder().setName('unblacklist').setDescription('Quita el bloqueo de un usuario o un rol en un script')
    .addUserOption(o => userOpt(o, false))
    .addRoleOption(o => roleOpt(o, false))
    .addStringOption(o => scriptOpt(o)),
  new SlashCommandBuilder().setName('getrole').setDescription('Configura el rol que recibe un comprador (dueño)')
    .addRoleOption(o => roleOpt(o, true)),
  new SlashCommandBuilder().setName('generatekeyrole').setDescription('Configura el rol que puede gestionar keys (dueño)')
    .addRoleOption(o => roleOpt(o, true)),
  new SlashCommandBuilder().setName('warn').setDescription('Advierte a un usuario')
    .addUserOption(o => userOpt(o, true))
    .addStringOption(o => o.setName('reason').setDescription('Razón').setRequired(true)),
  new SlashCommandBuilder().setName('prices').setDescription('Publica tus precios (solo Premium y Premium Plus)')
    .addStringOption(o => o.setName('title').setDescription('Título').setRequired(true))
    .addStringOption(o => o.setName('description').setDescription('Contenido (usa \\n para saltos de línea)').setRequired(true))
    .addChannelOption(o => o.setName('canal').setDescription('Canal donde se publica (se guarda para la próxima vez)').setRequired(false))
    .addStringOption(o => o.setName('imagen').setDescription('URL https de imagen (se guarda; deja vacío para usar la guardada)').setRequired(false)),
  new SlashCommandBuilder().setName('updates').setDescription('Publica una actualización (dueño)')
    .addStringOption(o => o.setName('title').setDescription('Título').setRequired(true))
    .addStringOption(o => o.setName('description').setDescription('Contenido (usa \\n para saltos de línea)').setRequired(true)),
  new SlashCommandBuilder().setName('ticketpanel').setDescription('Publica el botón para abrir tickets (staff del servidor)')
    .addChannelOption(o => o.setName('canal').setDescription('Canal donde se publica (opcional: este canal)').addChannelTypes([ChannelType.GuildText]).setRequired(false))
    .addStringOption(o => o.setName('mensaje').setDescription('Texto del panel (opcional; usa \\n para saltos de línea)').setMaxLength(1000).setRequired(false)),
  new SlashCommandBuilder().setName('ticketperm').setDescription('Configura los tickets del servidor (administradores)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s.setName('agregar-rol').setDescription('Añade un rol de staff que ve y atiende los tickets')
      .addRoleOption(o => o.setName('rol').setDescription('Rol de staff').setRequired(true)))
    .addSubcommand(s => s.setName('quitar-rol').setDescription('Quita un rol de staff de los tickets')
      .addRoleOption(o => o.setName('rol').setDescription('Rol a quitar').setRequired(true)))
    .addSubcommand(s => s.setName('categoria').setDescription('Elige la categoría donde se crean los tickets')
      .addChannelOption(o => o.setName('categoria').setDescription('Categoría').addChannelTypes([ChannelType.GuildCategory]).setRequired(true)))
    .addSubcommand(s => s.setName('logs').setDescription('Elige o crea el canal donde se registran los tickets')
      .addChannelOption(o => o.setName('canal').setDescription('Canal de logs (opcional: si no eliges, uso o creo #logs-tickets)').addChannelTypes([ChannelType.GuildText]).setRequired(false)))
    .addSubcommand(s => s.setName('ver').setDescription('Muestra la configuración de tickets')),
  new SlashCommandBuilder().setName('lock').setDescription('Bloquea un canal: nadie puede escribir, ni en hilos (staff)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addChannelOption(o => o.setName('canal').setDescription('Canal a bloquear (opcional: este canal)').addChannelTypes([ChannelType.GuildText, ChannelType.GuildAnnouncement]).setRequired(false))
    .addStringOption(o => o.setName('motivo').setDescription('Motivo que se muestra en el canal (opcional)').setMaxLength(200).setRequired(false)),
  new SlashCommandBuilder().setName('unlock').setDescription('Desbloquea un canal bloqueado con /lock (staff)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addChannelOption(o => o.setName('canal').setDescription('Canal a desbloquear (opcional: este canal)').addChannelTypes([ChannelType.GuildText, ChannelType.GuildAnnouncement]).setRequired(false)),
].map(c => {
  // Discord rechaza el registro entero si una opción obligatoria va después de una opcional.
  // Las obligatorias van primero (el orden solo cambia cómo se muestran en el menú de Discord).
  const json = c.toJSON();
  if (Array.isArray(json.options)) json.options = [...json.options].sort((x, y) => (y.required ? 1 : 0) - (x.required ? 1 : 0));
  return json;
});

// Comandos que responden en público
// /panel no es público: sus errores y su confirmación solo los ve quien lo ejecuta (el panel sí se publica en el canal)
const PUBLIC_COMMANDS = new Set(['whitelist', 'unwhitelist', 'blacklist', 'unblacklist', 'warn', 'prices', 'updates', 'dropkey']);

// ==========================================
// Bot
// ==========================================
export async function startDiscordBot({ db, token, clientId, guildId, publicUrl, ownerId, quota, obfuscate }) {
  ensureBotSchema(db);
  // Si al arrancar hay 0 scripts o 0 keys cuando esperabas datos, la base se reinició (revisa el volumen)
  const counts = db.prepare('SELECT (SELECT COUNT(*) FROM scripts) AS scripts, (SELECT COUNT(*) FROM keys) AS keys').get();
  console.log(`[Bot] Datos al arrancar: ${counts.scripts} scripts, ${counts.keys} keys. Réplica: ${process.env.RAILWAY_REPLICA_ID || 'local'}.`);

  const q = {
    scriptById: db.prepare('SELECT * FROM scripts WHERE id = ?'),
    scriptByName: db.prepare('SELECT * FROM scripts WHERE lower(name) = lower(?) ORDER BY id DESC LIMIT 1'),
    scriptsNamed: db.prepare('SELECT id FROM scripts WHERE lower(name) = lower(?)'),
    scriptsList: db.prepare('SELECT id, name, user_id FROM scripts ORDER BY id DESC LIMIT 100'),
    scriptsOfUser: db.prepare('SELECT 1 FROM scripts WHERE user_id = ? LIMIT 1'),
    userPlan: db.prepare('SELECT plan FROM users WHERE id = ?'),
    settingDel: db.prepare('DELETE FROM bot_settings WHERE owner = ? AND name = ?'),
    userById: db.prepare('SELECT id, username, avatar, custom_avatar FROM users WHERE id = ?'),
    keyByCode: db.prepare('SELECT * FROM keys WHERE key = ?'),
    keysByDiscord: db.prepare('SELECT * FROM keys WHERE discord_id = ?'),
    activeKeyFor: db.prepare(`
      SELECT * FROM keys WHERE script_id = ? AND discord_id = ? AND banned = 0
        AND (expires_at IS NULL OR expires_at > ?) LIMIT 1
    `),
    bannedKeyFor: db.prepare('SELECT 1 FROM keys WHERE script_id = ? AND discord_id = ? AND banned = 1 LIMIT 1'),
    keyForScriptUser: db.prepare(`
      SELECT * FROM keys WHERE script_id = ? AND discord_id = ?
      ORDER BY expires_at IS NULL DESC, expires_at DESC LIMIT 1
    `),
    keysOfUser: db.prepare(`
      SELECT k.*, s.name AS script_name FROM keys k JOIN scripts s ON s.id = k.script_id
      WHERE k.discord_id = ? ORDER BY k.expires_at IS NULL, k.expires_at DESC
    `),
    insertKey: db.prepare('INSERT INTO keys (key, script_id, expires_at) VALUES (?, ?, ?)'),
    insertClaimed: db.prepare('INSERT INTO keys (key, script_id, expires_at, discord_id) VALUES (?, ?, NULL, ?)'),
    claim: db.prepare('UPDATE keys SET discord_id = ? WHERE key = ?'),
    deleteKey: db.prepare('DELETE FROM keys WHERE key = ?'),
    setExpiry: db.prepare('UPDATE keys SET expires_at = ? WHERE key = ?'),
    banKeys: db.prepare('UPDATE keys SET banned = 1, ban_reason = ? WHERE script_id = ? AND discord_id = ?'),
    unbanKeys: db.prepare('UPDATE keys SET banned = 0, ban_reason = NULL WHERE script_id = ? AND discord_id = ?'),
    resetHwid: db.prepare('UPDATE keys SET hwid = NULL, hwid_reset_at = ? WHERE key = ?'),
    blacklisted: db.prepare('SELECT 1 FROM bot_blacklist WHERE script_id = ? AND discord_id = ?'),
    roleBlacklisted: db.prepare('SELECT 1 FROM bot_blacklist_roles WHERE script_id = ? AND role_id = ?'),
    roleBlacklistInsert: db.prepare('INSERT OR REPLACE INTO bot_blacklist_roles (script_id, role_id, reason, created_at) VALUES (?, ?, ?, ?)'),
    roleBlacklistDelete: db.prepare('DELETE FROM bot_blacklist_roles WHERE script_id = ? AND role_id = ?'),
    blacklistInsert: db.prepare('INSERT OR REPLACE INTO bot_blacklist (script_id, discord_id, reason, created_at) VALUES (?, ?, ?, ?)'),
    blacklistDelete: db.prepare('DELETE FROM bot_blacklist WHERE script_id = ? AND discord_id = ?'),
    rulesForScript: db.prepare('SELECT kind, discord_id, expires_at FROM bot_access_rules WHERE script_id = ?'),
    ruleInsert: db.prepare('INSERT OR REPLACE INTO bot_access_rules (script_id, kind, discord_id, label, expires_at) VALUES (?, ?, ?, ?, ?)'),
    insertKeyExp: db.prepare('INSERT INTO keys (key, script_id, expires_at, discord_id) VALUES (?, ?, ?, ?)'),
    ruleDelete: db.prepare('DELETE FROM bot_access_rules WHERE script_id = ? AND kind = ? AND discord_id = ?'),
    setting: db.prepare('SELECT value FROM bot_settings WHERE owner = ? AND name = ?'),
    settingSet: db.prepare('INSERT OR REPLACE INTO bot_settings (owner, name, value) VALUES (?, ?, ?)'),
    panelInsert: db.prepare('INSERT INTO bot_panels (script_id, channel_id, message_id, created_at) VALUES (?, ?, ?, ?)'),
    managerRoleRows: db.prepare("SELECT owner, value FROM bot_settings WHERE name = 'manager_role' AND value IS NOT NULL"),
    logInsert: db.prepare('INSERT INTO script_logs (script_id, script_name, text, created_at) VALUES (?, ?, ?, ?)'),
    panelForScript: db.prepare('SELECT channel_id FROM bot_panels WHERE script_id = ? ORDER BY created_at DESC LIMIT 1'),
    warnInsert: db.prepare('INSERT INTO bot_warnings (discord_id, reason, created_at) VALUES (?, ?, ?)'),
    planKeyInsert: db.prepare('INSERT INTO plan_keys (key, plan, created_at) VALUES (?, ?, ?)'),
  };

  const owner = () => ownerId || null;
  // Solo planes pagos pueden publicar precios con /prices
  const hasPaidPlan = id => { const p = q.userPlan.get(id)?.plan; return p === 'premium' || p === 'plus'; };
  // Plan Free: 100 keys por periodo (se reinicia cada 15 días); la cuota la lleva el servidor
  const FREE_KEY_CAP = 100;
  const keyCapOk = (ownerId, amount) => quota.reserveKeys(ownerId, amount);
  const hasPlusPlan = id => q.userPlan.get(id)?.plan === 'plus';
  // Cada creador tiene su propio workspace: sus roles (comprador/gestor) y sus scripts
  const settingFor = (workspaceId, name) => (workspaceId ? q.setting.get(workspaceId, name)?.value ?? null : null);
  const isPlatformOwner = id => Boolean(id) && id === owner();
  const createdAnyScript = userId => Boolean(q.scriptsOfUser.get(userId));
  // Acepta el ID (lo que manda el autocompletado) o el nombre, ignorando espacios y un "#" inicial.
  const findScript = value => {
    const v = String(value ?? '').trim().replace(/^#/, '');
    if (!v) return null;
    let found = /^\d+$/.test(v) ? q.scriptById.get(Number(v)) : q.scriptByName.get(v);
    if (!found) {
      // Nombre escrito a medias o con otra mayúscula: solo si coincide con un único script
      const hits = q.scriptsList.all().filter(s => s.name.toLowerCase().includes(v.toLowerCase()));
      if (hits.length === 1) found = q.scriptById.get(hits[0].id);
    }
    if (!found) console.warn(`[Bot] Script no encontrado para "${v}". Si pasa seguido, revisa que la base de datos sea la misma y no se haya reiniciado.`);
    return found ?? null;
  };
  const keyState = k => (k.banned ? 'baneada' : k.expires_at && k.expires_at <= now() ? 'expirada' : 'activa');
  // Roles recordados por usuario: si Discord no trae los roles en una interacción, se usan los últimos conocidos
  const roleCache = new Map();
  const ROLE_CACHE_MS = 10 * 60_000;
  const memberRoleIds = interaction => {
    if (interaction._roleIds) return interaction._roleIds;
    const roles = interaction.member?.roles;
    const live = !roles ? [] : Array.isArray(roles) ? roles.map(String) : [...(roles.cache?.keys() ?? [])];
    if (live.length) return live;
    const cached = roleCache.get(interaction.user.id);
    return cached && Date.now() - cached.at < ROLE_CACHE_MS ? cached.ids : [];
  };
  // Si no hay roles en la interacción, pide el miembro al servidor (con tope de 2,5 s) y recuerda sus roles
  async function loadRoles(interaction) {
    if (interaction._roleIds) return;
    let ids = memberRoleIds(interaction);
    if (!ids.length && interaction.guild) {
      try {
        const member = await Promise.race([
          interaction.guild.members.fetch(interaction.user.id),
          sleep(2500).then(() => { throw new Error('tiempo agotado'); }),
        ]);
        ids = [...member.roles.cache.keys()];
      } catch (err) {
        console.error('[Bot] No se pudieron cargar los roles del miembro:', err.message);
      }
    }
    if (ids.length) roleCache.set(interaction.user.id, { ids, at: Date.now() });
    interaction._roleIds = ids;
  }

  // Scripts que aparecen al elegir uno en un comando:
  // - /panel: solo los propios del usuario.
  // - el resto: los propios y los de creadores que le dieron rol gestor.
  function scriptsForAutocomplete(interaction) {
    const actor = interaction.user.id;
    const creators = new Set([actor]);
    if (interaction.commandName !== 'panel') {
      const roleIds = memberRoleIds(interaction);
      for (const row of q.managerRoleRows.all()) if (roleIds.includes(row.value)) creators.add(row.owner);
    }
    return q.scriptsList.all().filter(s => creators.has(s.user_id));
  }

  // Comandos que el rol gestor (/generatekeyrole) puede usar. El resto solo lo usa el creador.
  const MANAGER_COMMANDS = new Set(['whitelist', 'unwhitelist', 'blacklist', 'unblacklist', 'generatekey', 'deletekey', 'dropkey', 'cookiegame']);

  // Permiso sobre el workspace de workspaceId (el creador del script) para el comando actual:
  // dueño de la plataforma, el propio creador o admin del servidor usan todo;
  // el rol gestor del creador solo usa MANAGER_COMMANDS.
  function canUse(interaction, workspaceId) {
    const actor = interaction.user.id;
    if (isPlatformOwner(actor) || (workspaceId && actor === workspaceId)) return true;
    if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return true;
    if (!MANAGER_COMMANDS.has(interaction.commandName)) return false;
    const managerRole = settingFor(workspaceId, 'manager_role');
    return Boolean(managerRole && memberRoleIds(interaction).includes(managerRole));
  }

  // Registro de eventos en el canal de logs que configuró el creador del script (/logs)
  async function logScriptEvent(script, text, userId = null, opts = {}) {
    // Siempre se guarda en la base (lo ve el panel admin), tenga o no canal de logs
    const plain = text
      .replace(/<@&(\d+)>/g, '@role:$1')
      .replace(/<@!?(\d+)>/g, '@$1')
      .replace(/<#(\d+)>/g, '#$1');
    try { q.logInsert.run(script.id, script.name, plain, now()); } catch (err) { console.error('[Bot] No se pudo guardar el log:', err.message); }

    const channelId = settingFor(script.user_id, 'log_channel');
    if (!channelId) return;
    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel?.isTextBased()) return;
      const embed = new EmbedBuilder()
        .setColor(opts.color ?? 0x5865f2)
        .setTitle(opts.title ?? `📜 ${script.name}`)
        .setDescription(text)
        .setFooter({ text: 'logs by Vantarmor', iconURL: client.user.displayAvatarURL() })
        .setTimestamp();
      // Usuario de Discord vinculado a la key: nombre y foto
      const user = userId ? await client.users.fetch(userId).catch(() => null) : null;
      if (user) embed.setAuthor({ name: user.username, iconURL: user.displayAvatarURL() }).setThumbnail(user.displayAvatarURL());
      // Sin usuario de Discord (FFA): autor con el avatar de Roblox en chiquito
      if (!user && opts.author) embed.setAuthor(opts.author);
      // Avatar de Roblox (si se pudo consultar) reemplaza la miniatura
      if (opts.thumbnail) embed.setThumbnail(opts.thumbnail);
      await channel.send({ content: opts.content, embeds: [embed], components: opts.components ?? [] });
    } catch (err) {
      console.error('[Bot] No se pudo escribir en el canal de logs:', err.message);
    }
  }

  // Una regla de whitelist vale solo mientras no venza (expires_at NULL = permanente)
  const ruleActive = r => r.expires_at == null || r.expires_at > now();

  // Ya tiene acceso (key activa, creador, o whitelist por usuario o rol). No crea keys.
  function hasAccess(script, userId, roleIds) {
    if (q.activeKeyFor.get(script.id, userId, now())) return true;
    if (userId === owner() || userId === script.user_id) return true;
    return q.rulesForScript.all(script.id).filter(ruleActive).some(r =>
      (r.kind === 'user' && r.discord_id === userId) || (r.kind === 'role' && roleIds.includes(r.discord_id)));
  }

  // Mensaje para quien no tiene whitelist ni key (estilo Luarmor)
  const NO_ACCESS_MSG = 'You need to be whitelisted to get this script.\nIf you have a script key, click on the Redeem button below to redeem it';
  const KEY_LIMIT_MSG = '⛔ El creador de este script alcanzó el límite de keys de su plan en este periodo. Vuelve a intentar cuando se reinicie.';

  // Bloqueo: blacklist o key baneada en ese script
  const isBlocked = (script, userId, roleIds = []) =>
    Boolean(q.blacklisted.get(script.id, userId) || q.bannedKeyFor.get(script.id, userId)
      || roleIds.some(r => q.roleBlacklisted.get(script.id, r)));

  // Acceso a un script: blacklist, whitelist (usuario o rol), creador/dueño, o key existente
  function resolveAccess(script, userId, roleIds) {
    if (isBlocked(script, userId, roleIds)) return { status: 'blacklisted' };
    const existing = q.activeKeyFor.get(script.id, userId, now());
    if (existing) return { status: 'ok', key: existing.key };
    const allowed = userId === owner() || userId === script.user_id
      || q.rulesForScript.all(script.id).filter(ruleActive).some(r =>
        (r.kind === 'user' && r.discord_id === userId) || (r.kind === 'role' && roleIds.includes(r.discord_id)));
    if (!allowed) return { status: 'none' };
    // Las keys automáticas también cuentan para el límite del plan del creador
    if (!keyCapOk(script.user_id, 1)) return { status: 'limit' };
    const key = makeKey();
    q.insertClaimed.run(key, script.id, userId); // whitelist: key automática vinculada al usuario
    return { status: 'ok', key };
  }

  function loaderText(script, key) {
    const url = `${publicUrl}${script.loader_id ? `/files/v1/loaders/${script.loader_id}.lua` : `/scripts/hosted/${script.slug}`}`;
    if (script.ffa) return `loadstring(game:HttpGet("${url}"))()`;
    return [
      `script_key = "${key}"`,
      `loadstring(game:HttpGet("${url}"))()`,
    ].join('\n');
  }

  const cooldowns = new Map();
  function onCooldown(actorId) {
    const last = cooldowns.get(actorId) ?? 0;
    if (Date.now() - last < ACTION_COOLDOWN_MS) return true;
    cooldowns.set(actorId, Date.now());
    return false;
  }

  // Tarjeta mientras el script está en mantenimiento (el loader tampoco se entrega)
  // Mantenimiento total: el bot también responde con la tarjeta de mantenimiento
  const maintenanceAllOn = () => db.prepare("SELECT value FROM app_settings WHERE name = 'maintenance_all'").get()?.value === '1';
  const inMaintenance = script => Boolean(script.maintenance) || maintenanceAllOn();
  function maintenanceCard(script) {
    const embed = new EmbedBuilder()
      .setColor(0xfaa61a)
      .setTitle(`En mantenimiento · ${script.name}`)
      .setDescription('Este script está en mantenimiento. Vuelve a intentarlo en unos minutos.');
    return { embeds: [embed], components: [] };
  }

  // Tarjeta para quien no tiene acceso: explica cómo conseguirlo y trae los botones correspondientes
  function noAccessCard(script) {
    const embed = new EmbedBuilder()
      .setColor(0x2b2d31)
      .setTitle(`Acceso restringido · ${script.name}`)
      .setDescription([
        '🔑 Tienes una key → **Redeem Key**',
        '📋 Estás en la whitelist → **Get Script**',
        '❔ Sin acceso → pídelo al creador',
      ].join('\n'));
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`vanta:redeem:${script.id}`).setLabel('🔑 Redeem Key').setStyle(ButtonStyle.Success),
    );
    return { embeds: [embed], components: [row] };
  }

  // Lógica compartida entre comandos y botones del panel
  function getScriptReply(script, userId, roleIds) {
    if (inMaintenance(script)) return maintenanceCard(script);
    if (script.ffa) return `\`\`\`lua\n${loaderText(script)}\n\`\`\``;
    const access = resolveAccess(script, userId, roleIds);
    if (access.status === 'blacklisted') return `⛔ Estás bloqueado para **${script.name}**.`;
    if (access.status === 'limit') return KEY_LIMIT_MSG;
    if (access.status === 'none') {
      console.log(`[Bot] Sin acceso: script ${script.id} (${script.name}), usuario ${userId}, roles vistos ${roleIds.length}`);
      return noAccessCard(script);
    }
    logScriptEvent(script, `📜 <@${userId}> obtuvo el loader`);
    return `\`\`\`lua\n${loaderText(script, access.key)}\n\`\`\``;
  }

  function redeemKey(code, userId) {
    const k = q.keyByCode.get(code);
    if (!k) return '❌ Key inválida.';
    if (k.banned) return `⛔ Esta key está bloqueada${k.ban_reason ? `: ${k.ban_reason}` : ''}.`;
    if (k.expires_at && k.expires_at <= now()) return '❌ Esta key expiró.';
    if (k.discord_id && k.discord_id !== userId) return '❌ Esta key ya está vinculada a otra cuenta.';
    if (isBlocked({ id: k.script_id }, userId)) return '⛔ Estás bloqueado para este script.';
    if (q.activeKeyFor.get(k.script_id, userId, now())) return '✅ Ya tienes acceso a este script. Usa Get Script.';
    q.claim.run(userId, code);
    const claimedScript = q.scriptById.get(k.script_id);
    if (claimedScript) logScriptEvent(claimedScript, `🎟️ <@${userId}> canjeó una key`);
    const s = q.scriptById.get(k.script_id);
    return `✅ Key canjeada para **${s?.name ?? 'tu script'}**. Usa **Get Script** para obtener el loader.`;
  }

  // Intervalo de reinicio de HWID del script (horas; 0 = desactivado)
  const hwidHours = script => script.hwid_reset_hours ?? 24;

  // bypass = creador del script: ignora el intervalo y el botón desactivado
  function resetHwid(script, targetId, actorId, bypass) {
    const k = q.activeKeyFor.get(script.id, targetId, now());
    if (!k) return '❌ No hay una key activa para ese usuario en este script.';
    if (!bypass) {
      if (hwidHours(script) === 0) return '🔒 El reinicio de HWID está desactivado para este script.';
      const cooldown = hwidHours(script) * 3600;
      if (k.hwid_reset_at && now() - k.hwid_reset_at < cooldown) {
        return `⏳ Podrás reiniciar el HWID <t:${k.hwid_reset_at + cooldown}:R>.`;
      }
    }
    q.resetHwid.run(now(), k.key);
    logScriptEvent(script, `⚙️ HWID reiniciado para <@${targetId}>${targetId !== actorId ? ` por <@${actorId}>` : ''}`);
    return '✅ HWID reiniciado. Vuelve a ejecutar el loader.';
  }

  function maskKey(code) {
    return `${code.slice(0, 6)}…${code.slice(-4)}`;
  }

  // Get Stats del panel: estado del usuario en ese script.
  // Whitelist y key se tratan igual: resolveAccess crea la key de whitelist si aún no existe.
  function scriptStatsReply(userId, script, roleIds) {
    const granted = resolveAccess(script, userId, roleIds);
    if (granted.status === 'blacklisted') return `⛔ Estás bloqueado para **${script.name}**.`;
    if (granted.status === 'limit') return KEY_LIMIT_MSG;
    if (granted.status === 'none') return noAccessCard(script);
    const k = q.keyForScriptUser.get(script.id, userId);
    const lines = [`📊 **Tu estado en ${script.name}**`, 'Acceso: ✅ Key activa'];
    if (k) {
      const cooldown = hwidHours(script) * 3600;
      const cooldownEnds = k.hwid_reset_at ? k.hwid_reset_at + cooldown : 0;
      lines.push(`Key: \`${maskKey(k.key)}\` · ${keyState(k)}`);
      lines.push(`Vence: ${k.expires_at ? `<t:${k.expires_at}:R>` : 'nunca'}`);
      lines.push(`HWID: ${k.hwid ? 'vinculado' : 'sin vincular'}`);
      lines.push(`Reinicio HWID: ${hwidHours(script) === 0 ? 'desactivado' : cooldownEnds > now() ? `<t:${cooldownEnds}:R>` : 'disponible'}`);
    }
    return lines.join('\n');
  }

  // /stats: resumen de todas tus keys. Con script (botón del panel): tu estado en ese script
  function statsReply(userId, script = null, roleIds = []) {
    if (script) return scriptStatsReply(userId, script, roleIds);
    const rows = q.keysOfUser.all(userId);
    if (!rows.length) return 'No tienes keys todavía. Canjea una con **Redeem Key**.';
    const lines = rows.slice(0, 15).map(r =>
      `• **${r.script_name}**: ${keyState(r)} · vence ${r.expires_at ? `<t:${r.expires_at}:R>` : 'nunca'} · HWID ${r.hwid ? 'vinculado' : 'sin vincular'}`);
    return `📊 **Tus keys**\n${lines.join('\n')}`;
  }

  // Da automáticamente el rol comprador del creador al usuario (whitelist o canje de key).
  // Busca el servidor donde está ese rol; si el bot no está ahí, no hace nada.
  async function grantBuyerRole(script, userId) {
    const roleId = settingFor(script.user_id, 'buyer_role');
    if (!roleId) return null;
    for (const guild of client.guilds.cache.values()) {
      if (!guild.roles.cache.has(roleId)) continue;
      try {
        const member = await guild.members.fetch(userId);
        await member.roles.add(roleId);
        logScriptEvent(script, `👤 <@${userId}> recibió el rol comprador automáticamente`);
        return guild;
      } catch (err) {
        console.warn('[Bot] No se pudo dar el rol comprador:', err.message);
        return null;
      }
    }
    return null;
  }

  // Canje de key: además de activarla, da el rol comprador
  async function redeemWithRole(code, userId) {
    const result = redeemKey(code, userId);
    const row = db.prepare('SELECT script_id FROM keys WHERE key = ? AND discord_id = ?').get(code, userId);
    const script = row ? q.scriptById.get(row.script_id) : null;
    if (script) {
      const guild = await grantBuyerRole(script, userId);
      if (guild) return `${result}\n🎭 Te dimos el rol comprador en **${guild.name}**.`;
    }
    return result;
  }

  async function giveBuyerRole(interaction, script) {
    const roleId = settingFor(script.user_id, 'buyer_role');
    if (!roleId) return '👤 El creador de este script todavía no configuró el rol comprador con /getrole.';
    try {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      await member.roles.add(roleId);
      logScriptEvent(script, `👤 <@${interaction.user.id}> recibió el rol comprador`);
      return `✅ Rol asignado: <@&${roleId}>`;
    } catch (err) {
      console.error('[Bot] Error asignando rol:', err);
      return '❌ No pude asignar el rol. Verifica que el bot tenga Manage Roles y que su rol esté por encima del rol comprador.';
    }
  }

  // Avatar de Discord; si el usuario no tiene avatar propio, usa el avatar por defecto
  function avatarUrl(id, avatar) {
    if (avatar) return `https://cdn.discordapp.com/avatars/${id}/${avatar}.png?size=64`;
    return `https://cdn.discordapp.com/embed/avatars/${(BigInt(id) >> 22n) % 6n}.png`;
  }

  // Fecha en formato DD/MM/YYYY HH:mm, zona horaria de Ecuador
  function formatPanelDate(ts) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
      timeZone: 'America/Guayaquil', day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(ts).map(p => [p.type, p.value]));
    return `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}`;
  }

  // Panel con botones (estilo Luarmor): muestra quién creó el script
  function panelPayload(script, customDescription) {
    const creator = script.user_id ? q.userById.get(script.user_id) : null;
    const creatorName = creator?.username || (script.user_id ? `ID ${script.user_id}` : 'Vantarmor');
    const creatorIcon = script.user_id ? (creator?.custom_avatar || avatarUrl(script.user_id, creator?.avatar)) : undefined;
    const defaultDescription = `This control panel is for the project: **${script.name}**\nIf you're a buyer, click on the buttons below to redeem your key, get the script or get your role`;
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(`Panel de acceso · ${script.name}`)
      .setDescription(customDescription || defaultDescription)
      .setFooter({ text: `Sent by ${creatorName} | ${formatPanelDate(new Date())}`, iconURL: creatorIcon });
    const row1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`vanta:redeem:${script.id}`).setLabel('🔑 Redeem Key').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`vanta:script:${script.id}`).setLabel('📜 Get Script').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`vanta:role:${script.id}`).setLabel('👤 Get Role').setStyle(ButtonStyle.Primary),
    );
    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`vanta:hwid:${script.id}`).setLabel('⚙️ Reset HWID').setStyle(ButtonStyle.Secondary)
        .setDisabled(hwidHours(script) === 0),
      new ButtonBuilder().setCustomId(`vanta:stats:${script.id}`).setLabel('📊 Get Stats').setStyle(ButtonStyle.Secondary),
    );
    return { embeds: [embed], components: [row1, row2] };
  }

  // Aviso que se muestra cuando Discord responde "Missing Permissions" (código 50013) al publicar en un canal
  const BOT_PERMS_HELP = 'El bot no tiene permisos para publicar en ese canal. Dale al bot (o a su rol) los permisos Ver canal, Enviar mensajes e Insertar enlaces en ese canal. Tutorial: https://files.catbox.moe/ombcj8.mp4';

  // Responde directo. Solo si el trabajo tarda más de 2,5 s se muestra "pensando": así Discord no
  // expira la interacción (tiene unos 3 s para contestar) y el mensaje casi nunca aparece.
  function fastReply(interaction, visibility = {}) {
    let state = 'none'; // none | deferred | replied
    let deferred = null;
    const timer = setTimeout(() => {
      if (state !== 'none') return;
      state = 'deferred';
      deferred = interaction.deferReply(visibility).catch(() => {});
    }, 2500);
    const send = async payload => {
      clearTimeout(timer);
      const p = typeof payload === 'string' ? { content: payload } : payload;
      if (state === 'none') {
        state = 'replied';
        return interaction.reply({ ...p, ...visibility });
      }
      if (deferred) await deferred;
      return interaction.editReply(p);
    };
    return { send };
  }

  // ---------- Manejadores ----------

  async function handleChat(interaction) {
    const actor = interaction.user.id;
    const cmd = interaction.commandName;
    const isPublic = PUBLIC_COMMANDS.has(cmd);
    const visibility = isPublic ? {} : { flags: MessageFlags.Ephemeral };
    const rr = fastReply(interaction, visibility);
    const reply = content => rr.send({ content });
    await loadRoles(interaction);
    const denied = '⛔ No tienes permiso para esta acción.';

    switch (cmd) {
      case 'ping':
        return reply(`Pong · ${Math.round(interaction.client.ws.ping)} ms`);

      case 'panel': {
        const script = findScript(interaction.options.getString('script', true));
        if (!script) return reply('❌ Script no encontrado.');
        // Solo el creador publica el panel de sus scripts (ni gestores ni admins)
        if (script.user_id !== actor) return reply('⛔ Solo el creador de este script puede publicar su panel.');
        // Además, debe tener permisos de administración en el servidor donde se publica
        if (!interaction.inGuild() || !(await isStaffOf(interaction.guild, actor))) {
          return reply('⛔ Necesitas permisos de administración (Administrador, Gestionar servidor, Gestionar mensajes o Moderar miembros) en este servidor para publicar el panel.');
        }
        const customDescription = interaction.options.getString('descripcion')?.replace(/\\n/g, '\n');
        // interaction.channel puede venir vacío si el bot no tiene acceso al canal: lo buscamos directamente
        const channel = interaction.channel ?? await interaction.client.channels.fetch(interaction.channelId).catch(() => null);
        if (!channel?.send) return reply('❌ No puedo publicar el panel en este canal. Revisa que el bot tenga permisos para Ver canal y Enviar mensajes.');
        const sent = await channel.send(panelPayload(script, customDescription));
        q.panelInsert.run(script.id, interaction.channelId, sent.id, now());
        logScriptEvent(script, `📌 Panel publicado por <@${actor}> en <#${interaction.channelId}>`);
        return reply(`✅ Panel de **${script.name}** publicado.`);
      }

      case 'hostproyect': {
        // Mismo flujo que el obfuscador de la web: cuenta contra las cuotas de tu plan
        const file = interaction.options.getAttachment('archivo', true);
        const obf = interaction.options.getString('ofuscador') || 'real';
        const names = { real: 'Ofuscador 1', obscura: 'Ofuscador 2' };
        if (!/\.(lua|luau|txt)$/i.test(file.name || '')) return reply('❌ Adjunta un archivo .lua');
        if (file.size > 2 * 1024 * 1024) return reply('❌ El archivo supera 2 MB.');
        const limitMsg = quota.quotaError(actor, { isNewScript: false, isFfa: false });
        if (limitMsg) return reply(`⛔ ${limitMsg}`);
        const src = await (await fetch(file.url)).text();
        let out;
        try {
          out = await obfuscate(src, obf, { vm: obf === 'real' });
        } catch (err) {
          return reply(`❌ ${err.message || 'No se pudo ofuscar el archivo.'}`);
        }
        db.prepare('UPDATE users SET obf_used = obf_used + 1 WHERE id = ?').run(actor);
        return rr.send({
          content: `✅ Archivo ofuscado con ${names[obf] || obf}.`,
          files: [new AttachmentBuilder(Buffer.from(out, 'utf8'), { name: 'protegido.lua' })],
        });
      }

      case 'stats':
        return reply(statsReply(actor));

      case 'redeem':
        return reply(await redeemWithRole(interaction.options.getString('key', true).trim(), actor));

      case 'generatekey': {
        const script = findScript(interaction.options.getString('script', true));
        if (!script) return reply('❌ Script no encontrado.');
        if (!canUse(interaction, script.user_id)) return reply(denied);
        if (onCooldown(actor)) return reply('⏳ Espera unos segundos antes de otra acción.');
        const amount = interaction.options.getInteger('amount') ?? 1;
        if (!keyCapOk(script.user_id, amount)) return reply(`❌ El plan Free permite ${FREE_KEY_CAP} keys cada 15 días. Pasa a Premium para más.`);
        const raw = interaction.options.getString('duration');
        let seconds = null;
        if (raw) {
          seconds = parseDuration(raw);
          if (!seconds) return reply('❌ Duración inválida. Usa 30d, 12h, 1w, 1mo o 1y.');
        }
        const expires = seconds ? now() + seconds : null;
        logScriptEvent(script, `🔑 <@${actor}> generó ${amount} key(s)`);
        const list = db.transaction(() => {
          const out = [];
          for (let i = 0; i < amount; i++) {
            let k;
            do { k = makeKey(); } while (q.keyByCode.get(k));
            q.insertKey.run(k, script.id, expires);
            out.push(k);
          }
          return out;
        })();
        return reply(`✅ ${list.length} key(s) para **${script.name}**:\n\`\`\`\n${list.join('\n')}\n\`\`\``);
      }

      case 'logs': {
        if (!isPlatformOwner(actor) && !createdAnyScript(actor)) return reply('⛔ Solo creadores de scripts pueden configurar los logs.');
        let channel = interaction.options.getChannel('canal');
        let created = false;
        if (!channel) {
          // Sin canal: usa #logs-bot si ya existe en el servidor, o lo crea (visible solo para ti y el bot)
          const guild = interaction.guild;
          if (!guild) return reply('❌ Usa /logs dentro de tu servidor de Discord.');
          await guild.channels.fetch();
          channel = guild.channels.cache.find(c => c.name === 'logs-bot' && c.type === ChannelType.GuildText) || null;
          if (!channel) {
            try {
              channel = await guild.channels.create({
                name: 'logs-bot',
                type: ChannelType.GuildText,
                topic: 'Registro de usos de tus scripts de Vantarmor',
                permissionOverwrites: [
                  { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
                  { id: actor, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] },
                  { id: interaction.client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks] },
                ],
                reason: `/logs por ${interaction.user.tag}`,
              });
              created = true;
            } catch (err) {
              console.error('[Bot] No se pudo crear #logs-bot:', err.message);
              return reply('❌ No pude crear #logs-bot. Dale al bot el permiso "Gestionar canales" o elige un canal con la opción canal.');
            }
          }
        }
        q.settingSet.run(actor, 'log_channel', channel.id);
        return reply(`✅ Los logs de tus scripts se enviarán a <#${channel.id}>.${created ? ' Creé #logs-bot para ti; solo lo ves tú y el bot.' : ''}`);
      }

      // Sorteo: genera las keys y anuncia la cuenta regresiva (un mensaje por número)
      case 'dropkey': {
        const script = findScript(interaction.options.getString('script', true));
        if (!script) return reply('❌ Script no encontrado.');
        if (!canUse(interaction, script.user_id)) return reply(denied);
        if (onCooldown(actor)) return reply('⏳ Espera unos segundos antes de otra acción.');
        const amount = interaction.options.getInteger('amount', true);
        if (!keyCapOk(script.user_id, amount)) return reply(`❌ El plan Free permite ${FREE_KEY_CAP} keys cada 15 días. Pasa a Premium para más.`);
        const list = db.transaction(() => {
          const out = [];
          for (let i = 0; i < amount; i++) {
            let k;
            do { k = makeKey(); } while (q.keyByCode.get(k));
            q.insertKey.run(k, script.id, null);
            out.push(k);
          }
          return out;
        })();
        const channel = interaction.channel;
        await channel.send('# Key drop!!\n@everyone');
        for (let n = 10; n >= 1; n--) {
          await sleep(1000);
          await channel.send(String(n));
        }
        await sleep(1000);
        await channel.send('# GO!!');
        await channel.send(`\`\`\`\n${list.join('\n')}\n\`\`\``);
        logScriptEvent(script, `🎁 Key drop de ${amount} key(s) por <@${actor}>`);
        return reply(`✅ Drop de ${amount} key(s) para **${script.name}** enviado.`);
      }

      case 'deletekey': {
        const code = interaction.options.getString('key')?.trim();
        const target = interaction.options.getUser('user');
        if (!code && !target) return reply('❌ Indica una key o un usuario.');
        // Script opcional: si no lo eliges, aplica a todos tus scripts (o los que gestionas)
        const scriptArg = interaction.options.getString('script');
        const onlyScript = scriptArg ? findScript(scriptArg) : null;
        if (scriptArg && !onlyScript) return reply('❌ Script no encontrado.');

        // Por key: borra esa key si el script es tuyo (o de un creador que te dio rol gestor)
        if (code) {
          const k = q.keyByCode.get(code);
          if (!k) return reply('❌ Esa key no existe.');
          const script = q.scriptById.get(k.script_id);
          if (!canUse(interaction, script?.user_id)) return reply(denied);
          if (onCooldown(actor)) return reply('⏳ Espera unos segundos antes de otra acción.');
          q.deleteKey.run(code);
          if (script) logScriptEvent(script, `🗑️ <@${actor}> eliminó una key`);
          return reply(`🗑️ Key eliminada de **${script?.name ?? 'script desconocido'}**.`);
        }

        // Por usuario: borra sus keys vinculadas solo de los scripts que puedes gestionar
        const linked = q.keysByDiscord.all(target.id).filter(k => !onlyScript || k.script_id === onlyScript.id);
        const allowed = linked.filter(k => {
          const s = q.scriptById.get(k.script_id);
          return s && canUse(interaction, s.user_id);
        });
        if (!linked.length) return reply(`❌ <@${target.id}> no tiene keys vinculadas.`);
        if (!allowed.length) return reply(denied);
        if (onCooldown(actor)) return reply('⏳ Espera unos segundos antes de otra acción.');
        db.transaction(() => { for (const k of allowed) q.deleteKey.run(k.key); })();
        const byScript = new Map();
        for (const k of allowed) byScript.set(k.script_id, (byScript.get(k.script_id) ?? 0) + 1);
        for (const [scriptId, n] of byScript) {
          const s = q.scriptById.get(scriptId);
          if (s) logScriptEvent(s, `🗑️ <@${actor}> eliminó ${n} key(s) de <@${target.id}>`);
        }
        const names = [...byScript.keys()].map(id => `**${q.scriptById.get(id)?.name ?? id}**`).join(', ');
        return reply(`🗑️ ${allowed.length} key(s) de <@${target.id}> eliminadas en ${names}.${allowed.length < linked.length ? ` (${linked.length - allowed.length} de otros creadores no se tocaron.)` : ''}`);
      }

      case 'addtime': {
        const code = interaction.options.getString('key', true).trim();
        const k = q.keyByCode.get(code);
        if (!k) return reply('❌ Esa key no existe.');
        const script = q.scriptById.get(k.script_id);
        if (!canUse(interaction, script?.user_id)) return reply(denied);
        const secs = parseDuration(interaction.options.getString('duration', true));
        if (!secs) return reply('❌ Duración inválida. Usa 30d, 12h, 1w, 1mo o 1y.');
        if (k.expires_at === null) return reply('ℹ️ Esa key ya es forever.');
        q.setExpiry.run(Math.max(k.expires_at, now()) + secs, code);
        return reply('✅ Tiempo añadido.');
      }

      case 'resethwid': {
        const script = findScript(interaction.options.getString('script', true));
        if (!script) return reply('❌ Script no encontrado.');
        const target = interaction.options.getUser('user');
        const isManager = canUse(interaction, script.user_id);
        if (target && target.id !== actor && !isManager) return reply('⛔ Solo el creador del script puede reiniciar el HWID de otros.');
        const who = target?.id ?? actor;
        // El creador reinicia sin esperar el intervalo ni el botón desactivado
        return reply(resetHwid(script, who, actor, isManager));
      }

      case 'whitelist':
      case 'unwhitelist': {
        const rawScript = String(interaction.options.getString('script', true) ?? '').trim().replace(/^#/, '');
        // Con nombre escrito a mano y varios scripts con ese nombre, no adivina: obliga a elegir de la lista
        if (!/^\d+$/.test(rawScript) && q.scriptsNamed.all(rawScript).length > 1) {
          return reply('❌ Hay varios scripts con ese nombre. Elige el correcto de la lista que aparece al escribir el script (autocompletado).');
        }
        const script = findScript(rawScript);
        if (!script) return reply('❌ Script no encontrado.');
        if (!canUse(interaction, script.user_id)) return reply(denied);
        const user = interaction.options.getUser('user');
        const role = interaction.options.getRole('role');
        if (!user && !role) return reply('❌ Selecciona un usuario o un rol.');
        if (user && role) return reply('❌ Selecciona solo un destino: usuario o rol.');
        const kind = user ? 'user' : 'role';
        const id = (user ?? role).id;
        const label = user ? `<@${id}>` : `<@&${id}>`;
        if (cmd === 'whitelist') {
          const raw = interaction.options.getString('duration');
          const secs = raw ? parseDuration(raw) : null;
          if (raw && !secs) return reply('❌ Duración inválida. Usa 30d, 12h, 1w, 1mo o 1y, o déjalo vacío para permanente.');
          const expires = secs ? now() + secs : null;
          const expiryText = expires ? `hasta <t:${expires}:f>` : 'permanente';
          q.ruleInsert.run(script.id, kind, id, user ? user.username : role.name, expires);
          logScriptEvent(script, `✅ ${label} añadido a la whitelist por <@${actor}> (${expires ? 'temporal' : 'permanente'})`);
          // Whitelist de usuario: su key se crea (o se ajusta) con la misma duración, si no está bloqueado
          let keyLimited = false;
          if (user && !isBlocked(script, id)) {
            const active = q.activeKeyFor.get(script.id, id, now());
            if (active) q.setExpiry.run(expires, active.key);
            else if (keyCapOk(script.user_id, 1)) q.insertKeyExp.run(makeKey(), script.id, expires, id);
            else keyLimited = true;
          }
          const panel = q.panelForScript.get(script.id);
          const where = panel ? ` en el panel <#${panel.channel_id}>` : '';
          const roleGuild = user ? await grantBuyerRole(script, id) : null;
          const roleNote = roleGuild ? ` Se le dio el rol comprador en **${roleGuild.name}**.` : '';
          return reply(`✅ ${label} añadido a la whitelist de **${script.name}** (${expiryText}). Puede obtener el script con Get Script${where}.${roleNote}${keyLimited ? ' Su key se creará cuando se reinicie el límite de keys del plan.' : ''}`);
        }
        q.ruleDelete.run(script.id, kind, id);
        logScriptEvent(script, `➖ ${label} quitado de la whitelist por <@${actor}>`);
        return reply(`✅ ${label} quitado de la whitelist de **${script.name}**.`);
      }

      case 'cookiegame': {
        const script = findScript(interaction.options.getString('script', true));
        if (!script) return reply('❌ Script no encontrado.');
        if (!canUse(interaction, script.user_id)) return reply(denied);
        const raw = interaction.options.getString('duration');
        const secs = raw ? parseDuration(raw) : null;
        if (raw && !secs) return reply('❌ Duración inválida. Usa 30d, 12h, 1w, 1mo o 1y, o déjalo vacío para permanente.');
        const channel = interaction.channel;
        if (!channel?.isTextBased()) return reply('❌ Usa /cookiegame en un canal de texto.');
        return reply(await startCookieGame(channel, script, secs, raw));
      }

      case 'blacklist': {
        const script = findScript(interaction.options.getString('script'));
        if (script && !canUse(interaction, script.user_id)) return reply(denied);
        const target = interaction.options.getUser('user');
        const role = interaction.options.getRole('role');
        const reason = interaction.options.getString('reason') || 'Sin razón indicada';
        if (!target && !role) return reply('❌ Elige un usuario o un rol.');
        // Sin script: solo afecta a los scripts que el actor puede gestionar
        const targets = script ? [script] : q.scriptsList.all().filter(s => canUse(interaction, s.user_id));
        if (!targets.length) return reply(denied);
        if (role) {
          // Bloqueo por rol: la regla impide nuevas keys a quien tenga el rol; las keys de los miembros actuales se banean
          if (!interaction.guild) return reply('❌ Usa este comando dentro de un servidor.');
          const members = (await interaction.guild.members.fetch()).filter(m => !m.user.bot && m.roles.cache.has(role.id));
          for (const s of targets) {
            q.roleBlacklistInsert.run(s.id, role.id, reason, now());
            for (const m of members.values()) q.banKeys.run(reason, s.id, m.id);
            logScriptEvent(s, `⛔ Rol <@&${role.id}> bloqueado por <@${actor}> · ${reason}`);
          }
          return reply(`⛔ Rol <@&${role.id}> bloqueado en **${script ? script.name : 'todos tus scripts'}**.\nMiembros con el rol: ${members.size} (keys baneadas).\nRazón: ${reason}`);
        }
        for (const s of targets) {
          q.blacklistInsert.run(s.id, target.id, reason, now());
          q.banKeys.run(reason, s.id, target.id);
          logScriptEvent(s, `⛔ <@${target.id}> bloqueado por <@${actor}> · ${reason}`);
        }
        return reply(`⛔ <@${target.id}> bloqueado en **${script ? script.name : 'todos tus scripts'}**.\nRazón: ${reason}`);
      }

      case 'unblacklist': {
        const script = findScript(interaction.options.getString('script'));
        if (script && !canUse(interaction, script.user_id)) return reply(denied);
        const target = interaction.options.getUser('user');
        const role = interaction.options.getRole('role');
        if (!target && !role) return reply('❌ Elige un usuario o un rol.');
        const targets = script ? [script] : q.scriptsList.all().filter(s => canUse(interaction, s.user_id));
        if (!targets.length) return reply(denied);
        if (role) {
          if (!interaction.guild) return reply('❌ Usa este comando dentro de un servidor.');
          const members = (await interaction.guild.members.fetch()).filter(m => !m.user.bot && m.roles.cache.has(role.id));
          let removedRole = 0;
          for (const s of targets) {
            removedRole += q.roleBlacklistDelete.run(s.id, role.id).changes;
            // Solo se restauran las keys de miembros que no tengan un bloqueo individual
            for (const m of members.values()) if (!q.blacklisted.get(s.id, m.id)) q.unbanKeys.run(s.id, m.id);
            logScriptEvent(s, `✅ Bloqueo de rol <@&${role.id}> quitado por <@${actor}>`);
          }
          return reply(removedRole ? `✅ Bloqueo quitado para el rol <@&${role.id}>.` : `ℹ️ El rol <@&${role.id}> no tenía bloqueo activo.`);
        }
        let removed = 0;
        for (const s of targets) {
          removed += q.blacklistDelete.run(s.id, target.id).changes;
          q.unbanKeys.run(s.id, target.id);
          logScriptEvent(s, `✅ Bloqueo quitado a <@${target.id}> por <@${actor}>`);
        }
        return reply(removed ? `✅ Bloqueo quitado para <@${target.id}>.` : `ℹ️ <@${target.id}> no tenía bloqueo activo.`);
      }

      // Cada creador configura su propio rol comprador (solo para sus scripts)
      case 'getrole': {
        if (!isPlatformOwner(actor) && !createdAnyScript(actor)) return reply('⛔ Solo creadores de scripts pueden configurar el rol comprador.');
        const role = interaction.options.getRole('role', true);
        q.settingSet.run(actor, 'buyer_role', role.id);
        return reply(`✅ Rol comprador para tus scripts: <@&${role.id}>.`);
      }

      case 'generatekeyrole': {
        if (!isPlatformOwner(actor) && !createdAnyScript(actor)) return reply('⛔ Solo creadores de scripts pueden configurar el rol gestor.');
        const role = interaction.options.getRole('role', true);
        q.settingSet.run(actor, 'manager_role', role.id);
        return reply(`✅ Rol gestor para tus scripts: <@&${role.id}>. Puede usar /generatekey, /deletekey, /addtime, /whitelist y /blacklist en tus scripts.`);
      }

      case 'warn': {
        if (!isPlatformOwner(actor) && !createdAnyScript(actor)) return reply('⛔ Solo creadores de scripts pueden advertir a usuarios.');
        const target = interaction.options.getUser('user', true);
        const reason = interaction.options.getString('reason', true);
        q.warnInsert.run(target.id, reason, now());
        return reply(`⚠️ <@${target.id}> recibió una advertencia.\nRazón: ${reason}`);
      }

      case 'prices': {
        if (!isPlatformOwner(actor) && !hasPaidPlan(actor)) return reply('⛔ /prices es solo para planes Premium y Premium Plus.');
        const title = interaction.options.getString('title', true);
        const description = interaction.options.getString('description', true).replace(/\\n/g, '\n');
        const chosen = interaction.options.getChannel('canal');
        const imageRaw = interaction.options.getString('imagen');
        // Canal e imagen se guardan para las próximas veces
        if (chosen) q.settingSet.run(actor, 'prices_channel', chosen.id);
        if (imageRaw !== null) {
          const trimmed = imageRaw.trim();
          if (!trimmed) q.settingDel.run(actor, 'prices_image');
          else {
            let parsed;
            try { parsed = new URL(trimmed); } catch { return reply('❌ La imagen debe ser una URL https válida.'); }
            if (parsed.protocol !== 'https:' || parsed.href.length > 500) return reply('❌ La imagen debe ser una URL https (máx. 500 caracteres).');
            q.settingSet.run(actor, 'prices_image', parsed.href);
          }
        }
        const channelId = chosen?.id ?? settingFor(actor, 'prices_channel');
        if (!channelId) return reply('❌ Elige un canal con la opción canal. Se guardará para la próxima vez.');
        const channel = await interaction.client.channels.fetch(channelId).catch(() => null);
        if (!channel?.isTextBased()) return reply('❌ No encuentro el canal guardado. Elige otro con la opción canal.');
        const imageUrl = imageRaw !== null ? (imageRaw.trim() || null) : settingFor(actor, 'prices_image');
        const embed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle(title)
          .setDescription(description)
          .setFooter({ text: `${interaction.user.username} · Vantarmor` })
          .setTimestamp();
        if (imageUrl) embed.setImage(imageUrl);
        await channel.send({ embeds: [embed] });
        return reply(`✅ Precios publicados en <#${channel.id}>.`);
      }

      case 'updates': {
        if (!isPlatformOwner(actor) && !createdAnyScript(actor)) return reply('⛔ Solo creadores de scripts pueden publicar esto.');
        const title = interaction.options.getString('title', true);
        const description = interaction.options.getString('description', true).replace(/\\n/g, '\n');
        const embed = new EmbedBuilder()
          .setColor(cmd === 'prices' ? 0x5865f2 : 0xe93540)
          .setTitle(title)
          .setDescription(description)
          .setFooter({ text: `Vantarmor · ${new Date().getFullYear()}` })
          .setTimestamp();
        await interaction.channel.send({ embeds: [embed] });
        return reply('✅ Publicado.');
      }

      case 'ticketpanel': {
        if (!interaction.inGuild()) return reply('❌ Usa este comando dentro de tu servidor.');
        if (!(await isStaffOf(interaction.guild, actor))) return reply('⛔ Necesitas permisos de administración en este servidor para publicar el panel de tickets.');
        if (!ticketConfig(interaction.guildId).categoryId) return reply('❌ Primero elige la categoría de tickets con /ticketperm categoria.');
        const channel = interaction.options.getChannel('canal') ?? interaction.channel ?? await interaction.client.channels.fetch(interaction.channelId).catch(() => null);
        if (!channel?.isTextBased()) return reply('❌ No pude acceder a ese canal.');
        const text = interaction.options.getString('mensaje')?.replace(/\\n/g, '\n') || TICKET_DEFAULT_TEXT;
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`vanta:ticket-open:${interaction.guildId}`).setLabel('Abrir ticket').setEmoji('🎟️').setStyle(ButtonStyle.Primary),
        );
        try {
          await channel.send({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('Soporte').setDescription(text)], components: [row] });
        } catch (err) {
          if (err?.code === 50013) return reply(BOT_PERMS_HELP);
          throw err;
        }
        return reply(`✅ Panel de tickets publicado en <#${channel.id}>.`);
      }

      case 'ticketperm': {
        if (!interaction.inGuild()) return reply('❌ Usa este comando dentro de tu servidor.');
        if (interaction.guild.ownerId !== actor && !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
          return reply('⛔ Solo un administrador del servidor puede configurar los tickets.');
        }
        const guildId = interaction.guildId;
        const cfg = ticketConfig(guildId);
        const sub = interaction.options.getSubcommand();
        if (sub === 'agregar-rol') {
          const role = interaction.options.getRole('rol', true);
          if (cfg.staffRoles.includes(role.id)) return reply(`ℹ️ ${role} ya es parte del staff de tickets.`);
          if (cfg.staffRoles.length >= 10) return reply('❌ Solo puedes tener hasta 10 roles de staff. Quita uno antes.');
          ticketSaveConfig(guildId, { staffRoles: [...cfg.staffRoles, role.id] });
          return reply(`✅ ${role} ahora ve y atiende los tickets.`);
        }
        if (sub === 'quitar-rol') {
          const role = interaction.options.getRole('rol', true);
          if (!cfg.staffRoles.includes(role.id)) return reply(`ℹ️ ${role} no estaba en el staff de tickets.`);
          ticketSaveConfig(guildId, { staffRoles: cfg.staffRoles.filter(id => id !== role.id) });
          return reply(`✅ ${role} ya no ve los tickets.`);
        }
        if (sub === 'categoria') {
          const category = interaction.options.getChannel('categoria', true);
          if (category.type !== ChannelType.GuildCategory) return reply('❌ Elige una categoría (no un canal de texto).');
          if (!category.permissionsFor(interaction.client.user)?.has(PermissionFlagsBits.ManageChannels)) {
            return reply(`❌ El bot no puede crear canales en la categoría **${category.name}**. Dale el permiso "Gestionar canales" en esa categoría.`);
          }
          ticketSaveConfig(guildId, { categoryId: category.id });
          return reply(`✅ Los tickets se crearán en la categoría **${category.name}**.`);
        }
        if (sub === 'logs') {
          let channel = interaction.options.getChannel('canal');
          let created = false;
          if (!channel) {
            // Sin canal: uso #logs-tickets si ya existe, o lo creo (visible solo para el staff y el bot)
            await interaction.guild.channels.fetch();
            channel = interaction.guild.channels.cache.find(c => c.name === 'logs-tickets' && c.type === ChannelType.GuildText) || null;
            if (!channel) {
              try {
                channel = await interaction.guild.channels.create({
                  name: 'logs-tickets',
                  type: ChannelType.GuildText,
                  topic: 'Registro de tickets de Vantarmor',
                  permissionOverwrites: [
                    { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
                    { id: interaction.client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks] },
                    { id: actor, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] },
                    ...cfg.staffRoles.map(id => ({ id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] })),
                  ],
                  reason: `/ticketperm logs por ${interaction.user.tag}`,
                });
                created = true;
              } catch (err) {
                console.error('[Bot] No se pudo crear #logs-tickets:', err.message);
                return reply('❌ No pude crear #logs-tickets. Dale al bot el permiso "Gestionar canales" o elige un canal con la opción canal.');
              }
            }
          }
          ticketSaveConfig(guildId, { logChannelId: channel.id });
          return reply(created ? '✅ Creé **#logs-tickets** y los tickets se registrarán ahí.' : `✅ Los tickets se registrarán en <#${channel.id}>.`);
        }

        // ver
        const roles = cfg.staffRoles.map(id => `<@&${id}>`).join(' ') || 'ninguno (solo administradores)';
        const category = cfg.categoryId ? interaction.guild.channels.cache.get(cfg.categoryId) : null;
        return reply([
          '🎟️ **Configuración de tickets**',
          `• Categoría: ${category ? `**${category.name}**` : cfg.categoryId ? 'eliminada (elige otra con /ticketperm categoria)' : 'sin elegir'}`,
          `• Staff: ${roles}`,
          `• Logs: ${cfg.logChannelId ? `<#${cfg.logChannelId}>` : 'sin elegir'}`,
        ].join('\n'));
      }

      case 'lock':
      case 'unlock': {
        if (!interaction.inGuild()) return reply('❌ Usa este comando dentro de tu servidor.');
        if (!(await isStaffOf(interaction.guild, actor))) return reply('⛔ Necesitas permisos de administración en este servidor para bloquear canales.');
        const channel = interaction.options.getChannel('canal') ?? interaction.channel ?? await interaction.client.channels.fetch(interaction.channelId).catch(() => null);
        if (!channel?.permissionOverwrites) return reply('❌ No pude acceder a ese canal.');
        if (!channel.permissionsFor(interaction.client.user)?.has(PermissionFlagsBits.ManageChannels)) {
          return reply(`❌ El bot no puede editar **#${channel.name}**. Dale el permiso "Gestionar canales" en ese canal.`);
        }
        const locking = cmd === 'lock';
        const motivo = interaction.options.getString('motivo');
        // null = quitar el bloqueo del canal (vuelve a lo que dicte el servidor)
        const value = locking ? false : null;
        await channel.permissionOverwrites.edit(interaction.guild.roles.everyone.id, {
          SendMessages: value,
          SendMessagesInThreads: value,
          CreatePublicThreads: value,
          CreatePrivateThreads: value,
        }, { reason: `${cmd === 'lock' ? 'Bloqueado' : 'Desbloqueado'} por ${interaction.user.tag}` });

        // Hilos activos: se bloquean o desbloquean también (necesita "Gestionar hilos")
        let threadsDone = 0;
        if (channel.threads?.fetchActive) {
          const active = await channel.threads.fetchActive().catch(() => null);
          for (const thread of active?.threads?.values() ?? []) {
            await thread.setLocked(locking, `${cmd} por ${interaction.user.tag}`).then(() => { threadsDone++; }).catch(() => {});
          }
        }

        const note = locking
          ? `🔒 Canal bloqueado por <@${actor}>.${motivo ? `\nMotivo: ${motivo}` : ''}`
          : `🔓 Canal desbloqueado por <@${actor}>.`;
        await channel.send({ content: note, allowedMentions: { users: [] } }).catch(() => {});
        return reply(`✅ **#${channel.name}** ${locking ? 'bloqueado' : 'desbloqueado'}${threadsDone ? ` (${threadsDone} hilo(s) activo(s) también)` : ''}.`);
      }

      default:
        return reply('❌ Comando no disponible.');
    }
  }

  // ---------- Juego de la galleta (/cookiegame) ----------
  // Partidas en memoria: el primero que hace click se lleva la whitelist del script por el tiempo elegido
  // Tiempos fijos: 5 s con el botón bloqueado y luego 15 s para hacer click (20 s en total)
  const COOKIE_LOCK_MS = 5_000;
  const COOKIE_OPEN_MS = 15_000;
  const cookieGames = new Map();

  const cookieRow = (id, disabled) => new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`vanta:cookie:${id}`).setLabel('🍪 ¡Click!').setStyle(ButtonStyle.Success).setDisabled(disabled));

  async function startCookieGame(channel, script, secs, raw) {
    const id = crypto.randomBytes(6).toString('hex');
    const durText = secs ? `por ${raw}` : 'de forma permanente';
    const startedMs = Date.now();
    const openMs = startedMs + COOKIE_LOCK_MS;
    const endsAt = Math.floor((startedMs + COOKIE_LOCK_MS + COOKIE_OPEN_MS) / 1000);
    const openAt = Math.floor(openMs / 1000);
    const embed = open => new EmbedBuilder().setColor(open ? 0xf1c40f : 0x99aab5)
      .setTitle(`🍪 Juego de la galleta · ${script.name}`)
      .setDescription(open
        ? `¡Click ahora! El primero gana la whitelist ${durText} de **${script.name}**.\nSe cierra <t:${endsAt}:R>`
        : `🔒 Botón bloqueado. Se activa <t:${openAt}:R>\nSe cierra <t:${endsAt}:R>`);
    const message = await channel.send({ embeds: [embed(false)], components: [cookieRow(id, true)] });
    const game = { id, script, secs, durText, message, winner: null, openMs, timers: [] };
    game.timers.push(setTimeout(() => {
      if (game.winner || !cookieGames.has(id)) return;
      game.message.edit({ embeds: [embed(true)], components: [cookieRow(id, false)] })
        .catch(err => console.error('[Bot] No se pudo activar el botón de la galleta:', err.message));
    }, COOKIE_LOCK_MS));
    game.timers.push(setTimeout(() => endCookieGame(game, null), COOKIE_LOCK_MS + COOKIE_OPEN_MS));
    cookieGames.set(id, game);
    return `✅ Juego publicado en <#${channel.id}>. Se lo lleva el primero que haga click, ${durText}.`;
  }

  async function endCookieGame(game, winnerId) {
    game.timers.forEach(clearTimeout);
    cookieGames.delete(game.id);
    const text = winnerId
      ? `🏆 <@${winnerId}> fue el primero y ganó la whitelist ${game.durText} de **${game.script.name}**.`
      : '⌛ Nadie hizo click a tiempo. La galleta se perdió.';
    const embed = new EmbedBuilder().setColor(winnerId ? 0x57f287 : 0x99aab5)
      .setTitle(`🍪 Juego de la galleta · ${game.script.name}`).setDescription(text);
    await game.message.edit({ embeds: [embed], components: [] }).catch(err =>
      console.error('[Bot] No se pudo actualizar el juego de la galleta:', err.message));
  }

  async function handleCookieClick(interaction, gameId) {
    const game = cookieGames.get(gameId);
    if (!game) return interaction.reply({ content: '⌛ Este juego ya terminó.', flags: MessageFlags.Ephemeral });
    if (Date.now() < game.openMs) return interaction.reply({ content: '🔒 El botón todavía está bloqueado.', flags: MessageFlags.Ephemeral });
    const userId = interaction.user.id;
    if (isBlocked(game.script, userId)) {
      return interaction.reply({ content: `⛔ Estás bloqueado para **${game.script.name}**.`, flags: MessageFlags.Ephemeral });
    }
    // Sin esperas antes de este punto: el primer click borra la partida y los demás ya no ganan
    cookieGames.delete(gameId);
    game.winner = userId;
    const expires = game.secs ? now() + game.secs : null;
    q.ruleInsert.run(game.script.id, 'user', userId, interaction.user.username, expires);
    const active = q.activeKeyFor.get(game.script.id, userId, now());
    if (active) q.setExpiry.run(expires, active.key);
    else if (keyCapOk(game.script.user_id, 1)) q.insertKeyExp.run(makeKey(), game.script.id, expires, userId);
    logScriptEvent(game.script, `🍪 <@${userId}> ganó el juego de la galleta (whitelist ${game.durText})`);
    await interaction.reply({ content: `🏆 ¡Ganaste! Quedaste en la whitelist de **${game.script.name}** ${game.durText}. Usa Get Script para obtener tu loader.`, flags: MessageFlags.Ephemeral });
    await endCookieGame(game, userId);
  }

  // ---------- Tickets (gratis en todos los planes) ----------
  const TICKET_DEFAULT_TEXT = 'Click below to create a new support ticket 🎟️';
  const TICKET_COOLDOWN_MS = 30_000;
  const ticketLastOpen = new Map(); // `${guild}:${user}` -> timestamp
  const tq = {
    settings: db.prepare('SELECT * FROM bot_ticket_settings WHERE guild_id = ?'),
    upsertSettings: db.prepare(`INSERT INTO bot_ticket_settings (guild_id, category_id, staff_roles, log_channel_id) VALUES (?, ?, ?, ?)
      ON CONFLICT(guild_id) DO UPDATE SET category_id = excluded.category_id, staff_roles = excluded.staff_roles, log_channel_id = excluded.log_channel_id`),
    openByUser: db.prepare("SELECT * FROM bot_tickets WHERE guild_id = ? AND user_id = ? AND status = 'open'"),
    byChannel: db.prepare('SELECT * FROM bot_tickets WHERE channel_id = ?'),
    insert: db.prepare("INSERT INTO bot_tickets (guild_id, channel_id, user_id, status, created_at) VALUES (?, ?, ?, 'open', ?)"),
    close: db.prepare("UPDATE bot_tickets SET status = 'closed', closed_at = ? WHERE channel_id = ?"),
  };
  function ticketConfig(guildId) {
    const row = tq.settings.get(guildId);
    let staffRoles = [];
    try { staffRoles = JSON.parse(row?.staff_roles || '[]'); } catch { staffRoles = []; }
    return { categoryId: row?.category_id || null, staffRoles, logChannelId: row?.log_channel_id || null };
  }
  function ticketSaveConfig(guildId, patch) {
    const next = { ...ticketConfig(guildId), ...patch };
    tq.upsertSettings.run(guildId, next.categoryId, JSON.stringify(next.staffRoles), next.logChannelId);
  }

  // Registro de tickets: nombre, ID y foto del usuario; pie "logs by Vantarmor" con el avatar del bot
  async function logTicketEvent(guild, { userId, title, color, fields = [] }) {
    const cfg = ticketConfig(guild.id);
    if (!cfg.logChannelId) return;
    try {
      const channel = await guild.channels.fetch(cfg.logChannelId).catch(() => null);
      if (!channel?.isTextBased()) return;
      const user = await client.users.fetch(userId);
      const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle(title)
        .setAuthor({ name: user.username, iconURL: user.displayAvatarURL() })
        .setThumbnail(user.displayAvatarURL())
        .setDescription(`**Usuario:** <@${user.id}>\n**ID:** \`${user.id}\``)
        .setFooter({ text: 'logs by Vantarmor', iconURL: client.user.displayAvatarURL() })
        .setTimestamp();
      if (fields.length) embed.addFields(fields);
      await channel.send({ embeds: [embed], allowedMentions: { users: [] } });
    } catch (err) {
      console.warn('[Bot] No se pudo registrar el ticket en logs:', err.message);
    }
  }

  async function handleTicketButton(interaction, action, rawId) {
    const actor = interaction.user.id;
    const ephemeral = { flags: MessageFlags.Ephemeral };
    if (!interaction.inGuild()) return interaction.reply({ content: '❌ Los tickets solo funcionan dentro de un servidor.', ...ephemeral });
    const guild = interaction.guild;

    if (action === 'ticket-open') {
      const cfg = ticketConfig(guild.id);
      if (!cfg.categoryId) return interaction.reply({ content: '❌ El staff todavía no configuró la categoría de tickets.', ...ephemeral });
      const existing = tq.openByUser.get(guild.id, actor);
      if (existing) return interaction.reply({ content: `🎟️ Ya tienes un ticket abierto: <#${existing.channel_id}>`, ...ephemeral });
      const cooldownKey = `${guild.id}:${actor}`;
      const wait = TICKET_COOLDOWN_MS - (Date.now() - (ticketLastOpen.get(cooldownKey) ?? 0));
      if (wait > 0) return interaction.reply({ content: `⏳ Espera ${Math.ceil(wait / 1000)} s antes de abrir otro ticket.`, ...ephemeral });

      const tr = fastReply(interaction, ephemeral);
      await guild.roles.fetch();
      const category = guild.channels.cache.get(cfg.categoryId) ?? await guild.channels.fetch(cfg.categoryId).catch(() => null);
      if (!category || category.type !== ChannelType.GuildCategory) {
        return tr.send({ content: '❌ La categoría de tickets ya no existe. Pide al administrador que elija otra con /ticketperm categoria.' });
      }
      const staffRoleIds = cfg.staffRoles.filter(id => guild.roles.cache.has(id));
      const base = (interaction.user.username || 'usuario').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 20) || 'usuario';
      const channel = await guild.channels.create({
        name: `ticket-${base}`,
        type: ChannelType.GuildText,
        parent: category.id,
        topic: `Ticket de ${interaction.user.tag}`,
        permissionOverwrites: [
          { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
          { id: actor, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks] },
          { id: interaction.client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.EmbedLinks] },
          ...staffRoleIds.map(id => ({ id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] })),
        ],
        reason: `Ticket abierto por ${interaction.user.tag}`,
      });
      tq.insert.run(guild.id, channel.id, actor, now());
      ticketLastOpen.set(cooldownKey, Date.now());
      logTicketEvent(guild, { userId: actor, title: '🎟️ Ticket abierto', color: 0x57f287, fields: [{ name: 'Canal', value: `<#${channel.id}>`, inline: true }] });

      const closeRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`vanta:ticket-close:${channel.id}`).setLabel('Cerrar ticket').setEmoji('🔒').setStyle(ButtonStyle.Danger),
      );
      const staffMentions = staffRoleIds.map(id => `<@&${id}>`).join(' ');
      await channel.send({
        content: [`<@${actor}>`, staffMentions].filter(Boolean).join(' '),
        allowedMentions: { users: [actor], roles: staffRoleIds },
        embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('Ticket abierto')
          .setDescription('Explica tu problema con detalle. El staff te atenderá aquí.\nPara cerrarlo usa el botón de abajo.')],
        components: [closeRow],
      }).catch(err => console.warn('[Bot] No se pudo enviar el mensaje del ticket:', err.message));
      return tr.send({ content: `✅ Ticket creado: <#${channel.id}>` });
    }

    if (action === 'ticket-close') {
      const ticket = tq.byChannel.get(rawId);
      if (!ticket || ticket.status !== 'open') return interaction.reply({ content: 'Este ticket ya está cerrado.', ...ephemeral });
      const cfg = ticketConfig(guild.id);
      const isStaff = await isStaffOf(guild, actor) || cfg.staffRoles.some(id => interaction.member?.roles?.cache?.has(id));
      if (ticket.user_id !== actor && !isStaff) return interaction.reply({ content: '⛔ Solo quien abrió el ticket o el staff puede cerrarlo.', ...ephemeral });
      tq.close.run(now(), ticket.channel_id);
      const mins = Math.max(1, Math.round((now() - ticket.created_at) / 60));
      logTicketEvent(guild, { userId: ticket.user_id, title: '🔒 Ticket cerrado', color: 0xed4245, fields: [
        { name: 'Canal', value: `#${interaction.channel?.name ?? ticket.channel_id}`, inline: true },
        { name: 'Cerrado por', value: `<@${actor}>`, inline: true },
        { name: 'Duración', value: `${mins} min`, inline: true },
      ] });
      await interaction.reply({ content: `🔒 Ticket cerrado por <@${actor}>. El canal se borrará en 5 segundos.` });
      setTimeout(() => {
        const channel = interaction.channel;
        channel?.delete(`Ticket cerrado por ${interaction.user.tag}`).catch(err => console.warn('[Bot] No se pudo borrar el ticket:', err.message));
      }, 5000);
    }
  }

  // Botones del log de compartidas: eliminar la key, o permitir el equipo que la intentó usar
  async function handleKeyLogButton(interaction, action, key) {
    const ephemeral = { flags: MessageFlags.Ephemeral };
    const row = db.prepare('SELECT s.user_id FROM keys k JOIN scripts s ON s.id = k.script_id WHERE k.key = ?').get(key);
    if (!row) return interaction.reply({ content: 'Esta key ya no existe.', ...ephemeral });
    const actor = interaction.user.id;
    const allowed = row.user_id === actor || isPlatformOwner(actor)
      || (interaction.inGuild() && await isStaffOf(interaction.guild, actor));
    if (!allowed) return interaction.reply({ content: '⛔ Solo el creador del script o el staff puede usar estos botones.', ...ephemeral });

    if (action === 'allowkey') {
      // Vincula el equipo que intentó usarla; no cuenta como aviso
      const res = db.prepare('UPDATE keys SET hwid = pending_hwid, last_hwid = pending_hwid, pending_hwid = NULL WHERE key = ? AND pending_hwid IS NOT NULL').run(key);
      if (!res.changes) return interaction.reply({ content: 'No hay un equipo pendiente para esta key.', ...ephemeral });
      await interaction.update({ components: [] }).catch(() => {});
      return interaction.followUp({ content: '✅ Acceso permitido: ese equipo quedó vinculado a la key.', ...ephemeral });
    }

    db.prepare('DELETE FROM keys WHERE key = ?').run(key);
    await interaction.update({ components: [] }).catch(() => {});
    return interaction.followUp({ content: '🗑️ Key eliminada.', ...ephemeral });
  }

  async function handleButton(interaction) {
    const [ns, action, rawId] = interaction.customId.split(':');
    if (ns !== 'vanta') return;
    if (action === 'cookie') return handleCookieClick(interaction, rawId);
    if (action === 'delkey' || action === 'allowkey') return handleKeyLogButton(interaction, action, rawId);
    if (action === 'ticket-open' || action === 'ticket-close') return handleTicketButton(interaction, action, rawId);
    const script = findScript(rawId);
    if (!script) return interaction.reply({ content: NO_ACCESS_MSG, flags: MessageFlags.Ephemeral });

    // Bloqueados no pueden usar ningún botón del panel
    if (isBlocked(script, interaction.user.id, memberRoleIds(interaction))) {
      return interaction.reply({ content: `⛔ Estás bloqueado para **${script.name}**. No puedes usar este panel.`, flags: MessageFlags.Ephemeral });
    }

    // El modal no puede ir después de deferReply
    if (action === 'redeem') {
      if (hasAccess(script, interaction.user.id, memberRoleIds(interaction))) {
        return interaction.reply({ content: `✅ Ya tienes acceso a **${script.name}**. Usa **Get Script** para obtener tu loader.`, flags: MessageFlags.Ephemeral });
      }
      const modal = new ModalBuilder().setCustomId(`vanta:redeem-modal:${script.id}`).setTitle('Redeem Key');
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('key').setLabel('Key').setStyle(TextInputStyle.Short)
          .setMinLength(32).setMaxLength(64).setRequired(true),
      ));
      return interaction.showModal(modal);
    }

    const br = fastReply(interaction, { flags: MessageFlags.Ephemeral });
    await loadRoles(interaction);
    // Acepta texto o un payload con tarjetas (embeds y botones)
    const reply = payload => br.send(typeof payload === 'string' ? { content: payload } : payload);
    const actor = interaction.user.id;

    if (action === 'script') return reply(getScriptReply(script, actor, memberRoleIds(interaction)));
    if (action === 'stats') return reply(statsReply(actor, script, memberRoleIds(interaction)));
    if (action === 'role') {
      if (inMaintenance(script)) return reply(maintenanceCard(script));
      const access = resolveAccess(script, actor, memberRoleIds(interaction));
      if (access.status !== 'ok') return reply(access.status === 'limit' ? KEY_LIMIT_MSG : noAccessCard(script));
      return reply(await giveBuyerRole(interaction, script));
    }
    if (action === 'hwid') {
      const access = resolveAccess(script, actor, memberRoleIds(interaction));
      if (access.status !== 'ok') return reply(access.status === 'limit' ? KEY_LIMIT_MSG : noAccessCard(script));
      return reply(resetHwid(script, actor, actor, false));
    }
    return reply('❌ Acción no disponible.');
  }

  async function handleModal(interaction) {
    const [ns, action, rawId] = interaction.customId.split(':');
    if (ns !== 'vanta' || action !== 'redeem-modal') return;
    const mr = fastReply(interaction, { flags: MessageFlags.Ephemeral });
    const code = interaction.fields.getTextInputValue('key').trim();
    return mr.send({ content: await redeemWithRole(code, interaction.user.id) });
  }

  // ---------- Cliente ----------
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

  // Aviso por DM cuando la key de un comprador vence en las próximas 24 h (una vez por vencimiento)
  async function notifyExpiringKeys() {
    const nowS = now();
    const rows = db.prepare(`SELECT k.key, k.discord_id, k.expires_at, s.name AS script_name
      FROM keys k JOIN scripts s ON s.id = k.script_id
      WHERE k.discord_id IS NOT NULL AND k.banned = 0 AND k.expires_at IS NOT NULL
        AND k.expires_at > ? AND k.expires_at <= ?
        AND (k.expiry_notified_for IS NULL OR k.expiry_notified_for != k.expires_at)
      LIMIT 50`).all(nowS, nowS + 86400);
    for (const r of rows) {
      // Se marca antes de enviar: si falla el DM, no se reintenta en bucle
      db.prepare('UPDATE keys SET expiry_notified_for = ? WHERE key = ?').run(r.expires_at, r.key);
      try {
        const user = await client.users.fetch(r.discord_id);
        const embed = new EmbedBuilder().setColor(0xf1c40f)
          .setTitle(`⏳ Tu key de ${r.script_name} está por vencer`)
          .setDescription(`Vence <t:${r.expires_at}:R> (<t:${r.expires_at}:f>).`);
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setLabel('Ver mi cuenta').setStyle(ButtonStyle.Link).setURL(`${publicUrl}/dashboard`));
        await user.send({ embeds: [embed], components: [row] });
      } catch (err) {
        console.warn('[Bot] No se pudo enviar el aviso de vencimiento:', err.message);
      }
    }
  }

  // Canales de texto del servidor, para el selector del panel admin
  // Servidores donde el usuario es dueño o mod (y el bot está), con todos sus canales de texto y anuncios
  const STAFF_PERMS = [PermissionFlagsBits.Administrator, PermissionFlagsBits.ManageGuild, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ModerateMembers];
  const guildChannelsCache = new Map();
  async function textChannelsOf(guild) {
    const hit = guildChannelsCache.get(guild.id);
    if (hit && Date.now() - hit.at < 60_000) return hit.list;
    const all = await guild.channels.fetch();
    const list = [...all.values()]
      .filter(c => c && (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement))
      .map(c => ({ id: c.id, name: c.name, parent: c.parent?.name || '' }))
      .sort((a, b) => a.parent.localeCompare(b.parent) || a.name.localeCompare(b.name));
    guildChannelsCache.set(guild.id, { at: Date.now(), list });
    return list;
  }
  async function isStaffOf(guild, userId) {
    if (guild.ownerId === userId) return true;
    const member = await guild.members.fetch(userId).catch(() => null);
    return Boolean(member && STAFF_PERMS.some(p => member.permissions.has(p)));
  }
  client.guildsForUser = async userId => {
    const out = [];
    for (const guild of client.guilds.cache.values()) {
      if (!(await isStaffOf(guild, userId))) continue;
      out.push({ id: guild.id, name: guild.name, channels: await textChannelsOf(guild) });
    }
    return out;
  };
  // Canal donde el usuario puede publicar: debe ser dueño o mod del servidor de ese canal
  client.channelForStaff = async (userId, channelId) => {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel?.guild) throw new Error('No encuentro ese canal. Revisa el ID y que el bot esté en ese servidor.');
    if (!channel.isTextBased()) throw new Error('Ese canal no es de texto.');
    if (!(await isStaffOf(channel.guild, userId))) throw new Error('Solo puedes publicar en servidores donde eres dueño o mod.');
    return channel;
  };

  client.listTextChannels = () => {
    const guild = guildId ? client.guilds.cache.get(guildId) : client.guilds.cache.first();
    if (!guild) return [];
    return guild.channels.cache
      .filter(c => c.type === 0) // GuildText
      .map(c => ({ id: c.id, name: c.name, parent: c.parent?.name || '' }))
      .sort((a, b) => a.name.localeCompare(b.name));
  };

  // Foto del bot solo en los servidores donde el creador tiene su panel (por servidor, no global)
  client.setGuildAvatarFor = async (userId, url) => {
    const rows = db.prepare('SELECT DISTINCT p.channel_id FROM bot_panels p JOIN scripts s ON s.id = p.script_id WHERE s.user_id = ?').all(userId);
    if (!rows.length) throw new Error('Primero publica tu panel en tu servidor con /panel y luego pon la foto.');
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    const type = (res.headers.get('content-type') || '').split(';')[0].trim();
    if (!res.ok || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(type)) {
      throw new Error('La URL no es una imagen válida (png, jpg, gif o webp).');
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 5 * 1024 * 1024) throw new Error('La imagen pesa más de 5 MB.');
    const dataUri = `data:${type};base64,${buf.toString('base64')}`;
    const guilds = new Set();
    for (const r of rows) {
      const channel = await client.channels.fetch(r.channel_id).catch(() => null);
      if (channel?.guildId) guilds.add(channel.guildId);
    }
    if (!guilds.size) throw new Error('No encuentro tu servidor de Discord.');
    for (const guildId of guilds) {
      await client.rest.patch(Routes.guildMember(guildId, '@me'), { body: { avatar: dataUri } });
    }
    return guilds.size;
  };

  // Changelogs y tabla de precios: los publica el panel admin, no comandos de Discord
  client.announce = async (kind, channelId, title, description, imageUrl = null) => {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased()) throw new Error('Ese canal no es de texto');
    const isPrices = kind === 'prices';
    const embed = new EmbedBuilder()
      .setColor(isPrices ? 0x5865f2 : 0xe93540)
      .setTitle(title)
      .setDescription(description)
      .setFooter({ text: `Vantarmor · ${new Date().getFullYear()}` })
      .setTimestamp();
    if (imageUrl) embed.setImage(imageUrl);
    await channel.send({ embeds: [embed] }).catch(err => {
      if (err.code === 50013) throw new Error(BOT_PERMS_HELP);
      throw err;
    });
  };

  // Expuesto al servidor para registrar cuando se ejecuta un loader
  // Aviso de key usada desde otro equipo: DM al dueño de la key y registro en logs con botón para eliminarla
  // Intento de volcado: avisa al dueño con mención, la key y un botón para eliminarla
  client.notifyTamper = async ({ scriptId, key, hwid, rbxid, discordId, autoRevoked }) => {
    const script = q.scriptById.get(scriptId);
    if (!script) return;
    const text = [
      `• Key: ${key ? `\`${key}\`` : 'sin key'}`,
      `• HWID: ${hwid ? `\`${hwid}\`` : 'sin dato'}`,
      `• Roblox: ${rbxid ? `\`${rbxid}\`` : 'sin dato'}`,
      `• Discord: ${discordId ? `<@${discordId}>` : 'sin vincular'}`,
      autoRevoked ? '• Acción: key revocada automáticamente (opción del script). Para devolverle el acceso usa el botón.'
        : (key ? '• Si no reconoces este uso, elimina la key con el botón.' : ''),
    ].filter(Boolean).join('\n');
    const components = !key ? [] : [new ActionRowBuilder().addComponents(autoRevoked
      ? new ButtonBuilder().setCustomId(`vanta:allowkey:${key}`).setLabel('Permitir acceso').setEmoji('✅').setStyle(ButtonStyle.Success)
      : new ButtonBuilder().setCustomId(`vanta:delkey:${key}`).setLabel('Eliminar key').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
    )];
    await logScriptEvent(script, text, discordId, {
      color: 0xed4245,
      title: `🚨 Intento de dump · ${script.name}`,
      content: `<@${script.user_id}> alguien intentó hacer dump de **${script.name}**.`,
      components,
    });
    const owner = await client.users.fetch(script.user_id).catch(() => null);
    if (owner) await owner.send(`🚨 Intento de dump en **${script.name}**. Revisa el canal de logs o el panel.`).catch(() => {});
  };

  client.notifyKeyShare = async ({ scriptId, key, discordId, strikes, removed, hwid, boundHwid }) => {
    const script = q.scriptById.get(scriptId);
    if (!script) return;
    const dm = discordId ? await client.users.fetch(discordId).catch(() => null) : null;
    if (dm) {
      const msg = removed
        ? `⛔ Tu key de **${script.name}** fue eliminada por compartirla, y quedaste bloqueado de ese script.`
        : strikes === 1
          ? `⚠️ Tu key de **${script.name}** se usó desde otro equipo. Las keys son personales e intransferibles. Si vuelve a pasar, recibirás un aviso mucho más fuerte.`
          : `🚨 Segundo aviso: tu key de **${script.name}** volvió a usarse desde otro equipo. Si se comparte una vez más, la key se eliminará y quedarás bloqueado de este script.`;
      await dm.send(msg).catch(() => {});
    }
    const text = [
      `• Key: \`${key}\``,
      `• HWID vinculado: \`${boundHwid}\``,
      `• HWID que intentó usarla: \`${hwid}\``,
      `• Discord ID: ${discordId ? `\`${discordId}\`` : 'sin vincular'}`,
      removed
        ? '• Acción: key eliminada y usuario bloqueado en este script'
        : '• Si la compartieron, elimina la key. Si es tu propio equipo, permite el acceso.',
    ].join('\n');
    const components = removed ? [] : [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`vanta:delkey:${key}`).setLabel('Eliminar key').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`vanta:allowkey:${key}`).setLabel('Permitir acceso').setEmoji('✅').setStyle(ButtonStyle.Success),
    )];
    await logScriptEvent(script, text, discordId, {
      color: 0xed4245,
      title: removed ? '🚫 Key eliminada por compartirla' : `⚠️ Key compartida · aviso ${strikes}/3`,
      components,
    });
  };

  client.logScriptEvent = (scriptId, text, userId = null, opts = {}) => {
    const script = q.scriptById.get(scriptId);
    if (script) logScriptEvent(script, text, userId, opts);
  };

  // Permisos que el bot necesita en cada servidor. Si faltan, avisa en consola y le escribe al dueño (una vez al arrancar).
  const BOT_NEEDED_PERMS = [
    ['Gestionar canales', PermissionFlagsBits.ManageChannels, 'tickets, logs y bloqueo de canales'],
    ['Gestionar hilos', PermissionFlagsBits.ManageThreads, 'bloquear hilos'],
    ['Gestionar roles', PermissionFlagsBits.ManageRoles, 'dar roles de acceso'],
    ['Enviar mensajes', PermissionFlagsBits.SendMessages, 'publicar paneles y avisos'],
    ['Insertar enlaces', PermissionFlagsBits.EmbedLinks, 'mostrar los embeds'],
  ];
  async function checkGuildPermissions(c) {
    for (const guild of c.guilds.cache.values()) {
      try {
        const me = guild.members.me ?? await guild.members.fetchMe();
        const missing = BOT_NEEDED_PERMS.filter(([, flag]) => !me.permissions.has(flag));
        if (!missing.length) continue;
        const list = missing.map(([name, , para]) => `• ${name} (${para})`).join('\n');
        console.warn(`[Bot] Permisos que faltan en "${guild.name}":\n${list}`);
        const owner = await guild.fetchOwner().catch(() => null);
        await owner?.send(`⚠️ Vantarmor necesita más permisos en **${guild.name}** para funcionar completo:\n${list}`).catch(() => {});
      } catch (err) {
        console.warn(`[Bot] No pude revisar permisos en "${guild.name}":`, err.message);
      }
    }
  }

  client.once('ready', async c => {
    setTimeout(() => notifyExpiringKeys().catch(err => console.error('[Bot] Avisos de vencimiento:', err.message)), 30_000);
    setInterval(() => notifyExpiringKeys().catch(err => console.error('[Bot] Avisos de vencimiento:', err.message)), 10 * 60_000);
    try {
      const rest = new REST({ version: '10' }).setToken(token);
      const route = guildId
        ? Routes.applicationGuildCommands(clientId, guildId)
        : Routes.applicationCommands(clientId);
      await rest.put(route, { body: commands });
      console.log(`[Bot] Online como ${c.user.tag}. Comandos registrados${guildId ? ' en el servidor' : ' globalmente (puede tardar hasta 1 h)'}.`);
    } catch (err) {
      console.error('[Bot] No se pudieron registrar los comandos:', err.message);
    }
    await checkGuildPermissions(c);
  });

  // Bienvenida: a los nuevos miembros del servidor donde el creador (Premium Plus) la configuró con /welcome
  client.on('guildMemberAdd', async member => {
    try {
      const row = db.prepare("SELECT owner FROM bot_settings WHERE name = 'welcome_guild' AND value = ? LIMIT 1").get(member.guild.id);
      if (!row) return;
      const owner = row.owner;
      if (!isPlatformOwner(owner) && !hasPlusPlan(owner)) return;
      const channelId = settingFor(owner, 'welcome_channel');
      if (!channelId) return;
      const channel = await member.guild.channels.fetch(channelId).catch(() => null);
      if (!channel?.isTextBased()) return;
      const template = settingFor(owner, 'welcome_text') || 'Bienvenido {user} a {server}!';
      const description = template.replaceAll('{user}', `<@${member.id}>`).replaceAll('{server}', member.guild.name);
      const embed = new EmbedBuilder().setColor(0x2ecc71).setTitle(`👋 Bienvenido a ${member.guild.name}`).setDescription(description);
      const image = settingFor(owner, 'welcome_image');
      if (image) embed.setImage(image);
      await channel.send({ content: `<@${member.id}>`, embeds: [embed] });
    } catch (err) {
      console.warn('[Bot] No se pudo dar la bienvenida:', err.message);
    }
  });

  client.on('interactionCreate', async interaction => {
    try {
      // Mantenimiento total: slash, botones y modales quedan pausados para todos menos el dueño
      if (!interaction.isAutocomplete() && maintenanceAllOn() && interaction.user?.id !== ownerId) {
        if (interaction.isRepliable?.()) {
          const embed = new EmbedBuilder()
            .setColor(0xfaa61a)
            .setTitle('Vantarmor en mantenimiento')
            .setDescription('El bot y los loaders están pausados mientras trabajamos. Vuelve en unos minutos.');
          return await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral }).catch(() => {});
        }
        return;
      }
      if (interaction.isAutocomplete()) {
        // Sin esperas aquí: Discord solo da 3 s para responder el autocompletado
        const focused = interaction.options.getFocused().toLowerCase();
        const choices = scriptsForAutocomplete(interaction)
          .filter(s => s.name.toLowerCase().includes(focused))
          .slice(0, 25)
          .map(s => ({ name: s.name.slice(0, 100), value: String(s.id) }));
        if (!choices.length) console.warn(`[Bot] Autocompletado vacío (réplica ${process.env.RAILWAY_REPLICA_ID || 'local'}, ${q.scriptsList.all().length} scripts en esta base)`);
        return interaction.respond(choices).catch(err => console.warn('[Bot] No se pudo responder el autocompletado:', err.message));
      }
      if (interaction.isChatInputCommand()) return await handleChat(interaction);
      if (interaction.isButton()) return await handleButton(interaction);
      if (interaction.isModalSubmit()) return await handleModal(interaction);
    } catch (err) {
      console.error('[Bot] Error en interacción:', err);
      // Errores de Discord (permisos, canal, etc.) se muestran con su motivo; el resto, genérico
      // Falta de permisos del bot en el canal (/panel, /prices, etc.): se explica cómo darlos con el tutorial
      const discordMsg = err?.code === 50013 ? BOT_PERMS_HELP
        : err?.code && err?.message ? `Discord rechazó la acción: ${err.message}` : 'Ocurrió un error. Inténtalo de nuevo.';
      const payload = { content: `❌ ${discordMsg}`, flags: MessageFlags.Ephemeral };
      if (interaction.deferred || interaction.replied) await interaction.editReply(payload).catch(() => {});
      else if (interaction.isRepliable?.()) await interaction.reply(payload).catch(() => {});
    }
  });

  // Diagnóstico de conexión: los reconectos se ven en los logs
  client.on('error', err => console.error('[Bot] Error del cliente:', err.message));
  client.on('shardDisconnect', (_, id) => console.warn(`[Bot] Desconectado (shard ${id}). Reconectando...`));
  client.on('shardReconnecting', id => console.warn(`[Bot] Reconectando (shard ${id})...`));
  client.on('shardResume', id => console.log(`[Bot] Reconectado (shard ${id}).`));

  // Si el login falla (red caída, Discord lento), reintenta en vez de quedarse apagado hasta el próximo deploy
  for (let attempt = 1; ; attempt++) {
    try {
      await client.login(token);
      break;
    } catch (err) {
      console.error(`[Bot] Login falló (intento ${attempt}):`, err.message);
      await sleep(Math.min(60_000, 5_000 * attempt));
    }
  }
  return client;
}
