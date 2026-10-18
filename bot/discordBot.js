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
    .addStringOption(o => scriptOpt(o)),
  new SlashCommandBuilder().setName('stats').setDescription('Muestra tus keys'),
  new SlashCommandBuilder().setName('redeem').setDescription('Canjea una key')
    .addStringOption(o => o.setName('key').setDescription('Tu key').setRequired(true).setMinLength(32).setMaxLength(64)),
  new SlashCommandBuilder().setName('getscript').setDescription('Obtiene el loader de un script')
    .addStringOption(o => scriptOpt(o)),
  new SlashCommandBuilder().setName('generatekey').setDescription('Genera keys para un script (dueño o gestor)')
    .addStringOption(o => scriptOpt(o))
    .addIntegerOption(o => o.setName('amount').setDescription('Cantidad (1-50)').setMinValue(1).setMaxValue(50))
    .addStringOption(o => durationOpt(o)),
  new SlashCommandBuilder().setName('deletekey').setDescription('Elimina una key (dueño o gestor)')
    .addStringOption(o => o.setName('key').setDescription('Key').setRequired(true)),
  new SlashCommandBuilder().setName('addtime').setDescription('Añade tiempo a una key (dueño o gestor)')
    .addStringOption(o => o.setName('key').setDescription('Key').setRequired(true))
    .addStringOption(o => durationOpt(o, true)),
  new SlashCommandBuilder().setName('resethwid').setDescription('Reinicia el HWID de una key')
    .addStringOption(o => scriptOpt(o))
    .addUserOption(o => userOpt(o)),
  new SlashCommandBuilder().setName('whitelist').setDescription('Añade un usuario o rol a la whitelist')
    .addStringOption(o => scriptOpt(o))
    .addUserOption(o => userOpt(o))
    .addRoleOption(o => roleOpt(o)),
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
  new SlashCommandBuilder().setName('plankey').setDescription('Genera una key para activar un plan en el dashboard (dueño)')
    .addStringOption(o => o.setName('plan').setDescription('Plan').setRequired(true)
      .addChoices({ name: 'Premium', value: 'premium' }, { name: 'Premium Plus', value: 'plus' })),
  new SlashCommandBuilder().setName('prices').setDescription('Publica la tabla de precios (dueño)')
    .addStringOption(o => o.setName('title').setDescription('Título').setRequired(true))
    .addStringOption(o => o.setName('description').setDescription('Contenido (usa \\n para saltos de línea)').setRequired(true)),
  new SlashCommandBuilder().setName('updates').setDescription('Publica una actualización (dueño)')
    .addStringOption(o => o.setName('title').setDescription('Título').setRequired(true))
    .addStringOption(o => o.setName('description').setDescription('Contenido (usa \\n para saltos de línea)').setRequired(true)),
].map(c => c.toJSON());

// Comandos que responden en público
const PUBLIC_COMMANDS = new Set(['panel', 'whitelist', 'unwhitelist', 'blacklist', 'unblacklist', 'warn', 'prices', 'updates']);

