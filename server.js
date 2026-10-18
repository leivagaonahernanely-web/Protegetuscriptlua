import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execFile } from 'child_process';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { startDiscordBot, ensureBotSchema } from './bot/discordBot.js';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// ==========================================
// 0. CONSTANTES Y CONFIGURACIÓN
// ==========================================
const MAX_CODE_BYTES = 2 * 1024 * 1024;           // 2 MB por script
const OBFUSCATORS = ['prometheus', 'hercules', 'obscura'];   // Ofuscador 1, 2 y 3
const KEY_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const SESSION_COOKIE = 'vantarmor_session';
const STATE_COOKIE = 'oauth_state';

const {
  PORT = 3000,
  DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET,
  DISCORD_REDIRECT_URI,
  JWT_SECRET,
  DATABASE_PATH = 'vantarmor.db',
  FRONTEND_URL = 'https://vantarmorweb-production.up.railway.app',
  // En producción (https) debe ser true. Pon COOKIE_SECURE=false solo para probar en http.
  COOKIE_SECURE = 'true',
} = process.env;

// URL pública del sitio (sin barra final). Es la base del dashboard, CORS y del callback de OAuth.
const APP_URL = FRONTEND_URL.replace(/\/+$/, '');
// Callback de Discord OAuth2. Debe coincidir EXACTO con la URL registrada en el Developer Portal
// (OAuth2 → Redirects). Si DISCORD_REDIRECT_URI no se define, se usa APP_URL + /auth/discord/callback.
const REDIRECT_URI = DISCORD_REDIRECT_URI || `${APP_URL}/auth/discord/callback`;

const cookieSecure = COOKIE_SECURE !== 'false';

if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET) console.warn('⚠️  DISCORD_CLIENT_ID o DISCORD_CLIENT_SECRET no definidos: el login con Discord no funcionará.');
console.log(`🔗 OAuth callback: ${REDIRECT_URI}`);
// En Railway el disco del contenedor se borra en cada deploy: sin volumen se pierden usuarios, scripts y keys.
if (process.env.RAILWAY_ENVIRONMENT && !DATABASE_PATH.startsWith('/data')) {
  console.warn('⚠️  La base de datos NO está en un volumen: se borra en cada deploy. Monta un volumen en /data y usa DATABASE_PATH=/data/vantarmor.db');
}

if (!JWT_SECRET) console.warn('⚠️  JWT_SECRET no está definido: el login no funcionará.');

app.use(express.json({ limit: '3mb' }));          // el default de Express (100 KB) no alcanza para 2 MB
app.use(cookieParser());
app.use(cors({ origin: FRONTEND_URL, credentials: true }));

// ==========================================
// 1. BASE DE DATOS
// ==========================================
if (DATABASE_PATH.startsWith('/')) {
  const dir = path.dirname(DATABASE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const db = new Database(DATABASE_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT,
    avatar TEXT,
    plan TEXT DEFAULT 'free'
  );
  CREATE TABLE IF NOT EXISTS scripts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    name TEXT,
    slug TEXT UNIQUE,
    ffa INTEGER,
    content TEXT
  );
  CREATE TABLE IF NOT EXISTS keys (
    key TEXT PRIMARY KEY,
    script_id INTEGER,
    expires_at INTEGER,
    banned INTEGER DEFAULT 0
  );
`);

// Migraciones: añade columnas nuevas si la base ya existía
{
  const cols = db.prepare('PRAGMA table_info(scripts)').all().map(c => c.name);
  if (!cols.includes('obfuscator')) db.exec('ALTER TABLE scripts ADD COLUMN obfuscator TEXT');
  // source = código original (nunca se envía al cliente); content = lo que se sirve al loader
  if (!cols.includes('source')) db.exec('ALTER TABLE scripts ADD COLUMN source TEXT');

  // Columnas de keys para el bot y el control de HWID
  const keyCols = db.prepare('PRAGMA table_info(keys)').all().map(c => c.name);
  for (const [col, type] of [['discord_id', 'TEXT'], ['hwid', 'TEXT'], ['hwid_reset_at', 'INTEGER'], ['ban_reason', 'TEXT']]) {
    if (!keyCols.includes(col)) db.exec(`ALTER TABLE keys ADD COLUMN ${col} ${type}`);
  }
}
ensureBotSchema(db);

const stmt = {
  userById: db.prepare('SELECT id, username, avatar, plan FROM users WHERE id = ?'),
  upsertUser: db.prepare(`
    INSERT INTO users (id, username, avatar) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET username = excluded.username, avatar = excluded.avatar
  `),
  // Nunca se seleccionan source ni content aquí
  scriptsByUser: db.prepare(`
    SELECT id, user_id, name, slug, ffa, obfuscator FROM scripts
    WHERE user_id = ? ORDER BY id DESC
  `),
  scriptOwned: db.prepare('SELECT * FROM scripts WHERE id = ? AND user_id = ?'),
  scriptInsert: db.prepare(`
    INSERT INTO scripts (user_id, name, slug, ffa, obfuscator, source, content)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  scriptUpdate: db.prepare(`
    UPDATE scripts SET name = ?, ffa = ?, obfuscator = ?, source = ?, content = ?
    WHERE id = ? AND user_id = ?
  `),
  keysByUser: db.prepare(`
    SELECT k.key, k.script_id, k.expires_at, k.banned FROM keys k
    JOIN scripts s ON s.id = k.script_id
    WHERE s.user_id = ?
  `),
  keyInsert: db.prepare('INSERT INTO keys (key, script_id, expires_at) VALUES (?, ?, ?)'),
  slugExists: db.prepare('SELECT 1 FROM scripts WHERE slug = ?'),
  scriptBySlug: db.prepare('SELECT * FROM scripts WHERE slug = ?'),
};

