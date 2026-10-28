// Bot de Discord de la IA de soporte (aparte del bot principal de Vantarmor). Corre dentro del servidor principal.
// Responde cuando lo mencionan o cuando escriben "! Support responde <pregunta>".
// Hazlo privado en el Developer Portal (Bot > Public Bot apagado) para que solo tú lo añadas a servidores,
// y activa el intent "Message Content" (Bot > Privileged Gateway Intents).
import { Client, GatewayIntentBits, Events } from 'discord.js';
import { answerSupport, supportAiEnabled } from './support-ai.js';

const TOKEN = process.env.DISCORD_AI_TOKEN || '';
const TRIGGER = /^!\s*support\s+responde\b[:,]?\s*/i;
const MAX_PER_HOUR = 30; // por usuario
const HOUR_MS = 60 * 60 * 1000;
const hits = new Map();
const DISCORD_LIMIT = 1900;

function allowed(userId) {
  const now = Date.now();
  const list = (hits.get(userId) || []).filter(t => now - t < HOUR_MS);
  if (list.length >= MAX_PER_HOUR) { hits.set(userId, list); return false; }
  list.push(now);
  hits.set(userId, list);
  return true;
}

const chunks = text => {
  const out = [];
  for (let i = 0; i < text.length; i += DISCORD_LIMIT) out.push(text.slice(i, i + DISCORD_LIMIT));
  return out.length ? out : ['…'];
};
const quiet = { parse: [], repliedUser: false };

export function startDiscordAiBot() {
  if (!TOKEN) {
    console.warn('[Bot IA] DISCORD_AI_TOKEN no configurada: el bot de Discord no inicia.');
    return null;
  }
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });

  client.once(Events.ClientReady, c => {
    console.log(`[Bot IA] Conectado como ${c.user.tag} en ${c.guilds.cache.size} servidores`);
  });

  client.on(Events.MessageCreate, async msg => {
    try {
      if (msg.author.bot || !msg.guild) return;
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
      if (!allowed(msg.author.id)) {
        return msg.reply({ content: 'Llegaste al límite de preguntas por hora. Vuelve más tarde.', allowedMentions: quiet });
      }

      await msg.channel.sendTyping().catch(() => {});
      const reply = await answerSupport({ message: text, planName: 'usuario de Discord' });
      for (const part of chunks(reply)) {
        await msg.reply({ content: part, allowedMentions: quiet });
      }
    } catch (err) {
      console.error('[Bot IA] Error al responder:', err?.status || '', err?.message || err);
      await msg.reply({
        content: 'No pude responder ahora. Inténtalo de nuevo o abre un ticket en la web.',
        allowedMentions: quiet,
      }).catch(() => {});
    }
  });

  client.login(TOKEN).catch(err => console.error('[Bot IA] No pudo iniciar sesión:', err.message));
  return client;
}
