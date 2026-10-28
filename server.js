import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import net from 'net';
import dns from 'dns';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execFile } from 'child_process';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { createQuota, PLAN_DAYS_DEFAULT, MONTH_SECONDS, FREE_RESET_SECONDS } from './lib/quota.js';
import { analyzePerf } from './lib/perf.js';
import { startDiscordBot, ensureBotSchema } from './bot/discordBot.js';
import geoip from 'geoip-lite'; // país por IP, offline (solo se guarda el país, nunca la IP)
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

// Cabeceras de seguridad básicas en todas las respuestas
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
  });
  if (cookieSecure) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

// Límite de peticiones por IP en memoria: frena la fuerza bruta de keys, logins y canjes
function rateLimit({ windowMs, max, onLimit }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of hits) if (entry.reset < now) hits.delete(ip);
  }, windowMs).unref();
  return (req, res, next) => {
    const ip = req.ip || 'unknown';
    const now = Date.now();
    let entry = hits.get(ip);
    if (!entry || entry.reset < now) {
      entry = { count: 0, reset: now + windowMs };
      hits.set(ip, entry);
    }
    entry.count++;
    if (entry.count > max) {
      res.set('Retry-After', String(Math.ceil((entry.reset - now) / 1000)));
      return onLimit(req, res);
    }
    next();
  };
}
const loaderLimit = rateLimit({
  windowMs: 60_000,
  max: 120,
  onLimit: (req, res) => res.type('text/plain').status(429).send('!VANTARMOR:RATE_LIMITED'),
});
const jsonLimit = rateLimit({
  windowMs: 60_000,
  max: 30,
  onLimit: (req, res) => res.status(429).json({ error: 'Demasiadas peticiones. Espera un minuto.' }),
}); // Railway pone la IP real en X-Forwarded-For

// ==========================================
// 0. CONSTANTES Y CONFIGURACIÓN
// ==========================================
const MAX_CODE_BYTES = 2 * 1024 * 1024;           // 2 MB por script
const OBFUSCATORS = ['clyde', 'obscura', 'luau', 'none'];   // Ofuscador 1 (Clyde), Ofuscador 2 (Obscura), Ofuscador 3 (LuaUObfuscator, solo Premium Plus); 'none' = sin ofuscar (solo key)
const KEY_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
// Un error suelto no debe tirar el servidor ni dejar al bot a medias: se registra y el proceso sigue
process.on('unhandledRejection', err => console.error('[Proceso] Promesa sin manejar:', err));
process.on('uncaughtException', err => console.error('[Proceso] Error sin capturar:', err));

const SESSION_COOKIE = 'vantarmor_session';
const STATE_COOKIE = 'oauth_state';

const {
  PORT = 3000,
  DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET,
  DISCORD_REDIRECT_URI,
  JWT_SECRET,
  // En Railway la base va al volumen montado en /data (si no, se pierde en cada deploy)
  DATABASE_PATH = process.env.RAILWAY_ENVIRONMENT ? '/data/vantarmor.db' : 'vantarmor.db',
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
// Diagnóstico de persistencia: /data debe ser un Volume de Railway montado; si no, todo se borra en cada deploy.
if (process.env.RAILWAY_ENVIRONMENT) {
  let dataIsVolume = false;
  try { dataIsVolume = fs.statSync('/data').dev !== fs.statSync('/').dev; } catch { /* /data no existe */ }
  if (dataIsVolume && DATABASE_PATH.startsWith('/data')) {
    console.log(`💾 Base de datos persistente en el volumen: ${DATABASE_PATH}`);
  } else {
    console.warn(`⚠️  Base de datos en ${DATABASE_PATH}. /data ${dataIsVolume ? 'sí' : 'NO'} es un volumen: se borra en cada deploy. En Railway crea un Volume con ruta /data en este servicio.`);
  }
}

if (!JWT_SECRET) console.warn('⚠️  JWT_SECRET no está definido: se usará una clave guardada en la base de datos.');

app.use(express.json({ limit: '6mb' }));          // el default de Express (100 KB) no alcanza para 2 MB
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
  CREATE TABLE IF NOT EXISTS luau_usage (
    user_id TEXT NOT NULL,
    day TEXT NOT NULL,
    n INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day)
  );
  CREATE TABLE IF NOT EXISTS script_bans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    script_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    value TEXT NOT NULL,
    reason TEXT,
    created_at INTEGER,
    UNIQUE (script_id, kind, value)
  );
  CREATE TABLE IF NOT EXISTS scripts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    name TEXT,
    slug TEXT UNIQUE,
    ffa INTEGER,
    content TEXT
  );
  CREATE TABLE IF NOT EXISTS script_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    script_id INTEGER,
    script_name TEXT,
    text TEXT,
    created_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS keys (
    key TEXT PRIMARY KEY,
    script_id INTEGER,
    expires_at INTEGER,
    banned INTEGER DEFAULT 0
  );