// ==========================================
// 2. FRONTEND (carpeta 'frotend')
// ==========================================
app.use(express.static(path.join(__dirname, 'frotend')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'frotend', 'index.html')));
app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'frotend', 'login.html')));
app.get('/dashboard.html', (req, res) => res.sendFile(path.join(__dirname, 'frotend', 'dashboard.html')));

// ==========================================
// 3. HELPERS DE SESIÓN
// ==========================================
const sessionCookieOpts = {
  httpOnly: true,
  secure: cookieSecure,
  sameSite: 'lax',
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

function getSession(req) {
  const token = req.cookies[SESSION_COOKIE];
  if (!token || !JWT_SECRET) return null;
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

function requireAuth(req, res, next) {
  const session = getSession(req);
  if (!session) {
    const reason = !req.cookies[SESSION_COOKIE]
      ? 'No hay cookie de sesión en este navegador (¿estás en el mismo dominio que el login?)'
      : (!JWT_SECRET ? 'El servidor no tiene JWT_SECRET configurado' : 'Sesión inválida o expirada');
    return res.status(401).json({ error: reason });
  }
  req.userId = session.id;
  next();
}

const slugify = name => name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'script';

function uniqueSlug(name) {
  for (let i = 0; i < 5; i++) {
    const slug = `${slugify(name)}-${crypto.randomBytes(3).toString('hex')}`;
    if (!stmt.slugExists.get(slug)) return slug;
  }
  throw new Error('No se pudo generar un slug único');
}

// Valida nombre, modo y código. Devuelve { error } o los valores limpios.
function validateScriptInput({ name, ffa, obfuscator, code }, current = null) {
  const cleanName = name === undefined ? current?.name : String(name).trim();
  if (!cleanName || cleanName.length > 60) return { error: 'Nombre inválido (1 a 60 caracteres)' };

  const isFfa = ffa === undefined ? !!current?.ffa : !!ffa;
  const obf = isFfa ? null : (obfuscator === undefined ? current?.obfuscator : obfuscator);
  if (!isFfa && !OBFUSCATORS.includes(obf)) return { error: 'Elige un ofuscador válido' };

  const source = code === undefined ? current?.source : code;
  if (typeof source !== 'string' || !source.trim()) return { error: 'Falta el código del script' };
  if (Buffer.byteLength(source) > MAX_CODE_BYTES) return { error: 'El código supera 2 MB' };

  return { name: cleanName, isFfa, obfuscator: obf, source };
}

// ==========================================
// 4. OFUSCACIÓN
// ==========================================
// Ofuscadores reales (CLIs locales). El Dockerfile instala Lua 5.1 / 5.4 y
// clona ambos repos en OBFUSCATOR_DIR (por defecto /opt/obfuscators).
//   Ofuscador 1 = Prometheus (Lua 5.1)
//   Ofuscador 2 = Hercules  (Lua 5.4)
// Se ejecutan sin shell (execFile + argumentos separados) para evitar inyección.
const OBF_DIR = process.env.OBFUSCATOR_DIR || '/opt/obfuscators';
const OBF_TIMEOUT_MS = Number(process.env.OBFUSCATOR_TIMEOUT_MS) || 120_000;
const OBF_CONFIG = {
  prometheus: {
    bin: 'lua5.1',
    dir: path.join(OBF_DIR, 'prometheus'),
    args: (input, out) => ['cli.lua', '--preset', 'Medium', '--out', out, input],
    output: (input, out) => out,
  },
  hercules: {
    bin: 'lua5.4',
    dir: path.join(OBF_DIR, 'hercules', 'src'),
    // --light: el modo balanced tardaba más que el límite de la petición
    args: (input) => ['hercules.lua', input, '--light'],
    output: (input) => input.replace(/\.lua$/, '') + '_obfuscated.lua',
  },
  // Ofuscador 3 = Obscura (Python, MIT). CLI: python main.py <entrada> -o <salida> --mode lightweight
  obscura: {
    // Obscura usa sintaxis de Python 3.12; el Dockerfile instala ese intérprete
    bin: process.env.OBSCURA_PYTHON || '/opt/obscura-venv/bin/python',
    dir: path.join(OBF_DIR, 'obscura'),
    args: (input, out) => ['main.py', input, '-o', out, '--mode', 'lightweight'],
    output: (input, out) => out,
  },
};

function runObfuscatorCli(bin, args, cwd, luaPath) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, {
      cwd,
      timeout: OBF_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, LUA_PATH: `${cwd}/?.lua;${cwd}/?/init.lua;${luaPath};;` },
    }, (err, stdout, stderr) => {
      if (err) {
        const detail = String(stderr || stdout || err.message).slice(0, 500);
        return reject(Object.assign(new Error(`El ofuscador falló: ${detail}`), { status: 500 }));
      }
      resolve(stdout);
    });
  });
}

