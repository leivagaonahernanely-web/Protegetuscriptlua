// Servicio aparte del asistente de IA (solo para el dueño). No está enlazado con la web pública.
// Variables: AI_SERVICE_TOKEN (obligatoria), GEMINI_API_KEY, GEMINI_MODEL (opcional), PORT (opcional).
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { answerSupport, supportAiEnabled } from '../lib/support-ai.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = process.env.AI_SERVICE_TOKEN || '';
const PORT = Number(process.env.PORT) || 3000;
const HOUR_MS = 60 * 60 * 1000;
const MAX_PER_HOUR = 200;
let hits = [];

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.set('Cache-Control', 'no-store');
  next();
});
app.use(express.json({ limit: '64kb' }));

const sha = s => crypto.createHash('sha256').update(String(s)).digest();
function authorized(req) {
  if (!TOKEN) return false;
  const m = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
  if (!m) return false;
  return crypto.timingSafeEqual(sha(m[1]), sha(TOKEN));
}
function requireToken(req, res, next) {
  if (!TOKEN) return res.status(503).json({ error: 'AI_SERVICE_TOKEN no está configurada en el servicio.' });
  if (!authorized(req)) return res.status(401).json({ error: 'Token incorrecto.' });
  next();
}
function underLimit() {
  const now = Date.now();
  hits = hits.filter(t => now - t < HOUR_MS);
  if (hits.length >= MAX_PER_HOUR) return false;
  hits.push(now);
  return true;
}

app.get('/', (req, res) => res.sendFile(path.join(here, 'index.html')));
app.get('/api/status', requireToken, (req, res) => res.json({ enabled: supportAiEnabled() }));
app.post('/api/ask', requireToken, async (req, res) => {
  if (!supportAiEnabled()) return res.status(503).json({ error: 'Falta GEMINI_API_KEY en el servicio.' });
  if (!underLimit()) return res.status(429).json({ error: 'Límite por hora alcanzado. Espera un rato.' });
  try {
    const reply = await answerSupport({
      message: req.body?.message,
      history: req.body?.history,
      planName: 'dueño (administrador de Vantarmor)',
    });
    res.json({ reply });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Error del servicio. Inténtalo de nuevo.' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Asistente IA (servicio privado) en el puerto ${PORT}`);
  if (!TOKEN) console.warn('[AVISO] AI_SERVICE_TOKEN no configurada: el servicio responderá 503.');
});