`);

// Chat de la comunidad (web): mensajes de los usuarios con sesión
db.exec(`
  CREATE TABLE IF NOT EXISTS web_chat (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_web_chat_created ON web_chat(created_at);
  CREATE TABLE IF NOT EXISTS web_chat_mutes (
    user_id TEXT PRIMARY KEY,
    until INTEGER NOT NULL
  );
`);

// Migraciones: añade columnas nuevas si la base ya existía
{
  const cols = db.prepare('PRAGMA table_info(scripts)').all().map(c => c.name);
  if (!cols.includes('obfuscator')) db.exec('ALTER TABLE scripts ADD COLUMN obfuscator TEXT');
  // Contador de ejecuciones por key (cada key pertenece a un solo script)
  if (!db.prepare("SELECT 1 FROM pragma_table_info('keys') WHERE name = 'exec_count'").get()) db.exec('ALTER TABLE keys ADD COLUMN exec_count INTEGER DEFAULT 0');
  // Avisos por compartir la key (y último aviso, para no contar reintentos del loader)
  if (!db.prepare("SELECT 1 FROM pragma_table_info('keys') WHERE name = 'share_strikes'").get()) db.exec('ALTER TABLE keys ADD COLUMN share_strikes INTEGER DEFAULT 0');
  if (!db.prepare("SELECT 1 FROM pragma_table_info('keys') WHERE name = 'share_last_at'").get()) db.exec('ALTER TABLE keys ADD COLUMN share_last_at INTEGER');
  // Equipo que intentó usar la key por última vez (el dueño puede permitirlo desde el log)
  if (!db.prepare("SELECT 1 FROM pragma_table_info('keys') WHERE name = 'pending_hwid'").get()) db.exec('ALTER TABLE keys ADD COLUMN pending_hwid TEXT');
  // Último HWID vinculado: sobrevive al reinicio de HWID, para detectar compartidas aunque se reinicie
  if (!db.prepare("SELECT 1 FROM pragma_table_info('keys') WHERE name = 'last_hwid'").get()) {
    db.exec('ALTER TABLE keys ADD COLUMN last_hwid TEXT');
    db.exec('UPDATE keys SET last_hwid = hwid WHERE hwid IS NOT NULL');
  }
  // Foto de perfil personalizada (URL). Si es NULL se usa la de Discord.
  if (!db.prepare("SELECT 1 FROM pragma_table_info('users') WHERE name = 'custom_avatar'").get()) db.exec('ALTER TABLE users ADD COLUMN custom_avatar TEXT');
  // Foto del bot solo en los servidores del creador (se aplica desde sus paneles)
  if (!db.prepare("SELECT 1 FROM pragma_table_info('users') WHERE name = 'bot_avatar'").get()) db.exec('ALTER TABLE users ADD COLUMN bot_avatar TEXT');
  // Rol de staff asignado desde el panel admin: 'admin' o 'owner' (NULL = ninguno). Owner real = DISCORD_OWNER_ID
  if (!db.prepare("SELECT 1 FROM pragma_table_info('users') WHERE name = 'staff_role'").get()) db.exec('ALTER TABLE users ADD COLUMN staff_role TEXT');
  if (!db.prepare("SELECT 1 FROM pragma_table_info('users') WHERE name = 'discord_joined'").get()) db.exec('ALTER TABLE users ADD COLUMN discord_joined INTEGER DEFAULT 0');
  if (!db.prepare("SELECT 1 FROM pragma_table_info('keys') WHERE name = 'last_ip'").get()) db.exec('ALTER TABLE keys ADD COLUMN last_ip TEXT');
  db.exec("UPDATE scripts SET obfuscator = 'clyde' WHERE obfuscator = 'clyde_max'");
  // source = código original (nunca se envía al cliente); content = lo que se sirve al loader
  if (!cols.includes('source')) db.exec('ALTER TABLE scripts ADD COLUMN source TEXT');
  if (!cols.includes('hwid_reset_hours')) db.exec('ALTER TABLE scripts ADD COLUMN hwid_reset_hours INTEGER DEFAULT 24');
  // Detección de keys compartidas (1 = activa)
  if (!cols.includes('share_detection')) db.exec('ALTER TABLE scripts ADD COLUMN share_detection INTEGER DEFAULT 1');
  if (!cols.includes('auto_revoke_dump')) db.exec('ALTER TABLE scripts ADD COLUMN auto_revoke_dump INTEGER DEFAULT 0');
  if (!cols.includes('maintenance')) db.exec('ALTER TABLE scripts ADD COLUMN maintenance INTEGER DEFAULT 0');

  // Columnas de keys para el bot y el control de HWID
  const keyCols = db.prepare('PRAGMA table_info(keys)').all().map(c => c.name);
  for (const [col, type] of [['discord_id', 'TEXT'], ['hwid', 'TEXT'], ['hwid_reset_at', 'INTEGER'], ['ban_reason', 'TEXT']]) {
    if (!keyCols.includes(col)) db.exec(`ALTER TABLE keys ADD COLUMN ${col} ${type}`);
  }
}
// Migración: contador de ofuscaciones usadas por usuario
{
  const userCols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  if (!userCols.includes('obf_used')) db.exec('ALTER TABLE users ADD COLUMN obf_used INTEGER DEFAULT 0');
}
ensureBotSchema(db);
// Planes con vencimiento: días de cada key y fecha de vencimiento del plan del usuario
for (const sql of [
  "ALTER TABLE plan_keys ADD COLUMN days INTEGER",
  "ALTER TABLE users ADD COLUMN plan_expires_at INTEGER",
  "ALTER TABLE users ADD COLUMN plan_expired_at INTEGER",
  "ALTER TABLE users ADD COLUMN quota_reset_at INTEGER",
  "ALTER TABLE users ADD COLUMN scripts_period INTEGER DEFAULT 0",
  "ALTER TABLE users ADD COLUMN keys_period INTEGER DEFAULT 0",
  // Los scripts que ya existen conservan la máquina virtual; los nuevos la eligen en el formulario
  "ALTER TABLE scripts ADD COLUMN clyde_vm INTEGER DEFAULT 1",
  "ALTER TABLE scripts ADD COLUMN perf_level TEXT",
  "ALTER TABLE scripts ADD COLUMN loader_id TEXT",
]) { try { db.exec(sql); } catch { /* ya existe */ } }
// Identificador estable del loader: 40 caracteres aleatorios que se crean una vez y no cambian al editar el script
// Diagnóstico de espacio: si el volumen está lleno, SQLite no puede escribir y el servidor no debe caerse en el arranque
try {
  const free = fs.statfsSync(path.dirname(DATABASE_PATH));
  const freeMb = Math.round(Number(free.bavail) * Number(free.bsize) / 1048576);
  const dbMb = Math.round((fs.existsSync(DATABASE_PATH) ? fs.statSync(DATABASE_PATH).size : 0) / 1048576);
  console.log(`[DB] tamaño de la base: ${dbMb} MB · espacio libre en el volumen: ${freeMb} MB`);
  if (freeMb < 50) console.error('[DB] ALERTA: quedan menos de 50 MB libres en el volumen. Aumenta el tamaño del volumen en Railway.');
} catch { /* el diagnóstico nunca detiene el arranque */ }
// Estas escrituras de arranque pueden fallar con el disco lleno: el servidor sigue arrancando y lo avisa en los logs
try {
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS scripts_loader_id ON scripts(loader_id)');
  for (const row of db.prepare('SELECT id FROM scripts WHERE loader_id IS NULL').all()) {
    db.prepare('UPDATE scripts SET loader_id = ? WHERE id = ?').run(crypto.randomBytes(20).toString('hex'), row.id);
  }
} catch (err) {
  console.error('[DB] No se pudo completar la migración de arranque:', err.code || err.message, '· revisa el espacio del volumen.');
}
// Contadores por periodo y cuotas: lógica en lib/quota.js
const quota = createQuota(db);
const resetQuotaIfDue = userId => quota.resetIfDue(userId);
// Un plan pagado cuyo vencimiento ya pasó vuelve a Free y queda marcado para avisar al usuario
const expireAllStmt = db.prepare("UPDATE users SET plan = 'free', plan_expires_at = NULL, plan_expired_at = ? WHERE plan IN ('premium','plus') AND plan_expires_at IS NOT NULL AND plan_expires_at <= ?");
const expireOneStmt = db.prepare("UPDATE users SET plan = 'free', plan_expires_at = NULL, plan_expired_at = ? WHERE id = ? AND plan IN ('premium','plus') AND plan_expires_at IS NOT NULL AND plan_expires_at <= ?");
function expirePlans(userId) {
  const now = Math.floor(Date.now() / 1000);
  if (userId) expireOneStmt.run(now, userId, now); else expireAllStmt.run(now, now);
}
expirePlans();
setInterval(() => expirePlans(), 10 * 60_000);

// Clave de sesión: JWT_SECRET si está definida; si no, una clave generada y guardada en la base de datos.
// Así el login no se rompe en cada deploy mientras la base de datos esté en el volumen.
db.exec('CREATE TABLE IF NOT EXISTS app_settings (name TEXT PRIMARY KEY, value TEXT)');
// Registro de acciones del dueño y ajustes globales (mantenimiento, banner, estado del Ofuscador 3)
// Historial de versiones del código fuente de cada script (las últimas 10 por script)
db.exec('CREATE TABLE IF NOT EXISTS script_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, script_id INTEGER NOT NULL, name TEXT, obfuscator TEXT, ffa INTEGER, source_hash TEXT, source TEXT, created_at INTEGER)');
db.exec('CREATE INDEX IF NOT EXISTS script_versions_by_script ON script_versions(script_id)');
db.exec('CREATE INDEX IF NOT EXISTS scripts_by_user ON scripts(user_id)');
db.exec('CREATE INDEX IF NOT EXISTS keys_by_script ON keys(script_id)');
db.exec('CREATE INDEX IF NOT EXISTS keys_by_discord ON keys(discord_id)');
db.exec('CREATE INDEX IF NOT EXISTS plan_keys_by_user ON plan_keys(used_by)');
function snapshotVersion(scriptId, { name, obfuscator, ffa, source }) {
  const hash = crypto.createHash('sha256').update(String(source ?? '')).digest('hex');
  // Si el código no cambió (solo se editó el nombre o la protección), no se repite la versión
  const last = db.prepare('SELECT source_hash FROM script_versions WHERE script_id = ? ORDER BY id DESC LIMIT 1').get(scriptId);
  if (last?.source_hash === hash) return;
  db.prepare('INSERT INTO script_versions (script_id, name, obfuscator, ffa, source_hash, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(scriptId, String(name ?? ''), String(obfuscator ?? ''), ffa ? 1 : 0, hash, String(source ?? ''), Math.floor(Date.now() / 1000));
  db.prepare('DELETE FROM script_versions WHERE script_id = ? AND id NOT IN (SELECT id FROM script_versions WHERE script_id = ? ORDER BY id DESC LIMIT 10)').run(scriptId, scriptId);
}
// Soporte web: tickets y mensajes (el dueño responde como soporte)
db.exec(`CREATE TABLE IF NOT EXISTS support_tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, username TEXT, category TEXT NOT NULL,
  subject TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', script_id INTEGER, created_at INTEGER, updated_at INTEGER)`);
db.exec(`CREATE TABLE IF NOT EXISTS support_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL, author_id TEXT, is_staff INTEGER DEFAULT 0, body TEXT NOT NULL, created_at INTEGER)`);
db.exec('CREATE INDEX IF NOT EXISTS support_messages_by_ticket ON support_messages(ticket_id)');
db.exec('CREATE TABLE IF NOT EXISTS admin_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT, action TEXT, target TEXT, detail TEXT, created_at INTEGER)');
const appGet = (name, def = '') => db.prepare('SELECT value FROM app_settings WHERE name = ?').get(name)?.value ?? def;
const appSet = (name, value) => db.prepare('INSERT INTO app_settings (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value').run(name, String(value));
const auditLog = (actorId, action, target = '', detail = '') => db.prepare('INSERT INTO admin_audit (actor_id, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?)')
  .run(String(actorId ?? ''), action, String(target).slice(0, 120), String(detail).slice(0, 300), Math.floor(Date.now() / 1000));
const SESSION_SECRET = JWT_SECRET || (() => {
  const row = db.prepare("SELECT value FROM app_settings WHERE name = 'session_secret'").get();
  if (row) return row.value;
  const secret = crypto.randomBytes(48).toString('hex');
  db.prepare("INSERT INTO app_settings (name, value) VALUES ('session_secret', ?)").run(secret);
  return secret;
})();

const keyCapFor = userId => quota.capFor(userId);
// Reserva de keys del periodo (la comparte el bot)
const quotaApi = quota;

const scriptBanStmt = db.prepare('SELECT 1 FROM script_bans WHERE script_id = ? AND kind = ? AND value = ?');
const scriptBanned = (scriptId, kind, value) => Boolean(value) && Boolean(scriptBanStmt.get(scriptId, kind, String(value)));

const stmt = {
  userById: db.prepare('SELECT id, username, avatar, custom_avatar, bot_avatar, plan, obf_used, staff_role, discord_joined, plan_expires_at, plan_expired_at FROM users WHERE id = ?'),
  scriptCount: db.prepare('SELECT COUNT(*) AS n FROM scripts WHERE user_id = ?'),
  obfUsed: db.prepare('SELECT obf_used FROM users WHERE id = ?'),
  obfIncrement: db.prepare('UPDATE users SET obf_used = obf_used + 1 WHERE id = ?'),
  upsertUser: db.prepare(`
    INSERT INTO users (id, username, avatar) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET username = excluded.username, avatar = excluded.avatar
  `),
  // Nunca se seleccionan source ni content aquí
  scriptsByUser: db.prepare(`
    SELECT id, user_id, name, slug, loader_id, ffa, obfuscator, hwid_reset_hours, share_detection, auto_revoke_dump, maintenance, clyde_vm, perf_level FROM scripts
    WHERE user_id = ? ORDER BY id DESC
  `),
  scriptOwned: db.prepare('SELECT * FROM scripts WHERE id = ? AND user_id = ?'),
  scriptInsert: db.prepare(`
    INSERT INTO scripts (user_id, name, slug, ffa, obfuscator, source, content, hwid_reset_hours, share_detection, clyde_vm, auto_revoke_dump)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  scriptUpdate: db.prepare(`
    UPDATE scripts SET name = ?, ffa = ?, obfuscator = ?, source = ?, content = ?, hwid_reset_hours = ?, share_detection = ?, clyde_vm = ?, auto_revoke_dump = ?
    WHERE id = ? AND user_id = ?
  `),
  keysByUser: db.prepare(`
    SELECT k.key, k.script_id, k.expires_at, k.banned, k.hwid, k.discord_id, k.last_ip FROM keys k
    JOIN scripts s ON s.id = k.script_id
    WHERE s.user_id = ?
  `),
  keyInsert: db.prepare('INSERT INTO keys (key, script_id, expires_at) VALUES (?, ?, ?)'),
  slugExists: db.prepare('SELECT 1 FROM scripts WHERE slug = ?'),
  scriptBySlug: db.prepare('SELECT * FROM scripts WHERE slug = ?'),
  scriptByLoaderId: db.prepare('SELECT * FROM scripts WHERE loader_id = ?'),
};

// ==========================================
// 2. FRONTEND (carpeta 'frontend')
// ==========================================
// Páginas con URL limpia (sin .html). Las direcciones antiguas con .html redirigen a la limpia.
const CLEAN_PAGES = {
  '/': 'index.html',
  '/login': 'login.html',
  '/dashboard': 'dashboard.html',
  '/terminos': 'terminos.html',
  '/privacidad': 'privacidad.html',
  '/soporte': 'soporte.html',
  '/errores': 'errores.html',
};
const LEGACY_HTML = /^\/(index|login|dashboard|terminos|privacidad|soporte|errores)\.html$/;
app.use((req, res, next) => {
  const m = LEGACY_HTML.exec(req.path);
  if (!m) return next();
  res.redirect(301, m[1] === 'index' ? '/' : `/${m[1]}`);
});
// Si ya hay sesión, la portada y el login llevan directo al dashboard.
// Va ANTES de servir las páginas (que no miran la sesión).
app.get(['/', '/login'], (req, res, next) => {
  if (getSession(req)) return res.redirect('/dashboard');
  next();
});
app.use(express.static(path.join(__dirname, 'frontend'), { index: false }));
for (const [route, file] of Object.entries(CLEAN_PAGES)) {
  app.get(route, (req, res) => res.sendFile(path.join(__dirname, 'frontend', file)));
}

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
  if (!token) return null;
  try {
    return jwt.verify(token, SESSION_SECRET);
  } catch {
    return null;
  }
}

function requireAuth(req, res, next) {
  const session = getSession(req);
  if (session) { expirePlans(session.id); resetQuotaIfDue(session.id); }
  if (!session) {
    const reason = !req.cookies[SESSION_COOKIE]
      ? 'No hay cookie de sesión en este navegador (¿estás en el mismo dominio que el login?)'
      : 'Sesión inválida o expirada';
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
// Cada cuántas horas puede reiniciarse el HWID (0 = desactivado; /resethwid del creador siempre funciona)
const HWID_RESET_OPTIONS = [0, 6, 12, 24, 48, 72, 168];

// Reinicio de HWID: "Desactivado" (0) es solo para planes pagos; en Free se cambia a 24 h
const isPaidPlanId = userId => { const p = stmt.userById.get(userId)?.plan; return p === 'premium' || p === 'plus'; };
const isPlusPlanId = userId => stmt.userById.get(userId)?.plan === 'plus';
// Ofuscador 3: máximo 2 scripts creados por día (hora de Guayaquil) y por usuario
const LUAU_DAILY_LIMIT = 2;
const luauDay = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' });
const luauUsedStmt = db.prepare('SELECT n FROM luau_usage WHERE user_id = ? AND day = ?');
const luauBumpStmt = db.prepare('INSERT INTO luau_usage (user_id, day, n) VALUES (?, ?, 1) ON CONFLICT(user_id, day) DO UPDATE SET n = n + 1');
const luauUsedToday = userId => luauUsedStmt.get(userId, luauDay())?.n ?? 0;

function validateScriptInput({ name, ffa, obfuscator, code, hwidResetHours, shareDetection, clydeVm, autoRevokeDump }, current = null) {
  const cleanName = name === undefined ? current?.name : String(name).trim();
  if (!cleanName || cleanName.length > 60) return { error: 'Nombre inválido (1 a 60 caracteres)' };

  const isFfa = ffa === undefined ? !!current?.ffa : !!ffa;
  // FFA también se ofusca: el ofuscador se elige igual que en modo protegido
  const obf = obfuscator === undefined ? current?.obfuscator : obfuscator;
  if (!OBFUSCATORS.includes(obf)) return { error: 'Elige un ofuscador válido' };

  const source = code === undefined ? current?.source : code;
  if (typeof source !== 'string' || !source.trim()) return { error: 'Falta el código del script' };
  if (Buffer.byteLength(source) > MAX_CODE_BYTES) return { error: 'El código supera 2 MB' };

  const hwid = hwidResetHours === undefined ? (current?.hwid_reset_hours ?? 24) : Number(hwidResetHours);
  const share = shareDetection === undefined ? (current?.share_detection ?? 1) : (shareDetection ? 1 : 0);
  if (!HWID_RESET_OPTIONS.includes(hwid)) return { error: 'Intervalo de reinicio de HWID inválido' };

  const vm = clydeVm === undefined ? (current?.clyde_vm ?? 1) : (clydeVm ? 1 : 0);
  const autoRevoke = autoRevokeDump === undefined ? (current?.auto_revoke_dump ?? 0) : (autoRevokeDump ? 1 : 0);
  return { name: cleanName, isFfa, obfuscator: obf, source, hwidResetHours: hwid, shareDetection: share, clydeVm: vm, autoRevokeDump: autoRevoke };
}

// ==========================================
// 4. OFUSCACIÓN
// ==========================================
// Ofuscadores reales (CLI locales): Clyde (Node, Luau) y Obscura (Python). El Dockerfile los clona en OBFUSCATOR_DIR (por defecto /opt/obfuscators).
// Se ejecutan sin shell (execFile + argumentos separados) para evitar inyección.
const OBF_DIR = process.env.OBFUSCATOR_DIR || '/opt/obfuscators';
const OBF_TIMEOUT_MS = Number(process.env.OBFUSCATOR_TIMEOUT_MS) || 120_000;

// Busca la carpeta que contiene el archivo de entrada del ofuscador. Así sirve si el repo
// trae el CLI en la raíz o dentro de una subcarpeta (src/, etc.).
function findEntryDir(root, entry, depth = 0) {
  try {
    if (!fs.existsSync(root)) return null;
    if (fs.existsSync(path.join(root, entry))) return root;
    if (depth >= 3) return null;
    for (const d of fs.readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name.startsWith('.')) continue;
      const found = findEntryDir(path.join(root, d.name), entry, depth + 1);
      if (found) return found;
    }
  } catch { /* sin acceso: se considera no instalado */ }
  return null;
}
const OBF_CONFIG = {
  // Ofuscador 1 = Clyde (Node/TypeScript, MIT, Luau). CLI: node dist/cli/obfuscate.js <entrada> -o <salida>
  // Modo VM (--vm). El nivel Máximo se quitó porque no funcionaba al ejecutarse
  clyde: {
    bin: process.execPath,
    dir: findEntryDir(path.join(OBF_DIR, 'clyde'), path.join('dist', 'cli', 'obfuscate.js')),
    // Sin VM: rápido (casi no baja FPS). Con VM: más protección, pero más lento al ejecutarse
    args: (input, out, vm) => [path.join('dist', 'cli', 'obfuscate.js'), input, ...(vm ? ['--vm'] : []), '-o', out],
    output: (input, out) => out,
  },
  // Ofuscador 2 = Obscura (Python, MIT). CLI: python main.py <entrada> -o <salida> --mode lightweight
  obscura: {
    // Obscura usa sintaxis de Python 3.12; el Dockerfile instala ese intérprete
    bin: process.env.OBSCURA_PYTHON || '/opt/obscura-venv/bin/python',
    dir: findEntryDir(path.join(OBF_DIR, 'obscura'), 'main.py'),
    args: (input, out) => ['main.py', input, '-o', out, '--mode', 'lightweight'],
    output: (input, out) => out,
  },
};

// Diagnóstico al arrancar: se ve en los logs de Railway qué ofuscadores están listos
for (const [name, c] of Object.entries(OBF_CONFIG)) {
  console.log(c.dir ? `[Obf] ${name}: listo (${c.dir})` : `[Obf] ${name}: NO encontrado en ${OBF_DIR}`);
}

function runObfuscatorCli(bin, args, cwd, luaPath) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, {
      cwd,
      timeout: OBF_TIMEOUT_MS,
      maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, LUA_PATH: `${cwd}/?.lua;${cwd}/?/init.lua;${luaPath};;` },
    }, (err, stdout, stderr) => {
      if (err) {
        if (err.killed) {
          return reject(Object.assign(new Error('El ofuscador tardó demasiado con este script. Prueba con un script más corto o divídelo.'), { status: 422 }));
        }
        if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          return reject(Object.assign(new Error('La versión ofuscada de este script es demasiado grande. Prueba con un script más corto.'), { status: 422 }));
        }
        const detail = String(stderr || stdout || err.message).slice(0, 500);
        // Error de sintaxis del propio script
        if (/Parsing Error|syntax|unexpected token|expected <|expected/i.test(detail)) {
          return reject(Object.assign(new Error('Tu script tiene sintaxis que el ofuscador no entiende. Revisa que sea Lua/Luau válido o usa Sin ofuscar.'), { status: 422 }));
        }
        return reject(Object.assign(new Error(`El ofuscador falló: ${detail}`), { status: 500 }));
      }
      resolve(stdout);
    });
  });
}

// Ofuscador 3 = LuaUObfuscator (servicio externo, API v1). Solo Premium Plus.
// La key va en LUO_API_KEY (variable de entorno, nunca en el código).
const LUAU_API_BASE = 'https://luauobfuscator.win';
// La API acepta pocas compilaciones a la vez con una misma key: hacemos cola (máx. 2 a la vez)
// y reintentamos si responde 429 (demasiadas solicitudes)
let luauRunning = 0;
const LUAU_MAX_RUNNING = 2;
const delay = ms => new Promise(r => setTimeout(r, ms));
async function luauPost(body, auth) {
  for (let attempt = 1; ; attempt++) {
    while (luauRunning >= LUAU_MAX_RUNNING) await delay(500);
    luauRunning++;
    let res, text;
    try {
      res = await fetch(`${LUAU_API_BASE}/api/v1/obfuscate`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(OBF_TIMEOUT_MS),
      });
      text = await res.text();
    } finally {
      luauRunning--;
    }
    let data = {};
    try { data = JSON.parse(text); } catch { /* no es JSON */ }
    const out = { ok: res.ok, status: res.status, data };
    // Sin créditos no tiene sentido reintentar; solo reintenta la saturación (429 sin "tokens")
    const noTokens = /token/i.test(String(data.error || data.message || text));
    if (res.status !== 429 || noTokens || attempt >= 4) return out;
    await delay(2000 * attempt);
  }
}
async function obfuscateLuau(source) {
  const key = process.env.LUO_API_KEY;
  if (!key) throw Object.assign(new Error('El Ofuscador 3 no está configurado en el servidor.'), { status: 501 });
  const auth = { Authorization: `Bearer ${key}` };

  let r;
  try {
    r = await luauPost({ source, version: 'sun', protection: 'strong', runtime_trace: true }, auth);
  } catch (err) {
    console.warn('[Luau] No se pudo conectar:', err.message);
    throw Object.assign(new Error('No pudimos conectar con el Ofuscador 3. Inténtalo de nuevo.'), { status: 502 });
  }
  const data = r.data;
  if (!r.ok || !data.ok || !data.file?.download_url) {
    const detail = String(data.error || data.message || r.status).slice(0, 300);
    console.warn('[Luau] Error de la API:', r.status, detail);
    appSet('luau_last_error', `${new Date().toISOString()} · ${r.status} · ${detail}`.slice(0, 300));
    if (/token|credit|quota/i.test(detail)) appSet('luau_no_tokens_at', Math.floor(Date.now() / 1000));
    if (/token|credit|quota/i.test(detail)) throw Object.assign(new Error('El Ofuscador 3 se quedó sin créditos. Avisa al dueño para que recargue la cuenta.'), { status: 503 });
    if (r.status === 422 || /syntax|compiler|source/i.test(detail)) {
      throw Object.assign(new Error('Tu script tiene sintaxis que el Ofuscador 3 no entiende. Revisa que sea Luau válido.'), { status: 422 });
    }
    if (r.status === 429) throw Object.assign(new Error('El Ofuscador 3 está ocupado. Espera un momento y vuelve a intentar.'), { status: 503 });
    throw Object.assign(new Error('El Ofuscador 3 falló. Inténtalo de nuevo.'), { status: 502 });
  }

  let out;
  try {
    const dl = await fetch(new URL(data.file.download_url, LUAU_API_BASE), { headers: auth, signal: AbortSignal.timeout(OBF_TIMEOUT_MS) });
    if (!dl.ok) throw new Error(`HTTP ${dl.status}`);
    out = await dl.text();
  } catch (err) {
    console.warn('[Luau] No se pudo descargar el resultado:', err.message);
    throw Object.assign(new Error('El Ofuscador 3 no entregó el resultado. Inténtalo de nuevo.'), { status: 502 });
  }
  if (!out.trim()) throw Object.assign(new Error('El Ofuscador 3 no generó salida. Inténtalo de nuevo.'), { status: 502 });
  appSet('luau_no_tokens_at', '');
  return out;
}

// La tabla debe existir antes de preparar las consultas.
db.exec(`CREATE TABLE IF NOT EXISTS obf_cache (hash TEXT PRIMARY KEY, content TEXT NOT NULL, created_at INTEGER NOT NULL)`);
// Validación de sintaxis Luau con luau-compile (si está instalado en la imagen). Sin el binario, no valida.
const LUAU_COMPILE = process.env.LUAU_COMPILE_BIN || 'luau-compile';
function checkLuauSyntax(code) {
  return new Promise(resolve => {
    const tmp = path.join(os.tmpdir(), `vm-check-${crypto.randomBytes(8).toString('hex')}.lua`);
    try { fs.writeFileSync(tmp, String(code)); } catch { return resolve(null); }
    execFile(LUAU_COMPILE, ['--text', tmp], { timeout: 15_000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      fs.rm(tmp, () => {});
      // Sin binario, timeout o salida demasiado grande: no bloqueamos al creador
      if (!err || err.code === 'ENOENT' || err.killed || err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return resolve(null);
      const msg = String(stderr || stdout || err.message).split('\n').find(l => l.trim()) || 'error de sintaxis';
      resolve(msg.trim().slice(0, 300));
    });
  });
}
const obfCacheGet = db.prepare('SELECT content FROM obf_cache WHERE hash = ?');
const obfCachePut = db.prepare('INSERT OR REPLACE INTO obf_cache (hash, content, created_at) VALUES (?, ?, ?)');
async function obfuscate(source, obfuscator, opts = {}) {
  const hash = crypto.createHash('sha256').update(`${obfuscator}|${opts.vm ? 1 : 0}|${source}`).digest('hex');
  const hit = obfCacheGet.get(hash);
  if (hit) return hit.content;
  const content = await obfuscateUncached(source, obfuscator, opts);
  try { obfCachePut.run(hash, content, Math.floor(Date.now() / 1000)); } catch { /* la caché nunca rompe el guardado */ }
  return content;
}
async function obfuscateUncached(source, obfuscator, opts = {}) {
  if (obfuscator === 'luau') return obfuscateLuau(source);
  const cfg = OBF_CONFIG[obfuscator];
  if (!cfg) throw Object.assign(new Error('Elige un ofuscador válido'), { status: 400 });
  if (!cfg.dir) {
    throw Object.assign(new Error(`Ofuscador no instalado en el servidor (no encuentro su archivo principal dentro de ${OBF_DIR}). Revisa los logs de arranque.`), { status: 501 });
  }

  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vp-obf-'));
  try {
    const input = path.join(dir, 'script.lua');
    const out = path.join(dir, 'out.lua');
    await fs.promises.writeFile(input, source, 'utf8');

    await runObfuscatorCli(cfg.bin, cfg.args(input, out, !!opts.vm), cfg.dir, cfg.dir);

    // Si el CLI guardó con otro nombre, toma el .lua nuevo que haya generado
    let outFile = cfg.output(input, out);
    if (!fs.existsSync(outFile)) {
      const extra = fs.readdirSync(dir).filter(f => /\.luau?$/.test(f) && f !== 'script.lua');
      if (extra.length) outFile = path.join(dir, extra[0]);
    }
    const result = await fs.promises.readFile(outFile, 'utf8').catch(() => '');
    if (!result.trim()) throw Object.assign(new Error('El ofuscador no generó salida. Revisa que el script sea válido para este ofuscador.'), { status: 422 });
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

app.get('/auth/discord/callback', jsonLimit, async (req, res) => {
  const { code, state } = req.query;
  const expectedState = req.cookies[STATE_COOKIE];
  res.clearCookie(STATE_COOKIE);

  if (!code) return res.redirect('/login?error=no_code');
  if (!state || !expectedState || state !== expectedState) return res.redirect('/login?error=state');

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
      return res.redirect('/login?error=token_failed');
    }

    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `${tokenData.token_type} ${tokenData.access_token}` },
    });
    const dUser = await userRes.json();
    if (!userRes.ok || !dUser.id) {
      console.error('User error:', dUser);
      return res.redirect('/login?error=token_failed');
    }

    // Upsert: conserva el plan del usuario al volver a iniciar sesión
    stmt.upsertUser.run(dUser.id, dUser.username, dUser.avatar);

    const session = jwt.sign({ id: dUser.id, username: dUser.username }, SESSION_SECRET, { expiresIn: '7d' });
    res.cookie(SESSION_COOKIE, session, sessionCookieOpts);
    res.redirect('/dashboard');
  } catch (err) {
    console.error('OAuth error:', err);
    res.redirect('/login?error=server');
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
app.post('/api/plan/redeem', requireAuth, jsonLimit, (req, res) => {
  if (maintenanceBlock(req, res)) return;
  const key = String(req.body?.key || '').trim();
  if (key.length < 32 || key.length > 64) return res.status(400).json({ error: 'Key inválida' });

  const row = db.prepare('SELECT * FROM plan_keys WHERE key = ?').get(key);
  if (!row) return res.status(404).json({ error: 'Key de plan inválida' });
  if (row.used_by) return res.status(409).json({ error: 'Esta key ya fue usada' });

  const days = PLAN_DAYS_DEFAULT;
  let expiresAt = null;
  const ok = db.transaction(() => {
    const now = Math.floor(Date.now() / 1000);
    const claimed = db.prepare('UPDATE plan_keys SET used_by = ?, used_at = ? WHERE key = ? AND used_by IS NULL')
      .run(req.userId, now, key);
    if (!claimed.changes) return false;
    const me = stmt.userById.get(req.userId);
    const base = me && me.plan === row.plan && me.plan_expires_at > now ? me.plan_expires_at : now;
    expiresAt = base + days * 86400;
    db.prepare('UPDATE users SET plan = ?, plan_expires_at = ?, plan_expired_at = NULL WHERE id = ?').run(row.plan, expiresAt, req.userId);
    return true;
  })();
  if (!ok) return res.status(409).json({ error: 'Esta key ya fue usada' });

  res.json({ ok: true, plan: row.plan, expires_at: expiresAt });
});

// "Seguir con Free": el usuario decide quedarse en Free y se quita el aviso de vencimiento
app.post('/api/plan/stay-free', requireAuth, (req, res) => {
  db.prepare("UPDATE users SET plan = 'free', plan_expires_at = NULL, plan_expired_at = NULL WHERE id = ?").run(req.userId);
  res.json({ ok: true });
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
// JS mínimo para el botón Copiar. La CSP solo permite este script exacto (por hash).
const LOADER_COPY_JS = "document.getElementById('copy').addEventListener('click',function(){var b=this;navigator.clipboard.writeText(document.getElementById('code').innerText).then(function(){b.textContent='Copiado ✓';setTimeout(function(){b.textContent='Copiar'},1600)})});";
const LOADER_CSP = `default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${crypto.createHash('sha256').update(LOADER_COPY_JS).digest('base64')}'`;

// URL pública del loader: la nueva (con .lua) si el script ya tiene loader_id; si no, la de siempre
const loaderPath = s => (s.loader_id ? `/files/v1/loaders/${s.loader_id}.lua` : `/scripts/hosted/${s.slug}`);
function loaderPage(script) {
  const url = `${APP_URL}${loaderPath(script)}`;
  const ffa = !!script.ffa;
  // Solo el loader: nada del código del script. FFA no necesita key.
  const lines = [
    ...(ffa ? [] : ['<span class="k">script_key</span> = <span class="s">"KEY"</span>']),
    `<span class="f">loadstring</span>(game:HttpGet(<span class="s">"${escHtml(url)}"</span>))()`,
  ];
  const name = escHtml(script.name);
  const steps = [
    'Copia el loader',
    'Pégalo en tu executor',
    ...(ffa ? [] : ['Reemplaza <b>KEY</b> por tu key']),
  ];
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${name} · Vantarmor</title>
<style>
:root{--bg:#08080a;--panel:#121216;--panel-2:#1a1a20;--border:#26262e;--text:#f5f5f8;--text-dim:#a8a8b4;--muted:#6e6e78;--silver-1:#f5f5f8;--silver-2:#d0d0d8;--silver-3:#a0a0ac;--ok:#4ade80}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%;background:var(--bg);color:var(--text);font-family:Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased;line-height:1.55}
body{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:32px 16px;overflow-x:hidden;
  background:radial-gradient(ellipse 70% 45% at 50% -5%,rgba(224,224,232,.09),transparent 70%),var(--bg)}
.wrap{width:100%;max-width:640px}
.brand{display:flex;align-items:center;gap:10px;margin:0 0 18px 2px;font-weight:900;letter-spacing:.16em;font-size:12px;color:var(--text-dim)}
.logo{width:24px;height:24px;border-radius:7px;display:grid;place-items:center;background:linear-gradient(135deg,var(--silver-1) 0%,var(--silver-2) 45%,var(--silver-3) 100%)}
.logo svg{width:14px;height:14px;stroke:#08080a;fill:none;stroke-width:2.4}
.card{background:linear-gradient(180deg,var(--panel-2),var(--panel)) ;border:1px solid var(--border);border-radius:18px;overflow:hidden;box-shadow:0 30px 70px -30px rgba(0,0,0,.8)}
.head{padding:26px 26px 22px;border-bottom:1px solid var(--border)}
.eyebrow{margin:0 0 8px;font-size:11px;font-weight:800;letter-spacing:.2em;color:var(--muted);text-transform:uppercase}
.title{margin:0;display:flex;align-items:center;gap:12px;flex-wrap:wrap;font-size:24px;font-weight:900;letter-spacing:-.02em;line-height:1.2;overflow-wrap:anywhere}
.badge{font-size:10px;font-weight:800;letter-spacing:.12em;padding:4px 9px;border-radius:6px;white-space:nowrap}
.badge.ok{color:var(--ok);background:rgba(74,222,128,.10);border:1px solid rgba(74,222,128,.25)}
.badge.p{color:var(--text-dim);background:rgba(255,255,255,.04);border:1px solid var(--border)}
.steps{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin:20px 0 0;padding:0;list-style:none}
.steps li{display:flex;align-items:center;gap:10px;font-size:13px;color:var(--text-dim)}
.n{width:24px;height:24px;border-radius:50%;display:grid;place-items:center;flex:none;font-size:11px;font-weight:800;color:#08080a;background:linear-gradient(135deg,var(--silver-1),var(--silver-3))}
.steps b{color:var(--text)}
.bar{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 14px 12px 22px;border-bottom:1px solid var(--border);font-size:12px;color:var(--muted)}
.bar code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--text-dim)}
button.copy{font:inherit;font-size:13px;font-weight:800;color:#08080a;background:linear-gradient(135deg,var(--silver-1) 0%,var(--silver-2) 50%,var(--silver-3) 100%);border:0;border-radius:10px;padding:8px 16px;cursor:pointer;transition:transform .15s,box-shadow .2s;white-space:nowrap}
button.copy:hover{transform:translateY(-1px);box-shadow:0 8px 18px -8px rgba(224,224,232,.5)}
button.copy:active{transform:scale(.97)}
button.copy:focus-visible{outline:2px solid var(--silver-1);outline-offset:3px}
pre{margin:0;padding:22px 24px;background:#040407;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13.5px;line-height:1.85;white-space:pre-wrap;word-break:break-all;color:#d6d6e0;user-select:text;-webkit-user-select:text}
.k{color:#c9cbd6}.s{color:#9fd8b6}.f{color:#b8c4e8}
.foot{display:flex;align-items:center;gap:10px;padding:14px 22px;border-top:1px solid var(--border);color:var(--muted);font-size:12px;line-height:1.5}
.foot svg{width:14px;height:14px;flex:none;stroke:var(--muted);fill:none;stroke-width:2}
.legal{margin:18px 2px 0;font-size:12px;color:var(--muted);text-align:center}
.legal a{color:var(--text-dim);text-decoration:none}
.legal a:hover{color:var(--text)}
@media (max-width:560px){.head{padding:20px 18px 18px}.title{font-size:20px}.bar{padding-left:18px}pre{font-size:12.5px;padding:18px}.foot{padding:14px 18px}}
</style>
</head>
<body>
<main class="wrap">
  <div class="brand"><span class="logo"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2 4 5.5v6c0 5 3.4 9.2 8 10.5 4.6-1.3 8-5.5 8-10.5v-6z"/></svg></span>VANTARMOR</div>
  <section class="card" aria-labelledby="scriptTitle">
    <header class="head">
      <p class="eyebrow">Loader</p>
      <h1 class="title" id="scriptTitle">${name}<span class="badge ${ffa ? 'ok' : 'p'}">${ffa ? 'FFA · LIBRE' : 'PROTEGIDO'}</span></h1>
      <ol class="steps">
        ${steps.map((t, i) => `<li><span class="n">${i + 1}</span><span>${t}</span></li>`).join('')}
      </ol>
    </header>
    <div class="bar"><code>loadstring</code><button class="copy" id="copy" type="button">Copiar</button></div>
    <pre id="code">${lines.join('\n')}</pre>
    <footer class="foot">
      <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>
      <span>El código del script solo se entrega al ejecutarlo con una key válida.</span>
    </footer>
  </section>
  <p class="legal"><a href="/terminos">Términos</a> · <a href="/privacidad">Privacidad</a></p>
</main>
<script>${LOADER_COPY_JS}</script>
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
local HEAD = "[ VANTARMOR ]\\n"
local MSG = {
  KEY_REQUIRED = HEAD .. "A valid key is required.",
  KEY_INVALID = HEAD .. "The key is not valid.",
  KEY_EXPIRED = HEAD .. "Your key has expired.",
  NOT_AUTHORIZED = HEAD .. "You are not authorized to run this script.",
  HWID_MISMATCH = HEAD .. "This key is linked to another device.",
  VERIFY_FAILED = HEAD .. "Verification failed. Please rejoin.",
  CONNECTION_FAILED = HEAD .. "Connection failed. Please try again.",
  TAMPERING = HEAD .. "Tampering detected.",
  SCRIPT_NOT_FOUND = HEAD .. "Script not found.",
  REAUTH = HEAD .. "Please re-authenticate.",
  BLACKLISTED = HEAD .. "Access denied.",
  MAINTENANCE = HEAD .. "This script is under maintenance.\\nPlease try again in a few minutes.",
  MAINTENANCE_ALL = HEAD .. "Vantarmor is under maintenance.\\nPlease try again in a few minutes.",
  SERVER_UNREACHABLE = HEAD .. "Server unreachable. Please try later.",
  PAYLOAD_LOAD_FAILED = HEAD .. "The script could not be loaded by your executor.\\nPlease contact the script owner.",
}
local Players = game:GetService("Players")
local function kick(code)
  local msg = MSG[code] or MSG.VERIFY_FAILED
  local lp = Players.LocalPlayer
  if lp then lp:Kick(msg) end
  error(msg, 0)
end
-- Si loadstring fue reemplazado por una función de Lua (un volcador que intercepta el código), se corta
local function nativeFn(f)
  if type(f) ~= "function" then return false end
  local okI, info = pcall(function() return debug.getinfo(f, "S") end)
  return not (okI and type(info) == "table" and info.what ~= "C")
end
local function loaderTampered()
  -- loadstring es la vía del payload; load también puede usarse para volcar, así que se revisan los dos
  if not nativeFn(loadstring) then return true end
  if type(load) == "function" and not nativeFn(load) then return true end
  return false
end
local key = ""
if type(script_key) == "string" then key = (script_key:gsub("^%s+", ""):gsub("%s+$", "")) end
if key == "" and not FFA then kick("KEY_REQUIRED") end
local function enc(s) return (s:gsub("[^%w%-_%.~]", function(c) return string.format("%%%02X", string.byte(c)) end)) end
local hwid = ""
local okh, h = pcall(function() return game:GetService("RbxAnalyticsService"):GetClientId() end)
if okh and h then hwid = h end
local rbxid = ""
local okr, rid = pcall(function() return tostring(Players.LocalPlayer.UserId) end)
if okr and rid then rbxid = rid end
-- Detector de dump por tiempo y frames: si el reloj o el Heartbeat están congelados, se reporta como volcado
local detections = 0
local function runDetectors()
  local ok = pcall(function()
    local a = tonumber(os.date("%S"))
    task.wait(1.1)
    local b = tonumber(os.date("%S"))
    if not a or not b or a == b then detections += 1 end
    local hits = 0
    local conn = game:GetService("RunService").Heartbeat:Connect(function() hits += 1 end)
    local t0 = os.clock()
    repeat task.wait() until hits >= 2 or os.clock() - t0 > 2
    conn:Disconnect()
    if hits < 2 then detections += 1 end
  end)
  -- Si el propio detector falla no se castiga al jugador (evita falsos positivos en ejecutores raros)
  return ok
end
runDetectors()
if detections > 0 then
  pcall(function() game:HttpGet(AUTH_URL .. "?key=" .. enc(key) .. "&hwid=" .. enc(hwid) .. "&rbxid=" .. enc(rbxid) .. "&tamper=1") end)
  script_key = nil
  kick("TAMPERING")
end
-- Detector de entorno (hooks, metatables, integridad del runtime). Devuelve 109 si todo está limpio.
local function envProbeRun()
  local _ef = 0
  pcall(function()
    local _t, _p, _rg, _rs, _re = type, pcall, rawget, rawset, rawequal
    if _t(game) ~= "userdata" or _t(Enum) ~= "userdata" then return end
    if _VERSION ~= "Luau" then return end
    local _n = 0 / 0
    if _n == _n then return end
    if _t(math) ~= "table" or _t(string) ~= "table" then return end
    if _t(bit32) == "table" and bit32.bxor and bit32.bxor(0xA5A5, 0xA5A5) ~= 0 then return end
    if math.floor(1.9) ~= 1 then return end
    if string.byte("Z") ~= 90 then return end
    local _slot = {}
    local _mk = function() end
    if not _p(_rs, _slot, 0x2BAD, _mk) then return end
    if not _re(_rg(_slot, 0x2BAD), _mk) then return end
    _rs(_slot, 0x2BAD, nil)
    if _rg(_slot, 0x2BAD) ~= nil then return end
    local function _dec(_tb, _k)
      local _r = {}
      for _i = 1, #_tb do
        local _ki = (_k * ((_i % 11) + 1) + _i * 7 + (_k % 31)) % 256
        _r[_i] = string.char((_tb[_i] - _ki + 512) % 256)
      end
      return table.concat(_r)
    end
    -- Sonda de Tween con tiempo máximo (no se queda esperando si el Tween nunca termina)
    pcall(function()
      local _tw = _dec({
        (797217 - 796977), (-651497 + 651720), (192857 + (-192704)), (269712 - 269611),
        (226643 - 226585), (379280 - 379045), (435962 + (-435761)), (882599 + (-882437)),
        (287161 + (-287047)), (-770111 + 770160), (-774263 + 774391), (-845570 + 845648)
      }, 197)
      local _fr = Instance.new("Frame")
      local _c = 0
      _fr:GetPropertyChangedSignal("Position"):Connect(function() _c = _c + 1 end)
      local _ts = game:GetService(_tw)
      local _tn = _ts:Create(_fr, TweenInfo.new(0.01), { Position = UDim2.new(1, 0, 1, 0) })
      local _done = false
      _tn.Completed:Connect(function() _done = true end)
      _tn:Play()
      local _t0 = os.clock()
      repeat task.wait() until _done or os.clock() - _t0 > 2
      _fr:Destroy()
    end)
    -- Sonda de FPS
    pcall(function()
      local _ws = _dec({
        (896050 - 895799), (793030 + (-792931)), (234421 - 234239), (-742994 + 743249),
        (-132469 + 132556), (320775 - 320611), (497771 + (-497542)), (947677 + (-947622)),
        (-380387 + 380524)
      }, 73)
      game:GetService(_ws):GetRealPhysicsFPS()
    end)
    -- Funciones de hook del ejecutor: si aparecen, no se cuenta como limpio
    local _okE, _f = _p(function()
      return getfenv and getfenv(0) or getgenv and getgenv() or {}
    end)
    if _okE and _t(_f) == "table" then
      for _, _nm in ipairs({ "hookfunction", "hookmetamethod", "hookm", "replaceclosure", "getgc" }) do
        if _rg(_f, _nm) ~= nil then return end
      end
    end
    -- Integridad de la metatable de game (suave)
    pcall(function()
      if not getrawmetatable then return end
      local _s, _mt = _p(getrawmetatable, game)
      if _s and _t(_mt) == "table" then
        if _rg(_mt, "__index") == nil and _rg(_mt, "__namecall") == nil then return end
      end
    end)
    _ef = 109
  end)
  return _ef
end
local envScore = envProbeRun()
if envScore ~= 109 then
  pcall(function() game:HttpGet(AUTH_URL .. "?key=" .. enc(key) .. "&hwid=" .. enc(hwid) .. "&rbxid=" .. enc(rbxid) .. "&tamper=1") end)
  script_key = nil
  kick("TAMPERING")
end
-- Si loadstring fue interceptado: se avisa al servidor (dueño) y se corta antes de validar la key
if loaderTampered() then
  pcall(function() game:HttpGet(AUTH_URL .. "?key=" .. enc(key) .. "&hwid=" .. enc(hwid) .. "&rbxid=" .. enc(rbxid) .. "&tamper=1") end)
  script_key = nil
  kick("TAMPERING")
end
local ok, body = pcall(function() return game:HttpGet(AUTH_URL .. "?key=" .. enc(key) .. "&hwid=" .. enc(hwid) .. "&rbxid=" .. enc(rbxid)) end)
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
if loaderTampered() then kick("TAMPERING") end
local fn = loadstring(payload)
if not fn then kick("PAYLOAD_LOAD_FAILED") end
fn()
`;
}

// Página pública: el navegador ve solo el snippet (solo lectura); el ejecutor recibe el bootstrap.
app.get('/scripts/hosted/:slug', (req, res) => {
  if (/text\/html/.test(req.get('accept') || '')) {
    const script = stmt.scriptBySlug.get(req.params.slug);
    if (!script) return res.status(404).type('text/plain').send('-- script no encontrado');
    return res.set({ ...PAGE_HEADERS, 'Content-Security-Policy': LOADER_CSP }).type('html').send(loaderPage(script));
  }
  const script = stmt.scriptBySlug.get(req.params.slug);
  res.type('text/plain').send(loaderBootstrap(req.params.slug, !!(script && script.ffa)));
});

// Loader con URL de archivo: /files/v1/loaders/<loader_id>.lua (mismo contenido que /scripts/hosted/<slug>)
app.get('/files/v1/loaders/:file', (req, res) => {
  const m = /^([0-9a-f]{40})\.lua$/.exec(req.params.file);
  const script = m ? stmt.scriptByLoaderId.get(m[1]) : null;
  if (!script) return res.status(404).type('text/plain').send('-- script no encontrado');
  if (/text\/html/.test(req.get('accept') || '')) {
    return res.set({ ...PAGE_HEADERS, 'Content-Security-Policy': LOADER_CSP }).type('html').send(loaderPage(script));
  }
  res.type('text/plain').send(loaderBootstrap(script.slug, !!script.ffa));
});

// Tokens de un solo uso para entregar el código: /auth los emite, /payload los consume.
// Registro de usos del loader en el canal de logs del creador (el bot se asigna al arrancar)
let discordBot = null;
// Plan Free: para crear scripts debe unirse a nuestro servidor de Discord (una sola vez)
const DISCORD_JOIN_URL = 'https://discord.gg/FUjbTN69';
function discordJoinDone(userId) {
  return isPaidPlanId(userId) || Boolean(stmt.userById.get(userId)?.discord_joined);
}
// Conteo diario de ejecuciones por script (hora de Ecuador). Las gráficas leen de aquí,
// así que borrar los logs viejos no afecta a las estadísticas.
// Caché de ofuscación: mismo código y mismo modo = mismo resultado, sin volver a ofuscar (ni gastar créditos)
db.exec(`CREATE TABLE IF NOT EXISTS execution_daily (script_id INTEGER NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (script_id, day))`);
// Primera vez: se rellena con lo que quedaba en los logs
if (!db.prepare('SELECT 1 FROM execution_daily LIMIT 1').get()) {
  db.exec(`INSERT OR IGNORE INTO execution_daily (script_id, day, n)
    SELECT script_id, strftime('%Y-%m-%d', created_at, 'unixepoch', '-5 hours'), COUNT(*) FROM script_logs
    WHERE text LIKE '%Script ejecutado%' GROUP BY script_id, strftime('%Y-%m-%d', created_at, 'unixepoch', '-5 hours')`);
}
const ecuadorDay = ms => new Date(ms - 5 * 3600_000).toISOString().slice(0, 10);
const countExecutionStmt = db.prepare(`INSERT INTO execution_daily (script_id, day, n) VALUES (?, ?, 1)
  ON CONFLICT(script_id, day) DO UPDATE SET n = n + 1`);
// Conteo por país: (dueño del script, día, país). Solo guarda el código de país, nunca la IP.
db.exec(`CREATE TABLE IF NOT EXISTS execution_country (user_id TEXT NOT NULL, day TEXT NOT NULL, country TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, day, country))`);
const countryStmt = db.prepare(`INSERT INTO execution_country (user_id, day, country, n) VALUES (?, ?, ?, 1)
  ON CONFLICT(user_id, day, country) DO UPDATE SET n = n + 1`);
db.exec(`CREATE TABLE IF NOT EXISTS execution_hourly (script_id INTEGER NOT NULL, day TEXT NOT NULL, hour INTEGER NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (script_id, day, hour))`);
const hourlyStmt = db.prepare(`INSERT INTO execution_hourly (script_id, day, hour, n) VALUES (?, ?, ?, 1)
  ON CONFLICT(script_id, day, hour) DO UPDATE SET n = n + 1`);
db.exec(`CREATE TABLE IF NOT EXISTS execution_script_country (script_id INTEGER NOT NULL, day TEXT NOT NULL, country TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (script_id, day, country))`);
const scriptCountryStmt = db.prepare(`INSERT INTO execution_script_country (script_id, day, country, n) VALUES (?, ?, ?, 1)
  ON CONFLICT(script_id, day, country) DO UPDATE SET n = n + 1`);
const countryOf = ip => { try { return geoip.lookup(String(ip || ''))?.country || null; } catch { return null; } };
const countExecution = (scriptId, ip, userId) => {
  try {
    countExecutionStmt.run(scriptId, ecuadorDay(Date.now()));
    const nowMs = Date.now();
    hourlyStmt.run(scriptId, ecuadorDay(nowMs), new Date(nowMs - 5 * 3600_000).getUTCHours());
    const country = countryOf(ip);
    if (country && userId) countryStmt.run(String(userId), ecuadorDay(Date.now()), country);
    if (country) scriptCountryStmt.run(scriptId, ecuadorDay(Date.now()), country);
  } catch { /* las estadísticas nunca rompen el loader */ }
};

const logUse = (scriptId, text, userId = null, opts = {}) => { try { discordBot?.logScriptEvent?.(scriptId, text, userId, opts); } catch { /* el log nunca rompe el loader */ } };

// Nombre y foto de avatar de un usuario de Roblox (caché 1 h; si Roblox no responde, queda vacío)
const robloxCache = new Map();
db.exec('CREATE TABLE IF NOT EXISTS roblox_cache (user_id TEXT PRIMARY KEY, name TEXT, avatar TEXT, updated_at INTEGER)');
const robloxRowStmt = db.prepare('SELECT name, avatar, updated_at FROM roblox_cache WHERE user_id = ?');
const robloxSaveStmt = db.prepare(`INSERT INTO roblox_cache (user_id, name, avatar, updated_at) VALUES (?, ?, ?, ?)
  ON CONFLICT(user_id) DO UPDATE SET name = excluded.name, avatar = excluded.avatar, updated_at = excluded.updated_at`);
async function robloxInfo(userId) {
  const hit = robloxCache.get(userId);
  if (hit && hit.exp > Date.now()) return hit.value;
  const t = Math.floor(Date.now() / 1000);
  // Base de datos: sobrevive a reinicios. Con foto vale una hora; sin foto se vuelve a consultar pronto
  const saved = robloxRowStmt.get(userId);
  if (saved && saved.avatar && saved.updated_at > t - 3600) {
    const value = { name: saved.name, avatar: saved.avatar };
    robloxCache.set(userId, { value, exp: Date.now() + 3600_000 });
    return value;
  }
  const getJson = url => fetch(url, { signal: AbortSignal.timeout(4000) }).then(r => (r.ok ? r.json() : null)).catch(() => null);
  const load = async () => {
    const [u, th] = await Promise.all([
      getJson(`https://users.roblox.com/v1/users/${userId}`),
      getJson(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png&isCircular=false`),
    ]);
    const avatar = th?.data?.[0]?.imageUrl;
    return { name: u?.name || null, avatar: typeof avatar === 'string' && avatar.startsWith('https://') ? avatar : null };
  };
  let value = await load();
  // Roblox genera la miniatura la primera vez y responde sin imagen mientras tanto: se reintenta una vez
  if (!value.avatar) { await new Promise(r => setTimeout(r, 2500)); value = await load(); }
  if (value.name || value.avatar) {
    try { robloxSaveStmt.run(userId, value.name, value.avatar, t); } catch { /* la caché nunca rompe el log */ }
  }
  if (robloxCache.size > 5000) robloxCache.clear();
  robloxCache.set(userId, { value, exp: Date.now() + (value.avatar ? 3600_000 : 60_000) });
  return value;
}
// Registro de ejecución con la línea de Roblox (nombre + ID) y la foto de avatar como miniatura.
// No espera a Roblox para responderle al loader.
function logWithRoblox(scriptId, lines, userId, rbxid) {
  if (!rbxid) return logUse(scriptId, [...lines, '• Roblox: sin dato'].join('\n'), userId);
  robloxInfo(rbxid)
    .then(rbx => logUse(scriptId, [...lines, `• Roblox: ${rbx.name ? `${rbx.name} · ` : ''}\`${rbxid}\``].join('\n'), userId, { thumbnail: rbx.avatar }))
    .catch(() => logUse(scriptId, [...lines, `• Roblox: \`${rbxid}\``].join('\n'), userId));
}

const payloadTokens = new Map(); // token -> { scriptId, expires }
const PAYLOAD_TTL_MS = 30_000;
setInterval(() => {
  const now = Date.now();
  for (const [t, v] of payloadTokens) if (v.expires < now) payloadTokens.delete(t);
}, 60_000).unref();
function issuePayloadToken(scriptId, ip) {
  const token = crypto.randomBytes(24).toString('hex');
  payloadTokens.set(token, { scriptId, ip: ip || null, expires: Date.now() + PAYLOAD_TTL_MS });
  return token;
}

// Entrega el código con un token válido. El token se gasta aunque falle.
app.get('/scripts/hosted/:slug/payload', loaderLimit, (req, res) => {
  if (/text\/html/.test(req.get('accept') || '')) return res.status(403).type('text/plain').send('!VANTARMOR:FORBIDDEN');
  const token = String(req.query.token || '');
  const entry = payloadTokens.get(token);
  payloadTokens.delete(token);
  const script = stmt.scriptBySlug.get(req.params.slug);
  // El token vale solo para la IP que hizo el login, una vez y 30 s
  if (!entry || entry.expires < Date.now() || !script || script.id !== entry.scriptId || entry.ip !== (req.ip || null)) {
    return res.status(403).type('text/plain').send('!VANTARMOR:TOKEN_INVALID');
  }
  res.type('text/plain').send(script.content);
});

// Endpoint de verificación: lo llama el bootstrap. Responde el código del script o "!VANTARMOR:CODIGO".
// Key usada desde otro equipo. Cada aviso cuenta como máximo una vez cada 10 minutos (un reintento del loader no suma).
// 1.er aviso: privado al dueño de la key. 2.º: aviso fuerte. 3.er: la key se elimina y el usuario queda bloqueado en ese script.
const SHARE_COOLDOWN_S = 600;
function reportKeyShare(script, k, hwid, reply) {
  db.prepare('UPDATE keys SET pending_hwid = ? WHERE key = ?').run(hwid, k.key);
  fireWebhooks(script.user_id, 'key.shared', { key: k.key, scriptId: script.id, hwid });
  if (script.share_detection === 0) return reply('HWID_MISMATCH');
  const nowS = Math.floor(Date.now() / 1000);
  const boundHwid = k.hwid || k.last_hwid;
  const row = db.prepare(`UPDATE keys SET share_strikes = COALESCE(share_strikes, 0) + 1, share_last_at = ?
    WHERE key = ? AND (share_last_at IS NULL OR share_last_at < ?) RETURNING share_strikes`)
    .get(nowS, k.key, nowS - SHARE_COOLDOWN_S);
  if (!row) return reply('HWID_MISMATCH');
  const strikes = row.share_strikes;
  const removed = strikes >= 3;
  if (removed) {
    db.prepare('DELETE FROM keys WHERE key = ?').run(k.key);
    if (k.discord_id) {
      db.prepare('INSERT OR REPLACE INTO bot_blacklist (script_id, discord_id, reason, created_at) VALUES (?, ?, ?, ?)')
        .run(script.id, k.discord_id, 'Key compartida (3 avisos)', nowS);
    }
  }
  discordBot?.notifyKeyShare?.({ scriptId: script.id, key: k.key, discordId: k.discord_id, strikes, removed, hwid, boundHwid });
  return reply(removed ? 'KEY_INVALID' : 'HWID_MISMATCH');
}

const tamperSeen = new Map(); // antispam de avisos de volcado
app.get('/scripts/hosted/:slug/auth', loaderLimit, (req, res) => {
  // Los navegadores no reciben nunca el código
  if (/text\/html/.test(req.get('accept') || '')) return res.status(403).type('text/plain').send('!VANTARMOR:FORBIDDEN');
  const reply = code => res.type('text/plain').send(`!VANTARMOR:${code}`);

  const script = stmt.scriptBySlug.get(req.params.slug);
  if (!script) return reply('SCRIPT_NOT_FOUND');
  if (maintenanceAllOn() && !isOwnerId(script.user_id)) return reply('MAINTENANCE_ALL');
  if (script.maintenance) return reply('MAINTENANCE');
  // ID de Roblox de quien ejecuta (lo manda el loader desde el juego; vacío si no llegó)
  const rbxid = /^\d{1,20}$/.test(String(req.query.rbxid || '')) ? String(req.query.rbxid) : '';
  // El loader avisa cuando loadstring fue interceptado (volcado). Solo avisa al dueño: no banea.
  if (req.query.tamper === '1') {
    const tKey = String(req.query.key || '').trim().slice(0, 64);
    const tHwid = /^[\x21-\x7E]{8,128}$/.test(String(req.query.hwid || '')) ? String(req.query.hwid) : '';
    const keyRow = tKey ? db.prepare('SELECT discord_id FROM keys WHERE key = ? AND script_id = ?').get(tKey, script.id) : null;
    const tDiscord = keyRow?.discord_id || null;
    // Revocación automática (opción del script): la key queda baneada sin esperar al dueño
    const autoRevoked = Boolean(script.auto_revoke_dump && keyRow && tKey
      && db.prepare("UPDATE keys SET banned = 1, ban_reason = 'Volcado detectado' WHERE key = ? AND script_id = ?").run(tKey, script.id).changes);
    const seenKey = `${script.id}|${tKey}|${tHwid}`;
    const last = tamperSeen.get(seenKey) || 0;
    if (Date.now() - last > 10 * 60 * 1000) { // un aviso cada 10 min por key y HWID
      tamperSeen.set(seenKey, Date.now());
      logWithRoblox(script.id, [
        '🚨 Intento de dump: loadstring fue interceptado',
        `• Key: \`${tKey || 'sin key'}\``,
        `• HWID: \`${tHwid || 'sin dato'}\``,
        `• Discord: ${tDiscord ? `<@${tDiscord}>` : 'sin vincular'}`,
      ], tDiscord, rbxid);
      discordBot?.notifyTamper?.({ scriptId: script.id, key: tKey, hwid: tHwid, rbxid, discordId: tDiscord, autoRevoked });
      fireWebhooks(script.user_id, 'script.tamper', { scriptId: script.id, key: tKey, hwid: tHwid, rbxid, autoRevoked });
    }
    return reply('TAMPERING');
  }
  if (script.ffa) {
    const ffaHwid = String(req.query.hwid || '').slice(0, 128);
    countExecution(script.id, req.ip, script.user_id);
    logWithRoblox(script.id, [
      '🟢 Script ejecutado (FFA)',
      `• HWID: \`${/^[\x21-\x7E]{8,128}$/.test(ffaHwid) ? ffaHwid : 'sin dato'}\``,
      `• ID del script: \`${script.loader_id || script.id}\``,
    ], null, rbxid);
    return reply(`OK:${issuePayloadToken(script.id, req.ip)}`);
  }

  const key = String(req.query.key || '').trim().slice(0, 64);
  const rawHwid = String(req.query.hwid || '').slice(0, 128);
  // Solo caracteres imprimibles (sin espacios ni control): evita basura y texto que rompa los logs
  const hwid = /^[\x21-\x7E]{8,128}$/.test(rawHwid) ? rawHwid : '';
  if (!key) return reply('KEY_REQUIRED');
  if (scriptBanned(script.id, 'ip', req.ip)) return reply('BLACKLISTED');
  const k = db.prepare('SELECT * FROM keys WHERE key = ? AND script_id = ?').get(key, script.id);
  if (!k) return reply('KEY_INVALID');
  if (k.banned) return reply('BLACKLISTED');
  if (k.expires_at && k.expires_at * 1000 < Date.now()) return reply('KEY_EXPIRED');
  if (k.discord_id && db.prepare('SELECT 1 FROM bot_blacklist WHERE script_id = ? AND discord_id = ?').get(script.id, k.discord_id)) {
    return reply('BLACKLISTED');
  }
  if (!hwid) return reply('VERIFY_FAILED');
  if (scriptBanned(script.id, 'hwid', hwid)) return reply('BLACKLISTED');
  // Tras reiniciar el HWID la key queda sin equipo: si el HWID nuevo no es el último vinculado, cuenta como compartida
  if (!k.hwid && k.last_hwid && k.last_hwid !== hwid && script.share_detection !== 0) return reportKeyShare(script, k, hwid, reply);
  if (!k.hwid) {
    // Vinculación atómica: si otro equipo la vinculó al mismo tiempo, esta petición no la sobrescribe
    const bound = db.prepare('UPDATE keys SET hwid = ?, last_hwid = ? WHERE key = ? AND hwid IS NULL').run(hwid, hwid, key);
    if (!bound.changes) {
      const current = db.prepare('SELECT hwid FROM keys WHERE key = ?').get(key);
      if (!current) return reply('KEY_INVALID');
      if (current.hwid !== hwid) return reportKeyShare(script, k, hwid, reply);
    }
  } else if (k.hwid !== hwid) return reportKeyShare(script, k, hwid, reply);
  const run = db.prepare('UPDATE keys SET last_ip = ?, exec_count = COALESCE(exec_count, 0) + 1 WHERE key = ? RETURNING exec_count')
    .get(req.ip || null, key);
  countExecution(script.id, req.ip, script.user_id);
  logWithRoblox(script.id, [
    '🟢 Script ejecutado',
    `• Key: \`${key}\``,
    `• HWID: \`${hwid}\``,
    `• Discord ID: ${k.discord_id ? `\`${k.discord_id}\`` : 'sin vincular'}`,
    `• ID del script: \`${script.loader_id || script.id}\``,
    `• Veces que esta key ejecutó este script: ${run?.exec_count ?? 1}`,
  ], k.discord_id, rbxid);
  reply(`OK:${issuePayloadToken(script.id, req.ip)}`);
});

app.get('/auth/logout', (req, res) => {
  res.clearCookie(SESSION_COOKIE);
  res.redirect('/login');
});

// ==========================================
// 6. API
// ==========================================
app.get('/api/me', requireAuth, (req, res) => {
  const user = stmt.userById.get(req.userId);
  if (!user) return res.status(401).json({ error: 'Usuario no encontrado' });
  res.json({ ...user, owner: isOwnerId(req.userId) });
});

// ---------- Chat de la comunidad ----------
const CHAT_MAX_CHARS = 500;
const CHAT_COOLDOWN_MS = 2000;               // un mensaje cada 2 s por usuario
const CHAT_REACTIONS = ['👍', '❤️', '😂', '🔥', '😮', '😢'];
const CHAT_SPAM_MUTE_S = 5 * 60;             // silencio automático por spam
const CHAT_STREAM_MAX = 500;                 // conexiones en vivo a la vez
// Enlaces: http(s)://, www. o dominios comunes (ej. algo.gg, algo.com)
const CHAT_LINK_RE = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|gg|net|org|io|me|xyz|ly|gl|cc|to|link|app|dev)\b)/i;

db.exec(`
  CREATE TABLE IF NOT EXISTS web_chat_words (word TEXT PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS web_chat_reactions (
    message_id INTEGER NOT NULL, user_id TEXT NOT NULL, emoji TEXT NOT NULL,
    PRIMARY KEY (message_id, user_id, emoji)
  );
  CREATE TABLE IF NOT EXISTS web_chat_reports (
    message_id INTEGER NOT NULL, reporter_id TEXT NOT NULL, reason TEXT, created_at INTEGER,
    PRIMARY KEY (message_id, reporter_id)
  );
`);
if (!db.prepare("SELECT 1 FROM pragma_table_info('web_chat') WHERE name = 'reply_to'").get()) {
  db.exec('ALTER TABLE web_chat ADD COLUMN reply_to INTEGER');
}
// Palabras bloqueadas: se siembra una vez; después se administran desde el chat
if (!db.prepare('SELECT 1 FROM web_chat_words LIMIT 1').get()) {
  db.prepare('INSERT OR IGNORE INTO web_chat_words (word) VALUES (?)').run('scripts');
}

const chatLastPost = new Map();   // usuario -> último envío (ms), para la espera entre mensajes
const chatRecent = new Map();     // usuario -> envíos recientes ({ at, text }), para detectar spam
const chatSeen = new Map();       // usuario -> última vez que estuvo en el chat (ms)
const chatStreams = new Map();    // usuario -> conexiones en vivo (SSE)

const CHAT_SELECT = `SELECT c.id, c.user_id, c.text, c.created_at, c.reply_to, u.username, u.avatar, u.custom_avatar, u.plan, u.staff_role
  FROM web_chat c LEFT JOIN users u ON u.id = c.user_id`;
// Rol que se muestra: owner (DISCORD_OWNER_ID o asignado), admin (asignado), o el plan
function roleOf(userId, plan, staffRole) {
  if (isOwnerId(userId) || staffRole === 'owner') return 'owner';
  if (staffRole === 'admin') return 'admin';
  if (plan === 'plus') return 'plus';
  if (plan === 'premium') return 'premium';
  return 'free';
}
const canModerate = userId => {
  if (isOwnerId(userId)) return true;
  const staff = stmt.userById.get(userId)?.staff_role;
  return staff === 'admin' || staff === 'owner';
};
const chatStmt = {
  latest: db.prepare(`${CHAT_SELECT} ORDER BY c.id DESC LIMIT 60`),
  older: db.prepare(`${CHAT_SELECT} WHERE c.id < ? ORDER BY c.id DESC LIMIT ?`),
  newer: db.prepare(`${CHAT_SELECT} WHERE c.id > ? ORDER BY c.id ASC LIMIT 100`),
  one: db.prepare(`${CHAT_SELECT} WHERE c.id = ?`),
  insert: db.prepare('INSERT INTO web_chat (user_id, text, created_at, reply_to) VALUES (?, ?, ?, ?)'),
};

// Usuarios que estuvieron en el chat en los últimos 30 s (aprox. "en línea")
function onlineCount() {
  const cut = Date.now() - 30_000;
  for (const [id, t] of chatSeen) if (t < cut) chatSeen.delete(id);
  return chatSeen.size;
}

// Mensaje tal como lo ve el cliente. viewerId decide las reacciones propias y si se ven los reportes.
function decorateChat(rows, viewerId) {
  if (!rows.length) return [];
  const ids = rows.map(r => r.id);
  const ph = ids.map(() => '?').join(',');
  const reacts = db.prepare(`SELECT message_id, emoji, user_id FROM web_chat_reactions WHERE message_id IN (${ph})`).all(...ids);
  const reportRows = canModerate(viewerId)
    ? db.prepare(`SELECT message_id, COUNT(*) AS n FROM web_chat_reports WHERE message_id IN (${ph}) GROUP BY message_id`).all(...ids)
    : [];
  const replyIds = [...new Set(rows.map(r => r.reply_to).filter(Boolean))];
  const replies = replyIds.length
    ? db.prepare(`SELECT c.id, c.text, u.username FROM web_chat c LEFT JOIN users u ON u.id = c.user_id WHERE c.id IN (${replyIds.map(() => '?').join(',')})`).all(...replyIds)
    : [];
  const replyMap = new Map(replies.map(r => [r.id, r]));
  const reportMap = new Map(reportRows.map(r => [r.message_id, r.n]));
  const reactMap = new Map();
  for (const x of reacts) {
    const byEmoji = reactMap.get(x.message_id) ?? new Map();
    byEmoji.set(x.emoji, [...(byEmoji.get(x.emoji) ?? []), x.user_id]);
    reactMap.set(x.message_id, byEmoji);
  }
  return rows.map(r => {
    const rep = r.reply_to ? replyMap.get(r.reply_to) : null;
    return {
      id: r.id,
      user_id: r.user_id,
      username: r.username || `ID ${r.user_id}`,
      avatar: r.custom_avatar || (r.avatar ? `https://cdn.discordapp.com/avatars/${r.user_id}/${r.avatar}.png?size=64` : null),
      role: roleOf(r.user_id, r.plan, r.staff_role),
      text: r.text,
      created_at: r.created_at,
      reply: rep ? { id: rep.id, username: rep.username || 'usuario', text: String(rep.text).slice(0, 120) } : null,
      reactions: CHAT_REACTIONS.map(emoji => {
        const users = reactMap.get(r.id)?.get(emoji) ?? [];
        return { emoji, count: users.length, mine: !!viewerId && users.includes(viewerId) };
      }),
      reports: reportMap.get(r.id) ?? 0,
    };
  });
}

function chatBroadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const set of chatStreams.values()) for (const res of set) res.write(payload);
}