async function obfuscate(source, obfuscator) {
  const cfg = OBF_CONFIG[obfuscator];
  if (!cfg) throw Object.assign(new Error('Elige un ofuscador válido'), { status: 400 });
  if (!fs.existsSync(cfg.dir)) {
    throw Object.assign(new Error(`Ofuscador no instalado en el servidor (${cfg.dir})`), { status: 501 });
  }

  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vp-obf-'));
  try {
    const input = path.join(dir, 'script.lua');
    const out = path.join(dir, 'out.lua');
    await fs.promises.writeFile(input, source, 'utf8');

    await runObfuscatorCli(cfg.bin, cfg.args(input, out), cfg.dir, cfg.dir);

    const result = await fs.promises.readFile(cfg.output(input, out), 'utf8');
    if (!result.trim()) throw Object.assign(new Error('El ofuscador no generó salida'), { status: 500 });
    return result;
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

// ==========================================
// 5. AUTENTICACIÓN CON DISCORD
// ==========================================
app.get('/auth/discord', (req, res) => {
  // state anti-CSRF: se guarda en cookie y se compara en el callback
  const state = crypto.randomBytes(16).toString('hex');
  res.cookie(STATE_COOKIE, state, { httpOnly: true, secure: cookieSecure, sameSite: 'lax', maxAge: 10 * 60 * 1000 });

  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'identify email',
    state,
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

app.get('/auth/discord/callback', async (req, res) => {
  const { code, state } = req.query;
  const expectedState = req.cookies[STATE_COOKIE];
  res.clearCookie(STATE_COOKIE);

  if (!code) return res.redirect('/login.html?error=no_code');
  if (!state || !expectedState || state !== expectedState) return res.redirect('/login.html?error=state');

  try {
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) {
      console.error('Token error:', tokenData);
      return res.redirect('/login.html?error=token_failed');
    }

    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `${tokenData.token_type} ${tokenData.access_token}` },
    });
    const dUser = await userRes.json();
    if (!userRes.ok || !dUser.id) {
      console.error('User error:', dUser);
      return res.redirect('/login.html?error=token_failed');
    }

    // Upsert: conserva el plan del usuario al volver a iniciar sesión
    stmt.upsertUser.run(dUser.id, dUser.username, dUser.avatar);

    const session = jwt.sign({ id: dUser.id, username: dUser.username }, JWT_SECRET, { expiresIn: '7d' });
    res.cookie(SESSION_COOKIE, session, sessionCookieOpts);
    res.redirect('/dashboard.html');
  } catch (err) {
    console.error('OAuth error:', err);
    res.redirect('/login.html?error=server');
  }
});

