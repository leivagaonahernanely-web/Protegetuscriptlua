// Bot de Discord de la IA de soporte (aparte del bot principal de Vantarmor). Corre dentro del servidor principal.
// Responde cuando lo mencionan o cuando escriben "! Support responde <pregunta>".
// Ideas: "! Support idea <texto>" publica la idea en el canal de ideas del servidor.
// "! Create ideas channel" lo crea SOLO el dueño del servidor.
// Hazlo privado en el Developer Portal (Bot > Public Bot apagado) y activa el intent "Message Content".
import { ChannelType, Client, EmbedBuilder, Events, GatewayIntentBits, PermissionFlagsBits } from 'discord.js';
import { answerSupport, supportAiEnabled } from './support-ai.js';

const TOKEN = process.env.DISCORD_AI_TOKEN || '';
const TRIGGER = /^!\s*support\s+responde\b[:,]?\s*/i;
const IDEA_TRIGGER = /^!\s*support\s+idea\b[:,]?\s*/i;
const CREATE_IDEAS = /^!\s*create\s+ideas\s+channel\s*$/i;
const MAX_PER_HOUR = 30; // preguntas por usuario
const MAX_IDEAS_PER_HOUR = 5;
const MAX_IDEA_CHARS = 500;
const HOUR_MS = 60 * 60 * 1000;
const DISCORD_LIMIT = 1900;
const hits = new Map();
const ideaHits = new Map();
const quiet = { parse: [], repliedUser: false };

function within(map, key, max) {
  const now = Date.now();
  const list = (map.get(key) || []).filter(t => now - t < HOUR_MS);
  if (list.length >= max) { map.set(key, list); return false; }
  list.push(now);
  map.set(key, list);
  return true;
}
const chunks = text => {
  const out = [];
  for (let i = 0; i < text.length; i += DISCORD_LIMIT) out.push(text.slice(i, i + DISCORD_LIMIT));
  return out.length ? out : ['…'];
};
const ideaKey = guildId => `ai_ideas_channel_${guildId}`;