function reactionCounts(messageId) {
  const counts = {};
  for (const r of db.prepare('SELECT emoji, COUNT(*) AS n FROM web_chat_reactions WHERE message_id = ? GROUP BY emoji').all(messageId)) {
    counts[r.emoji] = r.n;
  }
  return counts;
}

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function blockedWordHit(text) {
  const lowered = text.toLowerCase();
  return db.prepare('SELECT word FROM web_chat_words').all()
    .map(r => r.word)
    .find(w => new RegExp(`(^|\\W)${escapeRe(w)}($|\\W)`).test(lowered)) ?? null;
}

// Mensajes: los últimos 60, los nuevos (after) o los anteriores (before)
app.get('/api/chat', requireAuth, (req, res) => {
  const after = Number(req.query.after) || 0;
  const before = Number(req.query.before) || 0;
  let rows;
  if (after > 0) rows = chatStmt.newer.all(after);
  else if (before > 0) rows = chatStmt.older.all(before, 50).reverse();
  else rows = chatStmt.latest.all().reverse();
  chatSeen.set(req.userId, Date.now());
  res.json({
    messages: decorateChat(rows, req.userId),
    online: onlineCount(),
    canModerate: canModerate(req.userId),
    hasMore: rows.length === (before ? 50 : 60),
  });
});

