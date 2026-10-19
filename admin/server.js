// Panel admin (servicio aparte en Railway). No tiene base de datos propia:
// pide todo al servidor principal con ADMIN_API_TOKEN, así que no necesita volumen.
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const {
  PORT = 3001,
  ADMIN_PASSWORD,
  ADMIN_SESSION_SECRET,
  ADMIN_API_TOKEN,
  MAIN_API_URL = 'https://vantarmorweb-production.up.railway.app',
} = process.env;

if (!ADMIN_PASSWORD || !ADMIN_SESSION_SECRET || !ADMIN_API_TOKEN) {
  console.error('[Admin] Faltan ADMIN_PASSWORD, ADMIN_SESSION_SECRET o ADMIN_API_TOKEN.');
  process.exit(1);
}

const COOKIE = 'vantarmor_admin';
const cookieOpts = { httpOnly: true, secure: true, sameSite: 'strict', maxAge: 8 * 3600 * 1000 };

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '50kb' }));
app.use(cookieParser());

// Comparación en tiempo constante (con hash para que las longitudes coincidan)
function same(a, b) {
  const h = s => crypto.createHash('sha256').update(String(s)).digest();
  return crypto.timingSafeEqual(h(a), h(b));
}

// Máximo 10 intentos fallidos por IP cada 15 minutos
const attempts = new Map();
function tooManyAttempts(ip) {
  const a = attempts.get(ip);
  if (!a) return false;
  if (Date.now() - a.since > 15 * 60_000) { attempts.delete(ip); return false; }
  return a.count >= 10;
}

function requireSession(req, res, next) {
  try {
    jwt.verify(req.cookies[COOKIE] || '', ADMIN_SESSION_SECRET);
    return next();
  } catch {
    return res.status(401).json({ error: 'Admin session required' });
  }
}

app.get('/', (req, res) => res.redirect('/admin'));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.post('/admin/login', (req, res) => {
  const ip = req.ip;
  if (tooManyAttempts(ip)) return res.status(429).json({ error: 'Too many attempts. Wait 15 minutes.' });
  if (!same(req.body?.password ?? '', ADMIN_PASSWORD)) {
    const a = attempts.get(ip) ?? { count: 0, since: Date.now() };
    a.count++;
    attempts.set(ip, a);
    return res.status(401).json({ error: 'Wrong password' });
  }
  attempts.delete(ip);
  const token = jwt.sign({ admin: true }, ADMIN_SESSION_SECRET, { expiresIn: '8h' });
  res.cookie(COOKIE, token, cookieOpts);
  res.json({ ok: true });
});

app.post('/admin/logout', (req, res) => {
  res.clearCookie(COOKIE, cookieOpts);
  res.json({ ok: true });
});

app.get('/admin/session', requireSession, (req, res) => res.json({ ok: true }));

// Solo estas rutas del servidor principal se reenvían (lista cerrada)
const ALLOWED = {
  'plan-keys': { GET: '/plan-keys', POST: '/plan-keys' },
  users: { GET: '/users' },
  publisher: { GET: '/publisher' },
  logs: { GET: '/logs' },
  channels: { GET: '/channels' },
  announce: { POST: '/announce' },
  'bot-avatar': { POST: '/bot-avatar' },
};

async function forward(res, method, route, body) {
  try {
    const out = await fetch(`${MAIN_API_URL}/api/owner${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${ADMIN_API_TOKEN}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const data = await out.json().catch(() => ({}));
    res.status(out.status).json(data);
  } catch {
    res.status(502).json({ error: 'Could not reach the main server' });
  }
}

app.get('/admin/api/:resource', requireSession, (req, res) => {
  const route = ALLOWED[req.params.resource]?.GET;
  if (!route) return res.status(404).json({ error: 'No existe' });
  forward(res, 'GET', route);
});

app.post('/admin/api/users/:id/plan', requireSession, (req, res) => {
  forward(res, 'POST', `/users/${encodeURIComponent(req.params.id)}/plan`, req.body);
});

app.post('/admin/api/:resource', requireSession, (req, res) => {
  const route = ALLOWED[req.params.resource]?.POST;
  if (!route) return res.status(404).json({ error: 'No existe' });
  forward(res, 'POST', route, req.body);
});

app.listen(PORT, () => {
  console.log(`[Admin] Panel en el puerto ${PORT}. Servidor principal: ${MAIN_API_URL}`);
});