export function startDiscordAiBot(db) {
  if (!TOKEN) {
    console.warn('[Bot IA] DISCORD_AI_TOKEN no configurada: el bot de Discord no inicia.');
    return null;
  }
  const getIdeasChannelId = guildId => {
    try { return db.prepare('SELECT value FROM app_settings WHERE name = ?').get(ideaKey(guildId))?.value || null; }
    catch { return null; }
  };
  const setIdeasChannelId = (guildId, channelId) => {
    db.prepare('INSERT INTO app_settings (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value')
      .run(ideaKey(guildId), channelId);
  };

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });

  client.once(Events.ClientReady, async c => {
    console.log(`[Bot IA] Conectado como ${c.user.tag} en ${c.guilds.cache.size} servidores`);
    // Este bot no tiene comandos de barra: borra los que pudieran haberse registrado por error
    await c.application.commands.set([]).catch(err => console.warn('[Bot IA] No pude limpiar comandos globales:', err.message));
    for (const guild of c.guilds.cache.values()) {
      await guild.commands.set([]).catch(err => console.warn(`[Bot IA] No pude limpiar comandos de ${guild.name}:`, err.message));
    }
  });

  async function handleCreateIdeas(msg) {
    if (msg.guild.ownerId !== msg.author.id) {
      return msg.reply({ content: 'Solo el dueño del servidor puede crear el canal de ideas.', allowedMentions: quiet });
    }
    const existing = getIdeasChannelId(msg.guild.id);
    if (existing && msg.guild.channels.cache.has(existing)) {
      return msg.reply({ content: `El canal de ideas ya existe: <#${existing}>`, allowedMentions: quiet });
    }
    const channel = await msg.guild.channels.create({
      name: 'ideas',
      type: ChannelType.GuildText,
      topic: 'Ideas de la comunidad. Para proponer una, escribe: ! Support idea <tu idea>',
      permissionOverwrites: [
        { id: msg.guild.roles.everyone.id, allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.SendMessages] },
        { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
      ],
    });
    setIdeasChannelId(msg.guild.id, channel.id);
    return msg.reply({ content: `Listo, creé el canal de ideas: <#${channel.id}>`, allowedMentions: quiet });
  }

  async function handleIdea(msg, text) {
    if (!text) {
      return msg.reply({ content: 'Escribe tu idea después del comando. Ejemplo: ! Support idea agregar modo oscuro', allowedMentions: quiet });
    }
    if (text.length > MAX_IDEA_CHARS) {
      return msg.reply({ content: `Tu idea es muy larga (máximo ${MAX_IDEA_CHARS} caracteres).`, allowedMentions: quiet });
    }
    const channelId = getIdeasChannelId(msg.guild.id);
    if (!channelId) {
      return msg.reply({ content: 'Todavía no hay canal de ideas en este servidor. Pídele al dueño que use ! Create ideas channel.', allowedMentions: quiet });
    }
    if (!within(ideaHits, msg.author.id, MAX_IDEAS_PER_HOUR)) {
      return msg.reply({ content: 'Ya enviaste varias ideas hace poco. Intenta más tarde.', allowedMentions: quiet });
    }
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      return msg.reply({ content: 'No encuentro el canal de ideas. Pídele al dueño que use ! Create ideas channel otra vez.', allowedMentions: quiet });
    }
    // Datos de quien da la idea: plan y si es staff (admin/dueño de Vantarmor o dueño del servidor de Vantarmor)
    const row = (() => { try { return db.prepare('SELECT plan, staff_role FROM users WHERE id = ?').get(msg.author.id); } catch { return null; } })();
    const planNames = { free: 'Free', premium: 'Premium', plus: 'Premium Plus' };
    const linked = Boolean(row);
    const plan = linked ? (planNames[row.plan] || row.plan || 'Free') : 'No vinculada';
    // Staff = el rol asignado en la web privada (columna staff_role): owner o admin
    const staffRole = row?.staff_role;
    const staff = !linked ? 'No vinculada' : staffRole === 'owner' ? 'Sí (owner)' : staffRole === 'admin' ? 'Sí (admin)' : 'No';
    const ownerId = msg.guild.ownerId;
    const embed = new EmbedBuilder()
      .setColor(0x9b8cff)
      .setTitle('💡 Nueva idea')
      .setDescription(text)
      .setAuthor({ name: msg.author.username, iconURL: msg.author.displayAvatarURL() })
      .addFields(
        { name: 'Plan', value: plan, inline: true },
        { name: 'Staff', value: staff, inline: true },
        { name: 'Propuesta por', value: `<@${msg.author.id}>`, inline: true },
        { name: 'Dueño del servidor', value: `<@${ownerId}>`, inline: true },
      )
      .setFooter({ text: linked ? 'Cuenta de Vantarmor vinculada' : 'Esta persona no ha iniciado sesión en la web de Vantarmor con Discord' })
      .setTimestamp();
    const users = [...new Set([ownerId, msg.author.id])];
    await channel.send({
      content: users.map(id => `<@${id}>`).join(' '),
      embeds: [embed],
      allowedMentions: { users },
    });
    return msg.reply({ content: `¡Gracias! Tu idea quedó en <#${channelId}>.`, allowedMentions: quiet });
  }

  async function handleQuestion(msg) {
    const me = client.user?.id;
    const mentioned = Boolean(me && msg.mentions.has(me));
    const triggered = TRIGGER.test(msg.content);
    if (!mentioned && !triggered) return;
    let text = msg.content.replace(TRIGGER, '');
    if (me) text = text.replace(new RegExp(`<@!?${me}>`, 'g'), '');
    text = text.trim();
    if (!text) {
      return msg.reply({ content: 'Escribe tu pregunta sobre Vantarmor después de mencionarme.', allowedMentions: quiet });
    }
    if (!supportAiEnabled()) {
      return msg.reply({ content: 'El asistente no está activo todavía.', allowedMentions: quiet });
    }
    if (!within(hits, msg.author.id, MAX_PER_HOUR)) {
      return msg.reply({ content: 'Llegaste al límite de preguntas por hora. Vuelve más tarde.', allowedMentions: quiet });
    }
    await msg.channel.sendTyping().catch(() => {});
    const reply = await answerSupport({ message: text, planName: 'usuario de Discord' });
    for (const part of chunks(reply)) {
      await msg.reply({ content: part, allowedMentions: quiet });
    }
  }

  client.on(Events.MessageCreate, async msg => {
    try {
      if (msg.author.bot || !msg.guild) return;
      if (CREATE_IDEAS.test(msg.content.trim())) return await handleCreateIdeas(msg);
      if (IDEA_TRIGGER.test(msg.content)) return await handleIdea(msg, msg.content.replace(IDEA_TRIGGER, '').trim());
      await handleQuestion(msg);
    } catch (err) {
      console.error('[Bot IA] Error al responder:', err?.status || '', err?.message || err);
      await msg.reply({
        content: 'No pude completar eso ahora. Inténtalo de nuevo o abre un ticket en la web.',
        allowedMentions: quiet,
      }).catch(() => {});
    }
  });

  client.login(TOKEN).catch(err => console.error('[Bot IA] No pudo iniciar sesión:', err.message));
  return client;
}