// Conexión en vivo: los mensajes, borrados, reacciones y reportes llegan al instante
app.get('/api/chat/stream', requireAuth, (req, res) => {
  let total = 0;
  for (const set of chatStreams.values()) total += set.size;
  if (total >= CHAT_STREAM_MAX) return res.status(503).end();

  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const set = chatStreams.get(req.userId) ?? new Set();
  set.add(res);
  chatStreams.set(req.userId, set);
  chatSeen.set(req.userId, Date.now());
  res.write(`event: online\ndata: ${JSON.stringify({ online: onlineCount() })}\n\n`);

  const ping = setInterval(() => {
    chatSeen.set(req.userId, Date.now());
    res.write(': ping\n\n');
    chatBroadcast('online', { online: onlineCount() });
  }, 25_000);
  req.on('close', () => {
    clearInterval(ping);
    set.delete(res);
    if (!set.size) chatStreams.delete(req.userId);
  });
});

app.post('/api/chat', requireAuth, (req, res) => {
  const text = String(req.body?.text ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return res.status(400).json({ error: 'Escribe un mensaje' });
  if (text.length > CHAT_MAX_CHARS) return res.status(400).json({ error: `Máximo ${CHAT_MAX_CHARS} caracteres` });
  const mute = db.prepare('SELECT until FROM web_chat_mutes WHERE user_id = ?').get(req.userId);
  const nowS = Math.floor(Date.now() / 1000);
  if (mute && mute.until > nowS) {
    const when = new Date(mute.until * 1000).toLocaleString('es-EC', { timeZone: 'America/Guayaquil' });
    return res.status(403).json({ error: `Estás silenciado en el chat hasta ${when}` });
  }
  if (blockedWordHit(text)) return res.status(400).json({ error: 'Tu mensaje contiene palabras no permitidas' });
  if (CHAT_LINK_RE.test(text)) return res.status(400).json({ error: 'No se permiten enlaces en el chat' });

  const nowMs = Date.now();
  const last = chatLastPost.get(req.userId) ?? 0;
  if (nowMs - last < CHAT_COOLDOWN_MS) return res.status(429).json({ error: 'Espera un momento antes de enviar otro mensaje' });

  // Spam: más de 6 mensajes en 10 s, o el mismo texto 3 veces en 1 minuto -> silencio de 5 min
  const recent = (chatRecent.get(req.userId) ?? []).filter(t => nowMs - t.at < 60_000);
  const burst = recent.filter(t => nowMs - t.at < 10_000).length;
  const repeated = recent.filter(t => t.text === text).length;
  if (burst >= 6 || repeated >= 2) {
    db.prepare('INSERT OR REPLACE INTO web_chat_mutes (user_id, until) VALUES (?, ?)').run(req.userId, nowS + CHAT_SPAM_MUTE_S);
    chatRecent.delete(req.userId);
    return res.status(403).json({ error: 'Silenciado 5 minutos por spam' });
  }
  chatRecent.set(req.userId, [...recent, { at: nowMs, text }].slice(-20));
  chatLastPost.set(req.userId, nowMs);

  const replyTo = Number(req.body?.replyTo) || null;
  if (replyTo && !chatStmt.one.get(replyTo)) return res.status(400).json({ error: 'El mensaje al que respondes ya no existe' });
  const info = chatStmt.insert.run(req.userId, text, nowS, replyTo);
  const [view] = decorateChat([chatStmt.one.get(info.lastInsertRowid)], null);
  chatBroadcast('message', view);
  res.json({ message: { ...view, reactions: view.reactions.map(r => ({ ...r, mine: false })) } });
});

// Borrar: el dueño de cada mensaje, o admin/owner (moderación)
app.delete('/api/chat/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT user_id FROM web_chat WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Mensaje no encontrado' });
  if (row.user_id !== req.userId && !canModerate(req.userId)) return res.status(403).json({ error: 'Solo puedes borrar tus mensajes' });
  db.prepare('DELETE FROM web_chat_reactions WHERE message_id = ?').run(id);
  db.prepare('DELETE FROM web_chat_reports WHERE message_id = ?').run(id);
  db.prepare('DELETE FROM web_chat WHERE id = ?').run(id);
  chatBroadcast('delete', { id });
  res.json({ ok: true });
});