// ==========================================
// Bot
// ==========================================
export async function startDiscordBot({ db, token, clientId, guildId, publicUrl, ownerId }) {
  ensureBotSchema(db);

  const q = {
    scriptById: db.prepare('SELECT * FROM scripts WHERE id = ?'),
    scriptByName: db.prepare('SELECT * FROM scripts WHERE lower(name) = lower(?) ORDER BY id DESC LIMIT 1'),
    scriptsList: db.prepare('SELECT id, name FROM scripts ORDER BY id DESC LIMIT 100'),
    keyByCode: db.prepare('SELECT * FROM keys WHERE key = ?'),
    activeKeyFor: db.prepare(`
      SELECT * FROM keys WHERE script_id = ? AND discord_id = ? AND banned = 0
        AND (expires_at IS NULL OR expires_at > ?) LIMIT 1
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
    rulesForScript: db.prepare('SELECT kind, discord_id FROM bot_access_rules WHERE script_id = ?'),
    ruleInsert: db.prepare('INSERT OR IGNORE INTO bot_access_rules (script_id, kind, discord_id, label) VALUES (?, ?, ?, ?)'),
    ruleDelete: db.prepare('DELETE FROM bot_access_rules WHERE script_id = ? AND kind = ? AND discord_id = ?'),
    setting: db.prepare('SELECT value FROM bot_settings WHERE owner = ? AND name = ?'),
    settingSet: db.prepare('INSERT OR REPLACE INTO bot_settings (owner, name, value) VALUES (?, ?, ?)'),
    panelInsert: db.prepare('INSERT INTO bot_panels (script_id, channel_id, message_id, created_at) VALUES (?, ?, ?, ?)'),
    warnInsert: db.prepare('INSERT INTO bot_warnings (discord_id, reason, created_at) VALUES (?, ?, ?)'),
    planKeyInsert: db.prepare('INSERT INTO plan_keys (key, plan, created_at) VALUES (?, ?, ?)'),
  };

  const owner = () => ownerId || null;
  const setting = name => q.setting.get(owner(), name)?.value ?? null;
  const findScript = value => /^\d+$/.test(String(value))
    ? q.scriptById.get(Number(value))
    : q.scriptByName.get(String(value ?? '').trim());
  const keyState = k => (k.banned ? 'baneada' : k.expires_at && k.expires_at <= now() ? 'expirada' : 'activa');
  const memberRoleIds = interaction => {
    const roles = interaction.member?.roles;
    if (!roles) return [];
    return Array.isArray(roles) ? roles.map(String) : [...(roles.cache?.keys() ?? [])];
  };

  // Permiso de gestión: dueño del workspace, administrador o rol gestor
  function canManage(interaction) {
    if (interaction.user.id === owner()) return true;
    if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return true;
    const managerRole = setting('manager_role');
    return Boolean(managerRole && memberRoleIds(interaction).includes(managerRole));
  }

  // Acceso a un script: blacklist, whitelist (usuario o rol), dueño, o key existente
  function resolveAccess(script, userId, roleIds) {
    if (q.blacklisted.get(script.id, userId)) return { status: 'blacklisted' };
    const existing = q.activeKeyFor.get(script.id, userId, now());
    if (existing) return { status: 'ok', key: existing.key };
    const allowed = userId === owner()
      || q.rulesForScript.all(script.id).some(r =>
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
    if (access.status === 'none') return `❌ No tienes acceso a **${script.name}**. Canjea una key o pide que te añadan a la whitelist.`;
    return `\`\`\`lua\n${loaderText(script, access.key)}\n\`\`\``;
  }

  function redeemKey(code, userId) {
    const k = q.keyByCode.get(code);
    if (!k) return '❌ Key inválida.';
    if (k.banned) return `⛔ Esta key está bloqueada${k.ban_reason ? `: ${k.ban_reason}` : ''}.`;
    if (k.expires_at && k.expires_at <= now()) return '❌ Esta key expiró.';
    if (k.discord_id && k.discord_id !== userId) return '❌ Esta key ya está vinculada a otra cuenta.';
    if (q.blacklisted.get(k.script_id, userId)) return '⛔ Estás bloqueado para este script.';
    q.claim.run(userId, code);
    const s = q.scriptById.get(k.script_id);
    return `✅ Key canjeada para **${s?.name ?? 'tu script'}**. Usa **Get Script** para obtener el loader.`;
  }

  function resetHwid(script, targetId, actorId, bypassCooldown) {
    const k = q.activeKeyFor.get(script.id, targetId, now());
    if (!k) return '❌ No hay una key activa para ese usuario en este script.';
    if (!bypassCooldown && k.hwid_reset_at && now() - k.hwid_reset_at < HWID_RESET_COOLDOWN_S) {
      return `⏳ Podrás reiniciar el HWID <t:${k.hwid_reset_at + HWID_RESET_COOLDOWN_S}:R>.`;
    }
    q.resetHwid.run(now(), k.key);
    return '✅ HWID reiniciado. Vuelve a ejecutar el loader.';
  }

  function statsReply(userId) {
    const rows = q.keysOfUser.all(userId);
    if (!rows.length) return 'No tienes keys todavía. Canjea una con **Redeem Key**.';
    const lines = rows.slice(0, 15).map(r =>
      `• **${r.script_name}**: ${keyState(r)} · vence ${r.expires_at ? `<t:${r.expires_at}:R>` : 'nunca'} · HWID ${r.hwid ? 'vinculado' : 'sin vincular'}`);
    return `📊 **Tus keys**\n${lines.join('\n')}`;
  }

  async function giveBuyerRole(interaction) {
    const roleId = setting('buyer_role');
    if (!roleId) return '👤 El dueño todavía no configuró el rol comprador con /getrole.';
    try {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      await member.roles.add(roleId);
      return `✅ Rol asignado: <@&${roleId}>`;
    } catch (err) {
      console.error('[Bot] Error asignando rol:', err);
      return '❌ No pude asignar el rol. Verifica que el bot tenga Manage Roles y que su rol esté por encima del rol comprador.';
    }
  }

  // Panel con botones (estilo Luarmor)
  function panelPayload(script) {
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(`Panel de acceso · ${script.name}`)
      .setDescription('Si eres comprador, usa los botones para canjear tu key, obtener el script o tu rol.')
      .setFooter({ text: 'Vantarmor' })
      .setTimestamp();
    const row1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`vanta:redeem:${script.id}`).setLabel('🔑 Redeem Key').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`vanta:script:${script.id}`).setLabel('📜 Get Script').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`vanta:role:${script.id}`).setLabel('👤 Get Role').setStyle(ButtonStyle.Primary),
    );
    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`vanta:hwid:${script.id}`).setLabel('⚙️ Reset HWID').setStyle(ButtonStyle.Secondary),
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
    const reply = content => interaction.editReply({ content });
    const denied = '⛔ No tienes permiso para esta acción.';

    switch (cmd) {
      case 'ping':
        return reply(`Pong · ${Math.round(interaction.client.ws.ping)} ms`);

      case 'panel': {
        if (!canManage(interaction)) return reply(denied);
        const script = findScript(interaction.options.getString('script', true));
        if (!script) return reply('❌ Script no encontrado.');
        const sent = await interaction.channel.send(panelPayload(script));
        q.panelInsert.run(script.id, interaction.channelId, sent.id, now());
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
        if (!canManage(interaction)) return reply(denied);
        if (onCooldown(actor)) return reply('⏳ Espera unos segundos antes de otra acción.');
        const script = findScript(interaction.options.getString('script', true));
        if (!script) return reply('❌ Script no encontrado.');
        const amount = interaction.options.getInteger('amount') ?? 1;
        const raw = interaction.options.getString('duration');
        let seconds = null;
        if (raw) {
          seconds = parseDuration(raw);
          if (!seconds) return reply('❌ Duración inválida. Usa 30d, 12h, 1w, 1mo o 1y.');
        }
        const expires = seconds ? now() + seconds : null;
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

      case 'deletekey': {
        if (!canManage(interaction)) return reply(denied);
        if (onCooldown(actor)) return reply('⏳ Espera unos segundos antes de otra acción.');
        const code = interaction.options.getString('key', true).trim();
        if (!q.keyByCode.get(code)) return reply('❌ Esa key no existe.');
        q.deleteKey.run(code);
        return reply('🗑️ Key eliminada.');
      }

      case 'addtime': {
        if (!canManage(interaction)) return reply(denied);
        const code = interaction.options.getString('key', true).trim();
        const k = q.keyByCode.get(code);
        if (!k) return reply('❌ Esa key no existe.');
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
        const isManager = canManage(interaction);
        if (target && target.id !== actor && !isManager) return reply('⛔ Solo el dueño o un gestor puede reiniciar el HWID de otros.');
        const who = target?.id ?? actor;
        const bypass = Boolean(target && target.id !== actor && isManager);
        return reply(resetHwid(script, who, actor, bypass));
      }

      case 'whitelist':
      case 'unwhitelist': {
        if (!canManage(interaction)) return reply(denied);
        const script = findScript(interaction.options.getString('script', true));
        if (!script) return reply('❌ Script no encontrado.');
        const user = interaction.options.getUser('user');
        const role = interaction.options.getRole('role');
        if (!user && !role) return reply('❌ Selecciona un usuario o un rol.');
        if (user && role) return reply('❌ Selecciona solo un destino: usuario o rol.');
        const kind = user ? 'user' : 'role';
        const id = (user ?? role).id;
        const label = user ? `<@${id}>` : `<@&${id}>`;
        if (cmd === 'whitelist') {
          q.ruleInsert.run(script.id, kind, id, user ? user.username : role.name);
          return reply(`✅ ${label} añadido a la whitelist de **${script.name}**. Puede obtener el script con Get Script.`);
        }
        q.ruleDelete.run(script.id, kind, id);
        return reply(`✅ ${label} quitado de la whitelist de **${script.name}**.`);
      }

      case 'blacklist': {
        if (!canManage(interaction)) return reply(denied);
        const script = findScript(interaction.options.getString('script'));
        const target = interaction.options.getUser('user', true);
        const reason = interaction.options.getString('reason') || 'Sin razón indicada';
        const targets = script ? [script] : q.scriptsList.all().map(s => ({ id: s.id, name: s.name }));
        for (const s of targets) {
          q.blacklistInsert.run(s.id, target.id, reason, now());
          q.banKeys.run(reason, s.id, target.id);
        }
        return reply(`⛔ <@${target.id}> bloqueado en **${script ? script.name : 'todos los scripts'}**.\nRazón: ${reason}`);
      }

      case 'unblacklist': {
        if (!canManage(interaction)) return reply(denied);
        const script = findScript(interaction.options.getString('script'));
        const target = interaction.options.getUser('user', true);
        const targets = script ? [script] : q.scriptsList.all().map(s => ({ id: s.id, name: s.name }));
        let removed = 0;
        for (const s of targets) {
          removed += q.blacklistDelete.run(s.id, target.id).changes;
          q.unbanKeys.run(s.id, target.id);
        }
        return reply(removed ? `✅ Bloqueo quitado para <@${target.id}>.` : `ℹ️ <@${target.id}> no tenía bloqueo activo.`);
      }

      case 'getrole': {
        if (interaction.user.id !== owner()) return reply('⛔ Solo el dueño puede configurar el rol comprador.');
        const role = interaction.options.getRole('role', true);
        q.settingSet.run(owner(), 'buyer_role', role.id);
        return reply(`✅ Rol comprador: <@&${role.id}>.`);
      }

      case 'generatekeyrole': {
        if (interaction.user.id !== owner()) return reply('⛔ Solo el dueño puede configurar el rol gestor.');
        const role = interaction.options.getRole('role', true);
        q.settingSet.run(owner(), 'manager_role', role.id);
        return reply(`✅ Rol gestor: <@&${role.id}>. Puede usar /generatekey, /deletekey, /addtime y /blacklist.`);
      }

      case 'warn': {
        if (!canManage(interaction)) return reply(denied);
        const target = interaction.options.getUser('user', true);
        const reason = interaction.options.getString('reason', true);
        q.warnInsert.run(target.id, reason, now());
        return reply(`⚠️ <@${target.id}> recibió una advertencia.\nRazón: ${reason}`);
      }

      case 'plankey': {
        if (interaction.user.id !== owner()) return reply('⛔ Solo el dueño puede generar keys de plan.');
        const plan = interaction.options.getString('plan', true);
        const key = makeKey();
        q.planKeyInsert.run(key, plan, now());
        const label = plan === 'plus' ? 'Premium Plus' : 'Premium';
        return reply(`✅ Key de **${label}** (uso único):\n\`\`\`\n${key}\n\`\`\`\nCanjéala en el dashboard, sección Planes.`);
      }

      case 'prices':
      case 'updates': {
        if (interaction.user.id !== owner()) return reply('⛔ Solo el dueño puede publicar esto.');
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
    if (!script) return interaction.reply({ content: '⚠️ Este panel ya no tiene un script válido.', flags: MessageFlags.Ephemeral });

    // El modal no puede ir después de deferReply
    if (action === 'redeem') {
      const modal = new ModalBuilder().setCustomId(`vanta:redeem-modal:${script.id}`).setTitle('Redeem Key');
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('key').setLabel('Key').setStyle(TextInputStyle.Short)
          .setMinLength(32).setMaxLength(64).setRequired(true),
      ));
      return interaction.showModal(modal);
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const reply = content => interaction.editReply({ content });
    const actor = interaction.user.id;

    if (action === 'script') return reply(getScriptReply(script, actor, memberRoleIds(interaction)));
    if (action === 'stats') return reply(statsReply(actor));
    if (action === 'role') {
      const access = resolveAccess(script, actor, memberRoleIds(interaction));
      if (access.status !== 'ok') return reply('❌ No tienes acceso a este script. Canjea una key o pide la whitelist.');
      return reply(await giveBuyerRole(interaction));
    }
    if (action === 'hwid') {
      const access = resolveAccess(script, actor, memberRoleIds(interaction));
      if (access.status !== 'ok') return reply('❌ No tienes acceso a este script.');
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
        const focused = interaction.options.getFocused().toLowerCase();
        const choices = q.scriptsList.all()
          .filter(s => s.name.toLowerCase().includes(focused))
          .slice(0, 25)
          .map(s => ({ name: s.name.slice(0, 100), value: String(s.id) }));
        return interaction.respond(choices);
      }
      if (interaction.isChatInputCommand()) return await handleChat(interaction);
      if (interaction.isButton()) return await handleButton(interaction);
      if (interaction.isModalSubmit()) return await handleModal(interaction);
    } catch (err) {
      console.error('[Bot] Error en interacción:', err);
      const payload = { content: 'Ocurrió un error. Inténtalo de nuevo.', flags: MessageFlags.Ephemeral };
      if (interaction.deferred || interaction.replied) await interaction.editReply(payload).catch(() => {});
      else if (interaction.isRepliable?.()) await interaction.reply(payload).catch(() => {});
    }
  });

  await client.login(token);
  return client;
}
