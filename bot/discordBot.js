// Bot de Discord para Vantarmor.
// Comparte la misma base SQLite que server.js: recibe `db` y no abre su propia conexión.
import {
  Client,
  GatewayIntentBits,
  MessageFlags,
  REST,
  Routes,
  SlashCommandBuilder,
} from 'discord.js';
import crypto from 'crypto';

const KEY_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const HWID_RESET_COOLDOWN_S = 24 * 3600;
const UNIT_SECONDS = { h: 3600, d: 86400, w: 604800, mo: 2592000, y: 31536000 };

export function parseDuration(raw) {
  const m = String(raw ?? '').trim().toLowerCase().match(/^(\d{1,4})(h|d|w|mo|y)$/);
  return m ? Number(m[1]) * UNIT_SECONDS[m[2]] : null;
}

const makeKey = () => Array.from(crypto.randomBytes(32), b => KEY_ALPHABET[b % KEY_ALPHABET.length]).join('');
const now = () => Math.floor(Date.now() / 1000);

export const commands = [
  new SlashCommandBuilder().setName('ping').setDescription('Verifica que el bot responde'),
  new SlashCommandBuilder().setName('stats').setDescription('Muestra tus keys canjeadas'),
  new SlashCommandBuilder().setName('redeem').setDescription('Canjea una key')
    .addStringOption(o => o.setName('key').setDescription('Tu key').setRequired(true).setMinLength(32).setMaxLength(64)),
  new SlashCommandBuilder().setName('getscript').setDescription('Obtiene el loader de un script al que tienes acceso')
    .addStringOption(o => o.setName('script').setDescription('Script').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder().setName('generatekey').setDescription('Genera keys para uno de tus scripts')
    .addStringOption(o => o.setName('script').setDescription('Script').setRequired(true).setAutocomplete(true))
    .addIntegerOption(o => o.setName('amount').setDescription('Cantidad (1-50)').setMinValue(1).setMaxValue(50))
    .addStringOption(o => o.setName('duration').setDescription('30d, 12h, 1w, 1mo, 1y. Vacío = forever')),
  new SlashCommandBuilder().setName('deletekey').setDescription('Elimina una de tus keys')
    .addStringOption(o => o.setName('key').setDescription('Key').setRequired(true)),
  new SlashCommandBuilder().setName('addtime').setDescription('Añade tiempo a una de tus keys')
    .addStringOption(o => o.setName('key').setDescription('Key').setRequired(true))
    .addStringOption(o => o.setName('duration').setDescription('30d, 12h, 1w, 1mo, 1y').setRequired(true)),
  new SlashCommandBuilder().setName('blacklist').setDescription('Bloquea a un usuario en uno de tus scripts')
    .addUserOption(o => o.setName('user').setDescription('Usuario').setRequired(true))
    .addStringOption(o => o.setName('script').setDescription('Script').setRequired(true).setAutocomplete(true))
    .addStringOption(o => o.setName('reason').setDescription('Razón')),
  new SlashCommandBuilder().setName('unblacklist').setDescription('Quita el bloqueo de un usuario en un script')
    .addUserOption(o => o.setName('user').setDescription('Usuario').setRequired(true))
    .addStringOption(o => o.setName('script').setDescription('Script').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder().setName('resethwid').setDescription('Reinicia el HWID de tu key (cada 24 h)')
    .addStringOption(o => o.setName('script').setDescription('Script').setRequired(true).setAutocomplete(true))
    .addUserOption(o => o.setName('user').setDescription('Solo dueño: reiniciar la key de otro usuario')),
].map(c => c.toJSON());

export async function startDiscordBot({ db, token, clientId, guildId, publicUrl }) {
  const q = {
    scriptById: db.prepare('SELECT * FROM scripts WHERE id = ?'),
    scriptByName: db.prepare('SELECT * FROM scripts WHERE lower(name) = lower(?) ORDER BY id DESC LIMIT 1'),
    scriptsAccessible: db.prepare(`
      SELECT DISTINCT s.id, s.name FROM scripts s
      LEFT JOIN keys k ON k.script_id = s.id
      WHERE s.user_id = ? OR k.discord_id = ?
      ORDER BY s.id DESC LIMIT 100
    `),
    keyByCode: db.prepare('SELECT * FROM keys WHERE key = ?'),
    keyOwned: db.prepare('SELECT k.* FROM keys k JOIN scripts s ON s.id = k.script_id WHERE k.key = ? AND s.user_id = ?'),
    activeKeyFor: db.prepare(`
      SELECT * FROM keys WHERE script_id = ? AND discord_id = ? AND banned = 0
        AND (expires_at IS NULL OR expires_at > ?) LIMIT 1
    `),
    isBlacklisted: db.prepare('SELECT 1 FROM keys WHERE script_id = ? AND discord_id = ? AND banned = 1 LIMIT 1'),
    keysOfUser: db.prepare(`
      SELECT k.*, s.name AS script_name FROM keys k JOIN scripts s ON s.id = k.script_id
      WHERE k.discord_id = ? ORDER BY k.expires_at IS NULL, k.expires_at DESC
    `),
    insertKey: db.prepare('INSERT INTO keys (key, script_id, expires_at) VALUES (?, ?, ?)'),
    claim: db.prepare('UPDATE keys SET discord_id = ? WHERE key = ?'),
    deleteKey: db.prepare('DELETE FROM keys WHERE key = ?'),
    setExpiry: db.prepare('UPDATE keys SET expires_at = ? WHERE key = ?'),
    ban: db.prepare('UPDATE keys SET banned = 1, ban_reason = ? WHERE script_id = ? AND discord_id = ?'),
    unban: db.prepare('UPDATE keys SET banned = 0, ban_reason = NULL WHERE script_id = ? AND discord_id = ?'),
    resetHwid: db.prepare('UPDATE keys SET hwid = NULL, hwid_reset_at = ? WHERE key = ?'),
  };

  const findScript = value => /^\d+$/.test(String(value))
    ? q.scriptById.get(Number(value))
    : q.scriptByName.get(String(value).trim());

  const keyState = k => (k.banned ? 'baneada' : k.expires_at && k.expires_at <= now() ? 'expirada' : 'activa');

  // Loader que se pega en el script de Roblox. El servidor valida key y HWID en /scripts/hosted/:slug
  function loaderText(script, key) {
    const url = `${publicUrl}/scripts/hosted/${script.slug}`;
    if (script.ffa) return `loadstring(game:HttpGet("${url}"))()`;
    return [
      `script_key = "${key}"`,
      'local hwid = game:GetService("RbxAnalyticsService"):GetClientId()',
      `loadstring(game:HttpGet("${url}?key=" .. script_key .. "&hwid=" .. hwid))()`,
    ].join('\n');
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  async function handleCommand(interaction) {
    const actor = interaction.user.id;
    const cmd = interaction.commandName;
    const reply = content => interaction.editReply({ content });
    const block = (s, text) => s?.user_id === actor ? null : text;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    switch (cmd) {
      case 'ping':
        return reply(`Pong · ${Math.round(client.ws.ping)} ms`);

      case 'stats': {
        const rows = q.keysOfUser.all(actor);
        if (!rows.length) return reply('No tienes keys canjeadas. Usa /redeem.');
        const lines = rows.slice(0, 15).map(r =>
          `• ${r.script_name}: ${keyState(r)} · vence ${r.expires_at ? `<t:${r.expires_at}:R>` : 'nunca'}`);
        return reply(`**Tus keys**\n${lines.join('\n')}`);
      }

      case 'redeem': {
        const code = interaction.options.getString('key', true).trim();
        const k = q.keyByCode.get(code);
        if (!k) return reply('❌ Key inválida.');
        if (k.banned) return reply(`⛔ Esta key está bloqueada${k.ban_reason ? `: ${k.ban_reason}` : ''}.`);
        if (k.expires_at && k.expires_at <= now()) return reply('❌ Esta key expiró.');
        if (k.discord_id && k.discord_id !== actor) return reply('❌ Esta key ya está vinculada a otra cuenta.');
        if (q.isBlacklisted.get(k.script_id, actor)) return reply('⛔ Estás bloqueado para este script.');
        q.claim.run(actor, code);
        const s = q.scriptById.get(k.script_id);
        return reply(`✅ Key canjeada para **${s?.name ?? 'tu script'}**. Usa /getscript para obtener el loader.`);
      }

      case 'getscript': {
        const s = findScript(interaction.options.getString('script', true));
        if (!s) return reply('❌ Script no encontrado.');
        if (!s.ffa && q.isBlacklisted.get(s.id, actor)) return reply(`⛔ Estás bloqueado para **${s.name}**.`);
        if (s.ffa) return reply(`\`\`\`lua\n${loaderText(s)}\n\`\`\``);
        const k = q.activeKeyFor.get(s.id, actor, now());
        if (!k) return reply('❌ No tienes una key activa para este script. Canjea una con /redeem.');
        return reply(`\`\`\`lua\n${loaderText(s, k.key)}\n\`\`\``);
      }

      case 'generatekey': {
        const s = findScript(interaction.options.getString('script', true));
        if (!s || s.user_id !== actor) return reply('⛔ Solo el dueño del script puede generar keys.');
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
            q.insertKey.run(k, s.id, expires);
            out.push(k);
          }
          return out;
        })();
        return reply(`✅ ${list.length} key(s) para **${s.name}**:\n\`\`\`\n${list.join('\n')}\n\`\`\``);
      }

      case 'deletekey': {
        const k = q.keyOwned.get(interaction.options.getString('key', true).trim(), actor);
        if (!k) return reply('❌ No encontré esa key entre tus scripts.');
        q.deleteKey.run(k.key);
        return reply('🗑️ Key eliminada.');
      }

      case 'addtime': {
        const code = interaction.options.getString('key', true).trim();
        const k = q.keyOwned.get(code, actor);
        if (!k) return reply('❌ No encontré esa key entre tus scripts.');
        const secs = parseDuration(interaction.options.getString('duration', true));
        if (!secs) return reply('❌ Duración inválida. Usa 30d, 12h, 1w, 1mo o 1y.');
        if (k.expires_at === null) return reply('ℹ️ Esa key ya es forever.');
        q.setExpiry.run(Math.max(k.expires_at, now()) + secs, code);
        return reply('✅ Tiempo añadido.');
      }

      case 'blacklist': {
        const s = findScript(interaction.options.getString('script', true));
        const denied = block(s, '⛔ Solo el dueño del script puede bloquear usuarios.');
        if (denied) return reply(denied);
        const target = interaction.options.getUser('user', true);
        const reason = interaction.options.getString('reason') || 'Sin razón indicada';
        const info = q.ban.run(reason, s.id, target.id);
        if (!info.changes) return reply(`ℹ️ <@${target.id}> no tiene keys en **${s.name}**.`);
        return reply(`⛔ <@${target.id}> bloqueado en **${s.name}**. Razón: ${reason}`);
      }

      case 'unblacklist': {
        const s = findScript(interaction.options.getString('script', true));
        const denied = block(s, '⛔ Solo el dueño del script puede quitar bloqueos.');
        if (denied) return reply(denied);
        const target = interaction.options.getUser('user', true);
        const info = q.unban.run(s.id, target.id);
        if (!info.changes) return reply(`ℹ️ <@${target.id}> no tenía un bloqueo en **${s.name}**.`);
        return reply(`✅ Bloqueo quitado para <@${target.id}> en **${s.name}**.`);
      }

      case 'resethwid': {
        const s = findScript(interaction.options.getString('script', true));
        if (!s) return reply('❌ Script no encontrado.');
        const target = interaction.options.getUser('user');
        const isOwner = s.user_id === actor;
        if (target && target.id !== actor && !isOwner) return reply('⛔ Solo el dueño puede reiniciar el HWID de otros.');
        const who = target?.id ?? actor;
        const k = q.activeKeyFor.get(s.id, who, now());
        if (!k) return reply('❌ No hay una key activa para ese usuario en este script.');
        // El dueño puede reiniciar la key de otro sin cooldown; el resto espera 24 h
        const bypass = isOwner && target && target.id !== actor;
        if (!bypass && k.hwid_reset_at && now() - k.hwid_reset_at < HWID_RESET_COOLDOWN_S) {
          return reply(`⏳ Podrás reiniciar el HWID <t:${k.hwid_reset_at + HWID_RESET_COOLDOWN_S}:R>.`);
        }
        q.resetHwid.run(now(), k.key);
        return reply('✅ HWID reiniciado. Vuelve a ejecutar el loader.');
      }

      default:
        return reply('❌ Comando no disponible.');
    }
  }

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
        const rows = q.scriptsAccessible.all(interaction.user.id, interaction.user.id)
          .filter(r => r.name.toLowerCase().includes(focused))
          .slice(0, 25)
          .map(r => ({ name: r.name.slice(0, 100), value: String(r.id) }));
        return interaction.respond(rows);
      }
      if (!interaction.isChatInputCommand()) return;
      await handleCommand(interaction);
    } catch (err) {
      console.error('[Bot] Error en interacción:', err);
      const payload = { content: 'Ocurrió un error. Inténtalo de nuevo.', flags: MessageFlags.Ephemeral };
      if (interaction.deferred || interaction.replied) await interaction.editReply(payload).catch(() => {});
      else if (interaction.isChatInputCommand()) await interaction.reply(payload).catch(() => {});
    }
  });

  await client.login(token);
  return client;
}