// Reacción: agrega o quita tu emoji en el mensaje
app.post('/api/chat/:id/react', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const emoji = String(req.body?.emoji ?? '');
  if (!CHAT_REACTIONS.includes(emoji)) return res.status(400).json({ error: 'Reacción no permitida' });
  if (!chatStmt.one.get(id)) return res.status(404).json({ error: 'Mensaje no encontrado' });
  const has = db.prepare('SELECT 1 FROM web_chat_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').get(id, req.userId, emoji);
  if (has) db.prepare('DELETE FROM web_chat_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').run(id, req.userId, emoji);
  else db.prepare('INSERT INTO web_chat_reactions (message_id, user_id, emoji) VALUES (?, ?, ?)').run(id, req.userId, emoji);
  const counts = reactionCounts(id);
  chatBroadcast('reactions', { messageId: id, counts });
  const mine = db.prepare('SELECT emoji FROM web_chat_reactions WHERE message_id = ? AND user_id = ?').all(id, req.userId).map(r => r.emoji);
  res.json({ counts, mine });
});

// Reporte: cada usuario puede reportar un mensaje una vez; el staff ve el contador
app.post('/api/chat/:id/report', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const row = chatStmt.one.get(id);
  if (!row) return res.status(404).json({ error: 'Mensaje no encontrado' });
  if (row.user_id === req.userId) return res.status(400).json({ error: 'No puedes reportar tu propio mensaje' });
  const reason = String(req.body?.reason ?? '').trim().slice(0, 200) || 'Sin motivo';
  const info = db.prepare('INSERT OR IGNORE INTO web_chat_reports (message_id, reporter_id, reason, created_at) VALUES (?, ?, ?, ?)')
    .run(id, req.userId, reason, Math.floor(Date.now() / 1000));
  if (!info.changes) return res.status(409).json({ error: 'Ya reportaste este mensaje' });
  const count = db.prepare('SELECT COUNT(*) AS n FROM web_chat_reports WHERE message_id = ?').get(id).n;
  chatBroadcast('reports', { messageId: id, count });
  res.json({ ok: true });
});

// Descartar los reportes de un mensaje (staff)
app.delete('/api/chat/:id/reports', requireAuth, (req, res) => {
  if (!canModerate(req.userId)) return res.status(403).json({ error: 'Solo admin u owner pueden hacer esto' });
  const id = Number(req.params.id);
  db.prepare('DELETE FROM web_chat_reports WHERE message_id = ?').run(id);
  chatBroadcast('reports', { messageId: id, count: 0 });
  res.json({ ok: true });
});

// Palabras bloqueadas (staff)
app.get('/api/chat/words', requireAuth, (req, res) => {
  if (!canModerate(req.userId)) return res.status(403).json({ error: 'Solo admin u owner' });
  res.json({ words: db.prepare('SELECT word FROM web_chat_words ORDER BY word').all().map(r => r.word) });
});
app.post('/api/chat/words', requireAuth, (req, res) => {
  if (!canModerate(req.userId)) return res.status(403).json({ error: 'Solo admin u owner' });
  const word = String(req.body?.word ?? '').trim().toLowerCase().slice(0, 40);
  if (word.length < 2) return res.status(400).json({ error: 'La palabra debe tener al menos 2 caracteres' });
  db.prepare('INSERT OR IGNORE INTO web_chat_words (word) VALUES (?)').run(word);
  res.json({ ok: true });
});
app.delete('/api/chat/words/:word', requireAuth, (req, res) => {
  if (!canModerate(req.userId)) return res.status(403).json({ error: 'Solo admin u owner' });
  db.prepare('DELETE FROM web_chat_words WHERE word = ?').run(String(req.params.word).toLowerCase());
  res.json({ ok: true });
});

// Silenciar en el chat (dueño, admin u owner). minutes = 0 quita el silencio. Nunca se silencia al dueño.
app.post('/api/chat/mute', requireAuth, (req, res) => {
  if (!canModerate(req.userId)) return res.status(403).json({ error: 'Solo admin u owner pueden silenciar' });
  const target = String(req.body?.userId ?? '');
  const minutes = Number(req.body?.minutes);
  if (!target || !Number.isInteger(minutes) || minutes < 0 || minutes > 10080) {
    return res.status(400).json({ error: 'Usuario o minutos inválidos (0 a 10080)' });
  }
  if (isOwnerId(target)) return res.status(403).json({ error: 'No se puede silenciar al dueño' });
  if (minutes === 0) {
    db.prepare('DELETE FROM web_chat_mutes WHERE user_id = ?').run(target);
  } else {
    db.prepare('INSERT OR REPLACE INTO web_chat_mutes (user_id, until) VALUES (?, ?)').run(target, Math.floor(Date.now() / 1000) + minutes * 60);
  }
  res.json({ ok: true });
});

// Foto de perfil por URL (solo https). URL vacía = volver a la foto de Discord.
// ---- Precios desde la web (solo Premium y Premium Plus): mismo canal e imagen guardados que /prices de Discord ----
const settingGet = (owner, name) => db.prepare('SELECT value FROM bot_settings WHERE owner = ? AND name = ?').get(owner, name)?.value ?? null;
const settingPut = (owner, name, value) => db.prepare('INSERT OR REPLACE INTO bot_settings (owner, name, value) VALUES (?, ?, ?)').run(owner, name, value);
const settingDelete = (owner, name) => db.prepare('DELETE FROM bot_settings WHERE owner = ? AND name = ?').run(owner, name);

app.get('/api/prices', requireAuth, requirePerkPlan, async (req, res) => {
  let guilds = [];
  if (discordBot?.guildsForUser) {
    try { guilds = await discordBot.guildsForUser(req.userId); } catch (err) { console.warn('[Precios] No se pudieron listar servidores:', err.message); }
  }
  res.json({
    channelId: settingGet(req.userId, 'prices_channel'),
    imageUrl: settingGet(req.userId, 'prices_image'),
    guilds,
  });
});

app.post('/api/prices', requireAuth, requirePerkPlan, async (req, res) => {
  const title = String(req.body?.title ?? '').trim();
  const description = String(req.body?.description ?? '').trim();
  const channelId = String(req.body?.channelId ?? '').trim();
  const imageRaw = String(req.body?.imageUrl ?? '').trim();
  if (!title || title.length > 256) return res.status(400).json({ error: 'Título requerido (máx. 256)' });
  if (!description || description.length > 4000) return res.status(400).json({ error: 'Contenido requerido (máx. 4000)' });
  if (!/^\d{17,20}$/.test(channelId)) return res.status(400).json({ error: 'Elige un canal' });
  let image = null;
  if (imageRaw) {
    let parsed;
    try { parsed = new URL(imageRaw); } catch { return res.status(400).json({ error: 'La imagen debe ser una URL https válida' }); }
    if (parsed.protocol !== 'https:' || parsed.href.length > 500) return res.status(400).json({ error: 'La imagen debe ser una URL https (máx. 500 caracteres)' });
    image = parsed.href;
  }
  if (!discordBot?.announce || !discordBot?.channelForStaff) return res.status(503).json({ error: 'El bot todavía no está conectado' });
  try {
    await discordBot.channelForStaff(req.userId, channelId);
    await discordBot.announce('prices', channelId, title, description, image);
  } catch (err) {
    return res.status(502).json({ error: `No se pudo publicar: ${err.message}` });
  }
  settingPut(req.userId, 'prices_channel', channelId);
  if (image) settingPut(req.userId, 'prices_image', image);
  else settingDelete(req.userId, 'prices_image');
  res.json({ ok: true });
});