// Configuración pública para el dashboard (link de invitación del bot)
app.get('/api/config', (req, res) => {
  const botInviteUrl = DISCORD_CLIENT_ID
    ? `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(DISCORD_CLIENT_ID)}&scope=bot%20applications.commands&permissions=268454912`
    : null;
  res.json({ botInviteUrl });
});

// Canje de key de plan (Premium / Premium Plus); cada key se usa una sola vez
app.post('/api/plan/redeem', requireAuth, (req, res) => {
  const key = String(req.body?.key || '').trim();
  if (key.length < 32 || key.length > 64) return res.status(400).json({ error: 'Key inválida' });

  const row = db.prepare('SELECT * FROM plan_keys WHERE key = ?').get(key);
  if (!row) return res.status(404).json({ error: 'Key de plan inválida' });
  if (row.used_by) return res.status(409).json({ error: 'Esta key ya fue usada' });

  const ok = db.transaction(() => {
    const claimed = db.prepare('UPDATE plan_keys SET used_by = ?, used_at = ? WHERE key = ? AND used_by IS NULL')
      .run(req.userId, Math.floor(Date.now() / 1000), key);
    if (!claimed.changes) return false;
    db.prepare('UPDATE users SET plan = ? WHERE id = ?').run(row.plan, req.userId);
    return true;
  })();
  if (!ok) return res.status(409).json({ error: 'Esta key ya fue usada' });

  res.json({ ok: true, plan: row.plan });
});

// Loader: sirve el código si la key es válida y el HWID coincide (o se vincula la primera vez)
const escHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Cabeceras de páginas de solo lectura: sin scripts, sin caché, sin referrer.
const PAGE_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

