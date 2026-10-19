// Bot de Discord para Vantarmor (estilo Luarmor).
// Comparte la base SQLite de server.js: recibe `db` y crea sus tablas con ensureBotSchema().
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
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
    CREATE TABLE IF NOT EXISTS bot_settings (
      owner TEXT, name TEXT, value TEXT, PRIMARY KEY (owner, name)
    );
    CREATE TABLE IF NOT EXISTS plan_keys (
      key TEXT PRIMARY KEY, plan TEXT NOT NULL,
      used_by TEXT, used_at INTEGER, created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS bot_warnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      discord_id TEXT, reason TEXT, created_at INTEGER
    );
  `);
  // Migración: la whitelist puede ser por tiempo (expires_at NULL = permanente)
  const hasExp = db.prepare("SELECT 1 FROM pragma_table_info('bot_access_rules') WHERE name = 'expires_at'").get();
  if (!hasExp) db.exec('ALTER TABLE bot_access_rules ADD COLUMN expires_at INTEGER');
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
  new SlashCommandBuilder().setName('redeem').setDescription('Canjea una key')
    .addStringOption(o => o.setName('key').setDescription('Tu key').setRequired(true).setMinLength(32).setMaxLength(64)),
  new SlashCommandBuilder().setName('getscript').setDescription('Obtiene el loader de un script')
    .addStringOption(o => scriptOpt(o)),
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
    .addChannelOption(o => o.setName('canal').setDescription('Canal de logs').setRequired(true)),
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
  new SlashCommandBuilder().setName('unwhitelist').setDescription('Quita un usuario o rol de la whitelist')
    .addStringOption(o => scriptOpt(o))
    .addUserOption(o => userOpt(o))
    .addRoleOption(o => roleOpt(o)),
  new SlashCommandBuilder().setName('blacklist').setDescription('Bloquea a un usuario en un script')
    .addUserOption(o => userOpt(o, true))
    .addStringOption(o => scriptOpt(o))
    .addStringOption(o => o.setName('reason').setDescription('Razón')),
  new SlashCommandBuilder().setName('unblacklist').setDescription('Quita el bloqueo de un usuario en un script')
    .addUserOption(o => userOpt(o, true))
    .addStringOption(o => scriptOpt(o)),
  new SlashCommandBuilder().setName('getrole').setDescription('Configura el rol que recibe un comprador (dueño)')
    .addRoleOption(o => roleOpt(o, true)),
  new SlashCommandBuilder().setName('generatekeyrole').setDescription('Configura el rol que puede gestionar keys (dueño)')
    .addRoleOption(o => roleOpt(o, true)),
  new SlashCommandBuilder().setName('warn').setDescription('Advierte a un usuario')
    .addUserOption(o => userOpt(o, true))
    .addStringOption(o => o.setName('reason').setDescription('Razón').setRequired(true)),
  new SlashCommandBuilder().setName('prices').setDescription('Publica la tabla de precios (dueño)')
    .addStringOption(o => o.setName('title').setDescription('Título').setRequired(true))
    .addStringOption(o => o.setName('description').setDescription('Contenido (usa \\n para saltos de línea)').setRequired(true)),
  new SlashCommandBuilder().setName('updates').setDescription('Publica una actualización (dueño)')
    .addStringOption(o => o.setName('title').setDescription('Título').setRequired(true))
    .addStringOption(o => o.setName('description').setDescription('Contenido (usa \\n para saltos de línea)').setRequired(true)),
].map(c => c.toJSON());

// Comandos que responden en público
const PUBLIC_COMMANDS = new Set(['panel', 'whitelist', 'unwhitelist', 'blacklist', 'unblacklist', 'warn', 'prices', 'updates', 'dropkey']);

// ==========================================
// Bot
// ==========================================
export async function startDiscordBot({ db, token, clientId, guildId, publicUrl, ownerId }) {
  ensureBotSchema(db);
  // Si al arrancar hay 0 scripts o 0 keys cuando esperabas datos, la base se reinició (revisa el volumen)
  const counts = db.prepare('SELECT (SELECT COUNT(*) FROM scripts) AS scripts, (SELECT COUNT(*) FROM keys) AS keys').get();
  console.log(`[Bot] Datos al arrancar: ${counts.scripts} scripts, ${counts.keys} keys. Réplica: ${process.env.RAILWAY_REPLICA_ID || 'local'}.`);

  const q = {
    scriptById: db.prepare('SELECT * FROM scripts WHERE id = ?'),
    scriptByName: db.prepare('SELECT * FROM scripts WHERE lower(name) = lower(?) ORDER BY id DESC LIMIT 1'),
    scriptsList: db.prepare('SELECT id, name, user_id FROM scripts ORDER BY id DESC LIMIT 100'),
    scriptsOfUser: db.prepare('SELECT 1 FROM scripts WHERE user_id = ? LIMIT 1'),
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
  // - /getscript: todos (los compradores lo usan así).
  // - el resto: los propios y los de creadores que le dieron rol gestor.
  function scriptsForAutocomplete(interaction) {
    const actor = interaction.user.id;
    if (interaction.commandName === 'getscript') return q.scriptsList.all();
    const creators = new Set([actor]);
    if (interaction.commandName !== 'panel') {
      const roleIds = memberRoleIds(interaction);
      for (const row of q.managerRoleRows.all()) if (roleIds.includes(row.value)) creators.add(row.owner);
    }
    return q.scriptsList.all().filter(s => creators.has(s.user_id));
  }

  // Comandos que el rol gestor (/generatekeyrole) puede usar. El resto solo lo usa el creador.
  const MANAGER_COMMANDS = new Set(['whitelist', 'unwhitelist', 'blacklist', 'unblacklist', 'generatekey', 'deletekey', 'dropkey']);

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
  async function logScriptEvent(script, text) {
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
      await channel.send({
        embeds: [new EmbedBuilder().setColor(0x5865f2).setDescription(text)
          .setFooter({ text: `${script.name} · ${formatPanelDate(new Date())}` })],
      });
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

  // Bloqueo: blacklist o key baneada en ese script
  const isBlocked = (script, userId) =>
    Boolean(q.blacklisted.get(script.id, userId) || q.bannedKeyFor.get(script.id, userId));

  // Acceso a un script: blacklist, whitelist (usuario o rol), creador/dueño, o key existente
  function resolveAccess(script, userId, roleIds) {
    if (isBlocked(script, userId)) return { status: 'blacklisted' };
    const existing = q.activeKeyFor.get(script.id, userId, now());
    if (existing) return { status: 'ok', key: existing.key };
    const allowed = userId === owner() || userId === script.user_id
      || q.rulesForScript.all(script.id).filter(ruleActive).some(r =>
        (r.kind === 'user' && r.discord_id === userId) || (r.kind === 'role' && roleIds.includes(r.discord_id)));
    if (!allowed) return { status: 'none' };
    const key = makeKey();
    q.insertClaimed.run(key, script.id, userId); // whitelist: key automática vinculada al usuario
    return { status: 'ok', key };
  }

  function loaderText(script, key) {
    const url = `${publicUrl}/scripts/hosted/${script.slug}`;
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

  // Lógica compartida entre comandos y botones del panel
  function getScriptReply(script, userId, roleIds) {
    if (script.ffa) return `\`\`\`lua\n${loaderText(script)}\n\`\`\``;
    const access = resolveAccess(script, userId, roleIds);
    if (access.status === 'blacklisted') return `⛔ Estás bloqueado para **${script.name}**.`;
    if (access.status === 'none') {
      console.log(`[Bot] Sin acceso: script ${script.id} (${script.name}), usuario ${userId}, roles vistos ${roleIds.length}`);
      return NO_ACCESS_MSG;
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
    if (granted.status === 'none') return NO_ACCESS_MSG;
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

  // ---------- Manejadores ----------

  async function handleChat(interaction) {
    const actor = interaction.user.id;
    const cmd = interaction.commandName;
    const isPublic = PUBLIC_COMMANDS.has(cmd);
    await interaction.deferReply(isPublic ? {} : { flags: MessageFlags.Ephemeral });
    await loadRoles(interaction);
    const reply = content => interaction.editReply({ content });
    const denied = '⛔ No tienes permiso para esta acción.';

    switch (cmd) {
      case 'ping':
        return reply(`Pong · ${Math.round(interaction.client.ws.ping)} ms`);

      case 'panel': {
        const script = findScript(interaction.options.getString('script', true));
        if (!script) return reply('❌ Script no encontrado.');
        // Solo el creador publica el panel de sus scripts (ni gestores ni admins)
        if (script.user_id !== actor) return reply('⛔ Solo el creador de este script puede publicar su panel.');
        const customDescription = interaction.options.getString('descripcion')?.replace(/\\n/g, '\n');
        const sent = await interaction.channel.send(panelPayload(script, customDescription));
        q.panelInsert.run(script.id, interaction.channelId, sent.id, now());
        logScriptEvent(script, `📌 Panel publicado por <@${actor}> en <#${interaction.channelId}>`);
        return reply(`✅ Panel de **${script.name}** publicado.`);
      }

      case 'stats':
        return reply(statsReply(actor));

      case 'redeem':
        return reply(redeemKey(interaction.options.getString('key', true).trim(), actor));

      case 'getscript': {
        const script = findScript(interaction.options.getString('script', true));
        if (!script) return reply('❌ Script no encontrado.');
        return reply(getScriptReply(script, actor, memberRoleIds(interaction)));
      }

      case 'generatekey': {
        const script = findScript(interaction.options.getString('script', true));
        if (!script) return reply('❌ Script no encontrado.');
        if (!canUse(interaction, script.user_id)) return reply(denied);
        if (onCooldown(actor)) return reply('⏳ Espera unos segundos antes de otra acción.');
        const amount = interaction.options.getInteger('amount') ?? 1;
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
        const channel = interaction.options.getChannel('canal', true);
        q.settingSet.run(actor, 'log_channel', channel.id);
        return reply(`✅ Los logs de tus scripts se enviarán a <#${channel.id}>.`);
      }

      // Sorteo: genera las keys y anuncia la cuenta regresiva (un mensaje por número)
      case 'dropkey': {
        const script = findScript(interaction.options.getString('script', true));
        if (!script) return reply('❌ Script no encontrado.');
        if (!canUse(interaction, script.user_id)) return reply(denied);
        if (onCooldown(actor)) return reply('⏳ Espera unos segundos antes de otra acción.');
        const amount = interaction.options.getInteger('amount', true);
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
        const script = findScript(interaction.options.getString('script', true));
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
          if (user && !isBlocked(script, id)) {
            const active = q.activeKeyFor.get(script.id, id, now());
            if (active) q.setExpiry.run(expires, active.key);
            else q.insertKeyExp.run(makeKey(), script.id, expires, id);
          }
          const panel = q.panelForScript.get(script.id);
          const where = panel ? ` en el panel <#${panel.channel_id}>` : '';
          return reply(`✅ ${label} añadido a la whitelist de **${script.name}** (${expiryText}). Puede obtener el script con Get Script${where}.`);
        }
        q.ruleDelete.run(script.id, kind, id);
        logScriptEvent(script, `➖ ${label} quitado de la whitelist por <@${actor}>`);
        return reply(`✅ ${label} quitado de la whitelist de **${script.name}**.`);
      }

      case 'blacklist': {
        const script = findScript(interaction.options.getString('script'));
        if (script && !canUse(interaction, script.user_id)) return reply(denied);
        const target = interaction.options.getUser('user', true);
        const reason = interaction.options.getString('reason') || 'Sin razón indicada';
        // Sin script: solo afecta a los scripts que el actor puede gestionar
        const targets = script ? [script] : q.scriptsList.all().filter(s => canUse(interaction, s.user_id));
        if (!targets.length) return reply(denied);
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
        const target = interaction.options.getUser('user', true);
        const targets = script ? [script] : q.scriptsList.all().filter(s => canUse(interaction, s.user_id));
        if (!targets.length) return reply(denied);
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

      case 'prices':
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

      default:
        return reply('❌ Comando no disponible.');
    }
  }

  async function handleButton(interaction) {
    const [ns, action, rawId] = interaction.customId.split(':');
    if (ns !== 'vanta') return;
    const script = findScript(rawId);
    if (!script) return interaction.reply({ content: NO_ACCESS_MSG, flags: MessageFlags.Ephemeral });

    // Bloqueados no pueden usar ningún botón del panel
    if (isBlocked(script, interaction.user.id)) {
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

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await loadRoles(interaction);
    const reply = content => interaction.editReply({ content });
    const actor = interaction.user.id;

    if (action === 'script') return reply(getScriptReply(script, actor, memberRoleIds(interaction)));
    if (action === 'stats') return reply(statsReply(actor, script, memberRoleIds(interaction)));
    if (action === 'role') {
      const access = resolveAccess(script, actor, memberRoleIds(interaction));
      if (access.status !== 'ok') return reply(NO_ACCESS_MSG);
      return reply(await giveBuyerRole(interaction, script));
    }
    if (action === 'hwid') {
      const access = resolveAccess(script, actor, memberRoleIds(interaction));
      if (access.status !== 'ok') return reply(NO_ACCESS_MSG);
      return reply(resetHwid(script, actor, actor, false));
    }
    return reply('❌ Acción no disponible.');
  }

  async function handleModal(interaction) {
    const [ns, action, rawId] = interaction.customId.split(':');
    if (ns !== 'vanta' || action !== 'redeem-modal') return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const code = interaction.fields.getTextInputValue('key').trim();
    return interaction.editReply({ content: redeemKey(code, interaction.user.id) });
  }

  // ---------- Cliente ----------
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

  // Canales de texto del servidor, para el selector del panel admin
  client.listTextChannels = () => {
    const guild = guildId ? client.guilds.cache.get(guildId) : client.guilds.cache.first();
    if (!guild) return [];
    return guild.channels.cache
      .filter(c => c.type === 0) // GuildText
      .map(c => ({ id: c.id, name: c.name, parent: c.parent?.name || '' }))
      .sort((a, b) => a.name.localeCompare(b.name));
  };

  // Foto de perfil del bot en Discord (la cambia el panel admin). Discord limita cuántas veces por hora.
  client.setBotAvatar = async url => {
    await client.user.setAvatar(url);
  };

  // Changelogs y tabla de precios: los publica el panel admin, no comandos de Discord
  client.announce = async (kind, channelId, title, description) => {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased()) throw new Error('Ese canal no es de texto');
    const isPrices = kind === 'prices';
    const embed = new EmbedBuilder()
      .setColor(isPrices ? 0x5865f2 : 0xe93540)
      .setTitle(title)
      .setDescription(description)
      .setFooter({ text: `Vantarmor · ${new Date().getFullYear()}` })
      .setTimestamp();
    await channel.send({ embeds: [embed] });
  };

  // Expuesto al servidor para registrar cuando se ejecuta un loader
  client.logScriptEvent = (scriptId, text) => {
    const script = q.scriptById.get(scriptId);
    if (script) logScriptEvent(script, text);
  };

  client.once('ready', async c => {
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
  });

  client.on('interactionCreate', async interaction => {
    try {
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
      const discordMsg = err?.code && err?.message ? `Discord rechazó la acción: ${err.message}` : 'Ocurrió un error. Inténtalo de nuevo.';
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