// ---- Bienvenida desde la web (solo Premium Plus): canal, mensaje e imagen de un servidor donde eres dueño o mod ----
function requirePlusPlan(req, res, next) {
  if (stmt.userById.get(req.userId)?.plan !== 'plus') {
    return res.status(403).json({ error: 'La bienvenida es solo para Premium Plus' });
  }
  next();
}
app.get('/api/welcome', requireAuth, requirePlusPlan, async (req, res) => {
  let guilds = [];
  if (discordBot?.guildsForUser) {
    try { guilds = await discordBot.guildsForUser(req.userId); } catch (err) { console.warn('[Bienvenida] No se pudieron listar servidores:', err.message); }
  }
  const guildId = settingGet(req.userId, 'welcome_guild');
  const channelId = settingGet(req.userId, 'welcome_channel');
  res.json({
    guildId,
    channelId,
    text: settingGet(req.userId, 'welcome_text'),
    imageUrl: settingGet(req.userId, 'welcome_image'),
    enabled: Boolean(guildId && channelId),
    guilds,
  });
});

app.post('/api/welcome', requireAuth, requirePlusPlan, async (req, res) => {
  const channelId = String(req.body?.channelId ?? '').trim();
  const text = String(req.body?.text ?? '').trim();
  const imageRaw = String(req.body?.imageUrl ?? '').trim();
  if (!/^\d{17,20}$/.test(channelId)) return res.status(400).json({ error: 'Elige un canal' });
  if (text.length > 1000) return res.status(400).json({ error: 'El mensaje es demasiado largo (máx. 1000)' });
  let image = null;
  if (imageRaw) {
    let parsed;
    try { parsed = new URL(imageRaw); } catch { return res.status(400).json({ error: 'La imagen debe ser una URL https válida' }); }
    if (parsed.protocol !== 'https:' || parsed.href.length > 500) return res.status(400).json({ error: 'La imagen debe ser una URL https (máx. 500 caracteres)' });
    image = parsed.href;
  }
  if (!discordBot?.channelForStaff) return res.status(503).json({ error: 'El bot todavía no está conectado' });
  let channel;
  try {
    channel = await discordBot.channelForStaff(req.userId, channelId);
  } catch (err) {
    return res.status(403).json({ error: err.message });
  }
  settingPut(req.userId, 'welcome_guild', channel.guild.id);
  settingPut(req.userId, 'welcome_channel', channelId);
  if (text) settingPut(req.userId, 'welcome_text', text);
  else settingDelete(req.userId, 'welcome_text');
  if (image) settingPut(req.userId, 'welcome_image', image);
  else settingDelete(req.userId, 'welcome_image');
  res.json({ ok: true });
});

app.delete('/api/welcome', requireAuth, requirePlusPlan, (req, res) => {
  for (const name of ['welcome_guild', 'welcome_channel', 'welcome_text', 'welcome_image']) settingDelete(req.userId, name);
  res.json({ ok: true });
});

// Perfil (foto de perfil y foto del bot): solo Premium y Premium Plus
function requirePerkPlan(req, res, next) {
  const plan = stmt.userById.get(req.userId)?.plan;
  if (plan !== 'premium' && plan !== 'plus') {
    return res.status(403).json({ error: 'Esta función es solo para Premium y Premium Plus' });
  }
  next();
}
app.post('/api/me/avatar', requireAuth, requirePerkPlan, (req, res) => {
  const raw = String(req.body?.url ?? '').trim();
  if (!raw) {
    db.prepare('UPDATE users SET custom_avatar = NULL WHERE id = ?').run(req.userId);
    return res.json({ ok: true, avatarUrl: null });
  }
  let parsed;
  try { parsed = new URL(raw); } catch { return res.status(400).json({ error: 'La URL no es válida' }); }
  if (parsed.protocol !== 'https:' || raw.length > 500) {
    return res.status(400).json({ error: 'Usa una URL https de una imagen (máximo 500 caracteres)' });
  }
  const url = parsed.toString();
  db.prepare('UPDATE users SET custom_avatar = ? WHERE id = ?').run(url, req.userId);
  res.json({ ok: true, avatarUrl: url });
});

// Foto del bot solo en los servidores donde el creador tiene su panel. Vacío = quitarla.
app.post('/api/me/bot-avatar', requireAuth, requirePerkPlan, async (req, res) => {
  const raw = String(req.body?.url ?? '').trim();
  if (!raw) {
    db.prepare('UPDATE users SET bot_avatar = NULL WHERE id = ?').run(req.userId);
    return res.json({ ok: true });
  }
  let parsed;
  try { parsed = new URL(raw); } catch { return res.status(400).json({ error: 'La URL no es válida' }); }
  if (parsed.protocol !== 'https:' || raw.length > 500) {
    return res.status(400).json({ error: 'Usa una URL https de una imagen (máximo 500 caracteres)' });
  }
  if (!discordBot?.setGuildAvatarFor) return res.status(503).json({ error: 'El bot todavía no está conectado' });
  try {
    const url = parsed.toString();
    await discordBot.setGuildAvatarFor(req.userId, url);
    db.prepare('UPDATE users SET bot_avatar = ? WHERE id = ?').run(url, req.userId);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Mantenimiento: bloquea compras, canjes y scripts nuevos. Los loaders existentes siguen funcionando y el dueño no se bloquea
// Mantenimiento total ('maintenance_all') también para loaders y bot; implica el normal.
function maintenanceAllOn() { return appGet('maintenance_all') === '1'; }
function maintenanceBlock(req, res) {
  const on = appGet('maintenance') === '1' || maintenanceAllOn();
  if (!on || isOwnerId(req.userId)) return false;
  res.status(503).json({ error: appGet('maintenance_msg') || 'Estamos en mantenimiento. Vuelve en unos minutos.', code: 'MAINTENANCE' });
  return true;
}
// Estado público del sitio (banner y mantenimiento)
app.get('/api/status', (req, res) => {
  // servers: solo el número de servidores donde está el bot (público, sin nombres)
  const servers = discordBot?.guilds?.cache ? discordBot.guilds.cache.size : null;
  const maintenance = appGet('maintenance') === '1' || maintenanceAllOn();
  res.json({ maintenance, maintenanceAll: maintenanceAllOn(), message: appGet('maintenance_msg'), banner: appGet('banner'), servers });
});

// ---- Panel del dueño: solo DISCORD_OWNER_ID ----
function isOwnerId(id) {
  return Boolean(process.env.DISCORD_OWNER_ID) && String(id) === String(process.env.DISCORD_OWNER_ID);
}
// Dueño por cookie (dashboard) o por token de servicio (panel admin, que llama desde otro servicio).
function requireOwnerApi(req, res, next) {
  const token = (req.get('authorization') || '').replace(/^Bearer /, '');
  const expected = process.env.ADMIN_API_TOKEN || '';
  if (expected && token && token.length === expected.length
      && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))) return next();
  return requireAuth(req, res, () => requireOwner(req, res, next));
}

function requireOwner(req, res, next) {
  if (!isOwnerId(req.userId)) return res.status(403).json({ error: 'Solo el dueño puede ver esto' });
  next();
}
app.get('/api/owner/plan-keys', requireOwnerApi, (req, res) => {
  // Quien canjeó la key: nombre y foto de Discord (la personalizada si la cambió)
  res.json(db.prepare(`SELECT pk.key, pk.plan, pk.days, pk.used_by, pk.used_at, pk.created_at,
      u.username AS used_by_name, u.avatar AS used_by_avatar, u.custom_avatar AS used_by_custom
    FROM plan_keys pk LEFT JOIN users u ON u.id = pk.used_by ORDER BY pk.created_at DESC LIMIT 200`).all()
    .map(({ used_by_avatar, used_by_custom, ...k }) => ({
      ...k,
      used_by_avatar_url: !k.used_by ? null : (used_by_custom
        || (used_by_avatar ? `https://cdn.discordapp.com/avatars/${k.used_by}/${used_by_avatar}.png?size=64` : defaultDiscordAvatar(k.used_by))),
    })));
});
app.post('/api/owner/plan-keys', requireOwnerApi, (req, res) => {
  const plan = req.body?.plan === 'plus' ? 'plus' : (req.body?.plan === 'premium' ? 'premium' : null);
  if (!plan) return res.status(400).json({ error: 'Plan inválido' });
  const key = crypto.randomBytes(24).toString('base64url'); // 32 caracteres, uso único
  db.prepare('INSERT INTO plan_keys (key, plan, days, created_at) VALUES (?, ?, ?, ?)').run(key, plan, PLAN_DAYS_DEFAULT, Math.floor(Date.now() / 1000));
  auditLog(req.userId, 'plan_key_create', plan, `${PLAN_DAYS_DEFAULT} días`);
  res.json({ key, plan, days: PLAN_DAYS_DEFAULT });
});
// ---- Usuarios (solo dueño): ver planes y cambiarlos ----
app.get('/api/owner/obfuscators', requireOwnerApi, (req, res) => {
  res.json(Object.entries(OBF_CONFIG).map(([id, c]) => ({ id, ready: Boolean(c.dir) })));
});

app.get('/api/owner/users', requireOwnerApi, (req, res) => {
  res.json(db.prepare(`SELECT u.id, u.username, u.avatar, u.custom_avatar, u.plan, u.obf_used, u.staff_role, u.plan_expires_at,
      (SELECT COUNT(*) FROM scripts s WHERE s.user_id = u.id) AS scripts
    FROM users u ORDER BY u.rowid DESC LIMIT 500`).all().map(({ custom_avatar, avatar, ...u }) => ({
      ...u,
      avatar_url: custom_avatar || (avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${avatar}.png?size=64` : defaultDiscordAvatar(u.id)),
      role: roleOf(u.id, u.plan, u.staff_role),
    })));
});
app.post('/api/owner/users/:id/plan', requireOwnerApi, (req, res) => {
  const plan = ['free', 'premium', 'plus'].includes(req.body?.plan) ? req.body.plan : null;
  if (!plan) return res.status(400).json({ error: 'Plan inválido' });
  const expiresAt = plan === 'free' ? null : Math.floor(Date.now() / 1000) + MONTH_SECONDS;
  const info = db.prepare('UPDATE users SET plan = ?, plan_expires_at = ?, plan_expired_at = NULL WHERE id = ?').run(plan, expiresAt, req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Usuario no encontrado' });
  auditLog(req.userId, 'user_plan', req.params.id, plan);
  res.json({ ok: true, plan, expires_at: expiresAt });
});

// Asignar rol de staff (solo desde el panel admin / dueño). Vacío = quitarlo
app.post('/api/owner/users/:id/staff', requireOwnerApi, (req, res) => {
  const raw = req.body?.role;
  const role = raw === 'admin' || raw === 'owner' ? raw : null;
  const info = db.prepare('UPDATE users SET staff_role = ? WHERE id = ?').run(role, req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Usuario no encontrado' });
  auditLog(req.userId, 'staff', req.params.id, role || 'quitado');
  res.json({ ok: true, staff_role: role });
});

// Foto por defecto de Discord (la misma que muestra Discord cuando el usuario no tiene avatar)
const defaultDiscordAvatar = id => { try { return `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(id) >> 22n) % 6n)}.png`; } catch { return null; } };
// Respaldo descargable para el dueño: copia en vivo de la base (se borra después de enviarla)
app.get('/api/owner/backup', requireOwnerApi, async (req, res) => {
  const file = path.join(BACKUP_DIR, `manual-${Date.now()}.db`);
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    await db.backup(file);
    auditLog(req.userId, 'settings', 'respaldo descargado', '');
    res.download(file, `vantarmor-${ecuadorDay(Date.now())}.db`, () => fs.rmSync(file, { force: true }));
  } catch (err) {
    fs.rmSync(file, { force: true });
    console.error('[Respaldo] Descarga fallida:', err.message);
    res.status(500).json({ error: 'No se pudo crear el respaldo' });
  }
});

app.get('/api/owner/publisher', requireOwnerApi, (req, res) => {
  res.json(db.prepare(`SELECT s.id, s.name, s.slug, s.ffa, s.obfuscator, s.source, s.user_id, u.username, u.avatar, u.custom_avatar
    FROM scripts s LEFT JOIN users u ON u.id = s.user_id ORDER BY s.id DESC`).all().map(({ avatar, custom_avatar, ...s }) => ({
      ...s,
      avatar_url: custom_avatar || (avatar ? `https://cdn.discordapp.com/avatars/${s.user_id}/${avatar}.png?size=64` : defaultDiscordAvatar(s.user_id)),
    })));
});

// Registro de usos y acciones de scripts (lo lee el panel admin)
// Filtros: scriptId, from y to (segundos Unix) y limit (hasta 5000, para exportar)
app.get('/api/owner/logs', requireOwnerApi, (req, res) => {
  const limit = Math.min(5000, Math.max(1, parseInt(req.query.limit, 10) || 300));
  const where = [];
  const args = [];
  const scriptId = parseInt(req.query.scriptId, 10);
  if (Number.isFinite(scriptId)) { where.push('script_id = ?'); args.push(scriptId); }
  const from = parseInt(req.query.from, 10);
  if (Number.isFinite(from)) { where.push('created_at >= ?'); args.push(from); }
  const to = parseInt(req.query.to, 10);
  if (Number.isFinite(to)) { where.push('created_at <= ?'); args.push(to); }
  const sql = `SELECT id, script_id, script_name, text, created_at FROM script_logs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
  res.json(db.prepare(sql).all(...args, limit));
});

// Resumen del dueño: Ofuscador 3, ventas de planes, ajustes del sitio y registro de acciones
app.get('/api/owner/overview', requireOwnerApi, (req, res) => {
  const usage = db.prepare('SELECT COALESCE(SUM(n), 0) AS n FROM luau_usage WHERE day = ?');
  const total = db.prepare('SELECT COALESCE(SUM(n), 0) AS n FROM luau_usage');
  const since = Math.floor(Date.now() / 1000) - 180 * 86400;
  res.json({
    luau: {
      configured: Boolean(process.env.LUO_API_KEY),
      today: usage.get(luauDay()).n,
      total: total.get().n,
      dailyLimit: LUAU_DAILY_LIMIT,
      noTokensAt: Number(appGet('luau_no_tokens_at', '')) || null,
      lastError: appGet('luau_last_error', '') || null,
    },
    settings: {
      maintenance: appGet('maintenance') === '1',
      maintenanceAll: maintenanceAllOn(),
      maintenanceMsg: appGet('maintenance_msg'),
      banner: appGet('banner'),
    },
    sales: {
      byPlan: db.prepare('SELECT plan, COUNT(*) AS total, SUM(CASE WHEN used_by IS NOT NULL THEN 1 ELSE 0 END) AS used FROM plan_keys GROUP BY plan').all(),
      byMonth: db.prepare("SELECT strftime('%Y-%m', used_at, 'unixepoch') AS month, COUNT(*) AS count FROM plan_keys WHERE used_at IS NOT NULL AND used_at >= ? GROUP BY month ORDER BY month DESC LIMIT 6").all(since),
      usersByPlan: db.prepare("SELECT COALESCE(plan, 'free') AS plan, COUNT(*) AS count FROM users GROUP BY plan").all(),
    },
    audit: db.prepare('SELECT actor_id, action, target, detail, created_at FROM admin_audit ORDER BY id DESC LIMIT 100').all(),
  });
});
// Servidores donde está el bot (solo dueño; el panel admin lo reenvía).
// Muestra solo invitaciones que ya existen: nunca crea ninguna.
const serverInviteCache = new Map(); // guildId -> { at, url }
async function existingInvite(guild) {
  const hit = serverInviteCache.get(guild.id);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.url;
  let url = null;
  try {
    const invites = await guild.invites.fetch();
    const now = Date.now();
    const valid = [...invites.values()].find(inv => !inv.temporary && (!inv.expiresTimestamp || inv.expiresTimestamp > now));
    url = valid ? `https://discord.gg/${valid.code}` : null;
  } catch {
    url = null; // sin permiso de gestionar el servidor, o error de Discord
  }
  serverInviteCache.set(guild.id, { at: Date.now(), url });
  return url;
}
app.get('/api/owner/servers', requireOwnerApi, async (req, res) => {
  const cache = discordBot?.guilds?.cache;
  if (!cache) return res.json({ online: false, servers: 0, list: [] });
  const guilds = [...cache.values()].sort((a, b) => (b.memberCount ?? 0) - (a.memberCount ?? 0));
  const invites = await Promise.all(guilds.map(existingInvite));
  const list = guilds.map((g, i) => ({ id: g.id, name: g.name, members: g.memberCount ?? null, invite: invites[i] }));
  res.json({ online: Boolean(discordBot.isReady?.()), servers: list.length, list });
});
app.post('/api/owner/settings', requireOwnerApi, (req, res) => {
  const b = req.body || {};
  const msg = String(b.maintenanceMsg ?? '').trim();
  const banner = String(b.banner ?? '').trim();
  if (msg.length > 200 || banner.length > 200) return res.status(400).json({ error: 'El mensaje y el banner deben tener máximo 200 caracteres' });
  // Solo cambia el mantenimiento si la petición lo trae: un guardado parcial no lo apaga
  const hasMaint = typeof b.maintenance === 'boolean';
  const all = b.maintenanceAll === true;   // el total implica el mantenimiento normal
  const on = b.maintenance === true || all;
  if (hasMaint || all) {
    appSet('maintenance', on ? '1' : '0');
    appSet('maintenance_all', all ? '1' : '0');
  }
  appSet('maintenance_msg', msg);
  appSet('banner', banner);
  if (hasMaint || all) auditLog(req.userId, 'settings', on ? (all ? 'mantenimiento total activado' : 'mantenimiento activado') : 'mantenimiento desactivado', banner ? `banner: ${banner}` : 'sin banner');
  res.json({ ok: true });
});

