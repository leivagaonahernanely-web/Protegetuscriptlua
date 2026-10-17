import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { startDiscordBot } from './bot/discordBot.js';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// ==========================================
// 0. CONSTANTES Y CONFIGURACIÓN
// ==========================================
const MAX_CODE_BYTES = 2 * 1024 * 1024;           // 2 MB por script
const OBFUSCATORS = ['prometheus', 'hercules'];   // Ofuscador 1 y Ofuscador 2
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
  FRONTEND_URL = 'https://protegetuscriptlua-production-71c7.up.railway.app',
  // En producción (https) debe ser true. Pon COOKIE_SECURE=false solo para probar en http.
  COOKIE_SECURE = 'true',
} = process.env;

const cookieSecure = COOKIE_SECURE !== 'false';

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
  if (!session) return res.status(401).json({ error: 'No auth' });
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
// Aquí se conecta el ofuscador real del servidor (Ofuscador 1 o 2).
// Hasta que lo implementes, los scripts protegidos devuelven error en vez de
// guardarse sin ofuscar, para no engañar al usuario.
async function obfuscate(source, obfuscator) {
  throw Object.assign(new Error(`Ofuscador "${obfuscator}" aún no está conectado en el servidor`), { status: 501 });
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
    redirect_uri: DISCORD_REDIRECT_URI,
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
        redirect_uri: DISCORD_REDIRECT_URI,
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

// Loader: sirve el código si la key es válida y el HWID coincide (o se vincula la primera vez)
app.get('/scripts/hosted/:slug', (req, res) => {
  const script = stmt.scriptBySlug.get(req.params.slug);
  if (!script) return res.status(404).type('text/plain').send('-- script no encontrado');
  if (script.ffa) return res.type('text/plain').send(script.content);

  const key = String(req.query.key || '').slice(0, 64);
  const hwid = String(req.query.hwid || '').slice(0, 128);
  const k = key ? db.prepare('SELECT * FROM keys WHERE key = ? AND script_id = ?').get(key, script.id) : null;
  if (!k || k.banned || (k.expires_at && k.expires_at * 1000 < Date.now())) {
    return res.status(403).type('text/plain').send('-- acceso denegado: key inválida, expirada o bloqueada');
  }
  if (!hwid) return res.status(403).type('text/plain').send('-- acceso denegado: falta HWID');
  if (!k.hwid) db.prepare('UPDATE keys SET hwid = ? WHERE key = ?').run(hwid, key);
  else if (k.hwid !== hwid) return res.status(403).type('text/plain').send('-- acceso denegado: HWID distinto; reinicia el HWID con /resethwid');

  res.type('text/plain').send(script.content);
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
  res.json(user);
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
  }).catch(err => console.error('[Bot] No se pudo iniciar:', err.message));
} else {
  console.warn('[Bot] DISCORD_BOT_TOKEN o DISCORD_CLIENT_ID no definidos: el bot no se inicia.');
}
// ==========================================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Servidor Vantarmor corriendo en el puerto ${PORT}`);
});
