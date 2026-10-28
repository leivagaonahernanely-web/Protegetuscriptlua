// Asistente de soporte: responde con la base de conocimiento de Vantarmor (lib/support-kb.md).
// Usa Gemini (Google AI). Requiere GEMINI_API_KEY en el servidor. Sin clave, el asistente queda desactivado.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const KB = fs.readFileSync(path.join(here, 'support-kb.md'), 'utf8');
// gemini-3.5-flash fue reemplazado por la familia 3.6 según la documentación de Google
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const MAX_MSG = 1500;
const MAX_HISTORY = 8;

export const supportAiEnabled = () => Boolean(process.env.GEMINI_API_KEY);

// history: [{ role: 'user' | 'assistant', content: string }]
export async function answerSupport({ message, history = [], planName = 'desconocido' }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw Object.assign(new Error('El asistente no está activo todavía.'), { status: 503 });

  const clean = s => String(s ?? '').slice(0, MAX_MSG).trim();
  const turns = (Array.isArray(history) ? history : [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && clean(m.content))
    .slice(-MAX_HISTORY)
    .map(m => ({ role: m.role, content: clean(m.content) }));
  const last = clean(message);
  if (!last) throw Object.assign(new Error('Escribe tu pregunta.'), { status: 400 });
  // El historial debe empezar con un mensaje del usuario y alternar roles
  while (turns.length && turns[0].role !== 'user') turns.shift();
  const messages = [...turns, { role: 'user', content: last }];

  const system = [
    'Eres el asistente de soporte de Vantarmor. Ayudas a creadores y usuarios con la plataforma.',
    `El plan del usuario que escribe es: ${planName}.`,
    'Usa solo la siguiente base de conocimiento. Si algo no está ahí, dilo y sugiere abrir un ticket en Soporte.',
    '',
    '<base_de_conocimiento>',
    KB,
    '</base_de_conocimiento>',
  ].join('\n');

  const contents = messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));

  let r;
  try {
    r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`, {
      method: 'POST',
      signal: AbortSignal.timeout(30_000),
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': key,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents,
        generationConfig: { maxOutputTokens: 700, temperature: 0.3 },
      }),
    });
  } catch {
    throw Object.assign(new Error('No pudimos contactar al asistente. Inténtalo de nuevo o abre un ticket.'), { status: 502 });
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.warn('[Asistente] Error de la API:', r.status, String(data?.error?.status || '').slice(0, 80));
    throw Object.assign(new Error('El asistente está ocupado. Inténtalo en un momento o abre un ticket.'), { status: 502 });
  }
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const reply = parts.map(p => p.text || '').join('\n').trim();
  return reply || 'No pude generar una respuesta. Abre un ticket en Soporte y te ayudamos.';
}