// Canales del servidor de Discord para el selector del panel admin
app.get('/api/owner/channels', requireOwnerApi, (req, res) => {
  if (!discordBot?.listTextChannels) return res.status(503).json({ error: 'El bot todavía no está conectado' });
  res.json(discordBot.listTextChannels());
});

// Publica un changelog o la tabla de precios en un canal elegido en el panel admin
app.post('/api/owner/announce', requireOwnerApi, async (req, res) => {
  const { kind, channelId, title, description, imageUrl } = req.body || {};
  if (!['prices', 'changelog'].includes(kind)) return res.status(400).json({ error: 'Tipo inválido' });
  if (!/^\d{17,20}$/.test(String(channelId ?? ''))) return res.status(400).json({ error: 'El ID del canal no es válido' });
  if (!String(title ?? '').trim() || String(title).length > 256) return res.status(400).json({ error: 'Título requerido (máx. 256)' });
  if (!String(description ?? '').trim() || String(description).length > 4000) return res.status(400).json({ error: 'Contenido requerido (máx. 4000)' });
  let image = null;
  if (String(imageUrl ?? '').trim()) {
    let parsed;
    try { parsed = new URL(String(imageUrl).trim()); } catch { return res.status(400).json({ error: 'La URL de la imagen no es válida' }); }
    if (parsed.protocol !== 'https:' || parsed.href.length > 500) return res.status(400).json({ error: 'La imagen debe ser una URL https (máx. 500 caracteres)' });
    image = parsed.href;
  }
  if (!discordBot?.announce) return res.status(503).json({ error: 'El bot todavía no está conectado' });
  try {
    await discordBot.announce(kind, String(channelId), String(title).trim(), String(description).trim(), image);
    auditLog(req.userId, 'announce', kind, String(title).trim());
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: `No se pudo publicar: ${err.message}` });
  }
});

app.get('/api/scripts', requireAuth, (req, res) => {
  res.json(stmt.scriptsByUser.all(req.userId));
});

// Cuotas del plan: scripts creados y ofuscaciones usadas (borrar un script no devuelve la cuota)
function quotaError(userId, opts) {
  return quota.quotaError(userId, opts);
}

// El usuario confirma que ya se unió; queda guardado y el aviso no vuelve a salir
app.post('/api/discord/joined', requireAuth, (req, res) => {
  db.prepare('UPDATE users SET discord_joined = 1 WHERE id = ?').run(req.userId);
  res.json({ ok: true });
});

// Revisión de rendimiento para el editor (no guarda nada)
const perfLimit = rateLimit({
  windowMs: 60_000,
  max: 120,
  onLimit: (req, res) => res.status(429).json({ error: 'Demasiadas revisiones seguidas. Espera un momento.' }),
});
app.post('/api/perf-check', requireAuth, perfLimit, (req, res) => {
  const source = String(req.body?.source || '');
  if (Buffer.byteLength(source) > MAX_CODE_BYTES) return res.status(400).json({ error: 'El código supera 2 MB' });
  const obfuscator = OBFUSCATORS.includes(req.body?.obfuscator) ? req.body.obfuscator : 'clyde';
  res.json(analyzePerf(source, { obfuscator, vm: req.body?.clydeVm !== false }));
});

app.post('/api/scripts', requireAuth, async (req, res) => {
  if (maintenanceBlock(req, res)) return;
  const input = validateScriptInput(req.body || {});
  if (input.error) return res.status(400).json({ error: input.error });
  if (input.obfuscator === 'luau' && !isPlusPlanId(req.userId)) return res.status(403).json({ error: 'El Ofuscador 3 es solo para Premium Plus' });
  if (!discordJoinDone(req.userId)) {
    return res.status(403).json({ error: 'Para crear scripts debes estar en nuestro servidor de Discord.', code: 'DISCORD_REQUIRED', invite: DISCORD_JOIN_URL });
  }
  if (!isPaidPlanId(req.userId) && input.hwidResetHours === 0) input.hwidResetHours = 24;
  const quotaMsg = quotaError(req.userId, { isNewScript: true, isFfa: input.isFfa });
  if (quotaMsg) return res.status(403).json({ error: quotaMsg });
  if (input.obfuscator === 'luau' && luauUsedToday(req.userId) >= LUAU_DAILY_LIMIT) {
    return res.status(403).json({ error: `Ya usaste tus ${LUAU_DAILY_LIMIT} compilaciones de hoy con el Ofuscador 3. Vuelve mañana.` });
  }

  try {
    const srcErr = await checkLuauSyntax(input.source);
    if (srcErr) return res.status(422).json({ error: `Tu código no compila: ${srcErr}` });
    const content = input.obfuscator === 'none' ? input.source : await obfuscate(input.source, input.obfuscator, { vm: input.clydeVm === 1 });
    const outErr = input.obfuscator === 'none' ? null : await checkLuauSyntax(content);
    if (outErr) return res.status(422).json({ error: `La versión ofuscada no compila. Avisa al equipo con este mensaje: ${outErr}` });
    const info = stmt.scriptInsert.run(
      req.userId, input.name, uniqueSlug(input.name), input.isFfa ? 1 : 0,
      input.obfuscator, input.source, content, input.hwidResetHours, input.shareDetection, input.clydeVm, input.autoRevokeDump,
    );
    db.prepare('UPDATE scripts SET loader_id = ? WHERE id = ?').run(crypto.randomBytes(20).toString('hex'), info.lastInsertRowid);
    db.prepare('UPDATE scripts SET perf_level = ? WHERE id = ?').run(analyzePerf(input.source, { obfuscator: input.obfuscator, vm: input.clydeVm === 1 }).level, info.lastInsertRowid);
    snapshotVersion(info.lastInsertRowid, { name: input.name, obfuscator: input.obfuscator, ffa: input.isFfa, source: input.source });
    if (!input.isFfa) stmt.obfIncrement.run(req.userId);
    if (input.obfuscator === 'luau') luauBumpStmt.run(req.userId, luauDay());
    db.prepare('UPDATE users SET scripts_period = COALESCE(scripts_period, 0) + 1 WHERE id = ?').run(req.userId);
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
  if (input.obfuscator === 'luau' && !isPlusPlanId(req.userId)) return res.status(403).json({ error: 'El Ofuscador 3 es solo para Premium Plus' });
  if (!isPaidPlanId(req.userId) && input.hwidResetHours === 0) input.hwidResetHours = 24;
  const quotaMsg = quotaError(req.userId, { isNewScript: false, isFfa: input.isFfa });
  if (quotaMsg) return res.status(403).json({ error: quotaMsg });
  if (input.obfuscator === 'luau' && !input.isFfa && luauUsedToday(req.userId) >= LUAU_DAILY_LIMIT) {
    return res.status(403).json({ error: `Ya usaste tus ${LUAU_DAILY_LIMIT} compilaciones de hoy con el Ofuscador 3. Vuelve mañana.` });
  }

  try {
    const srcErr = await checkLuauSyntax(input.source);
    if (srcErr) return res.status(422).json({ error: `Tu código no compila: ${srcErr}` });
    const content = input.obfuscator === 'none' ? input.source : await obfuscate(input.source, input.obfuscator, { vm: input.clydeVm === 1 });
    const outErr = input.obfuscator === 'none' ? null : await checkLuauSyntax(content);
    if (outErr) return res.status(422).json({ error: `La versión ofuscada no compila. Avisa al equipo con este mensaje: ${outErr}` });
    stmt.scriptUpdate.run(
      input.name, input.isFfa ? 1 : 0, input.obfuscator, input.source, content, input.hwidResetHours, input.shareDetection, input.clydeVm, input.autoRevokeDump,
      script.id, req.userId,
    );
    db.prepare('UPDATE scripts SET perf_level = ? WHERE id = ?').run(analyzePerf(input.source, { obfuscator: input.obfuscator, vm: input.clydeVm === 1 }).level, script.id);
    snapshotVersion(script.id, { name: input.name, obfuscator: input.obfuscator, ffa: input.isFfa, source: input.source });
    if (!input.isFfa) stmt.obfIncrement.run(req.userId);
    if (input.obfuscator === 'luau' && !input.isFfa) luauBumpStmt.run(req.userId, luauDay());
    res.json({ ok: true });
  } catch (err) {
    console.error('Update script error:', err);
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Error del servidor' });
  }
});

// ---- Soporte ----
const SUPPORT_CATEGORIES = ['key', 'hwid', 'loader', 'plan', 'ofuscador', 'otro'];
const SUPPORT_LIST_COLS = 'id, user_id, username, category, subject, status, script_id, created_at, updated_at';
const supportLimit = rateLimit({
  windowMs: 60_000,
  max: 10,
  onLimit: (req, res) => res.status(429).json({ error: 'Espera un minuto antes de enviar otro mensaje.' }),
});
// Un usuario solo ve sus tickets; el dueño ve todos. Devuelve null y responde 404 si no tiene acceso.
function supportTicket(req, res) {
  const t = db.prepare('SELECT * FROM support_tickets WHERE id = ?').get(Number(req.params.id));
  if (!t || (t.user_id !== req.userId && !isOwnerId(req.userId))) {
    res.status(404).json({ error: 'Ticket no encontrado' });
    return null;
  }
  return t;
}
app.get('/api/support/tickets', requireAuth, (req, res) => {
  if (req.query.all === '1' && isOwnerId(req.userId)) {
    return res.json(db.prepare(`SELECT ${SUPPORT_LIST_COLS} FROM support_tickets ORDER BY updated_at DESC LIMIT 200`).all());
  }
  res.json(db.prepare(`SELECT ${SUPPORT_LIST_COLS} FROM support_tickets WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100`).all(req.userId));
});
// Asistente de soporte con IA: 20 mensajes por hora y usuario
import { answerSupport, supportAiEnabled } from './lib/support-ai.js';
const aiHits = new Map();
const AI_WINDOW_MS = 60 * 60 * 1000;
const AI_MAX = 20;
function aiAllowed(userId) {
  const now = Date.now();
  const list = (aiHits.get(String(userId)) || []).filter(t => now - t < AI_WINDOW_MS);
  if (list.length >= AI_MAX) { aiHits.set(String(userId), list); return false; }
  list.push(now);
  aiHits.set(String(userId), list);
  return true;
}
app.get('/api/support/ai/status', requireAuth, (req, res) => res.json({ enabled: supportAiEnabled() }));
app.post('/api/support/ai', requireAuth, async (req, res) => {
  if (!supportAiEnabled()) return res.status(503).json({ error: 'El asistente no está activo todavía.' });
  if (!aiAllowed(req.userId)) return res.status(429).json({ error: 'Llegaste al límite de mensajes por hora. Vuelve más tarde o abre un ticket.' });
  try {
    const user = db.prepare('SELECT plan FROM users WHERE id = ?').get(String(req.userId));
    const reply = await answerSupport({ message: req.body?.message, history: req.body?.history, planName: user?.plan || 'desconocido' });
    res.json({ reply });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Error del servidor. Inténtalo de nuevo.' });
  }
});

app.post('/api/support/tickets', requireAuth, supportLimit, (req, res) => {
  const b = req.body || {};
  if (!SUPPORT_CATEGORIES.includes(b.category)) return res.status(400).json({ error: 'Elige una categoría' });
  const subject = String(b.subject ?? '').trim();
  if (!subject || subject.length > 100) return res.status(400).json({ error: 'El asunto es obligatorio (máx. 100 caracteres)' });
  const body = String(b.body ?? '').trim();
  if (!body || body.length > 2000) return res.status(400).json({ error: 'Escribe tu mensaje (máx. 2000 caracteres)' });
  let scriptId = null;
  if (b.scriptId !== undefined && b.scriptId !== null && b.scriptId !== '') {
    const owned = stmt.scriptOwned.get(Number(b.scriptId), req.userId);
    if (!owned) return res.status(400).json({ error: 'Ese script no es tuyo' });
    scriptId = owned.id;
  }
  const now = Math.floor(Date.now() / 1000);
  const user = stmt.userById.get(req.userId);
  const info = db.prepare('INSERT INTO support_tickets (user_id, username, category, subject, status, script_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(req.userId, user?.username || '', b.category, subject, 'open', scriptId, now, now);
  db.prepare('INSERT INTO support_messages (ticket_id, author_id, is_staff, body, created_at) VALUES (?, ?, 0, ?, ?)').run(info.lastInsertRowid, req.userId, body, now);
  res.status(201).json({ ok: true, id: Number(info.lastInsertRowid) });
});
app.get('/api/support/tickets/:id', requireAuth, (req, res) => {
  const ticket = supportTicket(req, res);
  if (!ticket) return;
  const messages = db.prepare('SELECT id, author_id, is_staff, body, created_at FROM support_messages WHERE ticket_id = ? ORDER BY id').all(ticket.id);
  res.json({ ticket: { ...ticket, mine: ticket.user_id === req.userId }, messages });
});
app.post('/api/support/tickets/:id/messages', requireAuth, supportLimit, (req, res) => {
  const ticket = supportTicket(req, res);
  if (!ticket) return;
  if (ticket.status === 'closed') return res.status(409).json({ error: 'Este ticket está cerrado. Abre uno nuevo si necesitas más ayuda.' });
  const body = String(req.body?.body ?? '').trim();
  if (!body || body.length > 2000) return res.status(400).json({ error: 'Escribe tu mensaje (máx. 2000 caracteres)' });
  const isStaff = isOwnerId(req.userId) && ticket.user_id !== req.userId;
  const now = Math.floor(Date.now() / 1000);
  db.prepare('INSERT INTO support_messages (ticket_id, author_id, is_staff, body, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(ticket.id, req.userId, isStaff ? 1 : 0, body, now);
  db.prepare('UPDATE support_tickets SET status = ?, updated_at = ? WHERE id = ?').run(isStaff ? 'answered' : 'open', now, ticket.id);
  res.status(201).json({ ok: true });
});
app.post('/api/support/tickets/:id/close', requireAuth, (req, res) => {
  const ticket = supportTicket(req, res);
  if (!ticket) return;
  db.prepare("UPDATE support_tickets SET status = 'closed', updated_at = ? WHERE id = ?").run(Math.floor(Date.now() / 1000), ticket.id);
  res.json({ ok: true });
});

// Versiones de un script: lista sin código y, al pedir una, su código fuente (solo del dueño del script)
// Mantenimiento de un script: los loaders reciben MAINTENANCE y no se ejecuta nada
app.post('/api/scripts/:id/maintenance', requireAuth, (req, res) => {
  const script = stmt.scriptOwned.get(Number(req.params.id), req.userId);
  if (!script) return res.status(404).json({ error: 'Script no encontrado' });
  const on = req.body?.on === true ? 1 : 0;
  db.prepare('UPDATE scripts SET maintenance = ? WHERE id = ? AND user_id = ?').run(on, script.id, req.userId);
  res.json({ ok: true, maintenance: on === 1 });
});

app.get('/api/scripts/:id/versions', requireAuth, (req, res) => {
  const script = stmt.scriptOwned.get(Number(req.params.id), req.userId);
  if (!script) return res.status(404).json({ error: 'Script no encontrado' });
  res.json(db.prepare('SELECT id, name, obfuscator, ffa, source_hash, created_at FROM script_versions WHERE script_id = ? ORDER BY id DESC').all(script.id));
});
app.get('/api/scripts/:id/versions/:vid', requireAuth, (req, res) => {
  const script = stmt.scriptOwned.get(Number(req.params.id), req.userId);
  if (!script) return res.status(404).json({ error: 'Script no encontrado' });
  const v = db.prepare('SELECT id, name, obfuscator, ffa, source_hash, source, created_at FROM script_versions WHERE id = ? AND script_id = ?').get(Number(req.params.vid), script.id);
  if (!v) return res.status(404).json({ error: 'Versión no encontrada' });
  res.json(v);
});

// Borrar keys propias (una o varias, máximo 100 por petición)
const ownedKeyStmt = db.prepare('SELECT k.key FROM keys k JOIN scripts s ON s.id = k.script_id WHERE k.key = ? AND s.user_id = ?');
const deleteKeyStmt = db.prepare('DELETE FROM keys WHERE key = ?');
app.post('/api/keys/delete', requireAuth, (req, res) => {
  const list = Array.isArray(req.body?.keys) ? req.body.keys.map(String).slice(0, 100) : [];
  if (!list.length) return res.status(400).json({ error: 'No hay keys para borrar' });
  let deleted = 0;
  db.transaction(() => {
    for (const k of list) {
      if (ownedKeyStmt.get(k, req.userId)) { deleteKeyStmt.run(k); deleted++; }
    }
  })();
  res.json({ deleted });
});

// Ejecuciones de tus scripts por día (hora de Ecuador) y por script
// Ejecuciones de mis scripts por país (solo código de país, sin IPs)
// Filtro opcional ?script=ID: solo si el script es del usuario; devuelve null si no lo es
const ownScriptFilter = req => {
  if (req.query.script === undefined || req.query.script === '' || req.query.script === 'all') return { id: null };
  const id = Number(req.query.script);
  const own = Number.isInteger(id) && db.prepare('SELECT 1 FROM scripts WHERE id = ? AND user_id = ?').get(id, req.userId);
  return own ? { id } : null;
};

app.get('/api/stats/countries', requireAuth, (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 60);
  const since = ecuadorDay(Date.now() - (days - 1) * 86400_000);
  const f = ownScriptFilter(req);
  if (!f) return res.status(404).json({ error: 'Script no encontrado' });
  const rows = f.id === null
    ? db.prepare('SELECT country, SUM(n) AS n FROM execution_country WHERE user_id = ? AND day >= ? GROUP BY country ORDER BY n DESC')
        .all(String(req.userId), since)
    : db.prepare('SELECT country, SUM(n) AS n FROM execution_script_country WHERE script_id = ? AND day >= ? GROUP BY country ORDER BY n DESC')
        .all(f.id, since);
  const total = rows.reduce((a, r) => a + r.n, 0);
  res.json({ days, total, countries: rows, script: f.id });
});

// Ejecuciones por hora del día (hora de Ecuador), para ver cuándo juegan tus usuarios
app.get('/api/stats/hourly', requireAuth, (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 60);
  const since = ecuadorDay(Date.now() - (days - 1) * 86400_000);
  const f = ownScriptFilter(req);
  if (!f) return res.status(404).json({ error: 'Script no encontrado' });
  const only = f.id === null ? '' : ' AND h.script_id = ?';
  const extra = f.id === null ? [] : [f.id];
  const rows = db.prepare(`
    SELECT h.hour, SUM(h.n) AS n FROM execution_hourly h JOIN scripts s ON s.id = h.script_id
    WHERE s.user_id = ? AND h.day >= ?${only} GROUP BY h.hour ORDER BY h.hour`).all(req.userId, since, ...extra);
  res.json({ days, hours: rows });
});

app.get('/api/stats/executions', requireAuth, (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 60);
  const since = ecuadorDay(Date.now() - (days - 1) * 86400_000);
  const f = ownScriptFilter(req);
  if (!f) return res.status(404).json({ error: 'Script no encontrado' });
  const only = f.id === null ? '' : ' AND s.id = ?';
  const extra = f.id === null ? [] : [f.id];
  const byDay = db.prepare(`
    SELECT e.day, SUM(e.n) AS n FROM execution_daily e JOIN scripts s ON s.id = e.script_id
    WHERE s.user_id = ? AND e.day >= ?${only} GROUP BY e.day ORDER BY e.day`).all(req.userId, since, ...extra);
  const byScript = db.prepare(`
    SELECT s.id, s.name, SUM(e.n) AS n FROM execution_daily e JOIN scripts s ON s.id = e.script_id
    WHERE s.user_id = ? AND e.day >= ?${only} GROUP BY s.id ORDER BY n DESC LIMIT 10`).all(req.userId, since, ...extra);
  // Total del período anterior (mismo largo) para comparar en las estadísticas
  const prevSince = ecuadorDay(Date.now() - (days * 2 - 1) * 86400_000);
  const prevTotal = db.prepare(`
    SELECT COALESCE(SUM(e.n), 0) AS n FROM execution_daily e JOIN scripts s ON s.id = e.script_id
    WHERE s.user_id = ? AND e.day >= ? AND e.day < ?${only}`).get(req.userId, prevSince, since, ...extra).n;
  const total = byDay.reduce((a, r) => a + r.n, 0);
  res.json({ days, total, prevTotal, byDay, byScript, script: f.id });
});