// Página que ve el navegador al abrir la URL del loader (estilo "Loadstring").
// Nunca muestra el código del script: solo el snippet para usar en el ejecutor.
function loaderPage(script) {
  const url = `${APP_URL}/scripts/hosted/${script.slug}`;
  const snippet = [
    'script_key = "KEY"',
    `loadstring(game:HttpGet("${url}"))()`,
  ].join('\n');
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Loadstring</title>
<style>
:root{--bg:#0b0b0c;--border:rgba(255,255,255,.1);--text:#e4e4e7}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--text);user-select:none;-webkit-user-select:none}
body{min-height:100vh;display:grid;place-items:center;padding:16px}
pre{margin:0;width:100%;max-width:720px;padding:16px 18px;background:#050505;border:1px solid var(--border);border-radius:12px;overflow-x:auto;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;line-height:1.7;white-space:pre}
</style>
</head>
<body>
<pre>${escHtml(snippet)}</pre>
</body>
</html>`;
}

// Bootstrap que recibe el ejecutor al pedir la URL del loader.
// Lee script_key, pide el script a /auth con key + HWID y, si algo falla, expulsa
// al jugador con el mensaje de la tabla MSG. No contiene el código del script.
function loaderBootstrap(slug, ffa) {
  const authUrl = `${APP_URL}/scripts/hosted/${slug}/auth`;
  const payloadUrl = `${APP_URL}/scripts/hosted/${slug}/payload`;
  return `local AUTH_URL = ${JSON.stringify(authUrl)}
local PAYLOAD_URL = ${JSON.stringify(payloadUrl)}
local FFA = ${ffa ? 'true' : 'false'}
local MSG = {
  KEY_REQUIRED = "🔑 Key is required",
  KEY_INVALID = "❌ Invalid key",
  KEY_EXPIRED = "⏱️ Session expired, rejoin",
  NOT_AUTHORIZED = "🚫 Not authorized",
  HWID_MISMATCH = "📝 Hwid is mismatch",
  VERIFY_FAILED = "🔒 Verification failed",
  CONNECTION_FAILED = "🌐 Connection failed, try again",
  TAMPERING = "⚠️ Tampering detected",
  SCRIPT_NOT_FOUND = "📋 Script ID not found",
  REAUTH = "🔄 Please re-authenticate",
  BLACKLISTED = "🛡️ Blacklisted",
  SERVER_UNREACHABLE = "📡 Server unreachable",
}
local Players = game:GetService("Players")
local function kick(code)
  local msg = MSG[code] or MSG.VERIFY_FAILED
  local lp = Players.LocalPlayer
  if lp then lp:Kick(msg) end
  error(msg, 0)
end
local key = ""
if type(script_key) == "string" then key = (script_key:gsub("^%s+", ""):gsub("%s+$", "")) end
if key == "" and not FFA then kick("KEY_REQUIRED") end
local function enc(s) return (s:gsub("[^%w%-_%.~]", function(c) return string.format("%%%02X", string.byte(c)) end)) end
local hwid = ""
local okh, h = pcall(function() return game:GetService("RbxAnalyticsService"):GetClientId() end)
if okh and h then hwid = h end
local ok, body = pcall(function() return game:HttpGet(AUTH_URL .. "?key=" .. enc(key) .. "&hwid=" .. enc(hwid)) end)
script_key = nil
if not ok or type(body) ~= "string" then kick("SERVER_UNREACHABLE") end
local code = body:match("^!VANTARMOR:(%u[%u_]*)$")
if code then kick(code) end
local tok = body:match("^!VANTARMOR:OK:(%x+)$")
if not tok then kick("VERIFY_FAILED") end
local ok2, payload = pcall(function() return game:HttpGet(PAYLOAD_URL .. "?token=" .. tok) end)
if not ok2 or type(payload) ~= "string" then kick("CONNECTION_FAILED") end
local pcode = payload:match("^!VANTARMOR:(%u[%u_]*)$")
if pcode then kick(pcode) end
local fn = loadstring(payload)
if not fn then kick("VERIFY_FAILED") end
fn()
`;
}

// Página pública: el navegador ve solo el snippet (solo lectura); el ejecutor recibe el bootstrap.
app.get('/scripts/hosted/:slug', (req, res) => {
  if (/text\/html/.test(req.get('accept') || '')) {
    const script = stmt.scriptBySlug.get(req.params.slug);
    if (!script) return res.status(404).type('text/plain').send('-- script no encontrado');
    return res.set(PAGE_HEADERS).type('html').send(loaderPage(script));
  }
  const script = stmt.scriptBySlug.get(req.params.slug);
  res.type('text/plain').send(loaderBootstrap(req.params.slug, !!(script && script.ffa)));
});

// Tokens de un solo uso para entregar el código: /auth los emite, /payload los consume.
const payloadTokens = new Map(); // token -> { scriptId, expires }
const PAYLOAD_TTL_MS = 30_000;
setInterval(() => {
  const now = Date.now();
  for (const [t, v] of payloadTokens) if (v.expires < now) payloadTokens.delete(t);
}, 60_000).unref();
function issuePayloadToken(scriptId) {
  const token = crypto.randomBytes(24).toString('hex');
  payloadTokens.set(token, { scriptId, expires: Date.now() + PAYLOAD_TTL_MS });
  return token;
}

// Entrega el código con un token válido. El token se gasta aunque falle.
app.get('/scripts/hosted/:slug/payload', (req, res) => {
  if (/text\/html/.test(req.get('accept') || '')) return res.status(403).type('text/plain').send('!VANTARMOR:FORBIDDEN');
  const token = String(req.query.token || '');
  const entry = payloadTokens.get(token);
  payloadTokens.delete(token);
  const script = stmt.scriptBySlug.get(req.params.slug);
  if (!entry || entry.expires < Date.now() || !script || script.id !== entry.scriptId) {
    return res.status(403).type('text/plain').send('!VANTARMOR:TOKEN_INVALID');
  }
  res.type('text/plain').send(script.content);
});

// Endpoint de verificación: lo llama el bootstrap. Responde el código del script o "!VANTARMOR:CODIGO".
app.get('/scripts/hosted/:slug/auth', (req, res) => {
  // Los navegadores no reciben nunca el código
  if (/text\/html/.test(req.get('accept') || '')) return res.status(403).type('text/plain').send('!VANTARMOR:FORBIDDEN');
  const reply = code => res.type('text/plain').send(`!VANTARMOR:${code}`);

  const script = stmt.scriptBySlug.get(req.params.slug);
  if (!script) return reply('SCRIPT_NOT_FOUND');
  if (script.ffa) return reply(`OK:${issuePayloadToken(script.id)}`);

  const key = String(req.query.key || '').trim().slice(0, 64);
  const hwid = String(req.query.hwid || '').slice(0, 128);
  if (!key) return reply('KEY_REQUIRED');
  const k = db.prepare('SELECT * FROM keys WHERE key = ? AND script_id = ?').get(key, script.id);
  if (!k) return reply('KEY_INVALID');
  if (k.banned) return reply('BLACKLISTED');
  if (k.expires_at && k.expires_at * 1000 < Date.now()) return reply('KEY_EXPIRED');
  if (k.discord_id && db.prepare('SELECT 1 FROM bot_blacklist WHERE script_id = ? AND discord_id = ?').get(script.id, k.discord_id)) {
    return reply('BLACKLISTED');
  }
  if (!hwid) return reply('VERIFY_FAILED');
  if (!k.hwid) db.prepare('UPDATE keys SET hwid = ? WHERE key = ?').run(hwid, key);
  else if (k.hwid !== hwid) return reply('HWID_MISMATCH');

  reply(`OK:${issuePayloadToken(script.id)}`);
});

app.get('/auth/logout', (req, res) => {
  res.clearCookie(SESSION_COOKIE);
  res.redirect('/login.html');
});

// ==========================================
// 6. API
// ==========================================
app.get('/api/me', requireAuth, (req, res) => {
  const user = stmt.userById.get(req.userId);
  if (!user) return res.status(401).json({ error: 'Usuario no encontrado' });
  res.json({ ...user, owner: isOwnerId(req.userId) });
});

// ---- Panel del dueño: solo DISCORD_OWNER_ID ----
function isOwnerId(id) {
  return Boolean(process.env.DISCORD_OWNER_ID) && String(id) === String(process.env.DISCORD_OWNER_ID);
}
function requireOwner(req, res, next) {
  if (!isOwnerId(req.userId)) return res.status(403).json({ error: 'Solo el dueño puede ver esto' });
  next();
}
app.get('/api/owner/plan-keys', requireAuth, requireOwner, (req, res) => {
  res.json(db.prepare('SELECT key, plan, used_by, used_at, created_at FROM plan_keys ORDER BY created_at DESC LIMIT 200').all());
});
app.post('/api/owner/plan-keys', requireAuth, requireOwner, (req, res) => {
  const plan = req.body?.plan === 'plus' ? 'plus' : (req.body?.plan === 'premium' ? 'premium' : null);
  if (!plan) return res.status(400).json({ error: 'Plan inválido' });
  const key = crypto.randomBytes(24).toString('base64url'); // 32 caracteres, uso único
  db.prepare('INSERT INTO plan_keys (key, plan, created_at) VALUES (?, ?, ?)').run(key, plan, Math.floor(Date.now() / 1000));
  res.json({ key, plan });
});
app.get('/api/owner/publisher', requireAuth, requireOwner, (req, res) => {
  res.json(db.prepare(`SELECT s.id, s.name, s.slug, s.ffa, s.obfuscator, s.source, s.user_id, u.username
    FROM scripts s LEFT JOIN users u ON u.id = s.user_id ORDER BY s.id DESC`).all());
});

app.get('/api/scripts', requireAuth, (req, res) => {
  res.json(stmt.scriptsByUser.all(req.userId));
});

app.post('/api/scripts', requireAuth, async (req, res) => {
  const input = validateScriptInput(req.body || {});
  if (input.error) return res.status(400).json({ error: input.error });

  try {
    const content = input.isFfa ? input.source : await obfuscate(input.source, input.obfuscator);
    const info = stmt.scriptInsert.run(
      req.userId, input.name, uniqueSlug(input.name), input.isFfa ? 1 : 0,
      input.obfuscator, input.source, content,
    );
    res.status(201).json({ ok: true, id: info.lastInsertRowid });
  } catch (err) {
    console.error('Create script error:', err);
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Error del servidor' });
  }
});

// Eliminar un script junto con sus keys y todo lo que el bot tiene ligado a él
app.delete('/api/scripts/:id', requireAuth, (req, res) => {
  const script = stmt.scriptOwned.get(req.params.id, req.userId);
  if (!script) return res.status(404).json({ error: 'Script no encontrado' });
  db.transaction(() => {
    db.prepare('DELETE FROM keys WHERE script_id = ?').run(script.id);
    for (const table of ['bot_panels', 'bot_access_rules', 'bot_blacklist']) {
      db.prepare(`DELETE FROM ${table} WHERE script_id = ?`).run(script.id);
    }
    db.prepare('DELETE FROM scripts WHERE id = ? AND user_id = ?').run(script.id, req.userId);
  })();
  res.json({ ok: true });
});

app.put('/api/scripts/:id', requireAuth, async (req, res) => {
  const script = stmt.scriptOwned.get(Number(req.params.id), req.userId);
  if (!script) return res.status(404).json({ error: 'Script no encontrado' });

  const input = validateScriptInput(req.body || {}, script);
  if (input.error) return res.status(400).json({ error: input.error });

  try {
    const content = input.isFfa ? input.source : await obfuscate(input.source, input.obfuscator);
    stmt.scriptUpdate.run(
      input.name, input.isFfa ? 1 : 0, input.obfuscator, input.source, content,
      script.id, req.userId,
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Update script error:', err);
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Error del servidor' });
  }
});

app.get('/api/keys', requireAuth, (req, res) => {
  res.json(stmt.keysByUser.all(req.userId));
});

app.post('/api/keys', requireAuth, (req, res) => {
  const scriptId = Number(req.body?.scriptId);
  const amount = req.body?.amount === undefined ? 1 : Number(req.body.amount);
  const days = req.body?.days === undefined || req.body.days === null ? null : Number(req.body.days);

  if (!Number.isInteger(scriptId)) return res.status(400).json({ error: 'scriptId inválido' });
  if (!Number.isInteger(amount) || amount < 1 || amount > 50) return res.status(400).json({ error: 'La cantidad debe estar entre 1 y 50' });
  if (days !== null && (!Number.isInteger(days) || days < 1 || days > 3650)) return res.status(400).json({ error: 'Días inválidos' });

  const script = stmt.scriptOwned.get(scriptId, req.userId);
  if (!script) return res.status(403).json({ error: 'No autorizado' });

  const expiresAt = days ? Math.floor(Date.now() / 1000) + days * 86400 : null;

  try {
    const generated = db.transaction(() => {
      const list = [];
      for (let i = 0; i < amount; i++) {
        let k;
        do {
          k = Array.from(crypto.randomBytes(32), b => KEY_ALPHABET[b % KEY_ALPHABET.length]).join('');
        } while (db.prepare('SELECT 1 FROM keys WHERE key = ?').get(k));
        stmt.keyInsert.run(k, script.id, expiresAt);
        list.push(k);
      }
      return list;
    })();
    res.json({ keys: generated });
  } catch (err) {
    console.error('Create keys error:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ==========================================
// 7. ARRANCAR SERVIDOR
// El bot usa la misma base SQLite; se inicia solo si existe DISCORD_BOT_TOKEN.
if (process.env.DISCORD_BOT_TOKEN && DISCORD_CLIENT_ID) {
  startDiscordBot({
    db,
    token: process.env.DISCORD_BOT_TOKEN,
    clientId: DISCORD_CLIENT_ID,
    guildId: process.env.DISCORD_GUILD_ID || undefined,
    publicUrl: process.env.PUBLIC_URL || FRONTEND_URL,
    ownerId: process.env.DISCORD_OWNER_ID || undefined, // tu ID de Discord (dueño del workspace)
  }).catch(err => console.error('[Bot] No se pudo iniciar:', err.message));
} else {
  console.warn('[Bot] DISCORD_BOT_TOKEN o DISCORD_CLIENT_ID no definidos: el bot no se inicia.');
}
// ==========================================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Servidor Vantarmor corriendo en el puerto ${PORT}`);
});