app.get('/api/keys', requireAuth, (req, res) => {
  res.json(stmt.keysByUser.all(req.userId));
});

// ---------- Baneos del creador ----------
// Se puede banear por HWID, IP o usuario de Discord (solo en ese script)
const ownedKey = db.prepare('SELECT k.* FROM keys k JOIN scripts s ON s.id = k.script_id WHERE k.key = ? AND s.user_id = ?');
function applyBan(k, kind, reason, userId, on) {
  const now = Math.floor(Date.now() / 1000);
  if (kind === 'user') {
    if (!k.discord_id) return { error: 'Esta key no está vinculada a un usuario de Discord', status: 400 };
    db.transaction(() => {
      if (on) {
        db.prepare('INSERT OR REPLACE INTO bot_blacklist (script_id, discord_id, reason, created_at) VALUES (?, ?, ?, ?)').run(k.script_id, k.discord_id, reason, now);
        db.prepare('UPDATE keys SET banned = 1, ban_reason = ? WHERE script_id = ? AND discord_id = ?').run(reason, k.script_id, k.discord_id);
      } else {
        db.prepare('DELETE FROM bot_blacklist WHERE script_id = ? AND discord_id = ?').run(k.script_id, k.discord_id);
        db.prepare('UPDATE keys SET banned = 0, ban_reason = NULL WHERE script_id = ? AND discord_id = ?').run(k.script_id, k.discord_id);
      }
    })();
    return { ok: true };
  }
  const value = kind === 'hwid' ? k.hwid : k.last_ip;
  if (!value) return { error: kind === 'hwid' ? 'Esta key todavía no tiene HWID' : 'Todavía no sabemos la IP de esta key', status: 400 };
  if (on) db.prepare('INSERT OR REPLACE INTO script_bans (script_id, kind, value, reason, created_at) VALUES (?, ?, ?, ?, ?)').run(k.script_id, kind, value, reason, now);
  else db.prepare('DELETE FROM script_bans WHERE script_id = ? AND kind = ? AND value = ?').run(k.script_id, kind, value);
  return { ok: true };
}
function banRoute(on) {
  return (req, res) => {
    const k = ownedKey.get(req.params.key, req.userId);
    if (!k) return res.status(404).json({ error: 'Key no encontrada' });
    const kind = String(req.body?.kind || '');
    if (!['hwid', 'ip', 'user'].includes(kind)) return res.status(400).json({ error: 'Tipo de baneo inválido' });
    const reason = String(req.body?.reason || 'Baneado por el creador').slice(0, 200);
    const out = applyBan(k, kind, reason, req.userId, on);
    if (out.error) return res.status(out.status).json({ error: out.error });
    if (on) fireWebhooks(ownerOfScript(k.script_id), 'key.banned', { key: k.key, scriptId: k.script_id, kind, reason });
    res.json({ ok: true });
  };
}
app.post('/api/keys/:key/ban', requireAuth, banRoute(true));
app.post('/api/keys/:key/unban', requireAuth, banRoute(false));

// ---------- Blacklist (web) ----------
// Usuarios de Discord, IPs y HWID bloqueados en tus scripts (todos los planes).
const blScriptOwned = db.prepare('SELECT id, name FROM scripts WHERE id = ? AND user_id = ?');
app.get('/api/blacklist', requireAuth, (req, res) => {
  const scripts = db.prepare('SELECT id, name FROM scripts WHERE user_id = ? ORDER BY id').all(req.userId);
  const users = db.prepare(`SELECT b.script_id, b.discord_id, b.reason, b.created_at, s.name AS script
    FROM bot_blacklist b JOIN scripts s ON s.id = b.script_id WHERE s.user_id = ? ORDER BY b.created_at DESC`).all(req.userId);
  const bans = db.prepare(`SELECT b.script_id, b.kind, b.value, b.reason, b.created_at, s.name AS script
    FROM script_bans b JOIN scripts s ON s.id = b.script_id WHERE s.user_id = ? ORDER BY b.created_at DESC`).all(req.userId);
  res.json({ scripts, users, bans });
});
function blacklistChange(req, res, on) {
  const script = blScriptOwned.get(Number(req.body?.scriptId), req.userId);
  if (!script) return res.status(404).json({ error: 'Script no encontrado' });
  const kind = String(req.body?.kind || '');
  const value = String(req.body?.value || '').trim().slice(0, 128);
  const reason = String(req.body?.reason || 'Bloqueado por el creador').slice(0, 200);
  if (!['hwid', 'ip', 'user'].includes(kind)) return res.status(400).json({ error: 'Tipo inválido' });
  if (!value) return res.status(400).json({ error: 'Escribe el valor a bloquear' });
  if (kind === 'user' && !/^\d{17,20}$/.test(value)) return res.status(400).json({ error: 'El ID de Discord debe tener entre 17 y 20 números' });
  if (kind === 'ip' && !/^[0-9a-fA-F:.]{3,45}$/.test(value)) return res.status(400).json({ error: 'IP inválida' });
  const now = Math.floor(Date.now() / 1000);
  if (kind === 'user') {
    db.transaction(() => {
      if (on) {
        db.prepare('INSERT OR REPLACE INTO bot_blacklist (script_id, discord_id, reason, created_at) VALUES (?, ?, ?, ?)').run(script.id, value, reason, now);
        db.prepare('UPDATE keys SET banned = 1, ban_reason = ? WHERE script_id = ? AND discord_id = ?').run(reason, script.id, value);
      } else {
        db.prepare('DELETE FROM bot_blacklist WHERE script_id = ? AND discord_id = ?').run(script.id, value);
        db.prepare('UPDATE keys SET banned = 0, ban_reason = NULL WHERE script_id = ? AND discord_id = ?').run(script.id, value);
      }
    })();
  } else if (on) {
    db.prepare('INSERT OR REPLACE INTO script_bans (script_id, kind, value, reason, created_at) VALUES (?, ?, ?, ?, ?)').run(script.id, kind, value, reason, now);
  } else {
    db.prepare('DELETE FROM script_bans WHERE script_id = ? AND kind = ? AND value = ?').run(script.id, kind, value);
  }
  res.json({ ok: true });
}
app.post('/api/blacklist', requireAuth, (req, res) => blacklistChange(req, res, true));
app.post('/api/blacklist/remove', requireAuth, (req, res) => blacklistChange(req, res, false));

// ==========================================
// WEBHOOKS: avisos al servidor del dueño (firmados con HMAC)
// ==========================================
db.exec(`CREATE TABLE IF NOT EXISTS webhooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  events TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER,
  last_status INTEGER,
  last_error TEXT,
  last_at INTEGER
)`);
db.exec('CREATE INDEX IF NOT EXISTS webhooks_by_user ON webhooks(user_id)');
const WEBHOOK_EVENTS = ['key.created', 'key.banned', 'key.shared', 'script.tamper'];
const WEBHOOK_MAX = 5;

// Solo IPs públicas: evita que un webhook apunte a la red interna del servidor
function isPublicIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    return true;
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    return !(l === '::' || l === '::1' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80') || l.startsWith('::ffff:'));
  }
  return false;
}
async function isPublicHttpsUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  if (u.port && u.port !== '443') return false;
  const host = u.hostname.toLowerCase();
  if (net.isIP(host)) return isPublicIp(host);
  if (!host.includes('.') || host === 'localhost' || host.endsWith('.local')) return false;
  try {
    const addrs = await dns.promises.lookup(host, { all: true });
    return addrs.length > 0 && addrs.every(a => isPublicIp(a.address));
  } catch { return false; }
}

async function deliverWebhook(w, event, data) {
  const body = JSON.stringify({ event, at: Math.floor(Date.now() / 1000), data });
  const sig = crypto.createHmac('sha256', w.secret).update(body).digest('hex');
  let status = null;
  let err = null;
  // Se revisa otra vez al enviar: el dominio podría haber cambiado de IP desde que se registró
  if (!(await isPublicHttpsUrl(w.url))) {
    err = 'URL no permitida';
  } else {
    try {
      const r = await fetch(w.url, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Vantarmor-Webhook/1',
          'X-Vantarmor-Event': event,
          'X-Vantarmor-Signature': `sha256=${sig}`,
        },
        body,
      });
      status = r.status;
      if (!r.ok) err = `HTTP ${r.status}`;
    } catch (e) {
      err = e?.name === 'TimeoutError' ? 'tiempo agotado' : String(e?.message || 'error de red').slice(0, 120);
    }
  }
  try {
    db.prepare('UPDATE webhooks SET last_status = ?, last_error = ?, last_at = ? WHERE id = ?')
      .run(status, err, Math.floor(Date.now() / 1000), w.id);
  } catch { /* el registro del resultado nunca rompe el loader */ }
}

// Envía el evento a todos los webhooks activos del dueño que escuchan ese evento (en segundo plano)
function fireWebhooks(userId, event, data) {
  if (!userId) return;
  try {
    const rows = db.prepare('SELECT id, url, secret FROM webhooks WHERE user_id = ? AND active = 1 AND events LIKE ?')
      .all(String(userId), `%,${event},%`);
    for (const w of rows) deliverWebhook(w, event, data).catch(() => {});
  } catch { /* nunca rompe la acción principal */ }
}
const ownerOfScript = scriptId => {
  try { return db.prepare('SELECT user_id FROM scripts WHERE id = ?').get(scriptId)?.user_id || null; } catch { return null; }
};

const webhookRow = w => ({ ...w, events: String(w.events || '').split(',').filter(Boolean) });
app.get('/api/webhooks', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT id, url, events, active, last_status, last_error, last_at, created_at FROM webhooks WHERE user_id = ? ORDER BY id DESC')
    .all(String(req.userId));
  res.json(rows.map(webhookRow));
});
app.post('/api/webhooks', requireAuth, async (req, res) => {
  const url = String(req.body?.url || '').trim().slice(0, 500);
  const events = [...new Set((Array.isArray(req.body?.events) ? req.body.events : []).map(String))]
    .filter(e => WEBHOOK_EVENTS.includes(e));
  if (!events.length) return res.status(400).json({ error: 'Elige al menos un evento' });
  if (!(await isPublicHttpsUrl(url))) return res.status(400).json({ error: 'La URL debe ser https y apuntar a un servidor público' });
  const count = db.prepare('SELECT COUNT(*) AS n FROM webhooks WHERE user_id = ?').get(String(req.userId)).n;
  if (count >= WEBHOOK_MAX) return res.status(400).json({ error: `Máximo ${WEBHOOK_MAX} webhooks` });
  const secret = crypto.randomBytes(24).toString('hex');
  const info = db.prepare('INSERT INTO webhooks (user_id, url, secret, events, active, created_at) VALUES (?, ?, ?, ?, 1, ?)')
    .run(String(req.userId), url, secret, `,${events.join(',')},`, Math.floor(Date.now() / 1000));
  // El secreto solo se muestra una vez, al crear el webhook
  res.json({ id: Number(info.lastInsertRowid), secret });
});
app.delete('/api/webhooks/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM webhooks WHERE id = ? AND user_id = ?').run(Number(req.params.id), String(req.userId));
  res.json({ ok: true });
});
app.post('/api/webhooks/:id/test', requireAuth, async (req, res) => {
  const w = db.prepare('SELECT id, url, secret FROM webhooks WHERE id = ? AND user_id = ?').get(Number(req.params.id), String(req.userId));
  if (!w) return res.status(404).json({ error: 'Webhook no encontrado' });
  await deliverWebhook(w, 'webhook.test', { message: 'Prueba de webhook de Vantarmor' });
  const row = db.prepare('SELECT last_status, last_error, last_at FROM webhooks WHERE id = ?').get(w.id);
  res.json(row);
});

app.post('/api/keys', requireAuth, (req, res) => {
  if (maintenanceBlock(req, res)) return;
  const scriptId = Number(req.body?.scriptId);
  const amount = req.body?.amount === undefined ? 1 : Number(req.body.amount);
  const days = req.body?.days === undefined || req.body.days === null ? null : Number(req.body.days);

  if (!Number.isInteger(scriptId)) return res.status(400).json({ error: 'scriptId inválido' });
  if (!Number.isInteger(amount) || amount < 1 || amount > 50) return res.status(400).json({ error: 'La cantidad debe estar entre 1 y 50' });
  if (days !== null && (!Number.isInteger(days) || days < 1 || days > 3650)) return res.status(400).json({ error: 'Días inválidos' });

  const script = stmt.scriptOwned.get(scriptId, req.userId);
  if (!script) return res.status(403).json({ error: 'No autorizado' });

  const expiresAt = days ? Math.floor(Date.now() / 1000) + days * 86400 : null;

  if (!quotaApi.reserveKeys(req.userId, amount)) {
    return res.status(403).json({ error: `Tu plan Free permite ${keyCapFor(req.userId)} keys cada 15 días. Te quedan ${quotaApi.keysLeft(req.userId)}.` });
  }

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
    fireWebhooks(req.userId, 'key.created', { scriptId: script.id, count: generated.length, keys: generated });
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
    quota: quotaApi,
    token: process.env.DISCORD_BOT_TOKEN,
    clientId: DISCORD_CLIENT_ID,
    guildId: process.env.DISCORD_GUILD_ID || undefined,
    publicUrl: process.env.PUBLIC_URL || FRONTEND_URL,
    ownerId: process.env.DISCORD_OWNER_ID || undefined, // tu ID de Discord (dueño del workspace)
  }).then(client => { discordBot = client; }).catch(err => console.error('[Bot] No se pudo iniciar:', err.message));
} else {
  console.warn('[Bot] DISCORD_BOT_TOKEN o DISCORD_CLIENT_ID no definidos: el bot no se inicia.');
}
// ==========================================
// Limpieza: los logs de scripts solo se guardan 1 día; el conteo de ejecuciones queda en execution_daily (60 días)
const LOG_KEEP_SECONDS = 86400;
function pruneOldData() {
  try {
    const t = Math.floor(Date.now() / 1000);
    const logs = db.prepare('DELETE FROM script_logs WHERE created_at < ?').run(t - LOG_KEEP_SECONDS).changes;
    db.prepare('DELETE FROM execution_daily WHERE day < ?').run(ecuadorDay(Date.now() - 60 * 86400_000));
    db.prepare('DELETE FROM execution_country WHERE day < ?').run(ecuadorDay(Date.now() - 60 * 86400_000));
    db.prepare('DELETE FROM execution_script_country WHERE day < ?').run(ecuadorDay(Date.now() - 60 * 86400_000));
    db.prepare('DELETE FROM execution_hourly WHERE day < ?').run(ecuadorDay(Date.now() - 60 * 86400_000));
    db.prepare('DELETE FROM obf_cache WHERE created_at < ?').run(Math.floor(Date.now() / 1000) - 7 * 86400);
    if (logs) console.log(`[Limpieza] ${logs} logs de scripts borrados (más de 1 día).`);
  } catch (err) { console.error('[Limpieza] Error:', err.message); }
}
pruneOldData();
setInterval(pruneOldData, 60 * 60_000).unref();

// Respaldo diario de la base (copia en la misma carpeta de datos; se conservan los últimos 7)
const BACKUP_DIR = path.join(path.dirname(DATABASE_PATH), 'backups');
async function backupDb() {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const file = path.join(BACKUP_DIR, `vantarmor-${ecuadorDay(Date.now())}.db`);
    if (fs.existsSync(file)) return;
    await db.backup(file);
    const files = fs.readdirSync(BACKUP_DIR).filter(f => /^vantarmor-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
    for (const old of files.slice(0, -7)) fs.rmSync(path.join(BACKUP_DIR, old), { force: true });
    console.log(`[Respaldo] Copia guardada: ${file}`);
  } catch (err) { console.error('[Respaldo] No se pudo respaldar:', err.message); }
}
backupDb();
setInterval(backupDb, 6 * 60 * 60_000).unref();

// Errores que no pasan por una ruta: respuesta JSON clara (en vez de HTML o "Error del servidor" sin detalle)
app.use((err, req, res, next) => {
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'El script es demasiado grande. El límite es de 2 MB de código.' });
  }
  if (res.headersSent) return next(err);
  console.error('Error no controlado:', err);
  res.status(err?.status && err.expose ? err.status : 500).json({
    error: err?.status && err.expose ? err.message : 'Error del servidor. Inténtalo de nuevo.',
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Servidor Vantarmor corriendo en el puerto ${PORT}`);
});
