import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { makeDecoyTrace } from './lib/decoy-trace.js';
import { LUA_SHA256, LUA_SHA256_CORE } from './lib/lua-sha256.js';
import net from 'net';
import dns from 'dns';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execFile } from 'child_process';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { normalizeLuaSource } from './lib/lua-source.js';
import { openDatabase } from './lib/db-engine.js';
import { validateRemoteBlocks, remoteBlocks, stripRemoteBlocks, hasRemoteBlocks, remoteHeader, hasStrayMarkers } from './lib/remote-blocks.js';
import { createQuota, PLAN_DAYS_DEFAULT, MONTH_SECONDS, FREE_RESET_SECONDS } from './lib/quota.js';
import { analyzePerf } from './lib/perf.js';
import { buildLua, BuildError } from './lib/nextofuscator/build.js';
import { buildVantObf, BuildError as VantBuildError } from './lib/vantobf/build.js';
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
// Límite solo de INTENTOS FALLIDOS por IP (key inválida/faltante, script no encontrado).
// Las ejecuciones con key correcta no cuentan: no expulsan a jugadores que comparten IP.
const authFails = new Map();
const AUTH_FAIL_MAX = 40;
const AUTH_FAIL_WINDOW = 5 * 60_000;
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of authFails) if (e.reset < now) authFails.delete(ip);
}, 60_000).unref();
function authBlocked(ip) {
  const e = authFails.get(ip);
  return Boolean(e) && e.reset > Date.now() && e.count >= AUTH_FAIL_MAX;
}
function noteAuthFail(ip) {
  const now = Date.now();
  let e = authFails.get(ip);
  if (!e || e.reset < now) { e = { count: 0, reset: now + AUTH_FAIL_WINDOW }; authFails.set(ip, e); }
  e.count++;
}
const jsonLimit = rateLimit({
  windowMs: 60_000,
  max: 30,
  onLimit: (req, res) => res.status(429).json({ error: 'Demasiadas peticiones. Espera un minuto.' }),
}); // Railway pone la IP real en X-Forwarded-For

// ==========================================
// 0. CONSTANTES Y CONFIGURACIÓN
// ==========================================
const MAX_CODE_BYTES = 2 * 1024 * 1024;           // 2 MB por script
// 'next' = Ofuscador 4 (NextOfuscator, lib/nextofuscator, predeterminado); 'luau' = Ofuscador 3 (LuaUObfuscator, solo Premium Plus); 'vantobf' = Ofuscador 5 (VantVM).
// 'none' = No obf (sin ofuscar, solo key). Ofuscador 1 (RealObfuscator) y Ofuscador 2 (Obscura) se quitaron.
const OBFUSCATORS = ['luau', 'next', 'vantobf', 'none'];
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
  FRONTEND_URL = 'https://vantarmor.up.railway.app',
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

// Variables críticas que deben estar definidas en producción
const MISSING_CRITICAL = ['DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'DISCORD_OWNER_ID'].filter(k => !process.env[k]);
if (MISSING_CRITICAL.length) console.warn(`⚠️  Variables críticas no definidas: ${MISSING_CRITICAL.join(', ')}. Algunas funciones no estarán disponibles.`);

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

// Restauración pendiente: /api/owner/import-db deja la copia en "<base>.import" y se aplica aquí, antes de abrir la base.
// La base anterior no se borra: queda como "<base>.replaced-<fecha>" por si hay que volver atrás.
if (process.env.DB_ENGINE !== 'postgres' && fs.existsSync(`${DATABASE_PATH}.import`)) {
  const stamp = Date.now();
  if (fs.existsSync(DATABASE_PATH)) {
    fs.renameSync(DATABASE_PATH, `${DATABASE_PATH}.replaced-${stamp}`);
    for (const ext of ['-wal', '-shm', '-journal']) {
      if (fs.existsSync(DATABASE_PATH + ext)) fs.renameSync(DATABASE_PATH + ext, `${DATABASE_PATH}.replaced-${stamp}${ext}`);
    }
  }
  fs.renameSync(`${DATABASE_PATH}.import`, DATABASE_PATH);
  console.log(`[Restauración] Copia aplicada en ${DATABASE_PATH}. La anterior quedó como ${DATABASE_PATH}.replaced-${stamp}`);
}

// Abre la base y, si conviene, la compacta al arrancar. Los DELETE de las podas reutilizan
// paginas internas y el archivo deja de crecer, pero solo un VACUUM devuelve el espacio al
// volumen, y un VACUUM normal no cabe cuando el volumen esta lleno. Ruta segura: VACUUM INTO
// a /tmp (disco efimero del contenedor, no gasta volumen), verificacion de integridad y de
// conteos, y recien entonces se reemplaza el archivo. Si algo falla, la base original queda.
function openCompactedDb() {
  let conn = openDatabase(DATABASE_PATH);
  if (process.env.DB_ENGINE === 'postgres') return conn;
  const mb = b => `${(b / 1048576).toFixed(1)} MB`;
  const tmp = '/tmp/vantarmor-compact.db';
  const bakTmp = '/tmp/vantarmor-precompact.bak';
  try {
    // poda previa: asi el VACUUM recupera justo las paginas que quedaron libres
    try { conn.prepare('DELETE FROM script_logs WHERE created_at < ?').run(Math.floor(Date.now() / 1000) - 7 * 86400); } catch {}
    try { conn.prepare('DELETE FROM loader_downloads WHERE created_at < ?').run(Math.floor(Date.now() / 1000) - 30 * 86400); } catch {} // 30 dias, mismo valor que LOADER_LOG_DAYS (declarado mas abajo)
    // resto de restauraciones anteriores (.replaced-*, .import): cada una pesa lo mismo que la base
    const dir = path.dirname(DATABASE_PATH);
    const baseName = path.basename(DATABASE_PATH);
    for (const f of fs.readdirSync(dir)) {
      // La copia "replaced" de una restauración se crea en ESTE mismo arranque (antes de esta limpieza):
      // se conserva 2 días para poder volver atrás. Borrarla aquí perdía los datos de antes de restaurar.
      const replacedStamp = /\.replaced-(\d+)/.exec(f);
      if (replacedStamp && Date.now() - Number(replacedStamp[1]) < 2 * 86400_000) continue;
      if (f === baseName + '.import' || f.startsWith(baseName + '.replaced-') || f.startsWith(baseName + '.precompact')) {
        const p = path.join(dir, f);
        const s = fs.statSync(p).size;
        fs.unlinkSync(p);
        console.log(`[Limpieza] Resto de restauracion eliminado: ${f} (${mb(s)})`);
      }
    }
    const pageSize = conn.pragma('page_size', { simple: true });
    const freelist = conn.pragma('freelist_count', { simple: true });
    const fileBytes = fs.statSync(DATABASE_PATH).size;
    const freeable = freelist * pageSize;
    // Modo incremental (auto_vacuum=2): las podas devuelven el espacio al volumen con incremental_vacuum,
    // sin copiar la base. Si la base aún está en modo normal, se reconstruye una vez en ese modo aunque
    // haya poco que recuperar (ver abajo: el pragma se aplica antes del VACUUM INTO).
    const autoVac = conn.pragma('auto_vacuum', { simple: true });
    if (freeable < fileBytes * 0.1 && autoVac === 2) {
      console.log(`[Limpieza] Compactacion al arranque omitida: recuperables ${mb(freeable)} de ${mb(fileBytes)}`);
      return conn;
    }
    try { fs.unlinkSync(tmp); } catch {}
    try { fs.unlinkSync(bakTmp); } catch {}
    conn.pragma('wal_checkpoint(TRUNCATE)');
    // VACUUM INTO toma el modo de auto_vacuum del pragma si se fija antes: así la copia queda en modo incremental
    if (autoVac !== 2) conn.pragma('auto_vacuum = INCREMENTAL');
    conn.exec(`VACUUM INTO '${tmp}'`);
    const vacSize = fs.statSync(tmp).size;
    const counts = {};
    for (const t of ['users', 'scripts', 'keys']) {
      try { counts[t] = conn.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n; } catch { counts[t] = null; }
    }
    const Database = createRequire(import.meta.url)('better-sqlite3');
    const check = new Database(tmp, { readonly: true });
    try {
      const integrity = check.pragma('integrity_check', { simple: true });
      if (integrity !== 'ok') throw new Error(`la copia compacta no paso la verificacion (${integrity})`);
      for (const [t, n] of Object.entries(counts)) {
        if (n == null) continue;
        const m = check.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
        if (m !== n) throw new Error(`conteo distinto en ${t}: ${n} -> ${m}`);
      }
    } finally { check.close(); }
    const bak = `${DATABASE_PATH}.precompact`;
    try { fs.rmSync(bak, { force: true }); } catch {}
    const free = fs.statfsSync(dir).bavail * fs.statfsSync(dir).bsize;
    let bakOnTmp = false;
    if (free >= vacSize * 1.1) {
      fs.renameSync(DATABASE_PATH, bak); // la original queda en el volumen como respaldo
    } else {
      // volumen sin margen: respaldo en el disco efimero y se libera el volumen para copiar
      fs.copyFileSync(DATABASE_PATH, bakTmp);
      fs.unlinkSync(DATABASE_PATH);
      bakOnTmp = true;
    }
    try {
      fs.copyFileSync(tmp, DATABASE_PATH);
    } catch (err) {
      try { fs.rmSync(DATABASE_PATH, { force: true }); } catch {}
      if (!bakOnTmp && fs.existsSync(bak)) fs.renameSync(bak, DATABASE_PATH);
      else fs.copyFileSync(bakTmp, DATABASE_PATH);
      throw err;
    }
    conn.close();
    conn = openDatabase(DATABASE_PATH);
    for (const [t, n] of Object.entries(counts)) {
      if (n == null) continue;
      const m = conn.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
      if (m !== n) throw new Error(`conteo distinto tras reemplazar en ${t}`);
    }
    try { fs.rmSync(bak, { force: true }); } catch {}
    try { fs.unlinkSync(tmp); } catch {}
    try { fs.unlinkSync(bakTmp); } catch {}
    console.log(`[Limpieza] Base compactada al arranque: ${mb(fileBytes)} -> ${mb(fs.statSync(DATABASE_PATH).size)}`);
  } catch (err) {
    console.warn('[Limpieza] Compactacion al arranque falló:', err.message);
    try { if (conn.open === false) conn = openDatabase(DATABASE_PATH); } catch {}
  }
  return conn;
}

const db = openCompactedDb();
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
    // Copia el HWID actual solo si la tabla tiene esa columna (en algunas bases no existe y el arranque se caía)
    if (db.prepare("SELECT 1 FROM pragma_table_info('keys') WHERE name = 'hwid'").get()) {
      db.exec('UPDATE keys SET last_hwid = hwid WHERE hwid IS NOT NULL');
    }
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
  if (!cols.includes('hwid_lock')) db.exec('ALTER TABLE scripts ADD COLUMN hwid_lock INTEGER DEFAULT 1');
  // 1 = entregar el código ofuscado (content). 0 = comportamiento actual (código original). Se activa por script tras probarlo en móvil
  if (!cols.includes('serve_protected')) db.exec('ALTER TABLE scripts ADD COLUMN serve_protected INTEGER DEFAULT 0');
  if (!cols.includes('obf_mode')) db.exec("ALTER TABLE scripts ADD COLUMN obf_mode TEXT DEFAULT 'medium'");
  if (!cols.includes('guard_secret')) db.exec('ALTER TABLE scripts ADD COLUMN guard_secret TEXT');
  // Entrega en dos pasos: /auth (GET) solo da un token de un solo uso, y el código sale de /payload (POST). 0 = como antes
  if (!cols.includes('secure_fetch')) db.exec('ALTER TABLE scripts ADD COLUMN secure_fetch INTEGER DEFAULT 0');
  // Detección de keys compartidas (1 = activa)
  if (!cols.includes('share_detection')) db.exec('ALTER TABLE scripts ADD COLUMN share_detection INTEGER DEFAULT 1');
  if (!cols.includes('auto_revoke_dump')) db.exec('ALTER TABLE scripts ADD COLUMN auto_revoke_dump INTEGER DEFAULT 0');
  if (!cols.includes('updated_at')) db.exec('ALTER TABLE scripts ADD COLUMN updated_at INTEGER');
  if (!cols.includes('version')) db.exec("ALTER TABLE scripts ADD COLUMN version TEXT DEFAULT ''");
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

// Proyectos: agrupan scripts. La whitelist por proyecto aplica a todos sus scripts.
db.exec(`CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER,
  logs_webhook TEXT, alert_webhook TEXT, allow_hwid_reset INTEGER DEFAULT 1, hwid_reset_cooldown_days INTEGER, auto_delete_expired INTEGER DEFAULT 0, allow_hwid_clone_sharing INTEGER DEFAULT 0)`);
// Migracion: proyectos existentes ganan los campos nuevos; keys ganan project_id (key de proyecto)
for (const [col, def] of [['logs_webhook','TEXT'],['alert_webhook','TEXT'],['allow_hwid_reset','INTEGER DEFAULT 1'],['hwid_reset_cooldown_days','INTEGER'],['auto_delete_expired','INTEGER DEFAULT 0'],['allow_hwid_clone_sharing','INTEGER DEFAULT 0']]) {
  if (!db.prepare(`SELECT 1 FROM pragma_table_info('projects') WHERE name = ?`).get(col)) db.exec(`ALTER TABLE projects ADD COLUMN ${col} ${def}`);
}
if (!db.prepare("SELECT 1 FROM pragma_table_info('keys') WHERE name = 'project_id'").get()) db.exec('ALTER TABLE keys ADD COLUMN project_id INTEGER');
// Todo script sin proyecto va al primer proyecto de su dueno (se crea uno si no tiene): el panel ya no deja scripts sueltos
(function ensureDefaultProjects() {
  for (const row of db.prepare('SELECT DISTINCT user_id FROM scripts WHERE project_id IS NULL').all()) {
    let p = db.prepare('SELECT id FROM projects WHERE user_id = ? ORDER BY id ASC LIMIT 1').get(row.user_id);
    if (!p) {
      const info = db.prepare('INSERT INTO projects (user_id, name, created_at) VALUES (?, ?, ?)').run(row.user_id, 'Proyecto 1', Math.floor(Date.now() / 1000));
      p = { id: Number(info.lastInsertRowid) };
    }
    db.prepare('UPDATE scripts SET project_id = ? WHERE user_id = ? AND project_id IS NULL').run(p.id, row.user_id);
  }
})();
db.exec(`CREATE TABLE IF NOT EXISTS bot_project_rules (project_id INTEGER NOT NULL, kind TEXT NOT NULL, discord_id TEXT NOT NULL, label TEXT, expires_at INTEGER, PRIMARY KEY (project_id, kind, discord_id))`);
if (!db.prepare("SELECT 1 FROM pragma_table_info('scripts') WHERE name = 'project_id'").get()) db.exec('ALTER TABLE scripts ADD COLUMN project_id INTEGER');
// Planes con vencimiento: días de cada key y fecha de vencimiento del plan del usuario
for (const sql of [
  "ALTER TABLE plan_keys ADD COLUMN days INTEGER",
  "ALTER TABLE users ADD COLUMN custom_scripts INTEGER",
  "ALTER TABLE users ADD COLUMN custom_obfuscations INTEGER",
  "ALTER TABLE users ADD COLUMN custom_panels INTEGER",
  "ALTER TABLE custom_plan_requests ADD COLUMN payment_method TEXT",
  "ALTER TABLE custom_plan_requests ADD COLUMN contact TEXT",
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
const expireAllStmt = db.prepare("UPDATE users SET plan = 'free', plan_expires_at = NULL, plan_expired_at = ? WHERE plan IN ('premium','plus','custom') AND plan_expires_at IS NOT NULL AND plan_expires_at <= ?");
const expireOneStmt = db.prepare("UPDATE users SET plan = 'free', plan_expires_at = NULL, plan_expired_at = ? WHERE id = ? AND plan IN ('premium','plus','custom') AND plan_expires_at IS NOT NULL AND plan_expires_at <= ?");
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
db.exec('CREATE INDEX IF NOT EXISTS scripts_by_user ON scripts(user_id)');
db.exec('CREATE INDEX IF NOT EXISTS keys_by_script ON keys(script_id)');
db.exec('CREATE INDEX IF NOT EXISTS keys_by_discord ON keys(discord_id)');
db.exec('CREATE INDEX IF NOT EXISTS plan_keys_by_user ON plan_keys(used_by)');
// Solicitudes del plan Custom: el usuario elige cuántos scripts, ofuscaciones y paneles; el dueño las aprueba
// Prueba gratis de Premium/Plus: una key por cuenta y plan. Reclamar otra vez (al vencer) suma 3 días a la misma key
db.exec(`CREATE TABLE IF NOT EXISTS free_ad_views (user_id TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0, updated_at INTEGER)`);
db.exec(`CREATE TABLE IF NOT EXISTS free_claims (user_id TEXT NOT NULL, plan TEXT NOT NULL, key TEXT NOT NULL UNIQUE, claimed_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, renewals INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, plan))`);
// Créditos de anuncio recompensado (Unity Ads, callback server a server). oid es único: evita reusar un anuncio
db.exec(`CREATE TABLE IF NOT EXISTS ad_credits (oid TEXT PRIMARY KEY, sid TEXT NOT NULL, created_at INTEGER NOT NULL, used_at INTEGER)`);
db.exec(`CREATE TABLE IF NOT EXISTS custom_plan_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, scripts INTEGER NOT NULL, obfuscations INTEGER NOT NULL, panels INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER, decided_at INTEGER)`);
// El historial de versiones se quitó: la tabla se borra al arrancar para liberar su espacio
try { db.exec('DROP TABLE IF EXISTS script_versions'); } catch (err) { console.warn('[Limpieza] script_versions:', err.message); }
// Soporte web: tickets y mensajes (el dueño responde como soporte)
db.exec(`CREATE TABLE IF NOT EXISTS support_tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, username TEXT, category TEXT NOT NULL,
  subject TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', script_id INTEGER, created_at INTEGER, updated_at INTEGER)`);
db.exec(`CREATE TABLE IF NOT EXISTS support_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL, author_id TEXT, is_staff INTEGER DEFAULT 0, body TEXT NOT NULL, created_at INTEGER)`);
db.exec('CREATE INDEX IF NOT EXISTS support_messages_by_ticket ON support_messages(ticket_id)');
db.exec('CREATE TABLE IF NOT EXISTS admin_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT, action TEXT, target TEXT, detail TEXT, created_at INTEGER)');
// Cada arranque del servicio deja una fila: el panel admin ve el historial de deploys
 db.exec(`CREATE TABLE IF NOT EXISTS app_deploys (id INTEGER PRIMARY KEY AUTOINCREMENT, deployment_id TEXT, commit_sha TEXT, started_at INTEGER NOT NULL)`);
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

// key_days (estilo de la referencia): keys "en stock" cuyo reloj arranca en la primera ejecucion
if (!db.prepare("SELECT 1 FROM pragma_table_info('keys') WHERE name = 'key_days'").get()) {
  db.exec('ALTER TABLE keys ADD COLUMN key_days INTEGER');
}
// Limites de key (estilo de la referencia): reinicios de HWID por key y limite de ejecuciones
if (!db.prepare("SELECT 1 FROM pragma_table_info('keys') WHERE name = 'hwid_resets'").get()) {
  db.exec('ALTER TABLE keys ADD COLUMN hwid_resets INTEGER');
}
if (!db.prepare("SELECT 1 FROM pragma_table_info('keys') WHERE name = 'exec_limit'").get()) {
  db.exec('ALTER TABLE keys ADD COLUMN exec_limit INTEGER');
}
if (!db.prepare("SELECT 1 FROM pragma_table_info('scripts') WHERE name = 'hwid_reset_limit'").get()) {
  db.exec('ALTER TABLE scripts ADD COLUMN hwid_reset_limit INTEGER DEFAULT 3');
}

// Contador de intentos de volcado por script (equivalente a "attacks_blocked" de la referencia)
if (!db.prepare("SELECT 1 FROM pragma_table_info('scripts') WHERE name = 'dump_attempts'").get()) {
  db.exec('ALTER TABLE scripts ADD COLUMN dump_attempts INTEGER');
}
if (!db.prepare("SELECT 1 FROM pragma_table_info('scripts') WHERE name = 'last_dump_at'").get()) {
  db.exec('ALTER TABLE scripts ADD COLUMN last_dump_at INTEGER');
}
// Los avisos blandos ya no se envian (marcaban ejecuciones normales como intentos de volcado);
// los eventos blandos viejos se eliminan para que el registro quede solo con cortes reales.
// En una base nueva dump_events todavia no existe aqui: solo se limpia si la tabla ya esta.
if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'dump_events'").get()) {
  db.prepare('DELETE FROM dump_events WHERE soft = 1').run();
}
// Secreto por script para la firma anti-spoof del auth (el loader lo lleva horneado)
if (!db.prepare("SELECT 1 FROM pragma_table_info('scripts') WHERE name = 'auth_secret'").get()) {
  db.exec('ALTER TABLE scripts ADD COLUMN auth_secret TEXT');
}

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
    SELECT id, user_id, name, slug, loader_id, ffa, obfuscator, obf_mode, hwid_reset_hours, share_detection, auto_revoke_dump, maintenance, clyde_vm, perf_level, project_id, hwid_lock, COALESCE(dump_attempts, 0) AS dump_attempts, last_dump_at, updated_at, version FROM scripts
    WHERE user_id = ? ORDER BY id DESC
  `),
  scriptOwned: db.prepare('SELECT * FROM scripts WHERE id = ? AND user_id = ?'),
  scriptInsert: db.prepare(`
    INSERT INTO scripts (user_id, project_id, name, slug, ffa, obfuscator, obf_mode, guard_secret, source, content, hwid_reset_hours, share_detection, clyde_vm, auto_revoke_dump, hwid_lock, updated_at, version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  scriptUpdate: db.prepare(`
    UPDATE scripts SET name = ?, ffa = ?, obfuscator = ?, obf_mode = ?, guard_secret = ?, source = ?, content = ?, hwid_reset_hours = ?, share_detection = ?, clyde_vm = ?, auto_revoke_dump = ?, hwid_lock = ?, updated_at = ?, version = COALESCE(?, version)
    WHERE id = ? AND user_id = ?
  `),
  keysByUser: db.prepare(`
    SELECT k.key, k.script_id, k.project_id, k.expires_at, k.banned, k.hwid, k.discord_id, k.last_ip,
           k.key_days, k.exec_count, k.exec_limit, k.hwid_resets, k.hwid_reset_at,
           CASE WHEN k.banned = 1 THEN 'banned'
                WHEN k.hwid IS NULL OR k.hwid = '' THEN 'reset'
                ELSE 'active' END AS status
    FROM keys k
    LEFT JOIN scripts s ON s.id = k.script_id
    WHERE s.user_id = ? OR EXISTS (SELECT 1 FROM projects p WHERE p.id = k.project_id AND p.user_id = ?)
  `),
  keyInsert: db.prepare('INSERT INTO keys (key, script_id, expires_at, key_days, project_id) VALUES (?, ?, ?, ?, ?)'),
  slugExists: db.prepare('SELECT 1 FROM scripts WHERE slug = ?'),
  scriptBySlug: db.prepare('SELECT * FROM scripts WHERE slug = ?'),
  scriptByLoaderId: db.prepare('SELECT * FROM scripts WHERE loader_id = ?'),
};

// ==========================================
// 1b. MANTENIMIENTO GLOBAL + PANEL DE ADMIN
// ==========================================
// Dos interruptores independientes guardados en app_settings:
//   maintenance        -> el SITIO (paginas web y /api) responde 404 con una pantalla bonita
//   maintenance_loader -> los LOADERS (/scripts/hosted, /files/v1/loaders, /v1/l, /v1/a, /auth)
//                         responden con un print() de Lua para que loadstring lo muestre.
// El panel /admin solo entra con una sesion de Discord cuyo ID este en ADMIN_DISCORD_IDS.
const BOOT_AT = Date.now();
const ADMIN_DISCORD_IDS = ['1501316920975036611', '1521690277436198983'];

function maintenanceState() {
  return {
    site: appGet('maintenance') === '1',
    loader: appGet('maintenance_loader') === '1',
    message: appGet('maintenance_msg') || '',
  };
}

const MAINTENANCE_HTML = `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>404 · En mantenimiento</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body {
    font-family: 'Inter', system-ui, sans-serif; color: #fff; background: #000;
    display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 24px;
    background-image: radial-gradient(circle at 15% 50%, rgba(255,255,255,.04) 0%, transparent 50%),
                      radial-gradient(circle at 85% 30%, rgba(255,255,255,.03) 0%, transparent 50%);
  }
  .card {
    max-width: 460px; width: 100%; text-align: center; padding: 48px 36px;
    background: linear-gradient(145deg, rgba(28,28,33,.55), rgba(10,10,12,.85));
    border: 1px solid rgba(255,255,255,.08); border-radius: 20px;
  }
  .code { font-family: 'JetBrains Mono', monospace; font-size: 13px; color: #8a8a94; letter-spacing: .3em; }
  h1 { font-size: 28px; margin: 14px 0 10px; font-weight: 700; }
  p { color: #bcbcc4; line-height: 1.6; font-size: 15px; }
  a { display: inline-block; margin-top: 24px; padding: 10px 22px; border-radius: 10px;
      background: #fff; color: #000; text-decoration: none; font-weight: 600; font-size: 14px; }
  .glow { width: 46px; height: 46px; margin: 0 auto 18px; border-radius: 50%;
          background: radial-gradient(circle at 35% 30%, #fff, #5b5b66 70%);
          box-shadow: 0 0 34px rgba(255,255,255,.35); }
</style></head>
<body><div class="card">
  <div class="glow"></div>
  <div class="code">404</div>
  <h1>Estamos en mantenimiento</h1>
  <p>VantArmor vuelve en un rato. Si necesitas algo mientras tanto, entra al servidor de Discord para las novedades.</p>
  <a href="https://discord.gg/aKQNc6pC">Ir al Discord</a>
  <a href="/" style="margin-left:12px;opacity:.7">Admins only</a>
</div><script src="/i18n.js"></script></body></html>`;

// Rutas de loader: la respuesta depende del interruptor de loaders (print de Lua)
const LOADER_PATH_RE = /^\/(v1\/l|v1\/a|scripts\/hosted\/[^/]+(\/auth|\/remote)?|files\/v1\/loaders\/[^/]+)\/?$/;

app.use((req, res, next) => {
  const m = maintenanceState();
  if (!m.site && !m.loader) return next();
  // El panel y sus API nunca se bloquean: ahi se apagan los interruptores.
  // /api/owner es lo que usa el panel de admin (servicio aparte, con token); si se bloquea,
  // el panel no puede ni apagar el mantenimiento. /api/version es solo el estado publico.
  if (req.path === '/admin' || req.path.startsWith('/api/admin')) return next();
  if (req.path.startsWith('/api/owner') || req.path === '/api/version') return next();
  // Los admins navegan el sitio aunque este en mantenimiento
  const _sess = getSession(req);
  if (_sess && (ADMIN_DISCORD_IDS.includes(String(_sess.id)) || isOwnerId(_sess.id))) return next();
  if (m.loader && LOADER_PATH_RE.test(req.path)) {
    const msg = (m.message || 'Estamos en mantenimiento. Unete al discord para novedades: discord.gg/aKQNc6pC').replace(/"/g, "'");
    return res.status(503).type('text/plain').send(`print("[VantArmor] ${msg}")`);
  }
  if (m.site) {
    if (req.path.startsWith('/api/')) return res.status(404).json({ status: 'error', code: 404, message: 'Not found' });
    return res.status(404).type('html').send(MAINTENANCE_HTML);
  }
  next();
});
// Límite por IP en todas las rutas del loader: frena fuerza bruta de keys, spam de reportes y
// tormentas de peticiones (cada intento cuenta; la respuesta es uniforme, no revela qué falló).
const loaderRateHit = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of loaderRateHit) if (now > e.resetMin && now > e.resetHour) loaderRateHit.delete(ip);
}, 120_000).unref();
const LOADER_RATE_MIN = 30, LOADER_RATE_HOUR = 240;
app.use((req, res, next) => {
  if (!LOADER_PATH_RE.test(req.path)) return next();
  const ip = req.ip || 'unknown';
  const now = Date.now();
  let e = loaderRateHit.get(ip);
  if (!e) { e = { min: 0, resetMin: now + 60_000, hour: 0, resetHour: now + 3_600_000 }; loaderRateHit.set(ip, e); }
  if (now > e.resetMin) { e.min = 0; e.resetMin = now + 60_000; }
  if (now > e.resetHour) { e.hour = 0; e.resetHour = now + 3_600_000; }
  e.min++; e.hour++;
  if (e.min > LOADER_RATE_MIN || e.hour > LOADER_RATE_HOUR) return res.status(429).type('text/plain').send('!VANTARMOR:RATE_LIMITED');
  next();
});

// ==========================================
// 2. FRONTEND (carpeta 'frontend')
// ==========================================
// Páginas con URL limpia (sin .html). Las direcciones antiguas con .html redirigen a la limpia.
const CLEAN_PAGES = {
  '/': 'index.html',
  '/login': 'login.html',
  '/dashboard': 'dashboard.html',
  '/keys-free': 'keys-free.html',
  '/terminos': 'terminos.html',
  '/privacidad': 'privacidad.html',
  '/soporte': 'soporte.html',
  '/errores': 'errores.html',
  '/admin': 'admin.html',
};
const LEGACY_HTML = /^\/(index|login|dashboard|terminos|privacidad|soporte|errores)\.html$/;
app.use((req, res, next) => {
  const m = LEGACY_HTML.exec(req.path);
  if (!m) return next();
  res.redirect(301, m[1] === 'index' ? '/' : `/${m[1]}`);
});
// Si ya hay sesión, la portada y el login llevan directo al dashboard.
// Va ANTES de servir las páginas (que no miran la sesión).
const userExistsStmt = db.prepare('SELECT 1 FROM users WHERE id = ?');
app.get(['/', '/login'], (req, res, next) => {
  const session = getSession(req);
  if (session) {
    if (userExistsStmt.get(session.id)) return res.redirect('/dashboard');
    // Cookie de un usuario que ya no existe (p. ej. tras cambiar de base de datos): se borra para poder iniciar sesión
    res.clearCookie(SESSION_COOKIE);
  }
  next();
});
// Sin cache para el HTML/JS del panel: cada refresco trae la version nueva (nada se queda viejo)
app.use((req, res, next) => {
  if (/\.(html|js|css)(\?|$)/.test(req.path) || req.path in CLEAN_PAGES) res.setHeader('Cache-Control', 'no-cache');
  next();
});
app.use(express.static(path.join(__dirname, '..', 'frontend'), { index: false }));
// Icono de la pestaña: el navegador pide /favicon.ico si la página no define uno
app.get('/favicon.ico', (req, res) => res.sendFile(path.join(__dirname, '..', 'frontend', 'favicon-64.png')));
// /panel es el nombre que mucha gente escribe; el panel real está en /dashboard
app.get('/panel', (req, res) => res.redirect(301, '/dashboard'));
for (const [route, file] of Object.entries(CLEAN_PAGES)) {
  app.get(route, (req, res) => {
    if (route === '/dashboard') {
      // Cinturon y tirantes: si la sesion es admin, el HTML ya sale con el tab de Admin visible
      const session = getSession(req);
      if (session && (ADMIN_DISCORD_IDS.includes(String(session.id)) || isOwnerId(session.id))) {
        const html = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'dashboard.html'), 'utf8')
          .replace('<a class="nav-item" id="navAdmin" href="/admin" hidden', '<a class="nav-item" id="navAdmin" href="/admin"');
        return res.type('html').send(html);
      }
    }
    return res.sendFile(path.join(__dirname, '..', 'frontend', file));
  });
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
const isPaidPlanId = userId => { const p = stmt.userById.get(userId)?.plan; return p === 'premium' || p === 'plus' || p === 'custom'; };
const isPlusPlanId = userId => { const p = stmt.userById.get(userId)?.plan; return p === 'plus' || p === 'custom'; };
// Ofuscador 3: máximo 2 scripts creados por día (hora de Guayaquil) y por usuario
const LUAU_DAILY_LIMIT = 2;
const luauDay = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' });
const luauUsedStmt = db.prepare('SELECT n FROM luau_usage WHERE user_id = ? AND day = ?');
const luauBumpStmt = db.prepare('INSERT INTO luau_usage (user_id, day, n) VALUES (?, ?, 1) ON CONFLICT(user_id, day) DO UPDATE SET n = n + 1');
const luauUsedToday = userId => luauUsedStmt.get(userId, luauDay())?.n ?? 0;

function validateScriptInput({ name, ffa, obfuscator, obfMode, code, hwidResetHours, shareDetection, clydeVm, autoRevokeDump, hwidLock, version }, current = null) {
  const cleanName = name === undefined ? current?.name : String(name).trim();
  if (!cleanName || cleanName.length > 60) return { error: 'Nombre inválido (1 a 60 caracteres)' };

  const isFfa = ffa === undefined ? !!current?.ffa : !!ffa;
  // FFA también se ofusca: el ofuscador se elige igual que en modo protegido
  // Scripts viejos con Clyde: si no mandan ofuscador, se regeneran con Obscura
  // Scripts viejos con Clyde, Ofuscador 4 o los modos propios (quitados): si no mandan ofuscador, se regeneran con Ofuscador 4
  // Ofuscadores quitados (1, 2, Clyde y modos viejos): al guardar pasan a Ofuscador 4
  const legacy = { clyde: 'next', km: 'next', pro: 'next', light: 'next', luau51: 'next', real: 'next', obscura: 'next' };
  let obf = obfuscator === undefined ? (legacy[current?.obfuscator] ?? current?.obfuscator) : obfuscator;
  // Ofuscador 3 (API) en pausa (próximamente): ningún script lo usa; al guardar pasa a Ofuscador 4
  if (obf === 'luau') obf = 'next';
  if (!OBFUSCATORS.includes(obf)) return { error: 'Elige un ofuscador válido' };

  const source = code === undefined ? current?.source : code;
  if (typeof source !== 'string' || !source.trim()) return { error: 'Falta el código del script' };
  if (Buffer.byteLength(source) > MAX_CODE_BYTES) return { error: 'El código supera 2 MB' };

  const hwid = hwidResetHours === undefined ? (current?.hwid_reset_hours ?? 24) : Number(hwidResetHours);
  const share = shareDetection === undefined ? (current?.share_detection ?? 1) : (shareDetection ? 1 : 0);
  if (!HWID_RESET_OPTIONS.includes(hwid)) return { error: 'Intervalo de reinicio de HWID inválido' };

  const vm = clydeVm === undefined ? (current?.clyde_vm ?? 1) : (clydeVm ? 1 : 0);
  const autoRevoke = autoRevokeDump === undefined ? (current?.auto_revoke_dump ?? 0) : (autoRevokeDump ? 1 : 0);
  // Solo en el equipo que la usó: apagado por defecto (la key sirve en otros equipos). Scripts existentes: encendido.
  const lock = hwidLock === undefined ? (current?.hwid_lock ?? 0) : (hwidLock ? 1 : 0);
  // Modo del Ofuscador 5 (VantObf): bajo/medium/high; default y fallback: medium
  const mode = obfMode === undefined || obfMode === null || obfMode === ''
    ? (current?.obf_mode || 'medium')
    : (['low', 'medium', 'high'].includes(String(obfMode)) ? String(obfMode) : 'medium');
  const ver = version === undefined ? (current?.version || '') : String(version).trim().slice(0, 24);
  return { name: cleanName, isFfa, obfuscator: obf, obfMode: mode, source, hwidResetHours: hwid, shareDetection: share, clydeVm: vm, autoRevokeDump: autoRevoke, hwidLock: lock, version: ver };
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
          return reject(Object.assign(new Error('Tu script tiene sintaxis que el ofuscador no entiende. Revisa que sea Lua/Luau válido.'), { status: 422 }));
        }
        console.error('[Ofuscador] fallo:', detail);
        return reject(Object.assign(new Error('El ofuscador falló con este script. Inténtalo de nuevo; si sigue, avisa al equipo.'), { status: 500 }));
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
// La caché de ofuscación ya no se guarda en la base: cada salida ya queda en scripts.content y la caché
// hacía crecer el volumen (hasta 90 días de versiones completas). Al arrancar se vacía; SQLite reutiliza ese espacio.
try { db.prepare('DELETE FROM obf_cache').run(); } catch (err) { console.warn('[obf_cache] No se pudo vaciar:', err.message); }

// Retención: el detalle de ejecuciones (script_logs) se poda a 7 dias, en el arranque y cada 6 h.
// El DELETE reutiliza paginas internas (el archivo deja de crecer); el VACUUM solo corre si hay
// espacio libre de sobra en el volumen, igual que el endpoint manual de compactar.
const SCRIPT_LOG_DAYS = 7;
function pruneScriptLogs() {
  try {
    const cutoff = Math.floor(Date.now() / 1000) - SCRIPT_LOG_DAYS * 86400;
    const info = db.prepare('DELETE FROM script_logs WHERE created_at < ?').run(cutoff);
    if (info.changes > 0) console.log('[Limpieza] script_logs: %d entradas de mas de %d dias eliminadas', info.changes, SCRIPT_LOG_DAYS);
  } catch (err) { console.warn('[Limpieza] script_logs:', err.message); }
}
function compactDbIfRoom(reason) {
  if (process.env.DB_ENGINE === 'postgres') return;
  try {
    const before = fs.statSync(DATABASE_PATH).size;
    const fsInfo = fs.statfsSync(path.dirname(DATABASE_PATH));
    const free = fsInfo.bavail * fsInfo.bsize;
    if (free < before * 1.1) {
      console.log('[Limpieza] VACUUM omitido (%s): libre %.1f MB, base %.1f MB', reason, free / 1048576, before / 1048576);
      return;
    }
    db.exec('VACUUM');
    const after = fs.statSync(DATABASE_PATH).size;
    console.log('[Limpieza] VACUUM ok (%s): %.1f MB -> %.1f MB', reason, before / 1048576, after / 1048576);
  } catch (err) { console.warn('[Limpieza] VACUUM:', err.message); }
}
pruneScriptLogs();
compactDbIfRoom('arranque');
setInterval(() => { pruneScriptLogs(); compactDbIfRoom('programado'); }, 6 * 3600_000).unref();
// Auto delete expired users (por proyecto): cada 15 min se borran las keys ya expiradas de esos proyectos
setInterval(() => {
  try {
    db.prepare('DELETE FROM keys WHERE expires_at IS NOT NULL AND expires_at < ? AND project_id IN (SELECT id FROM projects WHERE auto_delete_expired = 1)').run(Math.floor(Date.now() / 1000));
  } catch { }
}, 15 * 60_000).unref();

async function obfuscate(source, obfuscator, opts = {}) {
  source = normalizeLuaSource(source); // BOM y línea #! fuera antes de ofuscar
  return obfuscateUncached(source, obfuscator, opts);
}
// Huella de los archivos del motor de Ofuscador 4: cambia cada vez que se actualiza NextOfuscator
const NEXT_ENGINE_VERSION = (() => {
  const dir = path.join(path.dirname(new URL(import.meta.url).pathname), 'lib', 'nextofuscator');
  const h = crypto.createHash('sha256');
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort()) h.update(fs.readFileSync(path.join(dir, f)));
  return h.digest('hex').slice(0, 16);
})();
// Ofuscador 5 (VantVM): motor nativo propio, VM interna con opcodes aleatorizados por script
function obfuscateVant(source, mode, guard) {
  try {
    return buildVantObf(source, crypto.randomInt(1, 2 ** 31), { mode, guard }).code;
  } catch (err) {
    if (err instanceof VantBuildError) throw Object.assign(new Error(err.message), { status: 400 });
    throw err;
  }
}
// Ofuscador 4 (NextOfuscator): motor en JavaScript dentro del backend, sin CLI externo
function obfuscateNext(source) {
  try {
    return buildLua(source, crypto.randomInt(1, 2 ** 31)).code;
  } catch (err) {
    if (err instanceof BuildError) throw Object.assign(new Error(err.message), { status: 400 });
    throw err;
  }
}
async function obfuscateUncached(source, obfuscator, opts = {}) {
  if (obfuscator === 'luau') return obfuscateLuau(source);
  if (obfuscator === 'next') return obfuscateNext(source);
  if (obfuscator === 'vantobf') return obfuscateVant(source, opts.mode, opts.guard);
  const cfg = OBF_CONFIG[obfuscator];
  if (!cfg) throw Object.assign(new Error('Elige un ofuscador válido'), { status: 400 });
  if (!cfg.dir) {
    console.error('[Ofuscador] no instalado:', obfuscator);
    throw Object.assign(new Error('Este ofuscador no está disponible en el servidor en este momento. Elige otro.'), { status: 501 });
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
// Solicitud del plan Custom: el usuario elige cuántos scripts, ofuscaciones y paneles necesita
// Métodos de pago que se ofrecen. El pago se hace fuera de la web; aquí solo se indica cómo prefiere pagar.
const CUSTOM_PAYMENT_METHODS = ['Discord', 'PayPal', 'Binance Pay', 'Transferencia', 'Otro'];
app.post('/api/plan/custom-request', requireAuth, jsonLimit, (req, res) => {
  const vals = ['scripts', 'obfuscations', 'panels'].map(k => Number(req.body?.[k]));
  if (vals.some(v => !Number.isInteger(v) || v < 1 || v > 100000)) {
    return res.status(400).json({ error: 'Cada cantidad debe estar entre 1 y 100000' });
  }
  const paymentMethod = String(req.body?.paymentMethod || '');
  if (!CUSTOM_PAYMENT_METHODS.includes(paymentMethod)) {
    return res.status(400).json({ error: 'Elige un método de pago' });
  }
  const contact = String(req.body?.contact || '').trim().slice(0, 120);
  // Nunca se guardan números de tarjeta ni de cuenta bancaria
  if (/\d{12,}/.test(contact.replace(/[\s-]/g, ''))) {
    return res.status(400).json({ error: 'No pongas números de tarjeta ni de cuenta. Usa tu usuario de Discord o un correo.' });
  }
  const pending = db.prepare("SELECT id FROM custom_plan_requests WHERE user_id = ? AND status = 'pending'").get(req.userId);
  if (pending) return res.status(409).json({ error: 'Ya tienes una solicitud Custom pendiente. Espera a que el dueño la revise.' });
  const info = db.prepare('INSERT INTO custom_plan_requests (user_id, scripts, obfuscations, panels, payment_method, contact, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(req.userId, vals[0], vals[1], vals[2], paymentMethod, contact || null, Math.floor(Date.now() / 1000));
  res.json({ ok: true, id: info.lastInsertRowid });
});

app.post('/api/plan/redeem', requireAuth, jsonLimit, (req, res) => {
  if (maintenanceBlock(req, res)) return;
  const key = String(req.body?.key || '').trim();
  if (key.length < 32 || key.length > 64) return res.status(400).json({ error: 'Key inválida' });

  const row = db.prepare('SELECT * FROM plan_keys WHERE key = ?').get(key);
  if (!row) return res.status(404).json({ error: 'Key de plan inválida' });
  if (row.used_by) return res.status(409).json({ error: 'Esta key ya fue usada' });

  const days = row.days || PLAN_DAYS_DEFAULT;
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

// Callback de Unity Ads (server a server). Unity firma sid, oid y hmac (HMAC-MD5) con el secreto que te da su soporte.
// Sin UNITY_ADS_S2S_SECRET el callback se rechaza: no se puede falsificar un anuncio.
const UNITY_ADS_S2S_SECRET = process.env.UNITY_ADS_S2S_SECRET || '';
const AD_CREDIT_TTL = 30 * 60; // segundos que dura un anuncio visto sin reclamar
app.get('/api/ads/unity-callback', (req, res) => {
  if (!UNITY_ADS_S2S_SECRET) return res.status(503).type('text/plain').send('Callbacks no configurados');
  const params = req.query;
  if (!Object.values(params).every(v => typeof v === 'string')) return res.status(400).type('text/plain').send('Parámetros inválidos');
  const { hmac, ...rest } = params;
  if (typeof hmac !== 'string') return res.status(400).type('text/plain').send('Falta firma');
  const payload = Object.keys(rest).sort().map(k => `${k}=${rest[k]}`).join(',');
  const expected = crypto.createHmac('md5', UNITY_ADS_S2S_SECRET).update(payload).digest('hex');
  const a = Buffer.from(hmac), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(403).type('text/plain').send('Firma incorrecta');
  const sid = rest.sid || '', oid = rest.oid || '';
  if (!sid || !oid) return res.status(400).type('text/plain').send('Faltan sid u oid');
  const info = db.prepare('INSERT OR IGNORE INTO ad_credits (oid, sid, created_at) VALUES (?, ?, ?)').run(oid, sid, Math.floor(Date.now() / 1000));
  if (!info.changes) return res.status(400).type('text/plain').send('Duplicate order');
  res.type('text/plain').send('1');
});
// La app pide su sid (ID de la cuenta) antes de mostrar el anuncio, para que Unity lo devuelva firmado
app.get('/api/ads/session', requireAuth, (req, res) => res.json({ sid: String(req.userId) }));

// Pruebas gratis (3 días): estado de las keys de la cuenta
const FREE_PLAN_DAYS = 1; // cada reclamo da 1 día; al vencer hay que volver a ver anuncios
const FREE_ADS_REQUIRED = { premium: 7, plus: 14 }; // anuncios vistos necesarios según el plan
const FREE_ADS_MAX = Math.max(...Object.values(FREE_ADS_REQUIRED));
// Solo lee el contador de anuncios vistos (no suma nada)
app.get('/api/free-keys/ad-count', requireAuth, (req, res) => {
  const watched = db.prepare('SELECT count FROM free_ad_views WHERE user_id = ?').get(req.userId)?.count || 0;
  res.json({ watched, required: FREE_ADS_REQUIRED });
});
// Vuelve el contador a 0 (se llama al elegir un plan, para que cada plan empiece de cero)
app.post('/api/free-keys/ad-reset', requireAuth, jsonLimit, (req, res) => {
  db.prepare('DELETE FROM free_ad_views WHERE user_id = ?').run(req.userId);
  res.json({ watched: 0, required: FREE_ADS_REQUIRED });
});
// Suma un anuncio visto a la cuenta (lo llama la app al terminar cada anuncio de Unity). Tope: FREE_ADS_REQUIRED
app.post('/api/free-keys/ad-watched', requireAuth, jsonLimit, (req, res) => {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`INSERT INTO free_ad_views (user_id, count, updated_at) VALUES (?, 1, ?)
    ON CONFLICT(user_id) DO UPDATE SET count = MIN(count + 1, ?), updated_at = ?`).run(req.userId, now, FREE_ADS_MAX, now);
  const count = db.prepare('SELECT count FROM free_ad_views WHERE user_id = ?').get(req.userId).count;
  res.json({ watched: count, required: FREE_ADS_REQUIRED });
});
const FREE_PLANS = { premium: 'PREMIUM-', plus: 'PLUS-' };
app.get('/api/free-keys', requireAuth, (req, res) => {
  const now = Math.floor(Date.now() / 1000);
  const rows = db.prepare('SELECT plan, key, claimed_at, expires_at, renewals FROM free_claims WHERE user_id = ?').all(req.userId);
  res.json(rows.map(r => ({ plan: r.plan, key: r.key, expires_at: r.expires_at, expired: r.expires_at <= now, renewals: r.renewals })));
});

// Reclamar o renovar: si nunca reclamó el plan, crea la key; si ya la tenía y venció, suma 3 días a la misma key.
// No se puede reclamar mientras la prueba siga activa, ni si la cuenta ya tiene un plan pagado activo.
app.post('/api/free-keys/claim', requireAuth, jsonLimit, (req, res) => {
  if (maintenanceBlock(req, res)) return;
  const plan = String(req.body?.plan || '').toLowerCase();
  if (!FREE_PLANS[plan]) return res.status(400).json({ error: 'Plan inválido' });

  const now = Math.floor(Date.now() / 1000);
  // Un plan pagado activo no se reemplaza con la prueba (acortaría su vencimiento).
  // Sí se permite si el plan activo es la propia prueba de la cuenta.
  const me = stmt.userById.get(req.userId);
  const activePaid = !!me && ['premium', 'plus', 'custom'].includes(me.plan) && me.plan_expires_at > now;
  const fromFree = activePaid && me.plan === plan && !!db.prepare('SELECT 1 FROM free_claims WHERE user_id = ? AND plan = ? AND expires_at = ?')
    .get(req.userId, me.plan, me.plan_expires_at);
  if (activePaid && !fromFree) return res.status(409).json({ error: 'Ya tienes un plan activo' });

  // Hacen falta FREE_ADS_REQUIRED anuncios vistos (contador que suma la app al terminar cada anuncio de Unity)
  const watched = db.prepare('SELECT count FROM free_ad_views WHERE user_id = ?').get(req.userId)?.count || 0;
  const need = FREE_ADS_REQUIRED[plan];
  if (watched < need) {
    return res.status(402).json({ error: `Mira ${need - watched} anuncio(s) más`, code: 'AD_REQUIRED', watched, required: need });
  }
  const anyActive = db.prepare('SELECT 1 FROM free_claims WHERE user_id = ? AND expires_at > ?').get(req.userId, now);
  if (anyActive) return res.status(409).json({ error: 'Tu prueba gratis sigue activa' });

  const expiresAt = now + FREE_PLAN_DAYS * 86400;
  const result = db.transaction(() => {
    const row = db.prepare('SELECT * FROM free_claims WHERE user_id = ? AND plan = ?').get(req.userId, plan);
    if (row && row.expires_at > now) return { error: 'Tu prueba de ' + plan + ' sigue activa' };
    let key = row?.key;
    if (!row) {
      key = FREE_PLANS[plan] + crypto.randomBytes(24).toString('base64url');
      db.prepare('INSERT INTO free_claims (user_id, plan, key, claimed_at, expires_at, renewals) VALUES (?, ?, ?, ?, ?, 0)')
        .run(req.userId, plan, key, now, expiresAt);
    } else {
      db.prepare('UPDATE free_claims SET expires_at = ?, renewals = renewals + 1 WHERE user_id = ? AND plan = ?')
        .run(expiresAt, req.userId, plan);
    }
    db.prepare('UPDATE users SET plan = ?, plan_expires_at = ?, plan_expired_at = NULL WHERE id = ?').run(plan, expiresAt, req.userId);
    db.prepare('DELETE FROM free_ad_views WHERE user_id = ?').run(req.userId); // el contador vuelve a 0 tras reclamar
    return { key, renewed: !!row };
  })();

  if (result.error) return res.status(result.code === 'AD_REQUIRED' ? 402 : 409).json({ error: result.error, code: result.code || null });
  auditLog(req.userId, result.renewed ? 'free_key_renew' : 'free_key_claim', plan, `${FREE_PLAN_DAYS} días`);
  res.json({ ok: true, plan, key: result.key, expires_at: expiresAt, renewed: result.renewed });
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
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Not Authorized</title>
<style>
*{box-sizing:border-box}html,body{margin:0;min-height:100%}
body{background:#131730;display:flex;align-items:center;justify-content:center;text-align:center;color:#fff;font-family:Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
.wrap{padding:24px;max-width:720px}
.l1{font-size:clamp(22px,5vw,30px);font-weight:800;margin:0 0 18px}
.l2{font-size:clamp(30px,8vw,44px);font-weight:800;margin:0 0 16px;line-height:1.25}
.l3{font-size:clamp(16px,4vw,22px);color:#9aa3c0;margin:0}
</style>
</head>
<body><div class="wrap">
<p class="l1">🚫 Not Authorized 🚫</p>
<p class="l2">You are not allowed to view these files.</p>
<p class="l3">Close this page &amp; proceed.</p>
</div></body>
</html>`;
}

// Bootstrap que recibe el ejecutor al pedir la URL del loader.
// Lee script_key, pide el script a /auth con key + HWID y, si algo falla, expulsa
// al jugador con el mensaje de la tabla MSG. No contiene el código del script.
// La key aleatoria por script (loader_id) va en una variable: el bootstrap no lleva el slug ni la ruta completa.
// Diagnostico del bootstrap: solo para los loaders listados aqui (o con LOADER_DEBUG=1). Por defecto apagado.
const LOADER_DEBUG = process.env.LOADER_DEBUG === '1';
const DEBUG_LOADER_IDS = ['8d7860430a8b8709e5f8657e2cf1ccc135a4ec68', '472dfe8930f58db08b67d33f03f2de87b186caad'];
// ---- Firma RSA del payload (v7): el servidor firma, el loader solo verifica ----
// Bloque firmado: 0x00 0x01 + relleno 0xFF + 0x00 + "V7|<s>|<keyid>|<exp>|<sha256hex(cuerpo)>".
// keyid = primeros 16 hex de sha256(key). El loader lleva solo la clave publica (modulo + R y R2
// precomputados para Montgomery) y verifica con bit32: un paquete falsificado offline no produce
// firma valida. La clave privada nunca sale del servidor y queda persistida en app_settings.
let _rsaPrivPem = null, _rsaConsts = null;
function rsaKeyPair() {
  if (_rsaPrivPem) return _rsaPrivPem;
  try {
    const saved = process.env.VANTARMOR_RSA_PRIV_PEM || (db.prepare("SELECT value FROM app_settings WHERE name = 'rsa_priv_pem'").get() || {}).value || '';
    if (saved) { crypto.createPrivateKey(saved); _rsaPrivPem = saved; }
  } catch (e) { _rsaPrivPem = null; }
  if (!_rsaPrivPem) {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    _rsaPrivPem = privateKey;
    try { db.prepare("INSERT OR REPLACE INTO app_settings (name, value) VALUES ('rsa_priv_pem', ?)").run(privateKey); } catch (e) { console.error('[rsig] clave RSA no persistida:', e.message); }
  }
  return _rsaPrivPem;
}
function rsaConsts() {
  if (_rsaConsts) return _rsaConsts;
  const pub = crypto.createPublicKey(rsaKeyPair());
  const jwk = pub.export({ format: 'jwk' });
  const nBuf = Buffer.from(jwk.n, 'base64url');
  const N = BigInt('0x' + nBuf.toString('hex'));
  const R = (1n << 2058n) % N;
  const R2 = (1n << 4116n) % N;
  let inv = 1n;
  const nm = N % 2097152n;
  for (let i = 0; i < 6; i++) inv = (inv * (2n - nm * inv)) & 2097151n;
  const np = Number((2097152n - inv) % 2097152n);
  _rsaConsts = { n: nBuf.toString('hex').padStart(512, '0'), r: R.toString(16).padStart(512, '0'), r2: R2.toString(16).padStart(512, '0'), np };
  return _rsaConsts;
}
function payloadRsaSig(s, key, exp, body) {
  try {
    const priv = rsaKeyPair();
    const keyid = crypto.createHash('sha256').update(String(key || ''), 'utf8').digest('hex').slice(0, 16);
    const bhash = crypto.createHash('sha256').update(Buffer.from(String(body || ''), 'utf8')).digest('hex');
    const payload = `V7|${s}|${keyid}|${exp}|${bhash}`;
    const plen = Buffer.byteLength(payload, 'utf8');
    if (plen > 250) return null;
    const block = Buffer.alloc(256);
    block[0] = 0; block[1] = 1;
    const fill = 253 - plen;
    block.fill(0xff, 2, 2 + fill);
    block[2 + fill] = 0;
    block.write(payload, 3 + fill, 'utf8');
    return crypto.privateEncrypt({ key: priv, padding: crypto.constants.RSA_NO_PADDING }, block).toString('base64');
  } catch (err) {
    console.error('[rsig] fallo al firmar:', err.message);
    return null;
  }
}
// Marca de agua por key: constante invisible al final del payload entregado, unica por key.
// Si una build filtrada aparece, el dueño la busca en /api/keys (campo wm) y banea esa key.
function keyWatermark(scriptId, key) {
  return crypto.createHash('sha256').update(`vantarmor-wm|${scriptId}|${key || 'ffa'}`).digest('hex').slice(0, 16);
}

const LOADER_VERIFY_LUA = `-- [AntiForge] Firma RSA del servidor (v7): solo la clave publica viaja en el loader. El servidor
-- firma "V7|s|keyid|exp|sha256(cuerpo)" con su clave privada; un paquete armado a mano a partir
-- de una respuesta capturada no puede producir una firma valida. Falta de firma o firma mala =
-- el payload no se ejecuta. Con bit32 el chequeo es rapido; sin bit32 se omite (la entrega sigue
-- cifrada y acotada por exp, igual que antes).
do
  local _rsig = tostring(_data.rsig or "")
  local _fast = (type(bit32) == "table" and type(bit32.rrotate) == "function") or (type(bit) == "table" and (type(bit.ror) == "function" or type(bit.rrotate) == "function"))
  if _fast and type(_pay) == "string" and type(sha256) == "function" and type(tohex) == "function" and type(VANT_RSA_N) == "string" and #VANT_RSA_N == 512 then
    if #_rsig < 300 or #_rsig > 400 then _close() error(MSG.BAD_SIGNATURE, 0) end
    local _A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
    local _D = {}
    for _i = 1, 64 do _D[string.byte(_A, _i)] = _i - 1 end
    local _sb, _acc, _nb = {}, 0, 0
    for _i = 1, #_rsig do
      local _v = _D[string.byte(_rsig, _i)]
      if _v then
        _acc = _acc * 64 + _v
        _nb = _nb + 6
        if _nb >= 8 then
          _nb = _nb - 8
          _sb[#_sb + 1] = math.floor(_acc / 2 ^ _nb) % 256
          _acc = _acc % 2 ^ _nb
        end
      end
    end
    local _verified = false
    if #_sb == 256 then
      local _keyid = string.sub(tohex(sha256(tostring(key))), 1, 16)
      local _bhash = tohex(sha256(_pay))
      local _payload = "V7|" .. tostring(SK) .. "|" .. _keyid .. "|" .. tostring(_exp) .. "|" .. _bhash
      if #_payload <= 250 then
        local _expected = string.char(0, 1) .. string.rep(string.char(255), 253 - #_payload) .. string.char(0) .. _payload
        local B, L, NP = 2097152, 99, VANT_RSA_NP
        local function padAcc(acc)
          while #acc < L do acc[#acc + 1] = 0 end
          return acc
        end
        local function fromHex(hx)
          local acc = { 0 }
          for i = 1, #hx / 2 do
            local carry = tonumber(string.sub(hx, (i - 1) * 2 + 1, i * 2), 16)
            for j = 1, #acc do
              local v = acc[j] * 256 + carry
              acc[j] = v % B
              carry = math.floor(v / B)
            end
            if carry > 0 then acc[#acc + 1] = carry end
          end
          return padAcc(acc)
        end
        local function fromBytes(bs)
          local acc = { 0 }
          for i = 1, #bs do
            local carry = bs[i]
            for j = 1, #acc do
              local v = acc[j] * 256 + carry
              acc[j] = v % B
              carry = math.floor(v / B)
            end
            if carry > 0 then acc[#acc + 1] = carry end
          end
          return padAcc(acc)
        end
        local function cmpN(a, b)
          for i = L, 1, -1 do
            local x, y = a[i] or 0, b[i] or 0
            if x < y then return -1 elseif x > y then return 1 end
          end
          return 0
        end
        local function subIn(a, b)
          local c = 0
          for i = 1, L do
            local v = (a[i] or 0) - (b[i] or 0) - c
            if v < 0 then v = v + B; c = 1 else c = 0 end
            a[i] = v
          end
        end
        local function montMul(a, b, n)
          local t = {}
          for i = 1, 2 * L do t[i] = 0 end
          for i = 1, L do
            local ai = a[i]
            if ai ~= 0 then
              local carry = 0
              for j = 1, L do
                local v = t[i + j - 1] + ai * b[j] + carry
                t[i + j - 1] = v % B
                carry = math.floor(v / B)
              end
              local k = i + L
              while carry > 0 do
                local v = t[k] + carry
                t[k] = v % B
                carry = math.floor(v / B)
                k = k + 1
              end
            end
          end
          for i = 1, L - 1 do
            local m = (t[i] * NP) % B
            if m ~= 0 then
              local carry = 0
              for j = 1, L do
                local v = t[i + j - 1] + m * n[j] + carry
                t[i + j - 1] = v % B
                carry = math.floor(v / B)
              end
              local k = i + L
              while carry > 0 and k <= 2 * L do
                local v = t[k] + carry
                t[k] = v % B
                carry = math.floor(v / B)
                k = k + 1
              end
            end
          end
          local r = {}
          for i = 1, L do r[i] = t[L + i - 1] end
          if cmpN(r, n) >= 0 then subIn(r, n) end
          return r
        end
        local _N = fromHex(VANT_RSA_N)
        local _R2 = fromHex(VANT_RSA_R2)
        local _one = {}
        for i = 1, L do _one[i] = 0 end
        _one[1] = 1
        local _a = montMul(fromBytes(_sb), _R2, _N)
        local _res = _a
        for _i = 1, 16 do _res = montMul(_res, _res, _N) end
        _res = montMul(_res, _a, _N)
        local _m = montMul(_res, _one, _N)
        local _tmp = {}
        for i = 1, L do _tmp[i] = _m[i] end
        local _out = {}
        for _ = 1, 256 do
          local carry = 0
          for i = L, 1, -1 do
            local v = carry * B + _tmp[i]
            _tmp[i] = math.floor(v / 256)
            carry = v % 256
          end
          _out[#_out + 1] = carry
        end
        local _parts = {}
        for i = 256, 1, -1 do _parts[257 - i] = string.char(_out[i]) end
        _verified = (table.concat(_parts) == _expected)
      end
    end
    if not _verified then _close() error(MSG.BAD_SIGNATURE, 0) end
  end
end
`;

function loaderBootstrap(loaderId, ffa, secure = false, secret = '', initCode = '', guard = '') {
  const sk = /^[0-9a-f]{40}$/.test(String(loaderId || '')) ? String(loaderId) : '';
  return `local SK = ${JSON.stringify(sk)}
local AUTH_BASE = ${JSON.stringify(`${APP_URL}/v1/a?s=`)} .. SK
local AUTH_URL = ${JSON.stringify(`${APP_URL}/v1/a`)}
local PAYLOAD_URL = ${JSON.stringify(`${APP_URL}/v1/p`)}
local START_URL = ${JSON.stringify(`${APP_URL}/v1/a/start`)}
local PGET_URL = ${JSON.stringify(`${APP_URL}/v1/p`)}
local FFA = ${ffa ? 'true' : 'false'}
local SECURE = ${secure ? 'true' : 'false'}
local HEAD = "[ VANTARMOR ]\\n"
local MSG = {
  KEY_REQUIRED = HEAD .. "A valid key is required.",
  KEY_INVALID = HEAD .. "The key is not valid.",
  KEY_EXPIRED = HEAD .. "Your key has expired.",
  NOT_AUTHORIZED = HEAD .. "You are not authorized to run this script.",
  HWID_MISMATCH = HEAD .. "This key is linked to another device.",
  VERIFY_FAILED = HEAD .. "Verification failed. Please rejoin.",
  CONNECTION_FAILED = HEAD .. "Connection failed. Please try again.",
  TAMPERING = HEAD .. "Vantarmor is a Lua whitelisting service, and attempting to deobfuscate, reverse-engineer, or otherwise bypass its protections is against the service's Terms of Service. Continuing to do so could potentially get the owner or other involved parties in trouble, including account or service consequences. Stop attempting to deobfuscate or bypass Vantarmor and leave the protected code alone. Any AI usage against this will result in severe punishments and DMCA. Please abort.",
  SCRIPT_NOT_FOUND = HEAD .. "Script not found.",
  SCRIPT_DELETED = HEAD .. "This script was deleted by its owner.",
  REAUTH = HEAD .. "Please re-authenticate.",
  BLACKLISTED = HEAD .. "Access denied.",
  MAINTENANCE = HEAD .. "This script is under maintenance.\\nPlease try again in a few minutes.",
  MAINTENANCE_ALL = HEAD .. "Vantarmor is under maintenance.\\nPlease try again in a few minutes.",
  SERVER_UNREACHABLE = HEAD .. "Server unreachable. Please try later.",
  PAYLOAD_LOAD_FAILED = HEAD .. "The script could not be loaded by your executor.\\nPlease contact the script owner.",
  TOKEN_INVALID = HEAD .. "Your session expired. Please rejoin.",
  UPDATE_REQUIRED = HEAD .. "Your loader is outdated.\\nPlease copy the loader URL again from the panel.",
  FORBIDDEN = HEAD .. "Access denied.",
  EXEC_LIMIT = HEAD .. "This key reached its execution limit.",
}
local Players = game:GetService("Players")
local function _findLP()
  local lp = nil
  pcall(function() lp = Players.LocalPlayer end)
  if not lp then pcall(function() lp = game.Players.LocalPlayer end) end
  if not lp then
    pcall(function()
      local list = Players.GetPlayers and Players:GetPlayers()
      if type(list) == "table" then lp = list[1] end
    end)
  end
  return lp
end
local _DBG = ${(LOADER_DEBUG || DEBUG_LOADER_IDS.includes(sk)) ? 'true' : 'false'}
local function _dbg(m) if _DBG then print("[VANT-DBG] " .. tostring(m)) end end
if _DBG then pcall(function() if getgenv then getgenv().VANTARMOR_DEBUG = true end end) end
local function _forceKick(msg)
  local lp = _findLP()
  if lp then pcall(function() lp:Kick(msg) end) end
end
local function kick(code, suf)
  local msg = MSG[code] or MSG.VERIFY_FAILED
  if suf then msg = msg .. "\\n(ref: " .. tostring(suf) .. ")" end
  -- La razon queda en la consola aunque el kick del jugador falle en el ejecutor
  pcall(function() warn(msg) end)
  _forceKick(msg)
  error(msg, 0)
end
-- [AntiDump] Puerta de ejecutores: los ejecutores conocidos pasan limpios; uno desconocido
-- no se bloquea, entra en modo de baja confianza (sigue la autenticacion, el dueño lo ve en el log).
local _dumpHit = false
local _dumpWhy = ""
local _lowTrust = false
local _softHit = false
do
  local _execName = ""
  pcall(function()
    if type(identifyexecutor) == "function" then _execName = tostring(identifyexecutor() or "") end
  end)
  local _ok = false
  if #_execName > 0 then
    local _lower = _execName:lower()
    local _known = { "delta", "xeno", "solara", "krnl", "fluxus", "hydrogen", "codex", "arceus", "wave", "trigon", "crypt", "script-ware", "scriptware", "synapse", "evon", "vega", "ronin", "volcano", "swift", "nihon", "bunni", "willow", "macsploit", "potassium", "melon", "awp" }
    for _, _n in ipairs(_known) do
      if _lower:find(_n, 1, true) then _ok = true break end
    end
  end
  if not _ok then _lowTrust = true end
end
-- Si loadstring fue reemplazado por una función de Lua (un volcador que intercepta el código), se corta
local function nativeFn(f)
  if type(f) ~= "function" then return false end
  local okI, info = pcall(function() return debug.getinfo(f, "S") end)
  return not (okI and type(info) == "table" and info.what ~= "C")
end
local function loaderTampered()
  -- Solo corta por volcado real: loadstring reemplazado por una función de Lua (la vía del
  -- payload, lo que hacen los env-loggers) o marcadores de un dumper conocido. Todo lo demás
  -- (load, getgenv, request, HttpGet/HttpPost, writefile envueltos, sondas, hooks presentes)
  -- va por envWrapped()/softProbeRun() como aviso blando: varios ejecutores legítimos traen
  -- esas APIs ya envueltas en Lua y un corte aquí echa a usuarios limpios.
  local _why = ""
  if not nativeFn(loadstring) then _why = "loadstring_no_native" return true, _why end
  -- Marcadores que dejan los dumpers conocidos (Kingmor) al armarse en el entorno
  local _km = false
  pcall(function()
    local _envs = {}
    if type(getgenv) == "function" then local _e = getgenv(); if type(_e) == "table" then _envs[#_envs + 1] = _e end end
    if type(_G) == "table" then _envs[#_envs + 1] = _G end
    for _, _e in ipairs(_envs) do
      for _, _m in ipairs({ "__km_ls_hooked", "__km_wf_raw", "__km_ls_ref", "_KM_DUMP", "_KM_DUMP_LEN", "_LAST_DUMP", "_LAST_DUMP_NAME" }) do
        if rawget(_e, _m) ~= nil then _km = true end
      end
    end
  end)
  if _km then return true, "km_markers" end
  -- Env-logger concreto (Source Hub / Kyroxx): define GlobalScan y GenvScan como globales y
  -- escribe logged.txt con una cabecera fija. Un ejecutor limpio no trae ninguna de las dos.
  local _ev = false
  pcall(function()
    local _envs = {}
    if type(getgenv) == "function" then local _e = getgenv(); if type(_e) == "table" then _envs[#_envs + 1] = _e end end
    if type(_G) == "table" then _envs[#_envs + 1] = _G end
    if type(getfenv) == "function" then local _okf, _f = pcall(getfenv, 1); if _okf and type(_f) == "table" then _envs[#_envs + 1] = _f end end
    for _, _e in ipairs(_envs) do
      if type(rawget(_e, "GlobalScan")) == "function" and type(rawget(_e, "GenvScan")) == "function" then _ev = true end
    end
    if not _ev and type(readfile) == "function" then
      local _okr, _txt = pcall(readfile, "logged.txt")
      if _okr and type(_txt) == "string" and _txt:find('GetService("WebSocketService")', 1, true) and _txt:find("GameSettings", 1, true) then _ev = true end
    end
  end)
  if _ev then return true, "envlogger_markers" end
  return false, ""
end
-- APIs envueltas en funciones de Lua (load, getgenv, request, http_request, HttpGet/HttpPost,
-- writefile): los env-loggers las envuelven para registrar peticiones y contenido, pero varios
-- ejecutores legítimos también las traen envueltas, así que esto solo avisa al dueño, no corta.
local function envWrapped()
  local _wr = false
  local function _chk(f)
    if type(f) == "function" and not nativeFn(f) then _wr = true end
  end
  pcall(function()
    if type(load) == "function" then _chk(load) end
    if type(getgenv) == "function" then _chk(getgenv) end
    if type(request) == "function" then _chk(request) end
    if type(http_request) == "function" then _chk(http_request) end
    pcall(function() _chk(game.HttpGet) end)
    pcall(function() _chk(game.HttpPost) end)
    if type(writefile) == "function" then _chk(writefile) end
  end)
  -- loadstring debe compilar de verdad: un reemplazo que devuelve otra cosa delata al volcador
  local _okF, _f = pcall(loadstring, "return 47011")
  if not _okF or type(_f) ~= "function" then
    _wr = true
  else
    local _okR, _v = pcall(_f)
    if not _okR or _v ~= 47011 then _wr = true end
  end
  return _wr
end
-- [AntiDump] APIs que viven los volcadores y los env-loggers. Se miran las que existen en el
-- ejecutor: si dejaron de ser C (alguien las envolvio en Lua), hay volcado activo y se corta.
local function _probeFn(path)
  local okp, f = pcall(function()
    local tbl, sub = path:match("^(.-)%.([%w_]+)$")
    if tbl then
      local t = _G[tbl]
      if type(t) ~= "table" then return nil end
      return t[sub]
    end
    return _G[path]
  end)
  if okp then return f end
  return nil
end
-- Extraccion de codigo (getscriptbytecode y compania), descompiladores (debug.getupvalue/getinfo),
-- hooks y lectura/escritura de archivos: los volcadores y los env-loggers tocan todo esto
local _HARD_PROBES = { "getscriptbytecode", "getscriptclosure", "getscripthash", "getfunctionbytecode",
  "debug.getupvalue", "debug.setupvalue", "debug.getinfo", "debug.getlocal", "debug.getregistry",
  "hookfunction", "hookmetamethod", "replaceclosure", "readfile", "writefile", "appendfile", "listfiles", "getcustomasset" }
local function hardProbeRun()
  for _, _p in ipairs(_HARD_PROBES) do
    local _f = _probeFn(_p)
    if type(_f) == "function" and not nativeFn(_f) then return true end
  end
  return false
end
-- Herramientas de volcado presentes pero sin enganches (saveinstance, descompiladores, env-loggers):
-- muchos ejecutores las traen de fabrica, asi que esto solo AVISA al dueño, no echa al jugador
local _SOFT_NAMES = { "saveinstance", "save_instance", "decompile", "decompiler", "dumpstring", "dump_string",
  "__dump", "dumplog", "envlog", "httplog", "scriptsourcedump", "getscriptsource" }
local function softProbeRun()
  local _found = false
  pcall(function()
    local _envs = {}
    if type(getgenv) == "function" then local _e = getgenv(); if type(_e) == "table" then _envs[#_envs + 1] = _e end end
    if type(_G) == "table" then _envs[#_envs + 1] = _G end
    if type(shared) == "table" then _envs[#_envs + 1] = shared end
    for _, _e in ipairs(_envs) do
      for _, _n in ipairs(_SOFT_NAMES) do
        if rawget(_e, _n) ~= nil then _found = true end
      end
    end
  end)
  return _found
end
local key = ""
-- script_key puede venir como global normal, en _G, o en getgenv() (depende del executor)
local _rawKey = (getgenv and rawget(getgenv(), "script_key"))
  or (type(script_key) == "string" and script_key)
  or (_G and type(rawget(_G, "script_key")) == "string" and rawget(_G, "script_key"))
  or ""
if type(_rawKey) == "string" then key = (_rawKey:gsub("^%s+", ""):gsub("%s+$", "")) end
if key == "" and not FFA then kick("KEY_REQUIRED") end
local function enc(s) return (s:gsub("[^%w%-_%.~]", function(c) return string.format("%%%02X", string.byte(c)) end)) end
local hwid = ""
local okh, h = pcall(function() return game:GetService("RbxAnalyticsService"):GetClientId() end)
if okh and type(h) == "string" and #h >= 8 then hwid = h end
local rbxid = ""
local okr, rid = pcall(function() return tostring(Players.LocalPlayer.UserId) end)
if okr and rid then rbxid = rid end
local _DBG = ${(LOADER_DEBUG || DEBUG_LOADER_IDS.includes(sk)) ? 'true' : 'false'}
local function _dbg(m) if _DBG then print("[VANT-DBG " .. string.format("%.2f", os.clock()) .. "] " .. tostring(m)) end end
_dbg("inicio bootstrap")
-- Detector de dump: solo verifica que el Heartbeat responda (reloj completamente congelado = volcado)
local detections = 0
pcall(function()
  -- Dos ventanas seguidas con el reloj congelado antes de marcar: una sola ventana
  -- se equivocaba con picos de carga en moviles y echaba a usuarios limpios
  local function _win()
    local hits = 0
    local conn = game:GetService("RunService").Heartbeat:Connect(function() hits += 1 end)
    local t0 = os.clock()
    repeat task.wait() until hits >= 2 or os.clock() - t0 > 2
    conn:Disconnect()
    return hits >= 2
  end
  if not _win() and not _win() then detections += 1 end
end)
-- Si el propio detector falla no se castiga al jugador (evita falsos positivos)
local function _clearKey()
  pcall(function()
    if type(getgenv) == "function" then local _g = getgenv(); if _g then _g.script_key = nil end end
  end)
  if type(_G) == "table" then pcall(function() _G.script_key = nil end) end
  pcall(function() script_key = nil end)
end
_dbg("detector terminado detections=" .. tostring(detections))
if detections > 0 then _dumpHit = true; _dumpWhy = "heartbeat_congelado" end
-- Detector de entorno: solo reporta si encuentra funciones de hook activas (hookfunction, etc.)
-- Las comprobaciones de Tween/FPS se eliminaron porque fallaban en ejecutores legítimos y causaban
-- kicks falsos. Solo se castiga si se detectan hooks explícitos que indican volcado activo.
local function envProbeRun()
  local _hookFound = false
  pcall(function()
    local _rg = rawget
    local _okE, _f = pcall(function()
      return getfenv and getfenv(0) or getgenv and getgenv() or {}
    end)
    if _okE and type(_f) == "table" then
      for _, _nm in ipairs({ "hookfunction", "hookmetamethod", "hookm", "replaceclosure" }) do
        if _rg(_f, _nm) ~= nil then _hookFound = true end
      end
    end
  end)
  return _hookFound
end
local hookDetected = envProbeRun()
if hookDetected then _softHit = true end
-- Si loadstring fue interceptado: se avisa al servidor (dueño) y se corta antes de validar la key
local _lt1, _ltw1 = loaderTampered()
if _lt1 then _dbg("kick: loadertampered_pre " .. _ltw1) _dumpHit = true; _dumpWhy = _ltw1 end
-- Sondas de volcado: herramientas presentes o enganchadas van a aviso blando; el corte real
-- lo decide loaderTampered() (loadstring no nativo / marcadores) y el Heartbeat congelado.
if hardProbeRun() then _softHit = true end
if softProbeRun() then _softHit = true end
if envWrapped() then _softHit = true end
-- [AntiDump] Sonda sandbox real (la del anti-dump de referencia): string.byte con argumentos
-- invalidos hace que el ejecutor revele en el propio error el nombre de su envoltorio interno.
-- Si el error menciona un entorno de volcado (httplog, sandbox), o hay globals de logger a la
-- vista, el codigo se congela ahi mismo: sin envio, sin descifrado, el volcador no recibe nada.
local function _sandboxProbeHit()
  local _lvl = nil
  local _why = ""
  pcall(function()
    local _, _s = pcall(function() string.byte("a", function() return end, 9999, 38) end)
    if type(_s) == "string" then
      if _s:find("httplog", 1, true) then _lvl = "hard"; _why = "httplog " .. _s
      elseif _s:find("sandbox", 1, true) then _lvl = "soft"; _why = "sandbox " .. _s end
    end
  end)
  return _lvl, _why
end
local _spl, _spw = _sandboxProbeHit()
if _spl == "hard" then
  _dbg("kick: sandbox_probe " .. tostring(_spw))
  pcall(function() game:HttpGet(AUTH_BASE .. "&key=" .. enc(key) .. "&hwid=" .. enc(hwid) .. "&rbxid=" .. enc(rbxid) .. "&tamper=1") end)
  _clearKey()
  -- Con jugador real se le echa; en un volcador sin jugador queda el congelamiento
  _forceKick(MSG.TAMPERING .. "\\n(ref: " .. tostring(_spw) .. ")")
  warn(MSG.TAMPERING .. "\\n(ref: " .. tostring(_spw) .. ")")
  while true do end
elseif _spl == "soft" then
  -- El ejecutor nombra su propio envoltorio "sandbox" en errores internos: aviso, no corte
  _dbg("soft: sandbox_probe " .. tostring(_spw))
end
-- [AntiDump] Gancho de depuracion activo: los env-loggers suelen dejar un hook puesto en debug
pcall(function()
  if type(debug) == "table" and type(debug.gethook) == "function" then
    local _h = debug.gethook()
    if _h and _h ~= "" and _h ~= "external hook" then _softHit = true end
  end
end)
-- [AntiDump] Respuesta al volcado: aviso al servidor (con key y HWID) y kick.
-- El script nunca llega al volcador y el usuario ve el aviso en pantalla.
if _dumpHit then
  _dbg("kick: dump_hit " .. tostring(_dumpWhy))
  pcall(function() game:HttpGet(AUTH_BASE .. "&key=" .. enc(key) .. "&hwid=" .. enc(hwid) .. "&rbxid=" .. enc(rbxid) .. "&tamper=1") end)
  _clearKey()
  kick("TAMPERING", _dumpWhy)
end
-- Aviso blando: ya no se reporta. Los ejecutores legitimos traen APIs envueltas de fabrica y
-- cada aviso blandaba una ejecucion normal como intento de volcado en el registro del dueño.
${initCode ? `-- [Pre-Auth] Codigo del dueño (equivale a LRM_INIT_SCRIPT): corre antes de la autenticacion.
-- No pasa por el ofuscador, se lee tal cual: no pongas aqui nada critico.
${initCode}
` : ''}

-- [AntiSpoof] Firma de la peticion (estilo de la referencia): ct = bloque de 10 s, cn = nonce
-- aleatorio, cs = mezcla del secreto por script con la key, el HWID y ct. El servidor la
-- recalcula con la misma rutina; un cliente generico que reenvia parametros capturados
-- no puede falsificarla. Los loaders viejos sin cs siguen pasando.
_dbg("paso 0: key_len=" .. tostring(#tostring(key)) .. " hwid_len=" .. tostring(#tostring(hwid)) .. " rbx_len=" .. tostring(#tostring(rbxid)))
local _AS_SECRET = ${JSON.stringify(secret || '')}
-- Firma por paso: cada peticion (sesion y canje) lleva su propio ct/cn/cs
local _TABC = "OIlaE1JQTbC09734652"
local function _sig()
  local _ct = tostring(math.floor(os.time() / 10))
  local _cn = string.format("%08x%08x", math.floor((os.clock() * 1000000) % 4294967296), math.random(0, 2147483647))
  local _cs = ""
  do
    local _as_h = 5381
    local _seed = _AS_SECRET .. "|" .. _cn .. "|" .. tostring(key) .. "|" .. tostring(hwid) .. "|" .. _ct
    for _i = 1, #_seed do
      _as_h = (_as_h * 33 + _seed:byte(_i)) % 4294967296
      _as_h = (_as_h * 31 + 7) % 4294967296
    end
    local _b1, _b2, _b3, _b4
    _as_h = (_as_h * 31 + 7) % 4294967296
    _b1 = _as_h % 256
    _as_h = (_as_h * 31 + 7) % 4294967296
    _b2 = _as_h % 256
    _as_h = (_as_h * 31 + 7) % 4294967296
    _b3 = _as_h % 256
    _as_h = (_as_h * 31 + 7) % 4294967296
    _b4 = _as_h % 256
    _cs = string.format("%02x%02x%02x%02x", _b1, _b2, _b3, _b4)
  end
  return _ct, _cn, _cs
end
-- Blob t ofuscado (estilo de la referencia): key, hwid y firma van en el blob, cada nibble
-- sustituido por un caracter de una tabla propia y separado por 'k'. La URL nunca muestra
-- la key ni el HWID en claro y un log de proxy solo captura ruido.
local function _tBuild()
  local _ct, _cn, _cs = _sig()
  local _sep = string.char(1)
  local _pay = tostring(key) .. _sep .. tostring(hwid) .. _sep .. _ct .. _sep .. _cn .. _sep .. _cs
  local _parts = {}
  for _i = 1, #_pay do
    local _b = _pay:byte(_i)
    _parts[#_parts + 1] = _TABC:sub(math.floor(_b / 16) + 1, math.floor(_b / 16) + 1) .. "k" .. _TABC:sub(_b % 16 + 1, _b % 16 + 1)
  end
  return _ct, "a3" .. table.concat(_parts, "k")
end
-- Autenticacion por pasos (estilo de la referencia): nada corre directo. Paso 1 pide la
-- sesion (el servidor valida key, HWID y firma y cuenta la ejecucion), paso 2 canjea la sesion
-- por un token de descarga (el servidor revalida la firma y consume la sesion de un solo uso)
-- y paso 3 baja el codigo cifrado en trozos con ese token. Ninguna respuesta lleva el codigo
-- completo: un env-logger que capture los pasos solo ve una sesion, un token y trozos sueltos.
local _tok = ""
local function _getCode()
  script_key = nil
  pcall(function() if getgenv then rawset(getgenv(), "script_key", nil) end end)
  pcall(function() if _G then rawset(_G, "script_key", nil) end end)
  local function _bail(code)
    kick(code)
    error(code, 0)
  end
  -- Paso 1: sesion
  local _ct1, _t1 = _tBuild()
  local _ok1, _s1 = false, ""
  for _attempt = 1, 3 do
    _ok1, _s1 = pcall(function() return game:HttpGet(AUTH_BASE .. "&rbxid=" .. enc(rbxid) .. "&lt=" .. (_lowTrust and "1" or "0") .. "&v=2&ver=4&t=" .. _t1) end)
    if _ok1 and type(_s1) == "string" and #_s1 > 0 then break end
    if _attempt < 3 then task.wait(1 + math.random() * 2) end
  end
  _dbg("paso 1: sesion_len=" .. tostring(#tostring(_s1)))
  if not (_ok1 and type(_s1) == "string") then _bail("TAMPERING") end
  local _sessp = "!VANTARMOR:SESSION "
  if _s1:sub(1, #_sessp) ~= _sessp then return _s1 end
  local _sess = _s1:sub(#_sessp + 1):gsub("%s+$", "")
  -- Paso 2: canje de la sesion por el token de descarga
  local _ct2, _t2 = _tBuild()
  local _ok2, _s2 = false, ""
  for _attempt = 1, 3 do
    _ok2, _s2 = pcall(function() return game:HttpGet(START_URL .. "/" .. _sess .. "?t=" .. _t2) end)
    if _ok2 and type(_s2) == "string" and #_s2 > 0 then break end
    if _attempt < 3 then task.wait(1 + math.random() * 2) end
  end
  _dbg("paso 2: canje_len=" .. tostring(#tostring(_s2)))
  if not (_ok2 and type(_s2) == "string") then _bail("SERVER_UNREACHABLE") end
  local _ptp = "!VANTARMOR:PTOKEN "
  if _s2:sub(1, #_ptp) ~= _ptp then
    if _s2:find("!VANTARMOR:TOKEN_INVALID", 1, true) == 1 then return _s2 end
    _bail("TAMPERING")
  end
  local _pt = {}
  for _w in (_s2:sub(#_ptp + 1):gsub("%s+$", "")):gmatch("%S+") do _pt[#_pt + 1] = _w end
  _tok = _pt[1] or ""
  local _nch = tonumber(_pt[2]) or 0
  if _tok == "" or _nch < 1 or _nch > 4096 then _bail("TAMPERING") end
  -- Paso 3: trozos del codigo cifrado (cada uno con su token, numero y HWID)
  local _acc = {}
  for _i = 0, _nch - 1 do
    local _okc, _sc = false, ""
    for _attempt = 1, 3 do
      _okc, _sc = pcall(function() return game:HttpGet(PGET_URL .. "?t=" .. _tok .. "&n=" .. _i .. "&h=" .. enc(hwid)) end)
      if _okc and type(_sc) == "string" and #_sc > 0 then break end
      if _attempt < 3 then task.wait(0.5 + math.random()) end
    end
    if not (_okc and type(_sc) == "string") then _bail("SERVER_UNREACHABLE") end
    local _chp = "!VANTARMOR:CHUNK\\n"
    if _sc:sub(1, #_chp) ~= _chp then _bail("TAMPERING") end
    _acc[#_acc + 1] = _sc:sub(#_chp + 1):gsub("%s+$", "")
    _dbg("paso 3: trozo " .. _i .. "/" .. _nch .. " len=" .. tostring(#_acc[#_acc]))
  end
  local _b64all = table.concat(_acc)
  if #_b64all == 0 or #_b64all % 4 ~= 0 then _bail("VERIFY_FAILED") end
  return "!VANTARMOR:ENC\\n" .. _b64all
end
local ok, body = pcall(_getCode)
body = (ok and type(body) == "string") and body or nil
if type(body) ~= "string" then kick("TAMPERING") end
-- Token de sesion caducado: una re-autenticacion y un reintento (el REAUTH de la referencia)
if body:find("!VANTARMOR:TOKEN_INVALID", 1, true) == 1 then
  local _ok2, _fresh = pcall(_getCode)
  if _ok2 and type(_fresh) == "string" and _fresh:find("!VANTARMOR:TOKEN_INVALID", 1, true) ~= 1 then body = _fresh end
end
-- Entrega cifrada (v2): prefijo !VANTARMOR:ENC, luego key de 32 hex y ciphertext base64
-- Descifrado en Lua puro SIN operadores de bits (no compilan en algunos executors moviles):
-- solo aritmetica, xor por nibbles. Corre en cualquier executor
local _encp = "!VANTARMOR:ENC\\n"
if body:sub(1, #_encp) == _encp then
  local _M = 4294967296
  local _XN = {}
  for _a = 0, 15 do
    for _b = 0, 15 do
      local _x, _p, _aa, _bb = 0, 1, _a, _b
      for _ = 1, 4 do
        if _aa % 2 ~= _bb % 2 then _x = _x + _p end
        _p = _p * 2
        _aa = math.floor(_aa / 2)
        _bb = math.floor(_bb / 2)
      end
      _XN[_a * 16 + _b] = _x
    end
  end
  -- Ruta rapida: bit32 viene de Roblox y existe en todos los ejecutores; xor nativo en vez de
  -- la tabla de nibbles (el descifrado puro en Lua tardaba decenas de segundos en moviles).
  -- Fallback intacto: si un ejecutor raro quita bit32, corre el de nibbles de siempre.
  local _bits = nil
  do
    local _ok, _b = pcall(function() return bit32 end)
    if _ok and type(_b) == "table" and type(_b.bxor) == "function" then _bits = _b end
  end
  if not _bits then
    local _ok, _b = pcall(function() return bit end)
    if _ok and type(_b) == "table" and type(_b.bxor) == "function" and type(_b.band) == "function" then _bits = _b end
  end
  local function _xor(a, b)
    if _bits then
      local r = _bits.bxor(math.floor(a) % 4294967296, math.floor(b) % 4294967296)
      if r < 0 then r = r + 4294967296 end
      return r
    end
    local _r, _p = 0, 1
    for _ = 1, 8 do
      _r = _r + _XN[(a % 16) * 16 + (b % 16)] * _p
      a = math.floor(a / 16)
      b = math.floor(b / 16)
      _p = _p * 16
    end
    return _r
  end
  -- Loader v3: la clave ya no viaja en la respuesta. Se deriva de key+hwid+token,
  -- datos que el cliente ya envio: la respuesta capturada es ciphertext sin clave.
  -- (Rutina identica corre en el servidor.)
  local function _xs(h)
    h = (h * 8192) % _M
    h = _xor(h, math.floor(h / 131072))
    h = (h * 32) % _M
    return h
  end
  local function _mix(_seed)
    local _h1, _h2 = 374761393, 668265263
    for _i = 1, #_seed do
      _h1 = (_h1 + _seed:byte(_i) * 31 + 7) % _M
      _h1 = _xs(_h1)
      _h2 = (_h2 + _h1) % _M
      _h2 = _xs(_h2)
    end
    local _kb = {}
    for _i = 1, 16 do
      _h1 = _xs(_h1)
      _h2 = _xs(_h2)
      _kb[_i] = _xor(_h1, _h2) % 256
    end
    return _kb
  end
  local _rest = body:sub(#_encp + 1)
  local _nl = _rest:find("\\n", 1, true)
  local _kb = nil
  if _nl then
    local _khex = _rest:sub(1, _nl - 1)
    if #_khex == 32 then
      _kb = {}
      for _i = 1, 16 do
        local _hi = tonumber(_khex:sub(_i * 2 - 1, _i * 2 - 1), 16)
        local _lo = tonumber(_khex:sub(_i * 2, _i * 2), 16)
        if not _hi or not _lo then _kb = nil break end
        _kb[_i] = _hi * 16 + _lo
      end
      if _kb then _rest = _rest:sub(_nl + 1) end
    end
  end
  if not _kb then
    local _ks = (tostring(key or ""):gsub("^%s+", "")):gsub("%s+$", "")
    local _seed = _ks:sub(1, 64) .. "|" .. tostring(hwid or ""):sub(1, 128) .. "|" .. tostring(_tok or "") .. "|v2"
    _kb = _mix(_seed)
  end
  local _b64 = _rest
  _b64 = (_b64:gsub("^%s+", ""))
  _b64 = (_b64:gsub("%s+$", ""))
  if #_b64 == 0 then kick("VERIFY_FAILED") end
  local _k = {}
  for _j = 0, 3 do
    local _w = 0
    for _i = 0, 3 do
      local _p = _j * 4 + _i
      _w = _w + _kb[_p + 1] * 256 ^ _i
    end
    _k[_j + 1] = _w
  end
  local _AL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
  local _im = {}
  for _i = 1, 64 do _im[_AL:byte(_i)] = _i - 1 end
  local _bytes = {}
  local _bn = 0
  local _acc, _bits = 0, 0
  for _i = 1, #_b64 do
    if _i % 4096 == 0 and task then task.wait() end
    local _d = _im[_b64:byte(_i)]
    if _d then
      _acc = _acc * 64 + _d
      _bits = _bits + 6
      if _bits >= 8 then
        _bits = _bits - 8
        _bn = _bn + 1
        _bytes[_bn] = math.floor(_acc / 2 ^ _bits) % 256
        _acc = _acc % 2 ^ _bits
      end
    end
  end
  if _bn == 0 or _bn % 4 ~= 0 then kick("VERIFY_FAILED") end
  local _DL = 2654435769
  local _m = _bn / 4
  if _m < 2 then kick("VERIFY_FAILED") end
  local _v = {}
  for _i = 1, _m do
    local _o = (_i - 1) * 4
    _v[_i] = _bytes[_o + 1] + _bytes[_o + 2] * 256 + _bytes[_o + 3] * 65536 + _bytes[_o + 4] * 16777216
  end
  local function _mx(sum, y, z, p0, e, k)
    local _t1 = _xor(math.floor(z / 32), (y * 4) % _M)
    local _t2 = _xor(math.floor(y / 8), (z * 16) % _M)
    local _s1 = (_t1 + _t2) % _M
    local _t3 = _xor(sum, y)
    local _t4 = _xor(k[_xor(p0 % 4, e) + 1], z)
    local _s2 = (_t3 + _t4) % _M
    return _xor(_s1, _s2)
  end
  local _rounds = 6 + math.floor(52 / _m)
  local _sum = (_DL * _rounds) % _M
  local _y = _v[1]
  repeat
    local _e = math.floor(_sum / 4) % 4
    for _p = _m, 2, -1 do
      local _z = _v[_p - 1]
      _y = (_v[_p] - _mx(_sum, _y, _z, _p - 1, _e, _k)) % _M
      _v[_p] = _y
      if _p % 4096 == 0 and task then task.wait() end
    end
    local _z2 = _v[_m]
    _y = (_v[1] - _mx(_sum, _y, _z2, 0, _e, _k)) % _M
    _v[1] = _y
    _sum = (_sum - _DL) % _M
  until _sum == 0
  local _parts = {}
  for _i = 1, _m do
    local _w = _v[_i]
    _parts[_i] = string.char(_w % 256, math.floor(_w / 256) % 256, math.floor(_w / 65536) % 256, math.floor(_w / 16777216) % 256)
  end
  local _pt = table.concat(_parts)
  local _len = #_pt
  while _len > 0 and _pt:byte(_len) == 0 do _len = _len - 1 end
  body = "!VANTARMOR:CODE\\n" .. _pt:sub(1, _len)
end
-- El servidor responde "!VANTARMOR:CODIGO" (error) o "!VANTARMOR:CODE" seguido del script (éxito).
-- Se usa string.sub en lugar de match para soportar scripts multilínea
-- (el patrón (.*) no captura saltos de línea en Lua, y el $ tampoco funciona bien con salto final).
-- Los códigos de error toleran CR-LF o LF al final (algunos proxies / ejecutores los agregan).
local errCode = body:match("^!VANTARMOR:([%u_]+)[\\r\\n]*$")
if errCode then kick(errCode) end
local _prefix = "!VANTARMOR:CODE\\n"
local payload = (body:sub(1, #_prefix) == _prefix and #body > #_prefix) and body:sub(#_prefix + 1) or nil
if not payload then kick("VERIFY_FAILED") end
_dbg("paso 5: payload descifrado largo=" .. tostring(#payload))
-- Ultima puerta antes de compilar el script descifrado: si el entorno es un volcador (sonda
-- sandbox), se congela aqui tambien. El codigo descifrado nunca llega a ejecutarse ahi.
local _spl, _spw = _sandboxProbeHit()
if _spl == "hard" then
  _dbg("kick: sandbox_probe " .. tostring(_spw))
  pcall(function() game:HttpGet(AUTH_BASE .. "&key=" .. enc(key) .. "&hwid=" .. enc(hwid) .. "&rbxid=" .. enc(rbxid) .. "&tamper=1") end)
  _clearKey()
  -- Con jugador real se le echa; en un volcador sin jugador queda el congelamiento
  _forceKick(MSG.TAMPERING .. "\\n(ref: " .. tostring(_spw) .. ")")
  warn(MSG.TAMPERING .. "\\n(ref: " .. tostring(_spw) .. ")")
  while true do end
elseif _spl == "soft" then
  -- El ejecutor nombra su propio envoltorio "sandbox" en errores internos: aviso, no corte
  _dbg("soft: sandbox_probe " .. tostring(_spw))
end
-- Revision despues del payload: si algo se engancho mientras corria, se corta. Las herramientas
-- presentes sin enganches ya no se reportan (avisaban ejecuciones normales como volcados).
local _lt2, _ltw2 = loaderTampered()
if _lt2 then
  _dbg("kick: loadertampered_post " .. _ltw2)
  pcall(function() game:HttpGet(AUTH_BASE .. "&key=" .. enc(key) .. "&hwid=" .. enc(hwid) .. "&tamper=1") end)
  _clearKey()
  kick("TAMPERING", _ltw2)
end
${guard ? `pcall(function() if getgenv then getgenv().VANTARMOR_RUN = ${JSON.stringify(guard)} end end)
pcall(function() _G.VANTARMOR_RUN = ${JSON.stringify(guard)} end)
` : ''}-- Tercer argumento de loadstring = entorno del loader (Luau lo soporta): asi el payload
-- nunca hereda el entorno plano aunque el executor no tenga setfenv.
local _lfn
pcall(function() if getfenv then _lfn = getfenv(0) end end)
if type(_lfn) ~= 'table' then pcall(function() if getgenv then _lfn = getgenv() end end) end
if type(_lfn) ~= 'table' then pcall(function() if getfenv then _lfn = getfenv(1) end end) end
if type(_lfn) ~= 'table' then _lfn = _G end
if type(_lfn) ~= 'table' then _lfn = {} end
-- Si el loadstring del executor compila el payload en el entorno global de Roblox
-- (ignora el 3er argumento y no hay setfenv), el VM no ve loadstring ni los globals del
-- executor. Se publican en _G (misma tabla que usa ese entorno) y se deja el entorno
-- completo en _G.VANTARMOR_ENV como ultima reserva del VM.
pcall(function() if type(loadstring) == "function" and _G then _G.loadstring = loadstring end end)
pcall(function() if type(getgenv) == "function" and _G and _G.getgenv == nil then _G.getgenv = getgenv end end)
pcall(function() if type(getfenv) == "function" and _G and _G.getfenv == nil then _G.getfenv = getfenv end end)
pcall(function() if type(setfenv) == "function" and _G and _G.setfenv == nil then _G.setfenv = setfenv end end)
pcall(function() local _rq = request or http_request or (syn and syn.request) if type(_rq) == "function" and _G and _G.request == nil then _G.request = _rq end end)
pcall(function() if _G and type(_lfn) == "table" then _G.VANTARMOR_ENV = _lfn end end)
if type(_lfn.loadstring) ~= 'function' and type(loadstring) == 'function' then _lfn.loadstring = loadstring end
if type(_lfn._G) ~= 'table' then _lfn._G = _lfn end
local fn, cerr = loadstring(payload, "=VantArmor", _lfn)
-- El error exacto de compilación queda en la consola del executor (para diagnosticar el script)
if not fn then
  warn("[VANTARMOR] No se pudo compilar el script: " .. tostring(cerr))
  kick("PAYLOAD_LOAD_FAILED")
end
-- task.spawn: ejecuta el script del usuario en un hilo separado.
-- Si el script del usuario tiene un error, no mata el bootstrap y el error
-- aparece con el nombre real del script (no "LocalScript").
-- El payload compilado hereda el entorno global plano del executor (sin game ni getgenv),
-- y ahi el VM del Ofuscador 5 no resuelve los globals del script del usuario. Se lo cambia
-- al entorno real del loader (con game, workspace y los globals del executor).
local _sfok = pcall(function()
  if type(setfenv) == 'function' and type(_lfn) == 'table' then setfenv(fn, _lfn) end
end)
_dbg('payload setfenv ' .. tostring(_sfok))
pcall(function()
  local _ps, _pf = pcall(loadstring, 'return _G')
  if _ps and type(_pf) == "function" then
    local _env = _pf()
    if type(_env) == "table" then
      if type(loadstring) == "function" then _env.loadstring = loadstring end
      if type(getgenv) == "function" and _env.getgenv == nil then _env.getgenv = getgenv end
      _env.VANTARMOR_ENV = _lfn
    end
  end
end)
task.spawn(function()
  local _rok, _rerr = pcall(fn, _lfn)
  if not _rok and _rerr then warn(tostring(_rerr)) end
end)
task.spawn(function()
  pcall(function() task.wait(1.5) end)
  pcall(function()
    local _sv = getgenv and getgenv().VANTARMOR_STATUS
    if _sv and _sv.Destroy then _sv:Destroy() end
  end)
end)
`;
}

// El bootstrap del loader se sirve ofuscado con los ofuscadores reales del servidor, en este orden:
// Clyde (ligero, sin VM) y NextOfuscator de reserva. Cada resultado queda en memoria: mismo
// bootstrap plano = misma salida, sin volver a ofuscar en cada descarga. Sin modo VM: la capa VM
// rompía ejecutores móviles (leía script_key mal y kickeaba con "A valid key is required"); por
// eso queda el stub de respaldo (bytes desplazados + escapes \ddd, ilegible a simple vista,
// decodificado con Lua puro) y LOADER_OBF=off como salida rápida. La seguridad fuerte sigue en el
// servidor (validación de key/HWID), no en ocultar el loader.
// La cadena va ENCENDIDA por defecto desde el loader v6 (sin capa VM, que era lo que rompía
// móviles). Si un executor se rompe, LOADER_OBF=off vuelve al stub codificado al instante.
const LOADER_OBF = String(process.env.LOADER_OBF || 'on').trim().toLowerCase();
const LOADER_OBF_CHAIN = (LOADER_OBF === 'off' || LOADER_OBF === '') ? [] : ['vantobf'];
const loaderObfCache = new Map();
// Codificacion del stub: suma dependiente de posicion mas clave derivada del contenido
// (8 bytes de sha256 del propio bootstrap). Determinista (misma entrada = misma salida, la
// cache de protectLoader sigue valiendo) y ya no se recupera con un env-log de una variable:
// hay que reimplementar el decodificador del stub, no basta leer _b.
function loaderEncodeKey(plain) {
  return Array.from(crypto.createHash('sha256').update(String(plain)).digest().subarray(0, 8));
}
function loaderEncodedBlob(plain) {
  const bytes = Buffer.from(String(plain), 'utf8');
  const key = loaderEncodeKey(plain);
  // String con escapes \ddd (no tabla numerica): Luau lo compila mucho mas rapido y no agota memoria
  const parts = new Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    parts[i] = '\\' + String((bytes[i] + key[i % 8] + (i % 251)) & 0xff).padStart(3, '0');
  }
  return '"' + parts.join('') + '"';
}
function loaderStubFromPlain(plain) {
  const blob = loaderEncodedBlob(plain);
  const key = loaderEncodeKey(plain);
  return `-- VANTARMOR\nlocal _b = ${blob}\nlocal _k = {${key.join(',')}}\nlocal _t = {}\nfor _i = 1, #_b do _t[_i] = string.char((string.byte(_b, _i) - _k[(_i - 1) % 8 + 1] - (_i - 1) % 251) % 256) if _i % 2048 == 0 and task then task.wait() end end\nlocal _fn = loadstring(table.concat(_t))\nif not _fn then error("[VANTARMOR] loader invalido", 0) end\n_fn()\n`;
}
// Sello anti-dump: el loader lo pone en el entorno y el script ofuscado (Ofuscador 5) lo exige.
// Si alguien ejecuta el payload solo, sin el loader, el script lo echa con kick.
function scriptGuardSecret(srow) {
  let gs = srow?.guard_secret;
  if (!gs) {
    gs = crypto.randomBytes(16).toString('hex');
    try { db.prepare('UPDATE scripts SET guard_secret = ? WHERE id = ?').run(gs, srow.id); } catch { /* siguiente intento */ }
  }
  return gs;
}
function scriptGuardValue(secret) {
  return crypto.createHash('sha256').update('vantarmor-guard|' + String(secret || '')).digest('hex').slice(0, 32);
}
// Secreto y codigo pre-auth del script dueño del loader (se buscan al generar el loader)
function loaderExtras(loaderId) {
  const srow = /^[0-9a-f]{40}$/.test(String(loaderId || '')) ? stmt.scriptByLoaderId.get(loaderId) : null;
  return {
    secret: srow ? scriptAuthSecret(srow) : '',
    initCode: srow ? getInitCode(srow.id) : '',
    guard: srow ? scriptGuardValue(scriptGuardSecret(srow)) : '',
  };
}
function loaderStub(loaderId, ffa, secure) {
  const ex = loaderExtras(loaderId);
  return loaderStubFromPlain(loaderBootstrap(loaderId, ffa, secure, ex.secret, ex.initCode, ex.guard));
}
// Los parsers de Lua 5.1 ahogan con expresiones de una sola linea muy largas (el VM bundle
// trae table.concat({string.char(...)}) de decenas de miles de caracteres). Partir la lista
// en varios concat unidos con .. produce el mismo string y compila en todos lados.
function splitLongConcatLines(out) {
  return String(out).split('\n').map(line => {
    if (line.length <= 3900) return line;
    const m = /^(local\s+[\w.]+)\s*=\s*table\.concat\(\{(.*)\}\)\s*$/.exec(line);
    if (!m) return line;
    const varName = m[1].replace(/^local\s+/, '');
    const parts = [];
    let depth = 0, cur = '';
    for (const ch of m[2]) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; }
      else cur += ch;
    }
    if (cur.trim()) parts.push(cur);
    const emit = calls => {
      const lines2 = [`${m[1]} = ${calls[0]}`];
      for (let i = 1; i < calls.length; i++) lines2.push(`${varName} = ${varName} .. ${calls[i]}`);
      return lines2.join('\n');
    };
    if (parts.length >= 2) {
      const chunks = [];
      let cc = [], cl = 0;
      for (const p of parts) {
        const t = p.trim();
        if (cl + t.length > 2800 && cc.length) { chunks.push(cc); cc = []; cl = 0; }
        cc.push(t); cl += t.length;
      }
      if (cc.length) chunks.push(cc);
      return emit(chunks.map(c => `table.concat({${c.join(',')}})`));
    }
    const m2 = /^(local\s+[\w.]+)\s*=\s*table\.concat\(\{string\.char\(([\d,]+)\)\}\)\s*$/.exec(line);
    if (!m2) return line;
    const nums = m2[2].split(',');
    const chunks2 = [];
    for (let i = 0; i < nums.length; i += 700) chunks2.push(nums.slice(i, i + 700));
    return emit(chunks2.map(c => `table.concat({string.char(${c.join(',')})})`));
  }).join('\n');
}
async function protectLoaderPlain(plain) {
  const cacheKey = crypto.createHash('sha256').update(plain).digest('hex');
  const cached = loaderObfCache.get(cacheKey);
  if (cached !== undefined) return cached;
  let out = null;
  for (const name of LOADER_OBF_CHAIN) {
    try {
      // Sin modo VM: la capa VM rompía ejecutores móviles (kickeaba con "A valid key is required")
      const result = await obfuscate(plain, name, { vm: false });
      if (result && String(result).trim()) { out = String(result).trim() + '\n'; break; }
      console.warn(`[Loader] Ofuscador ${name} devolvió salida vacía`);
    } catch (err) {
      console.warn(`[Loader] Ofuscador ${name} falló:`, String(err.message || err).slice(0, 200));
    }
  }
  if (out === null) out = loaderStubFromPlain(plain);
  else out = splitLongConcatLines(out);
  if (loaderObfCache.size > 500) loaderObfCache.clear();
  loaderObfCache.set(cacheKey, out);
  return out;
}
async function protectLoader(loaderId, ffa, secure) {
  const ex = loaderExtras(loaderId);
  const plain = loaderBootstrap(loaderId, ffa, secure, ex.secret, ex.initCode, ex.guard);
  return protectLoaderPlain(plain);
}

// Loader v5 (una sola etapa): el archivo que se reparte lee la key del usuario
// (getgenv().VANTARMOR_KEY o script_key), pide a /v1/l el payload firmado y solo compila
// si la firma HMAC-SHA256 y la vigencia (10 min) verifican. Sin key no hay entrega (salvo\n// scripts FFA, que son publicos por diseño): el
// servidor responde 401. Los loaders viejos dejan de funcionar: hay que volver a descargar.
function v5Loader(loaderId, ffa, secure) {
  const ex = loaderExtras(loaderId);
  const WARN = 'Vantarmor is a Lua whitelisting service, and attempting to deobfuscate, reverse-engineer, or otherwise bypass its protections is against the service\'s Terms of Service. Continuing to do so could potentially get the owner or other involved parties in trouble, including account or service consequences. Stop attempting to deobfuscate or bypass Vantarmor and leave the protected code alone. Any AI usage against this will result in severe punishments and DMCA. Please abort.';
  return `-- VANTARMOR (v6): entrega cifrada. El loader no guarda ningun secreto del servidor.
-- La key va en getgenv().VANTARMOR_KEY (o script_key) ANTES de ejecutar el loader.
-- El servidor valida key + HWID y entrega solo ciphertext; la clave de descifrado se
-- deriva de key + HWID + vigencia (max 10 minutos), datos que el loader ya conoce (salvo\n-- scripts FFA, que son publicos por diseño).
local SK = ${JSON.stringify(String(loaderId))}
local GUARD = ${JSON.stringify(String(ex.guard || ''))}
local FFA = ${ffa ? 'true' : 'false'}
local LURL = ${JSON.stringify(`${APP_URL}/v1/l`)}
local AURL = ${JSON.stringify(`${APP_URL}/v1/a`)}
local HEAD = "[ VANTARMOR ]\\n"
local WARN = ${JSON.stringify(WARN)}
local MSG = {
  KEY_REQUIRED = HEAD .. "Set getgenv().VANTARMOR_KEY before loading.",
  NOT_AUTHORIZED = HEAD .. "You are not authorized to run this script.",
  RATE_LIMITED = HEAD .. "Too many attempts. Please wait a minute and try again.",
  EXPIRED = HEAD .. "Your session expired. Please rejoin.",
  BAD_SIGNATURE = HEAD .. "Verification failed (bad signature). Please re-download the loader.",
  CONNECTION_FAILED = HEAD .. "Connection failed. Please try again.",
  TAMPERING = HEAD .. WARN,
  PAYLOAD_LOAD_FAILED = HEAD .. "The script could not be loaded by your executor.\\nPlease contact the script owner.",
}
-- [AntiForge] Solo la clave publica del servidor: n, R = 2^2058 mod n y R2 = R^2 mod n (Montgomery).
local VANT_RSA_N = "${rsaConsts().n}"
local VANT_RSA_R2 = "${rsaConsts().r2}"
local VANT_RSA_NP = ${rsaConsts().np}
${LUA_SHA256_CORE}
local Players = game:GetService("Players")
local HttpService = game:GetService("HttpService")
local key, hwid, rbxid = "", "", ""
local function _findLP()
  local lp = nil
  pcall(function() lp = Players.LocalPlayer end)
  if not lp then pcall(function() lp = game.Players.LocalPlayer end) end
  if not lp then
    pcall(function()
      local list = Players.GetPlayers and Players:GetPlayers()
      if type(list) == "table" then lp = list[1] end
    end)
  end
  return lp
end
local function _forceKick(msg)
  local lp = _findLP()
  if lp then pcall(function() lp:Kick(msg) end) end
end
local function kick(msg)
  pcall(function() warn(msg) end)
  _forceKick(msg)
  error(msg, 0)
end
-- Estado del ejecutor para el log del dueño: ejecutores conocidos = confianza normal
local _lowTrust = true
pcall(function()
  if type(identifyexecutor) == "function" then
    local _n = tostring(identifyexecutor() or ""):lower()
    local _known = { "delta", "xeno", "solara", "krnl", "fluxus", "hydrogen", "codex", "arceus", "wave", "trigon", "crypt", "script-ware", "scriptware", "synapse", "evon", "vega", "ronin", "volcano", "swift", "nihon", "bunni", "willow", "macsploit", "potassium", "melon", "awp" }
    for _, _k in ipairs(_known) do
      if _n:find(_k, 1, true) then _lowTrust = false break end
    end
  end
end)
local _sg
pcall(function()
  local _ui = (type(gethui) == 'function' and gethui()) or nil
  if not _ui then _ui = game:FindFirstChildOfClass('CoreGui') end
  if not _ui then
    local _pl = game:GetService('Players')
    local _lp = _pl and (_pl.LocalPlayer or (_pl.GetPlayers and _pl:GetPlayers()[1]))
    _ui = _lp and _lp:FindFirstChildOfClass('PlayerGui')
  end
  if not _ui then return end
  local g = Instance.new('ScreenGui')
  g.Name = 'VANTARMOR_STATUS'
  g.IgnoreGuiInset = true
  g.ResetOnSpawn = false
  g.DisplayOrder = 2147483647
  local t = Instance.new('TextLabel')
  t.AnchorPoint = Vector2.new(0.5, 1)
  t.Position = UDim2.new(0.5, 0, 1, -14)
  t.Size = UDim2.new(1, 0, 0, 30)
  t.BackgroundTransparency = 1
  t.Font = Enum.Font.GothamBold
  t.TextSize = 16
  t.TextColor3 = Color3.fromRGB(240, 240, 248)
  t.TextStrokeTransparency = 0.45
  t.Text = 'executing script...'
  t.Parent = g
  g.Parent = _ui
  _sg = g
  if getgenv then getgenv().VANTARMOR_STATUS = g end
end)
local function _close()
  pcall(function() if _sg then _sg:Destroy() end end)
end
local function _clearKey()
  pcall(function()
    if type(getgenv) == "function" then local _g = getgenv(); if _g then _g.VANTARMOR_KEY = nil; _g.script_key = nil end end
  end)
  if type(_G) == "table" then pcall(function() _G.VANTARMOR_KEY = nil; _G.script_key = nil end) end
end
-- Key del usuario: getgenv().VANTARMOR_KEY primero; script_key sigue funcionando
local _rk = (getgenv and rawget(getgenv(), "VANTARMOR_KEY"))
  or (type(VANTARMOR_KEY) == "string" and VANTARMOR_KEY)
  or (_G and type(rawget(_G, "VANTARMOR_KEY")) == "string" and rawget(_G, "VANTARMOR_KEY"))
  or (getgenv and rawget(getgenv(), "script_key"))
  or (type(script_key) == "string" and script_key)
  or (_G and type(rawget(_G, "script_key")) == "string" and rawget(_G, "script_key"))
  or ""
if type(_rk) == "string" then key = (_rk:gsub("^%s+", ""):gsub("%s+$", "")) end
if #key > 64 then key = key:sub(1, 64) end
if key == "" and not FFA then _close() error(MSG.KEY_REQUIRED, 0) end
local function enc(s) return (s:gsub("[^%w%-_%.~]", function(c) return string.format("%%%02X", string.byte(c)) end)) end
pcall(function()
  local h = game:GetService("RbxAnalyticsService"):GetClientId()
  if type(h) == "string" and #h >= 8 then hwid = h end
end)
if #hwid > 128 then hwid = hwid:sub(1, 128) end
pcall(function() rbxid = tostring(Players.LocalPlayer.UserId) end)
-- Reporte de volcado al dueño: lleva key, HWID y razon (solo corte real)
local function _reportTamper(why)
  pcall(function()
    local _r = request or http_request or (syn and syn.request)
    if _r then _r({ Url = AURL, Method = "POST", Headers = { ["Content-Type"] = "application/json" }, Body = HttpService:JSONEncode({ s = SK, key = key, hwid = hwid, rbxid = rbxid, ver = 6, tamper = "1", why = why }) }) end
  end)
end
local function nativeFn(f)
  if type(f) ~= "function" then return false end
  local okI, info = pcall(function() return debug.getinfo(f, "S") end)
  return not (okI and type(info) == "table" and info.what ~= "C")
end
local function _tampered()
  if not nativeFn(loadstring) then return "loadstring_no_native" end
  local _km = false
  pcall(function()
    local _envs = {}
    if type(getgenv) == "function" then local _e = getgenv(); if type(_e) == "table" then _envs[#_envs + 1] = _e end end
    if type(_G) == "table" then _envs[#_envs + 1] = _G end
    for _, _e in ipairs(_envs) do
      for _, _m in ipairs({ "__km_ls_hooked", "__km_wf_raw", "__km_ls_ref", "_KM_DUMP", "_KM_DUMP_LEN", "_LAST_DUMP", "_LAST_DUMP_NAME" }) do
        if rawget(_e, _m) ~= nil then _km = true end
      end
    end
  end)
  if _km then return "dumper_markers" end
  return nil
end
local _tw = _tampered()
if _tw then _clearKey() _reportTamper(_tw) kick(MSG.TAMPERING) end
-- Reloj congelado (dos ventanas seguidas) = volcado: reporte y corte
do
  local detections = 0
  pcall(function()
    local function _win()
      local hits = 0
      local conn = game:GetService("RunService").Heartbeat:Connect(function() hits = hits + 1 end)
      local t0 = os.clock()
      repeat task.wait() until hits >= 2 or os.clock() - t0 > 2
      conn:Disconnect()
      return hits >= 2
    end
    if not _win() and not _win() then detections = 1 end
  end)
  if detections > 0 then _clearKey() _reportTamper("heartbeat_congelado") kick(MSG.TAMPERING) end
end
-- [AntiDump] Sonda sandbox (la del anti-dump de referencia): el error del ejecutor revela
-- su envoltorio interno. Solo "httplog" corta: congelado antes de pedir el payload.
do
  local _hit = false
  pcall(function()
    local _, _s = pcall(function() string.byte("a", function() return end, 9999, 38) end)
    if type(_s) == "string" and _s:find("httplog", 1, true) then _hit = true end
  end)
  if _hit then
    _clearKey()
    _reportTamper("sandbox_probe")
    pcall(function() local _lp = _findLP() if _lp then _lp:Kick(MSG.TAMPERING) end end)
    warn(MSG.TAMPERING)
    while true do end
  end
end
${ex.initCode ? `-- [Pre-Auth] Codigo del dueño (equivale a LRM_INIT_SCRIPT): corre antes de la autenticacion.
-- No pasa por el ofuscador, se lee tal cual: no pongas aqui nada critico.
${ex.initCode}
` : ''}-- Pide el payload firmado: POST JSON (la key no viaja en la URL); GET de reserva.
-- Error del servidor (401/429) = corte inmediato con su mensaje; fallo de red = 3 reintentos.
local _data = nil
for _i = 1, 3 do
  local _raw = nil
  do
    local _r = request or http_request or (syn and syn.request)
    if _r then
      local _okp, _resp = pcall(_r, { Url = LURL, Method = "POST", Headers = { ["Content-Type"] = "application/json" }, Body = HttpService:JSONEncode({ s = SK, key = key, hwid = hwid, rbxid = rbxid, ver = 6, lt = _lowTrust and "1" or nil, ee = 1 }) })
      if _okp and type(_resp) == "table" then
        local _b = _resp.Body or _resp.body
        if type(_b) == "string" and #_b > 0 then _raw = _b end
      end
    end
  end
  if not _raw then
    local _okg, _gr = pcall(function() return game:HttpGet(LURL .. "?s=" .. enc(SK) .. "&key=" .. enc(key) .. "&hwid=" .. enc(hwid) .. "&rbxid=" .. enc(rbxid) .. "&ee=1&ver=6") end)
    if _okg and type(_gr) == "string" and #_gr > 0 then _raw = _gr end
  end
  if _raw then
    local _okj, _j = pcall(function() return HttpService:JSONDecode(_raw) end)
    if _okj and type(_j) == "table" then
      if _j.ok == true then _data = _j break end
      _close()
      local _em = MSG.NOT_AUTHORIZED
      if _j.error == "rate_limited" then _em = MSG.RATE_LIMITED end
      if _j.error == "unavailable" then _em = MSG.CONNECTION_FAILED end
      error(_em, 0)
    end
  end
  if _i < 3 then pcall(function() task.wait(1 + math.random() * 2) end) end
end
if not _data then
  _close()
  pcall(function() warn(MSG.TAMPERING) end)
  error(MSG.TAMPERING, 0)
end
-- Vigencia: exp en segundos Unix, maximo 10 minutos desde la emision
local _exp = tonumber(_data.exp) or 0
if os.time() > _exp then _close() error(MSG.EXPIRED, 0) end
-- Descifrado v5: la entrega cifrada (ee=1) manda ciphertext; la clave se deriva en ambos
-- lados de datos que ya viajan (secreto, key, hwid, exp). Rutina identica a la del servidor.
local function _vantDec5(_b64, _ckey, _chwid, _cexp)
  local _M = 4294967296
  local _XN = {}
  for _a = 0, 15 do
    for _b = 0, 15 do
      local _x, _p, _aa, _bb = 0, 1, _a, _b
      for _ = 1, 4 do
        if _aa % 2 ~= _bb % 2 then _x = _x + _p end
        _p = _p * 2
        _aa = math.floor(_aa / 2)
        _bb = math.floor(_bb / 2)
      end
      _XN[_a * 16 + _b] = _x
    end
  end
  local _bits = nil
  do
    local _ok, _bt = pcall(function() return bit32 end)
    if _ok and type(_bt) == "table" and type(_bt.bxor) == "function" then _bits = _bt end
  end
  if not _bits then
    local _ok, _bt = pcall(function() return bit end)
    if _ok and type(_bt) == "table" and type(_bt.bxor) == "function" and type(_bt.band) == "function" then _bits = _bt end
  end
  local function _xor(a, b)
    if _bits then
      local r = _bits.bxor(math.floor(a) % 4294967296, math.floor(b) % 4294967296)
      if r < 0 then r = r + 4294967296 end
      return r
    end
    local _r, _p = 0, 1
    for _ = 1, 8 do
      _r = _r + _XN[(a % 16) * 16 + (b % 16)] * _p
      a = math.floor(a / 16)
      b = math.floor(b / 16)
      _p = _p * 16
    end
    return _r
  end
  local function _xs(h)
    h = (h * 8192) % _M
    h = _xor(h, math.floor(h / 131072))
    h = (h * 32) % _M
    return h
  end
  local function _mix(_seed)
    local _h1, _h2 = 374761393, 668265263
    for _i = 1, #_seed do
      _h1 = (_h1 + _seed:byte(_i) * 31 + 7) % _M
      _h1 = _xs(_h1)
      _h2 = (_h2 + _h1) % _M
      _h2 = _xs(_h2)
    end
    local _kb = {}
    for _i = 1, 16 do
      _h1 = _xs(_h1)
      _h2 = _xs(_h2)
      _kb[_i] = _xor(_h1, _h2) % 256
    end
    return _kb
  end
  local _seed = tostring(_ckey or ""):sub(1, 64) .. "|" .. tostring(_chwid or ""):sub(1, 128) .. "|" .. string.format("%.0f", _cexp or 0) .. "|v6"
  local _kb = _mix(_seed)
  local _b = (_b64 or ""):gsub("%s+", "")
  if #_b == 0 then return nil end
  local _AL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
  local _im = {}
  for _i = 1, 64 do _im[_AL:byte(_i)] = _i - 1 end
  local _bytes = {}
  local _bn = 0
  local _acc, _bts = 0, 0
  for _i = 1, #_b do
    local _d = _im[_b:byte(_i)]
    if _d then
      _acc = _acc * 64 + _d
      _bts = _bts + 6
      if _bts >= 8 then
        _bts = _bts - 8
        _bn = _bn + 1
        _bytes[_bn] = math.floor(_acc / 2 ^ _bts) % 256
        _acc = _acc % 2 ^ _bts
      end
    end
  end
  if _bn == 0 or _bn % 4 ~= 0 then return nil end
  local _DL = 2654435769
  local _m = _bn / 4
  if _m < 2 then return nil end
  local _k = {}
  for _j = 0, 3 do
    local _w = 0
    for _i = 0, 3 do
      local _p = _j * 4 + _i
      _w = _w + _kb[_p + 1] * 256 ^ _i
    end
    _k[_j + 1] = _w
  end
  local _v = {}
  for _i = 1, _m do
    local _o = (_i - 1) * 4
    _v[_i] = _bytes[_o + 1] + _bytes[_o + 2] * 256 + _bytes[_o + 3] * 65536 + _bytes[_o + 4] * 16777216
  end
  local function _mx(sum, y, z, p0, e, k)
    local _t1 = _xor(math.floor(z / 32), (y * 4) % _M)
    local _t2 = _xor(math.floor(y / 8), (z * 16) % _M)
    local _s1 = (_t1 + _t2) % _M
    local _t3 = _xor(sum, y)
    local _t4 = _xor(k[_xor(p0 % 4, e) + 1], z)
    local _s2 = (_t3 + _t4) % _M
    return _xor(_s1, _s2)
  end
  local _rounds = 6 + math.floor(52 / _m)
  local _sum = (_DL * _rounds) % _M
  local _y = _v[1]
  repeat
    local _e = math.floor(_sum / 4) % 4
    for _p = _m, 2, -1 do
      local _z = _v[_p - 1]
      _y = (_v[_p] - _mx(_sum, _y, _z, _p - 1, _e, _k)) % _M
      _v[_p] = _y
      if _p % 4096 == 0 and task then task.wait() end
    end
    local _z2 = _v[_m]
    _y = (_v[1] - _mx(_sum, _y, _z2, 0, _e, _k)) % _M
    _v[1] = _y
    _sum = (_sum - _DL) % _M
  until _sum == 0
  local _parts = {}
  for _i = 1, _m do
    local _w = _v[_i]
    _parts[_i] = string.char(_w % 256, math.floor(_w / 256) % 256, math.floor(_w / 65536) % 256, math.floor(_w / 16777216) % 256)
  end
  local _pt = table.concat(_parts)
  local _len = #_pt
  while _len > 0 and _pt:byte(_len) == 0 do _len = _len - 1 end
  return _pt:sub(1, _len)
end
-- v6: el cliente ya no guarda ningun secreto del servidor, asi que no puede verificar la
-- firma HMAC (esa era la puerta por la que el secreto viajaba a cada loader). La
-- autenticidad va por construccion: solo una respuesta real del servidor descifra a texto
-- que compila, porque la clave depende de key|hwid|exp y la vigencia acota el replay.
local _pay = nil
if type(_data.enc) == "string" and #_data.enc > 0 then
  _pay = _vantDec5(_data.enc, key, hwid, _exp)
elseif type(_data.body) == "string" and #_data.body > 0 then
  _pay = _data.body
end
if type(_pay) ~= "string" or #_pay < 16 or string.sub(_pay, 1, 14) ~= "-- [VantArmor]" then _close() error(MSG.BAD_SIGNATURE, 0) end
${LOADER_VERIFY_LUA}
_data.body = _pay
-- Sello que exige el VM del payload
pcall(function() if getgenv then getgenv().VANTARMOR_RUN = GUARD end end)
pcall(function() _G.VANTARMOR_RUN = GUARD end)
-- Entorno para el payload: el 3er argumento de loadstring le pasa el entorno del loader,
-- asi el payload ve los globals del executor (loadstring, game, task, getgenv). Sin esto,
-- un executor Luau compila el payload en el entorno global de Roblox, donde loadstring no
-- existe y el VM no puede resolver los globals del script (nilcall).
local _lf5
pcall(function() _lf5 = getfenv(1) end)
if type(_lf5) ~= "table" then pcall(function() if getgenv then _lf5 = getgenv() end end) end
if type(_lf5) ~= "table" then _lf5 = _G end
if type(_lf5) ~= "table" then _lf5 = {} end
pcall(function()
  local _le = getfenv and getfenv(1)
  if type(_le) == "table" and _le ~= _lf5 then
    for _k, _v in pairs(_le) do if _lf5[_k] == nil then _lf5[_k] = _v end end
  end
end)
-- Si el loadstring del executor compila el payload en el entorno global de Roblox
-- (ignora el 3er argumento y no hay setfenv), el VM no ve loadstring ni los globals del
-- executor. Se publican en _G (misma tabla que usa ese entorno) y se deja el entorno
-- completo en _G.VANTARMOR_ENV como ultima reserva del VM.
pcall(function() if type(loadstring) == "function" and _G then _G.loadstring = loadstring end end)
pcall(function() if type(getgenv) == "function" and _G and _G.getgenv == nil then _G.getgenv = getgenv end end)
pcall(function() if type(getfenv) == "function" and _G and _G.getfenv == nil then _G.getfenv = getfenv end end)
pcall(function() if type(setfenv) == "function" and _G and _G.setfenv == nil then _G.setfenv = setfenv end end)
pcall(function() local _rq = request or http_request or (syn and syn.request) if type(_rq) == "function" and _G and _G.request == nil then _G.request = _rq end end)
pcall(function() if _G and type(_lf5) == "table" then _G.VANTARMOR_ENV = _lf5 end end)
-- El executor compila los chunks de loadstring en su entorno global plano (sin loadstring
-- ni globals del executor). Una sonda compilada con el mismo loadstring devuelve esa tabla:
-- se escriben ahi los globals del executor y el entorno del loader (lo ve el VM del payload).
pcall(function()
  local _ps, _pf = pcall(loadstring, 'return _G')
  if _ps and type(_pf) == "function" then
    local _env = _pf()
    if type(_env) == "table" then
      if type(loadstring) == "function" then _env.loadstring = loadstring end
      if type(getgenv) == "function" and _env.getgenv == nil then _env.getgenv = getgenv end
      if type(getfenv) == "function" and _env.getfenv == nil then _env.getfenv = getfenv end
      if type(setfenv) == "function" and _env.setfenv == nil then _env.setfenv = setfenv end
      local _rq = request or http_request or (syn and syn.request)
      if type(_rq) == "function" and _env.request == nil then _env.request = _rq end
      _env.VANTARMOR_ENV = _lf5
    end
  end
end)
if type(_lf5.loadstring) ~= "function" and type(loadstring) == "function" then _lf5.loadstring = loadstring end
if type(_lf5._G) ~= "table" then _lf5._G = _lf5 end
local _fn, _ferr = loadstring(_data.body, "=VantArmor", _lf5)
if not _fn then _close() pcall(function() warn(tostring(_ferr)) end) error(MSG.PAYLOAD_LOAD_FAILED, 0) end
pcall(function() if setfenv and type(_lf5) == "table" then setfenv(_fn, _lf5) end end)
local _perr = nil
task.spawn(function()
  local _rok, _rerr = pcall(_fn, _lf5)
  if not _rok and _rerr then
    _perr = tostring(_rerr)
    pcall(function() warn(_perr) end)
    pcall(function() print("[VantArmor] " .. _perr) end)
    -- El error tambien queda visible en la barra de estado (los warn no siempre se ven)
    pcall(function()
      if _sg and _sg.Parent then
        local _tl = _sg:FindFirstChildOfClass("TextLabel")
        if _tl then _tl.Text = "script error: " .. _perr:sub(1, 90) end
      end
    end)
    task.spawn(function() pcall(function() task.wait(8) end) _close() end)
  end
end)
task.spawn(function()
  pcall(function() task.wait(1.5) end)
  if not _perr then _close() end
end)
`;
}
async function serveLoaderFile(res, loaderId, ffa, secure) {
  const plain = v5Loader(loaderId, ffa, secure);
  const out = await protectLoaderPlain(plain);
  return res.type('text/plain').send(out);
}

// Herramientas de descarga (curl, wget, scripts de Python, etc.) que piden el bootstrap a mano.
// Los ejecutores no entran aquí: su User-Agent no coincide con estos nombres.
const LOADER_PROBE_UA = /(curl|wget|python-requests|python-urllib|httpie|postman|go-http-client|okhttp|java\/|libwww|scrapy|aiohttp|fetch\/|undici|node-fetch|axios)/i;
function isLoaderProbe(req) {
  return LOADER_PROBE_UA.test(String(req.get('user-agent') || ''));
}
function sendLoaderDecoy(req, res) {
  console.warn('[Señuelo loader] ip=%s ua=%s', req.ip, String(req.get('user-agent') || '').slice(0, 80));
  return res.type('text/plain').send(makeDecoyTrace());
}

// Ejecutores y clientes conocidos de Roblox que llaman a /auth.
// Roblox usa "Roblox/WinInet"; los ejecutores populares usan su propio nombre.
// Si el UA es vacío o no coincide con ninguno → señuelo.
// Lista permisiva: preferimos no bloquear ejecutores legítimos desconocidos en lugar de
// bloquear usuarios reales, así que solo bloqueamos lo que sí identificamos como herramienta.
const ROBLOX_EXECUTOR_UA = /(roblox|WinInet|synapse|wave|krnl|hydrogen|script-ware|fluxus|electron|solara|delta|celery|xeno|trigon|crypt|arceus|evon|vega|codex|bloxstrap)/i;
function isRobloxAuthRequest(req) {
  const ua = String(req.get('user-agent') || '');
  // Si es herramienta de descarga conocida → NO es ejecutor
  if (isLoaderProbe(req)) return false;
  // Si coincide con ejecutor o cliente Roblox conocido → SÍ
  if (ROBLOX_EXECUTOR_UA.test(ua)) return true;
  // UA vacío: en Railway llega así desde algunos ejecutores → permitir
  if (ua.trim() === '') return true;
  // UA desconocido pero no bloqueado → permitir para no romper ejecutores nuevos
  return true;
}
function sendAuthDecoy(req, res) {
  console.warn('[Señuelo /auth] ip=%s ua=%s', req.ip, String(req.get('user-agent') || '').slice(0, 80));
  return res.type('text/plain').send('!VANTARMOR:FORBIDDEN');
}

// Página pública: el navegador ve solo el snippet (solo lectura); el ejecutor recibe el bootstrap.
app.get('/scripts/hosted/:slug', async (req, res) => {
  if (/text\/html/.test(req.get('accept') || '')) {
    const script = stmt.scriptBySlug.get(req.params.slug);
    if (!script) return res.status(404).type('text/plain').send('-- script no encontrado');
    return res.set({ ...PAGE_HEADERS, 'Content-Security-Policy': LOADER_CSP }).type('html').send(loaderPage(script));
  }
  const script = stmt.scriptBySlug.get(req.params.slug);
  if (script) logLoaderDownload(script, req.ip);
  await serveLoaderFile(res, script ? script.loader_id : '', !!(script && script.ffa), !!(script && script.secure_fetch));
});

// Loader con URL de archivo: /files/v1/loaders/<loader_id>.lua (mismo contenido que /scripts/hosted/<slug>)
app.get('/files/v1/loaders/:file', async (req, res) => {
  const m = /^([0-9a-f]{40})\.lua$/.exec(req.params.file);
  const script = m ? stmt.scriptByLoaderId.get(m[1]) : null;
  if (!script) return res.status(404).type('text/plain').send('-- script no encontrado');
  if (/text\/html/.test(req.get('accept') || '')) {
    return res.set({ ...PAGE_HEADERS, 'Content-Security-Policy': LOADER_CSP }).type('html').send(loaderPage(script));
  }
  logLoaderDownload(script, req.ip);
  await serveLoaderFile(res, script.loader_id, !!script.ffa, !!script.secure_fetch);
});

// /v1/l (v5): entrega autenticada con respuesta firmada. Requiere s + key (GET o POST JSON);
// hwid preferido. Key ausente/invalida/expirada/baneada o HWID que no coincide -> 401 JSON
// {ok:false,error:"unauthorized"} sin payload. s desconocido o bare -> 404 sin traza.
// Exito -> {ok:true, exp, sig, body}; exp = 10 minutos; sig = HMAC-SHA256(secreto del script,
// s|key|exp|body) en hex minuscula. Rate limit 10/min por IP y por key. Cada fallo queda en
// auth_fail_log (y en el antifuerza-bruta por IP). Los navegadores siguen sin pasar (403).
const L_RATE_MAX = 10;
const L_RATE_WIN = 60000;
const lRateIp = new Map();
const lRateKey = new Map();
setInterval(() => {
  const cut = Date.now() - L_RATE_WIN;
  for (const [k, arr] of lRateIp) { const keep = arr.filter(x => x > cut); if (keep.length) lRateIp.set(k, keep); else lRateIp.delete(k); }
  for (const [k, arr] of lRateKey) { const keep = arr.filter(x => x > cut); if (keep.length) lRateKey.set(k, keep); else lRateKey.delete(k); }
}, 60000).unref();
function lRateHit(map, k) {
  const now = Date.now();
  const arr = (map.get(k) || []).filter(x => x > now - L_RATE_WIN);
  arr.push(now);
  map.set(k, arr);
  return arr.length > L_RATE_MAX;
}
db.exec(`CREATE TABLE IF NOT EXISTS auth_fail_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  ip TEXT,
  s TEXT,
  reason TEXT,
  key_hint TEXT
)`);
// Keys de proyecto: una key puede ser de script (script_id) o de proyecto (project_id); una key de
// proyecto sirve para todos los scripts de ese proyecto (estilo Vantarmor: usuarios por aplicacion).
const keyByKeyStmt = db.prepare('SELECT * FROM keys WHERE key = ?');
const keyForScript = (key, script) => {
  if (!key || !script) return null;
  const k = keyByKeyStmt.get(String(key));
  if (!k) return null;
  if (k.script_id === script.id) return k;
  if (k.project_id != null && k.project_id === script.project_id) return k;
  return null;
};
const projectOfKey = db.prepare('SELECT allow_hwid_clone_sharing, allow_hwid_reset, hwid_reset_cooldown_days, auto_delete_expired, logs_webhook, alert_webhook FROM projects WHERE id = ?');
const ownerOfKey = key => {
  try {
    const r = db.prepare('SELECT s.user_id AS su, p.user_id AS pu FROM keys k LEFT JOIN scripts s ON s.id = k.script_id LEFT JOIN projects p ON p.id = k.project_id WHERE k.key = ?').get(key);
    return (r && (r.su || r.pu)) || null;
  } catch { return null; }
};
function logAuthFail(req, s, reason, key) {
  try {
    db.prepare('INSERT INTO auth_fail_log (ts, ip, s, reason, key_hint) VALUES (?, ?, ?, ?, ?)')
      .run(Math.floor(Date.now() / 1000), req.ip || null, s ? String(s).slice(0, 64) : null, reason || 'UNKNOWN', key ? String(key).slice(0, 4) + '..(' + String(key).length + ')' : null);
    // Webhook de alertas del proyecto: intentos de crack y baneos
    if (['KEY_INVALID', 'KEY_BANNED', 'KEY_EXPIRED', 'BLACKLISTED', 'HWID_MISMATCH', 'VERIFY_FAILED', 'EXEC_LIMIT', 'TAMPERING'].includes(reason)) {
      const _scr = /^[0-9a-f]{40}$/.test(String(s)) ? stmt.scriptByLoaderId.get(s) : null;
      if (_scr && _scr.project_id != null) fireProjectWebhook(_scr.project_id, 'alert', { evento: reason, key: key || 'FFA (sin key)', ip: req.ip || 'sin dato' });
    }
  } catch { /* el registro nunca rompe la respuesta */ }
  console.warn('[v1/l] auth fail ip=%s s=%s reason=%s', req.ip, s, reason);
}
const L_TTL_S = 600; // max 10 minutos (requisito: exp <= 10 min)
const v1lHandler = async (req, res) => {
  const send401 = () => res.status(401).json({ ok: false, error: 'unauthorized' });
  const send404 = () => res.status(404).type('text/plain').send('-- script no encontrado');
  const send429 = () => res.status(429).json({ ok: false, error: 'rate_limited' });
  const _acc = String(req.get('accept') || '');
  const _uaL = String(req.get('user-agent') || '');
  // Navegador real: los navegadores modernos siempre mandan cabeceras Sec-Fetch / Sec-CH-UA,
  // y los UAs de navegador clasico tambien se detectan. Los ejecutores no las mandan.
  const _browser = req.get('sec-fetch-site') || req.get('sec-fetch-mode') || req.get('sec-fetch-dest') || req.get('sec-ch-ua')
    || /Mozilla\/5\.0 \(.*(Chrome|CriOS|Firefox|FxiOS|Safari|Edge|Edg|OPR|SamsungBrowser)/.test(_uaL);
  if (/text\/html/.test(_acc) && (_browser || !isRobloxAuthRequest(req))) return res.status(403).type('text/plain').send('!VANTARMOR:FORBIDDEN');
  // curl, wget, python y demas herramientas de consola: la auth no es para ellas.
  // Igual que un reporte de volcado: queda en dump_events, suma al contador y avisa al dueño.
  // Y si traen una key valida del script, la key queda baneada al instante (el "kick" del lado
  // del servidor: curl no corre en el juego, no hay a quien echar).
  if (/^(curl|wget|httpie)\//i.test(_uaL) || /python-requests|python-urllib|libwww-perl|postmanruntime/i.test(_uaL)) {
    const _cb = (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) ? req.body : {};
    const _cq = { ...req.query, ..._cb };
    const _cs = String(_cq.s || '');
    const _ckey = String(_cq.key || '').trim().slice(0, 64);
    const _cscript = /^[0-9a-f]{40}$/.test(_cs) ? stmt.scriptByLoaderId.get(_cs) : null;
    const _ck = _cscript && _ckey ? keyForScript(_ckey, _cscript) : null;
    const nowS = Math.floor(Date.now() / 1000);
    if (_cscript) {
      try {
        db.prepare('INSERT INTO dump_events (script_id, key, hwid, ip, discord_id, soft, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)')
          .run(_cscript.id, _ck ? _ck.key : (_ckey || null), null, req.ip || null, _ck ? _ck.discord_id : null, nowS);
        db.prepare('UPDATE scripts SET dump_attempts = COALESCE(dump_attempts, 0) + 1, last_dump_at = ? WHERE id = ?').run(nowS, _cscript.id);
      } catch { /* el registro nunca rompe la respuesta */ }
      if (_ck && !_ck.banned) {
        try { db.prepare("UPDATE keys SET banned = 1, ban_reason = 'UA no permitido (curl/wget/python)' WHERE key = ? AND script_id = ?").run(_ck.key, _cscript.id); } catch { }
      }
      const _seenUA = `${_cscript.id}|ua|${_ckey}`;
      if (Date.now() - (tamperSeen.get(_seenUA) || 0) > 10 * 60 * 1000) {
        tamperSeen.set(_seenUA, Date.now());
        logWithRoblox(_cscript.id, [
          '🚨 Intento de dump con herramienta de consola (curl/wget/python)',
          `• Key: \`${_ckey || 'sin key'}\``,
          `• IP: \`${req.ip || 'sin dato'}\``,
        ], _ck ? _ck.discord_id : null, '');
        discordBot?.notifyTamper?.({ scriptId: _cscript.id, key: _ckey, hwid: '', rbxid: '', discordId: _ck ? _ck.discord_id : null, autoRevoked: Boolean(_ck && !_ck.banned), soft: false });
        fireWebhooks(_cscript.user_id, 'script.tamper', { scriptId: _cscript.id, key: _ckey, hwid: '', rbxid: '', autoRevoked: Boolean(_ck && !_ck.banned), soft: false });
      }
    }
    logAuthFail(req, _cs, 'BLOCKED_UA', _ckey);
    return res.status(403).type('text/plain').send('!VANTARMOR:FORBIDDEN');
  }
  const b = (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) ? req.body : {};
  const q = { ...req.query, ...b };
  const s = String(q.s || '');
  if (!/^[0-9a-f]{40}$/.test(s)) {
    noteAuthFail(req.ip);
    logAuthFail(req, s, 'SCRIPT_NOT_FOUND', '');
    return send404();
  }
  if (lRateHit(lRateIp, req.ip || 'unknown')) { logAuthFail(req, s, 'RATE_LIMITED_IP', ''); return send429(); }
  const script = stmt.scriptByLoaderId.get(s);
  if (!script) {
    noteAuthFail(req.ip);
    logAuthFail(req, s, 'SCRIPT_NOT_FOUND', '');
    return send404();
  }
  if (maintenanceAllOn() && !isOwnerId(script.user_id)) { logAuthFail(req, s, 'MAINTENANCE_ALL', ''); return send401(); }
  // Kill switch v6: desde el loader v6 el archivo ya no lleva secretos, asi que los loaders viejos (ver<6) dejan de recibir entrega
  if ((Number(String(q.ver || '0')) || 0) < 6) return res.status(403).type('text/plain').send('!VANTARMOR:UPDATE_REQUIRED');
  if (script.maintenance) { logAuthFail(req, s, 'MAINTENANCE', ''); return send401(); }
  const key = String(q.key || '').trim().slice(0, 64);
  const rawHwid = String(q.hwid || '').slice(0, 128);
  if (!key && !script.ffa) {
    if (authBlocked(req.ip)) { logAuthFail(req, s, 'RATE_LIMITED_FAILS', ''); return send429(); }
    noteAuthFail(req.ip);
    logAuthFail(req, s, 'KEY_REQUIRED', '');
    return send401();
  }
  if (key && lRateHit(lRateKey, script.id + '|' + key)) { logAuthFail(req, s, 'RATE_LIMITED_KEY', key); return send429(); }
  // Firma anti-spoof (opcional): si llega se valida; ausente pasa (la key es el requisito)
  if (q.cs !== undefined && q.cs !== null && String(q.cs).trim() !== '') {
    const _ct = Number(String(q.ct || ''));
    const _now = Math.floor(Date.now() / 1000);
    const _sigOk = Number.isInteger(_ct) && _ct > 0 && Math.abs(_now - _ct * 10) <= 20
      && authSig(scriptAuthSecret(script), String(q.cn || ''), key, rawHwid, String(_ct)) === String(q.cs).trim().toLowerCase();
    if (!_sigOk) { noteAuthFail(req.ip); logAuthFail(req, s, 'VERIFY_FAILED', key); return send401(); }
  }
  if (scriptBanned(script.id, 'ip', req.ip)) { logAuthFail(req, s, 'BLACKLISTED', key); return send401(); }
  let execKey = null;
  let hwid = /^[\x21-\x7E]{8,128}$/.test(rawHwid) ? rawHwid : '';
  if (!script.ffa) {
    const k = keyForScript(key, script);
    const cloneSharing = k && k.project_id != null && (projectOfKey.get(k.project_id) || {}).allow_hwid_clone_sharing === 1;
    if (!k) { noteAuthFail(req.ip); logAuthFail(req, s, 'KEY_INVALID', key); return send401(); }
    if (k.banned) { logAuthFail(req, s, 'KEY_BANNED', key); return send401(); }
    if (k.expires_at && k.expires_at * 1000 < Date.now()) { logAuthFail(req, s, 'KEY_EXPIRED', key); return send401(); }
    if (k.discord_id && db.prepare('SELECT 1 FROM bot_blacklist WHERE script_id = ? AND discord_id = ?').get(script.id, k.discord_id)) { logAuthFail(req, s, 'BLACKLISTED', key); return send401(); }
    // Si GetClientId() fallo en el ejecutor, la IP hace de identificador de equipo (igual que en /v1/a)
    if (!hwid && req.ip) hwid = `ip:${req.ip}`;
    if (script.hwid_lock !== 0 && !cloneSharing) {
      const shareReply = code => { logAuthFail(req, s, 'HWID_MISMATCH', key); return send401(); };
      if (!hwid) { logAuthFail(req, s, 'VERIFY_FAILED', key); return send401(); }
      if (!k.hwid && k.last_hwid && k.last_hwid !== hwid && script.share_detection !== 0) return reportKeyShare(script, k, hwid, shareReply);
      if (!k.hwid) {
        const bound = db.prepare('UPDATE keys SET hwid = ?, last_hwid = ? WHERE key = ? AND hwid IS NULL').run(hwid, hwid, key);
        if (!bound.changes) {
          const current = db.prepare('SELECT hwid FROM keys WHERE key = ?').get(key);
          if (!current) { logAuthFail(req, s, 'KEY_INVALID', key); return send401(); }
          if (current.hwid !== hwid) return reportKeyShare(script, k, hwid, shareReply);
        }
      } else if (k.hwid !== hwid) return reportKeyShare(script, k, hwid, shareReply);
    }
    if (k.exec_limit && (k.exec_count || 0) >= k.exec_limit) { logAuthFail(req, s, 'EXEC_LIMIT', key); return send401(); }
    if (!k.expires_at && k.key_days) {
      const _exp = Math.floor(Date.now() / 1000) + k.key_days * 86400;
      const _act = db.prepare('UPDATE keys SET expires_at = ? WHERE key = ? AND expires_at IS NULL').run(_exp, key);
      k.expires_at = _act.changes ? _exp : (db.prepare('SELECT expires_at FROM keys WHERE key = ?').get(key)?.expires_at ?? null);
      if (k.expires_at && k.expires_at * 1000 < Date.now()) { logAuthFail(req, s, 'KEY_EXPIRED', key); return send401(); }
    }
    const run = db.prepare('UPDATE keys SET last_ip = ?, exec_count = COALESCE(exec_count, 0) + 1 WHERE key = ? RETURNING exec_count').get(req.ip || null, key);
    execKey = key;
    countExecution(script.id, req.ip, script.user_id);
    logWithRoblox(script.id, [
      '🟢 Script ejecutado',
      ...(String(q.lt) === '1' ? ['• Ejecutor: desconocido (baja confianza)'] : []),
      `• Key: \`${key}\``,
      `• HWID: \`${hwid || 'sin dato'}\``,
      `• Discord ID: ${k.discord_id ? `\`${k.discord_id}\`` : 'sin vincular'}`,
      `• ID del script: \`${script.loader_id || script.id}\``,
      `• Veces que esta key ejecutó este script: ${run?.exec_count ?? 1}`,
    ], k.discord_id, /^\d{1,20}$/.test(String(q.rbxid || '')) ? String(q.rbxid) : '');
  } else {
    countExecution(script.id, req.ip, script.user_id);
    logWithRoblox(script.id, [
      '🟢 Script ejecutado (FFA)',
      `• ID del script: \`${script.loader_id || script.id}\``,
    ], null, /^\d{1,20}$/.test(String(q.rbxid || '')) ? String(q.rbxid) : '');
  }
  const body = servedCode(script, { ip: req.ip, key: execKey });
  if (!body) {
    console.error('[v1/l] servedCode fallo para', s);
    return res.status(503).json({ ok: false, error: 'unavailable' });
  }
  const exp = Math.floor(Date.now() / 1000) + L_TTL_S;
  if (String(q.ee || '') === '1') {
    // Entrega cifrada: la respuesta solo lleva ciphertext. Desde el loader v6 la clave se
    // deriva solo de datos del cliente (key, hwid, exp): el secreto del script nunca viaja
    // al cliente, asi que un loader capturado o leido no permite descifrar capturas ajenas.
    // Loaders v5 (que aun traen el secreto en su texto) siguen con la derivacion anterior.
    const qver = Number(String(q.ver || '0')) || 0;
    const kSeed = qver >= 6
      ? `${execKey || ''}|${rawHwid}|${exp}|v6`
      : `${scriptAuthSecret(script)}|${execKey || ''}|${rawHwid}|${exp}|v5`;
    const k16 = deriveKey16(kSeed);
    const enc = xxteaEncrypt(body, k16).toString('base64');
    const esig = crypto.createHmac('sha256', scriptAuthSecret(script)).update(`${s}|${execKey || ''}|${exp}|${enc}`).digest('hex');
    const rsig = payloadRsaSig(s, execKey || '', exp, body);
    return res.json({ ok: true, exp, sig: esig, enc, rsig });
  }
  const sig = crypto.createHmac('sha256', scriptAuthSecret(script)).update(`${s}|${execKey || ''}|${exp}|${body}`).digest('hex');
  const rsig = payloadRsaSig(s, execKey || '', exp, body);
  return res.json({ ok: true, exp, sig, body, rsig });
};
app.get('/v1/l', (req, res) => v1lHandler(req, res));
app.post('/v1/l', express.json({ type: () => true, limit: '8kb' }), (req, res) => v1lHandler(req, res));

// Tokens de un solo uso para entregar el código: /auth los emite, /payload los consume.
// Registro de usos del loader en el canal de logs del creador (el bot se asigna al arrancar)
let discordBot = null;
// Plan Free: para crear scripts debe unirse a nuestro servidor de Discord (una sola vez)
const DISCORD_JOIN_URL = 'https://discord.gg/aKQNc6pC';
function discordJoinDone(userId) {
  return isPaidPlanId(userId) || Boolean(stmt.userById.get(userId)?.discord_joined);
}
// Conteo diario de ejecuciones por script (hora de Ecuador). Las gráficas leen de aquí,
// así que borrar los logs viejos no afecta a las estadísticas.
// Caché de ofuscación: mismo código y mismo modo = mismo resultado, sin volver a ofuscar (ni gastar créditos)
db.exec(`CREATE TABLE IF NOT EXISTS execution_daily (script_id INTEGER NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (script_id, day))`);
// IP de cada descarga del loader (/files/v1/loaders). Solo lo ve el dueño, en su panel privado.
db.exec(`CREATE TABLE IF NOT EXISTS user_images (user_id TEXT NOT NULL, kind TEXT NOT NULL, mime TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER, PRIMARY KEY (user_id, kind))`);
// Las imágenes van a archivos en IMAGES_DIR, no a la base (así la base no crece con fotos).
// Por defecto están junto a la base, en el mismo volumen: para que no ocupen el volumen de la base,
// apunta IMAGES_DIR a otro disco o servicio. La fila de user_images guarda "file:<nombre>".
const IMAGES_DIR = process.env.IMAGES_DIR || path.join(path.dirname(DATABASE_PATH), 'images');
const IMAGE_EXT = { png: 'png', jpeg: 'jpg', webp: 'webp', gif: 'gif' };
function writeImageFile(userId, kind, mime, buf) {
  const ext = IMAGE_EXT[String(mime).split('/')[1]];
  if (!ext) throw new Error('tipo de imagen no permitido');
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
  const name = `${userId}-${kind}.${ext}`;
  const tmp = path.join(IMAGES_DIR, `.${name}.tmp`);
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, path.join(IMAGES_DIR, name));
  return name;
}
function removeUserImage(userId, kind) {
  const row = db.prepare('SELECT data FROM user_images WHERE user_id = ? AND kind = ?').get(userId, kind);
  if (row?.data?.startsWith('file:')) {
    try { fs.rmSync(path.join(IMAGES_DIR, path.basename(row.data.slice(5))), { force: true }); } catch { /* el archivo ya no está */ }
  }
  db.prepare('DELETE FROM user_images WHERE user_id = ? AND kind = ?').run(userId, kind);
}
function saveUserImage(userId, kind, mime, b64) {
  const buf = Buffer.from(b64, 'base64');
  removeUserImage(userId, kind);
  const name = writeImageFile(userId, kind, mime, buf);
  db.prepare('INSERT INTO user_images (user_id, kind, mime, data, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(userId, kind, mime, `file:${name}`, Math.floor(Date.now() / 1000));
}
// Migración: las imágenes que ya estaban en la base pasan a archivos (la base libera ese espacio al compactar)
for (const row of db.prepare("SELECT user_id, kind, mime, data FROM user_images WHERE data NOT LIKE 'file:%'").all()) {
  try {
    const name = writeImageFile(row.user_id, row.kind, row.mime, Buffer.from(row.data, 'base64'));
    db.prepare('UPDATE user_images SET data = ? WHERE user_id = ? AND kind = ?').run(`file:${name}`, row.user_id, row.kind);
  } catch (err) { console.warn('[Imágenes] No se migró', row.user_id, row.kind, err.message); }
}
db.exec(`CREATE TABLE IF NOT EXISTS loader_downloads (id INTEGER PRIMARY KEY AUTOINCREMENT, script_id INTEGER, slug TEXT, ip TEXT, created_at INTEGER NOT NULL)`);
// Scripts borrados: el loader distingue "borrado" de "no existe" y el historial muestra cada borrado
db.exec(`CREATE TABLE IF NOT EXISTS deleted_scripts (id INTEGER PRIMARY KEY AUTOINCREMENT, script_id INTEGER, user_id TEXT NOT NULL, slug TEXT NOT NULL, name TEXT, deleted_at INTEGER NOT NULL)`);
const LOADER_LOG_DAYS = 30;
let loaderLogWrites = 0;
function logLoaderDownload(script, ip) {
  try {
    const now = Math.floor(Date.now() / 1000);
    db.prepare('INSERT INTO loader_downloads (script_id, slug, ip, created_at) VALUES (?, ?, ?, ?)')
      .run(script.id, script.slug || '', String(ip || 'unknown').slice(0, 64), now);
    // Limpieza cada 200 descargas: se borra lo más viejo que LOADER_LOG_DAYS
    if (++loaderLogWrites % 200 === 0) db.prepare('DELETE FROM loader_downloads WHERE created_at < ?').run(now - LOADER_LOG_DAYS * 86400);
  } catch (err) {
    console.warn('[Loader log]', String(err.message || err).slice(0, 200));
  }
}
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
  // Webhook de logs del proyecto: solo ejecuciones correctas (la primera linea lleva la marca verde)
  try {
    if (Array.isArray(lines) && typeof lines[0] === 'string' && lines[0].startsWith('🟢')) {
      const _scr = db.prepare('SELECT project_id FROM scripts WHERE id = ?').get(scriptId);
      if (_scr && _scr.project_id != null) fireProjectWebhook(_scr.project_id, 'logs', {
        evento: 'Ejecución correcta',
        key: userId ? String(userId) : 'FFA (sin key)',
        detalle: lines.slice(1).map(l => String(l).replace(/[`*]/g, '')).join(' · ').slice(0, 900),
      });
    }
  } catch { }
  if (!rbxid) return logUse(scriptId, [...lines, '• Roblox: sin dato'].join('\n'), userId);
  robloxInfo(rbxid)
    .then(rbx => logUse(scriptId, [...lines, `• Roblox: ${rbx.name ? `${rbx.name} · ` : ''}\`${rbxid}\``].join('\n'), userId, { thumbnail: rbx.avatar }))
    .catch(() => logUse(scriptId, [...lines, `• Roblox: \`${rbxid}\``].join('\n'), userId));
}

const payloadTokens = new Map(); // token -> { scriptId, expires }
const PAYLOAD_TTL_MS = 30_000;
// Sesiones de autenticacion por pasos (v4, estilo de la referencia): /auth valida todo y crea la
// sesion, /v1/a/start/<sesion> la canjea por un token de descarga y /v1/p?t=&n= baja el codigo
// cifrado en trozos. La sesion es de un solo uso, vive 60 s y queda atada al HWID: una URL
// capturada no se puede reusar y ninguna respuesta lleva el codigo completo.
const authSessions = new Map();
const AUTH_SESSION_TTL_MS = 60_000;
const CHUNK_TTL_MS = 120_000;
const CHUNK_SIZE = 48000; // multiplo de 4: cortar el base64 en otro punto rompe el decodificado
setInterval(() => { const now = Date.now(); for (const [k, v] of authSessions) if (v.expires < now) authSessions.delete(k); }, 30_000).unref();
// Blob ofuscado del parametro t (estilo de la referencia): los datos van en bytes y cada nibble
// se sustituye por un caracter de una tabla propia, separado por 'k'. No es cifrado: evita que la
// URL capturada (logs de proxy) muestre la key y el HWID en claro.
const T_ABC = 'OIlaE1JQTbC09734652';
function decodeTblob(t) {
  try {
    let s = String(t || '');
    if (s.slice(0, 2) === 'a3') s = s.slice(2);
    s = s.split('k').join('');
    if (!s.length || s.length % 2) return null;
    let hex = '';
    for (const ch of s) { const i = T_ABC.indexOf(ch); if (i < 0) return null; hex += i.toString(16); }
    const payload = Buffer.from(hex, 'hex').toString('utf8');
    const pp = payload.split('\u0001');
    if (pp.length < 5) return null;
    return { key: pp[0], hwid: pp[1], ct: pp[2], cn: pp[3], cs: pp[4] };
  } catch { return null; }
}
setInterval(() => {
  const now = Date.now();
  for (const [t, v] of payloadTokens) if (v.expires < now) payloadTokens.delete(t);
}, 60_000).unref();
// Firma anti-spoof del auth (equivale a clienttime/clientnonce/externalsignature de la referencia):
// el loader hornea un secreto por script y manda ct (bloque de 10 s), cn (nonce) y cs (firma).
// El servidor recalcula cs con el mismo mezclador; un cliente generico que reenvia parametros
// capturados no puede falsificarla. Los loaders viejos que no mandan cs siguen pasando.
function scriptAuthSecret(script) {
  if (script.auth_secret) return script.auth_secret;
  const s = crypto.randomBytes(16).toString('hex');
  try { db.prepare('UPDATE scripts SET auth_secret = ? WHERE id = ?').run(s, script.id); } catch { /* se regenera */ }
  return s;
}
function authSig(secret, nonce, key, hwid, bucket) {
  const s = Buffer.from(`${secret}|${nonce}|${key}|${hwid}|${bucket}`, 'utf8');
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (h * 33 + s[i]) % 4294967296;
    h = (h * 31 + 7) % 4294967296;
  }
  const parts = [];
  for (let i = 0; i < 4; i++) { h = (h * 31 + 7) % 4294967296; parts.push(h % 256); }
  return parts.map(b => b.toString(16).padStart(2, '0')).join('');
}
function issuePayloadToken(script, ip, key, v, hwid, rawHwid, ver) {
  // Varios tokens vivos por (script, key): revocar el anterior rompia la re-ejecucion rapida
  // (la segunda /auth mataba el token que la primera /v1/p todavia iba a usar). Cada token ya es
  // de un solo uso, con TTL y atado al HWID, asi que no hace falta revocar nada.
  const token = crypto.randomBytes(24).toString('hex');
  // seedHwid: el HWID crudo tal como lo mando el loader (la semilla debe ser reproducible por el cliente)
  payloadTokens.set(token, { scriptId: script.id, key: key || null, hwid: hwid || null, ip: ip || null, expires: Date.now() + PAYLOAD_TTL_MS, v: v === '2', seedHwid: rawHwid || null, ver: ver || 0 });
  return token;
}

// Código que se entrega al ejecutor: el ofuscado solo si el dueño lo activó para ese script
// Tokens de sesión para los bloques remotos: los emite /auth y los valida /remote.
// Están atados a la IP, a la slug y (si hay) a la key, duran 15 min y se revisa la key en cada pedido.
const remoteTokens = new Map(); // token -> { scriptId, slug, ip, key, expires, calls }
const REMOTE_TTL_MS = 15 * 60_000;
const REMOTE_MAX_CALLS = 300;
setInterval(() => {
  const now = Date.now();
  for (const [t, v] of remoteTokens) if (v.expires < now) remoteTokens.delete(t);
}, 60_000).unref();

function issueRemoteToken(script, ip, key) {
  const token = crypto.randomBytes(24).toString('hex');
  remoteTokens.set(token, { scriptId: script.id, slug: script.slug, ip: ip || null, key: key || null, expires: Date.now() + REMOTE_TTL_MS, calls: 0 });
  return token;
}

// Código que se entrega al ejecutor. Los bloques --@remote nunca van en el código: se piden aparte.
// Registro de avisos de volcado: cada reporte del loader queda con key, HWID, IP y Discord
db.exec(`CREATE TABLE IF NOT EXISTS dump_events (
  id INTEGER PRIMARY KEY, script_id INTEGER, key TEXT, hwid TEXT, ip TEXT, discord_id TEXT, soft INTEGER, created_at INTEGER
)`);

// ---- Webhooks protegidos (estilo V4) + variables de entorno ----
// El dueño marca en el source una línea `--@webhook:nombre https://...`. El servidor guarda la URL
// y la quita del código entregado; el script llama VANT_SEND_WEBHOOK("nombre", payload) y el
// servidor (no el cliente) lleva la URL, limita 30/min por IP, y sustituye %VARIABLES% que el
// cliente no puede falsear. Máximo 6 por script, payloads hasta 7000 caracteres, 3 embeds.
db.exec('CREATE TABLE IF NOT EXISTS script_webhooks (script_id INTEGER, name TEXT, url TEXT, PRIMARY KEY (script_id, name))');
const webhookStmt = {
  byScript: db.prepare('SELECT name, url FROM script_webhooks WHERE script_id = ? ORDER BY rowid'),
  clear: db.prepare('DELETE FROM script_webhooks WHERE script_id = ?'),
  save: db.prepare('INSERT INTO script_webhooks (script_id, name, url) VALUES (?, ?, ?)'),
};
const WEBHOOK_LINE = /^--@webhook:([A-Za-z0-9_]{1,40})[ \t]+(\S+)[ \t]*$/gm;
function parseWebhookMarkers(source) {
  const text = String(source ?? '');
  const list = [];
  const names = new Set();
  for (const m of text.matchAll(WEBHOOK_LINE)) {
    const name = m[1];
    const url = m[2];
    if (names.has(name)) return { error: `El webhook --@webhook:${name} está repetido.` };
    if (!/^https:\/\//.test(url)) return { error: `La URL del webhook --@webhook:${name} debe empezar por https://` };
    names.add(name);
    list.push({ name, url });
  }
  if (list.length > 6) return { error: 'Máximo 6 webhooks protegidos por script.' };
  if ((text.match(/--@webhook:/g) || []).length !== list.length) return { error: 'Revisa la sintaxis de --@webhook:nombre URL (una por línea, URL https).' };
  return { list };
}
const stripWebhookMarkers = source => String(source ?? '').replace(/^--@webhook:[^\n]*\r?\n?/gm, '');
// Codigo pre-auth del dueño (equivale a LRM_INIT_SCRIPT): corre en el loader ANTES de la autenticacion
db.exec('CREATE TABLE IF NOT EXISTS script_init (script_id INTEGER PRIMARY KEY, code TEXT)');
const getInitCode = scriptId => db.prepare('SELECT code FROM script_init WHERE script_id = ?').get(scriptId)?.code || '';
const saveScriptExtras = (scriptId, list, initCode) => {
  webhookStmt.clear.run(scriptId);
  for (const h of list) webhookStmt.save.run(scriptId, h.name, h.url);
  // undefined = no tocar (edicion sin el campo); '' = quitar; texto = guardar
  if (initCode !== undefined) db.prepare('INSERT OR REPLACE INTO script_init (script_id, code) VALUES (?, ?)').run(scriptId, initCode ? String(initCode).slice(0, 4000) : null);
};

// Sesión de webhook: token por entrega, vive 6 h. El servidor re-chequea la key en cada envío.
const webhookSessions = new Map(); // token -> { scriptId, key, ip, expires }
const WEBHOOK_SESSION_TTL = 6 * 3600_000;
setInterval(() => { const t = Date.now(); for (const [k, v] of webhookSessions) if (v.expires < t) webhookSessions.delete(k); }, 300_000).unref();
const webhookRate = new Map(); // ip -> marcas de tiempo de la última ventana
setInterval(() => { const cut = Date.now() - 60_000; for (const [k, arr] of webhookRate) { const keep = arr.filter(x => x > cut); if (keep.length) webhookRate.set(k, keep); else webhookRate.delete(k); } }, 60_000).unref();
// keyInfoStmt retirado: keyForScript cubre keys de script y de proyecto

function runtimeHeader(script, ip, key) {
  const info = key ? keyForScript(key, script) : null;
  const esc = s => String(s).replace(/[\\"]/g, '\\$&');
  const secondsLeft = info && info.expires_at ? Math.max(0, Math.floor(info.expires_at - Date.now() / 1000)) : 'math.huge';
  let head = `-- [VantArmor] Variables de entorno fijadas por el servidor\n`
    + `VANT_IsUserPremium = ${info ? 'true' : 'false'}\n`
    + `VANT_LinkedDiscordID = "${esc(info && info.discord_id ? info.discord_id : '')}"\n`
    + `VANT_TotalExecutions = ${info && info.exec_count ? info.exec_count : 0}\n`
    + `VANT_SecondsLeft = ${secondsLeft}\n`
    + `VANT_ScriptName = "${esc(script.name)}"\n`;
  const hooks = webhookStmt.byScript.all(script.id);
  if (hooks.length && key) {
    const sTok = crypto.randomBytes(24).toString('hex');
    webhookSessions.set(sTok, { scriptId: script.id, key, ip: ip || null, expires: Date.now() + WEBHOOK_SESSION_TTL });
    head += `local __vm_ws = "${sTok}"\n`
      + `local function VANT_SEND_WEBHOOK(name, payload)\n`
      + `  pcall(function()\n`
      + `    local _r = request or http_request or (syn and syn.request)\n`
      + `    if _r then _r({ Url = ${JSON.stringify(APP_URL + '/v1/w')}, Method = "POST", Headers = { ["Content-Type"] = "application/json" }, Body = game:GetService("HttpService"):JSONEncode({ t = __vm_ws, n = tostring(name), p = payload }) }) end\n`
      + `  end)\nend\n`;
  }
  return head;
}

// [AntiDump] La ruta del loader NUNCA entrega la fuente en claro: si la copia guardada
// es la fuente (script guardado sin ofuscar) o no existe copia, se ofusca al vuelo con
// el motor propio y se cachea. Si la proteccion falla, no se entrega nada (fail closed).
const _plainGuardCache = new Map();
// Firma de fuente legible: los motores reales cifran las cadenas, quitan los comentarios
// y renombran identificadores, así que una copia que conserva eso es fuente en claro.
// Cubre también copias viejas que ya no coinciden byte a byte con la fuente actual.
// Dudoso = plain (se re-ofusca): entregar sin protección nunca es una opción.
function looksLikePlainSource(s) {
  if (/(^|\n)\s*--/.test(s) || s.includes('--[[')) return true;
  if (/[:%. ]GetService\s*\(/.test(s)) return true;
  let readable = 0;
  const re = /"((?:[^"\\\n]|\\.){8,})"/g;
  let m;
  while ((m = re.exec(s))) {
    if (!/\\x[0-9a-fA-F]{2}|\\[0-9]{1,3}|\\u\{/.test(m[1])) { readable++; if (readable >= 3) return true; }
  }
  return false;
}
function protectedBase(script, plain) {
  const saved = String(script.content || '');
  // Plain = sin copia, o copia que coincide con la fuente en cualquiera de sus formas
  // (cruda, sin webhooks, sin bloques remotos), o copia que conserva marcas de fuente
  // legible (copias viejas incluidas). Un ofuscado real no conserva nada de eso.
  const src = String(script.source || '');
  const variants = new Set([plain, src, stripWebhookMarkers(src), stripRemoteBlocks(src)]
    .map(v => String(v || '').trim()).filter(Boolean));
  // Ofuscador 3 (API externa) en pausa: su salida está fallando dentro de su VM en el juego
  // (aritmética sobre nil), así que su copia guardada nunca se sirve: la entrega pasa por el
  // motor propio (Ofuscador 5) con la misma caché y fail closed.
  const forzarRegen = script.obfuscator === 'luau';
  const isPlain = forzarRegen || !saved || (plain && variants.has(saved.trim())) || looksLikePlainSource(saved);
  if (!isPlain) return saved;                                // copia ofuscada real
  const k = crypto.createHash('sha1').update(plain).digest('hex');
  if (_plainGuardCache.has(k)) return _plainGuardCache.get(k);
  let out = null;
  try {
    // Motor propio (VantObf): la fuente en claro nunca sale del servidor aunque el script
    // se haya guardado sin ofuscar. Resultado cacheado por hash de la fuente.
    out = obfuscateVant(plain, script.obf_mode || undefined, scriptGuardValue(script.guard_secret || ''));
    if (!out || !String(out).trim()) out = null;
  } catch (err) {
    console.error('[AntiDump] ofuscado al vuelo fallo:', err.message);
    out = null;
  }
  if (_plainGuardCache.size > 200) _plainGuardCache.clear();
  _plainGuardCache.set(k, out);
  return out; // null = fallo al proteger: no se entrega nada
}
function servedCode(script, { ip, key } = {}) {
  // La ruta del loader SIEMPRE sirve la copia protegida (ofuscada): el toggle
  // serve_protected solo controla la vista previa del panel, nunca lo que
  // llega al ejecutor. La fuente en claro nunca sale del servidor.
  const plain = script.source ? stripWebhookMarkers(stripRemoteBlocks(script.source)) : '';
  const base = protectedBase(script, plain);
  if (base === null) return null;
  const head = runtimeHeader(script, ip, key);
  const wmTail = '\n--[==[VANT_WM:' + keyWatermark(script.id, key) + ']==]';
  if (!hasRemoteBlocks(script.source || '')) return head + base + wmTail;
  const token = issueRemoteToken(script, ip, key);
  return head + remoteHeader({ url: `${APP_URL}/scripts/hosted/${script.slug}/remote`, token }) + base + wmTail;
}

// [AntiDump] Los bloques remotos tampoco salen en claro: el cuerpo se entrega ofuscado
// con el mismo motor y el mismo sello que el payload base. Si la protección falla, el
// bloque no se sirve (fail closed). La cabecera que lo consume viaja en cada entrega,
// así que el cambio no obliga a volver a descargar el loader.
const _remoteBodyCache = new Map();
function remoteProtectedBody(script, body) {
  const bare = stripWebhookMarkers(String(body || ''));
  if (!bare.trim()) return null;
  const seal = scriptGuardValue(script.guard_secret || '');
  const k = crypto.createHash('sha1').update(bare + '|' + seal).digest('hex');
  if (_remoteBodyCache.has(k)) return _remoteBodyCache.get(k);
  if (_remoteBodyCache.size > 200) _remoteBodyCache.clear();
  let out = null;
  try {
    const obf = obfuscateVant('return ' + bare, script.obf_mode || undefined, seal);
    if (obf && String(obf).trim()) out = '--VANTARMOR:OBF\n' + obf;
  } catch (err) {
    console.error('[AntiDump] bloque remoto: ofuscado falló:', err.message);
    out = null;
  }
  _remoteBodyCache.set(k, out);
  return out;
}

// Entrega cifrada (v2, estilo Vantarmor): el código sale cifrado con XXTEA y una key de sesión
// aleatoria. Un fetch a mano a /auth sin key válida no recibe nada, y cada entrega es un blob
// distinto que no se puede reusar. La misma rutina corre en Lua puro dentro del bootstrap.
const XXTEA_DELTA = 0x9E3779B9 >>> 0;
function xxteaWords(buf) {
  const n = buf.length >>> 2;
  const w = new Array(n).fill(0);
  for (let i = 0; i < n; i++) w[i] = buf.readUInt32LE(i * 4) >>> 0;
  return w;
}
function xxteaWordsToBuf(w) {
  const out = Buffer.alloc(w.length * 4);
  for (let i = 0; i < w.length; i++) out.writeUInt32LE(w[i] >>> 0, i * 4);
  return out;
}
// Clave de sesion derivada (loader v3): la clave ya no viaja en la respuesta.
// Se deriva de datos que solo el cliente envio (key + hwid + token de un solo uso),
// con la misma rutina aritmetica en el servidor y en el bootstrap (Lua puro, sin bit ops).
function xs32(h) {
  h = (h * 8192) % 4294967296; // shl 13
  h = ((h ^ Math.floor(h / 131072)) >>> 0); // xor shr 17
  h = (h * 32) % 4294967296; // shl 5
  return h >>> 0;
}
function deriveKey16(seed) {
  const s = Buffer.from(String(seed), 'utf8');
  let h1 = 374761393 >>> 0, h2 = 668265263 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h1 = (h1 + s[i] * 31 + 7) % 4294967296;
    h1 = xs32(h1);
    h2 = (h2 + h1) % 4294967296;
    h2 = xs32(h2);
  }
  const out = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) {
    h1 = xs32(h1);
    h2 = xs32(h2);
    out[i] = (h1 ^ h2) & 0xff;
  }
  return out;
}
function xxteaMx(sum, y, z, p0, e, k) {
  const a = (((z >>> 5) ^ ((y << 2) >>> 0)) + ((y >>> 3) ^ ((z << 4) >>> 0))) >>> 0;
  const b = ((sum ^ y) + ((k[(p0 & 3) ^ e] ^ z) >>> 0)) >>> 0;
  return (a ^ b) >>> 0;
}
function xxteaEncrypt(plain, key16) {
  let bytes = Buffer.from(String(plain), 'utf8');
  const pad = (4 - (bytes.length % 4)) % 4;
  if (pad) bytes = Buffer.concat([bytes, Buffer.alloc(pad)]);
  if (bytes.length < 8) bytes = Buffer.concat([bytes, Buffer.alloc(8 - bytes.length)]);
  const v = xxteaWords(bytes);
  const k = xxteaWords(key16);
  const n = v.length;
  const rounds = 6 + Math.floor(52 / n);
  let sum = 0;
  let z = v[n - 1];
  for (let r = 0; r < rounds; r++) {
    sum = (sum + XXTEA_DELTA) >>> 0;
    const e = (sum >>> 2) & 3;
    for (let p = 0; p < n - 1; p++) {
      const y = v[p + 1];
      z = v[p] = (v[p] + xxteaMx(sum, y, z, p, e, k)) >>> 0;
    }
    const y0 = v[0];
    z = v[n - 1] = (v[n - 1] + xxteaMx(sum, y0, z, n - 1, e, k)) >>> 0;
  }
  return xxteaWordsToBuf(v);
}
// Entrega el código al ejecutor: texto plano (loaders viejos) o cifrado (loader v2)
function sendExecutorCode(req, res, script, opts, enc, keySeed) {
  const code = servedCode(script, opts);
  // Fail closed: sin version protegida no hay entrega (la fuente en claro nunca sale)
  if (code === null) return res.status(503).type('text/plain').send('!VANTARMOR:SERVER_UNREACHABLE');
  if (!enc) return res.type('text/plain').send('!VANTARMOR:CODE\n' + code);
  // Loader v3 (ver >= 3): la clave ya no viaja en la respuesta; se deriva de key+hwid+token,
  // datos que el cliente ya envio. La respuesta capturada es ciphertext sin clave.
  // Loader v2 viejo (ver < 3): recibe la clave en la respuesta, por compatibilidad.
  const key16 = keySeed ? deriveKey16(keySeed) : crypto.randomBytes(16);
  if (keySeed) return res.type('text/plain').send(`!VANTARMOR:ENC\n${xxteaEncrypt(code, key16).toString('base64')}`);
  return res.type('text/plain').send(`!VANTARMOR:ENC\n${key16.toString('hex')}\n${xxteaEncrypt(code, key16).toString('base64')}`);
}
// Entrega el código con un token válido. El token se gasta aunque falle.
// Solo POST con el token en el cuerpo: un GET (navegador, curl) ya no devuelve código
const payloadHandler = (req, res, slug) => {
  if (/text\/html/.test(req.get('accept') || '')) return res.status(403).type('text/plain').send('!VANTARMOR:FORBIDDEN');
  if (isLoaderProbe(req)) return sendAuthDecoy(req, res);
  // Cuerpo: "<token>" (loaders viejos) o "<token> <hwid>" (nuevos: el token queda atado al equipo)
  const _parts = String(req.body || '').trim().split(/\s+/);
  const token = _parts[0] || '';
  const _p_hwid = _parts[1] || '';
  const entry = payloadTokens.get(token);
  payloadTokens.delete(token);
  const script = stmt.scriptBySlug.get(slug);
  // El token vale para este script, una vez y 30 s
  // No se compara la IP: en móviles el GET y el POST pueden salir por IPs distintas (cambio de Wi-Fi a datos)
  // v4 (entrega por trozos): el POST de una sola respuesta queda cerrado, solo el GET por trozos
  if (!entry || entry.expires < Date.now() || !script || script.id !== entry.scriptId || (entry.ver || 0) < 3 || (entry.ver || 0) >= 4) {
    // Señuelo: solo para herramientas claras (curl, python, etc.). Un ejecutor legítimo nunca recibe la
    // traza falsa: si su token vence o falla, ve TOKEN_INVALID ("Verification failed. Please rejoin.").
    const _motivo = !entry ? 'token desconocido (revocado, consumido o de otro deploy)' : entry.expires < Date.now() ? 'token vencido' : !script ? 'script no encontrado' : script.id !== entry.scriptId ? 'token de otro script' : 'ver<3';
    console.warn('[payload fail] slug=%s ip=%s motivo=%s ua=%s', slug, req.ip, _motivo, String(req.get('user-agent') || '').slice(0, 80));
    noteAuthFail(req.ip);
    if (isLoaderProbe(req) && (authFails.get(req.ip)?.count || 0) >= 3) {
      console.warn('[Señuelo] slug=%s ip=%s ua=%s', slug, req.ip, String(req.get('user-agent') || '').slice(0, 80));
      return res.type('text/plain').send('!VANTARMOR:CODE\n' + makeDecoyTrace());
    }
    return res.status(403).type('text/plain').send('!VANTARMOR:TOKEN_INVALID');
  }
  // El token queda atado al HWID que lo pidió: usado desde otro equipo no vale
  if (entry.hwid && _p_hwid && _p_hwid !== entry.hwid) return res.status(403).type('text/plain').send('!VANTARMOR:TOKEN_INVALID');
  // Token válido: se limpia el contador de fallos de esta IP, así una ejecución lenta que
  // llegó con el token vencido no acumula hacia el señuelo y al usuario real no lo come el señuelo
  authFails.delete(req.ip);
  // El loader espera el mismo prefijo que en la entrega de un paso
  const _seed = entry.ver >= 3 ? `${entry.key || ''}|${entry.seedHwid || ''}|${token}|v2` : null;
  return sendExecutorCode(req, res, script, { ip: req.ip, key: entry.key }, entry.v === true, _seed);
};
// Ruta antigua (por slug): se mantiene para bootstraps que ya estuvieran en ejecución
app.post('/scripts/hosted/:slug/payload', express.text({ type: () => true, limit: '1kb' }), (req, res) => payloadHandler(req, res, req.params.slug));
// Ruta nueva: el bootstrap no lleva el slug. El token ya está atado a un script, así que se resuelve desde ahí.
app.post('/v1/p', express.text({ type: () => true, limit: '1kb' }), (req, res) => {
  // El cuerpo es "<token> <hwid>": solo el primer campo es el token (el bootstrap manda token + salto + HWID)
  const _tok = String(req.body || '').trim().split(/\s+/)[0] || '';
  const e = payloadTokens.get(_tok);
  const row = e ? db.prepare('SELECT slug FROM scripts WHERE id = ?').get(e.scriptId) : null;
  return payloadHandler(req, res, row ? row.slug : '');
});

// ---- Autenticacion por pasos (v4, estilo de la referencia) ----
// Paso 1 (/v1/a): valida key, HWID, firma y cuenta la ejecucion; crea una sesion de un solo uso.
// Paso 2 (/v1/a/start/<sesion>): revalida la firma, consume la sesion y entrega un token de descarga.
// Paso 3 (/v1/p?t=&n=&h=): devuelve los trozos del codigo cifrado. Ninguna respuesta lleva el
// codigo completo y cada sesion/token es de un solo uso con caducidad y atado al HWID.
function startAuthSession(res, script, { key, rawHwid, hwid, ip }) {
  const uuid = crypto.randomUUID();
  authSessions.set(uuid, { scriptId: script.id, key: key || null, hwid: hwid || null, rawHwid: rawHwid || '', ip: ip || null, expires: Date.now() + AUTH_SESSION_TTL_MS, used: false });
  return res.type('text/plain').send('!VANTARMOR:SESSION ' + uuid);
}
app.get('/v1/a/start/:uuid', (req, res) => {
  if (/text\/html/.test(req.get('accept') || '')) return res.status(403).type('text/plain').send('!VANTARMOR:FORBIDDEN');
  if (isLoaderProbe(req)) return sendAuthDecoy(req, res);
  const uuid = String(req.params.uuid || '');
  const sess = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid) ? authSessions.get(uuid) : null;
  if (!sess) { noteAuthFail(req.ip); return res.status(403).type('text/plain').send('!VANTARMOR:TOKEN_INVALID'); }
  if (sess.used || sess.expires < Date.now()) { authSessions.delete(uuid); return res.status(403).type('text/plain').send('!VANTARMOR:TOKEN_INVALID'); }
  const t = decodeTblob(req.query.t);
  const script = db.prepare('SELECT * FROM scripts WHERE id = ?').get(sess.scriptId);
  if (!script || !t) { authSessions.delete(uuid); noteAuthFail(req.ip); return res.status(403).type('text/plain').send('!VANTARMOR:VERIFY_FAILED'); }
  if (maintenanceAllOn() && !isOwnerId(script.user_id)) return res.status(503).type('text/plain').send('!VANTARMOR:MAINTENANCE_ALL');
  if (script.maintenance) return res.status(503).type('text/plain').send('!VANTARMOR:MAINTENANCE');
  const _ct = Number(t.ct);
  const _now = Math.floor(Date.now() / 1000);
  const sigOk = Number.isInteger(_ct) && _ct > 0 && Math.abs(_now - _ct * 10) <= 20
    && authSig(scriptAuthSecret(script), String(t.cn || ''), String(t.key || ''), String(t.hwid || ''), String(_ct)) === String(t.cs || '').trim().toLowerCase();
  // La key del blob debe ser la misma que abrio la sesion: un canje con otra key no vale
  if (!sigOk || String(t.hwid || '') !== String(sess.rawHwid || '') || String(t.key || '') !== String(sess.key || '')) {
    noteAuthFail(req.ip);
    return res.status(403).type('text/plain').send('!VANTARMOR:VERIFY_FAILED');
  }
  // La sesion se gasta aunque algo falle despues: una URL de start capturada no vale dos veces
  authSessions.delete(uuid);
  const token = crypto.randomBytes(24).toString('hex');
  const code = servedCode(script, { ip: req.ip, key: sess.key });
  // Fail closed: sin version protegida no hay entrega (la fuente en claro nunca sale)
  if (code === null) return res.status(503).type('text/plain').send('!VANTARMOR:SERVER_UNREACHABLE');
  const key16 = deriveKey16(`${sess.key || ''}|${sess.rawHwid || ''}|${token}|v2`);
  const enc = xxteaEncrypt(code, key16);
  const b64 = enc.toString('base64');
  const chunks = [];
  for (let i = 0; i < b64.length; i += CHUNK_SIZE) chunks.push(b64.slice(i, i + CHUNK_SIZE));
  payloadTokens.set(token, { scriptId: script.id, key: sess.key, hwid: sess.hwid, ip: sess.ip, expires: Date.now() + CHUNK_TTL_MS, v: true, seedHwid: sess.rawHwid, ver: 4, chunks, gets: 0 });
  return res.type('text/plain').send(`!VANTARMOR:PTOKEN ${token} ${chunks.length} ${enc.length}`);
});
// Descarga por trozos (GET): cada peticion lleva el token, el numero de trozo y el HWID.
// El token vive 120 s y aguanta n trozos + margen; no es de un solo uso por peticion porque el
// bootstrap baja varios trozos con el mismo.
app.get('/v1/p', (req, res) => {
  if (/text\/html/.test(req.get('accept') || '')) return res.status(403).type('text/plain').send('!VANTARMOR:FORBIDDEN');
  if (isLoaderProbe(req)) return sendAuthDecoy(req, res);
  const token = String(req.query.t || '');
  const entry = payloadTokens.get(token);
  const script = entry ? db.prepare('SELECT 1 AS ok FROM scripts WHERE id = ?').get(entry.scriptId) : null;
  if (!entry || !script || entry.expires < Date.now() || (entry.ver || 0) < 4 || !Array.isArray(entry.chunks)) {
    noteAuthFail(req.ip);
    return res.status(403).type('text/plain').send('!VANTARMOR:TOKEN_INVALID');
  }
  const h = String(req.query.h || '');
  if (entry.hwid && h && h !== entry.hwid) return res.status(403).type('text/plain').send('!VANTARMOR:TOKEN_INVALID');
  const n = Number(req.query.n);
  if (!Number.isInteger(n) || n < 0 || n >= entry.chunks.length) return res.status(403).type('text/plain').send('!VANTARMOR:TOKEN_INVALID');
  entry.gets = (entry.gets || 0) + 1;
  if (entry.gets > entry.chunks.length + 8) { payloadTokens.delete(token); return res.status(403).type('text/plain').send('!VANTARMOR:TOKEN_INVALID'); }
  authFails.delete(req.ip);
  return res.type('text/plain').send('!VANTARMOR:CHUNK\n' + entry.chunks[n]);
});

// Libreria de comprobacion de keys (equivalente a library.lua de la referencia): un script puede
// validar la key y mostrar su propio mensaje antes de cargar, sin esperar al kick del loader.
app.get('/v1/library.lua', (req, res) => {
  res.type('text/plain').send(`-- VantArmor | libreria de keys
-- Uso:
--   local lib = loadstring(game:HttpGet("${APP_URL}/v1/library.lua"))()
--   lib.script_id = "<ID del loader>"
--   local st = lib.check_key(script_key)
--   if st.code == "KEY_VALID" then lib.load_script() else print(st.code) end
local LIB = { script_id = "", script_key = "", hwid = "" }
local BASE = ${JSON.stringify(APP_URL)}
pcall(function()
  local _id = game:GetService("RbxAnalyticsService"):GetClientId()
  if type(_id) == "string" then LIB.hwid = _id end
end)
local HttpService = game:GetService("HttpService")
local function _get(url) return game:HttpGet(url) end
function LIB.check_key(key)
  local st = { code = "UNKNOWN_ERROR", message = "Sin respuesta del servidor", data = {} }
  local ok, body = pcall(function()
    return _get(BASE .. "/v1/k?s=" .. tostring(LIB.script_id) .. "&key=" .. tostring(key or LIB.script_key or "") .. "&hwid=" .. tostring(LIB.hwid))
  end)
  if not ok or type(body) ~= "string" then return st end
  local first = body:match("^[^\n]*") or ""
  if first:sub(1, 11) ~= "!VANTARMOR:" then return st end
  st.code = first:sub(12)
  for k, v in body:gmatch("\n([%w_]+)=([^\n]*)") do st.data[k] = v end
  st.data.auth_expire = tonumber(st.data.expires) or 0
  st.data.total_executions = tonumber(st.data.execs) or 0
  st.message = st.code
  return st
end
-- Carga el script del panel con la key ya lista (equivale a load_script de la referencia)
function LIB.load_script()
  -- v5: entrega autenticada (/v1/l exige key y devuelve el payload firmado). La firma
  -- HMAC la verifica el loader de dos pasos; aqui la proteccion la pone el servidor.
  local key = LIB.script_key
  if type(key) ~= "string" or key == "" then key = tostring(script_key or "") end
  pcall(function()
    local _g = getgenv and getgenv()
    if _g and type(_g.VANTARMOR_KEY) == "string" and _g.VANTARMOR_KEY ~= "" then key = _g.VANTARMOR_KEY end
  end)
  if type(key) == "string" then key = (key:gsub("^%s+", ""):gsub("%s+$", "")) end
  if key == "" then error("[VantArmor] Set getgenv().VANTARMOR_KEY before loading", 0) end
  local raw = nil
  local _r = request or http_request or (syn and syn.request)
  if _r then
    local okp, resp = pcall(_r, { Url = BASE .. "/v1/l", Method = "POST", Headers = { ["Content-Type"] = "application/json" }, Body = HttpService:JSONEncode({ s = tostring(LIB.script_id), key = key, hwid = tostring(LIB.hwid) }) })
    if okp and type(resp) == "table" then raw = resp.Body or resp.body end
  end
  if type(raw) ~= "string" or #raw == 0 then
    local okg, g = pcall(function() return _get(BASE .. "/v1/l?s=" .. tostring(LIB.script_id) .. "&key=" .. tostring(key) .. "&hwid=" .. tostring(LIB.hwid)) end)
    if okg and type(g) == "string" then raw = g end
  end
  if type(raw) ~= "string" or #raw == 0 then error("[VantArmor] loader no disponible", 0) end
  local okj, data = pcall(function() return HttpService:JSONDecode(raw) end)
  if not okj or type(data) ~= "table" or data.ok ~= true then
    error("[VantArmor] " .. tostring((type(data) == "table" and data.error) or "unauthorized"), 0)
  end
  local fn = loadstring(tostring(data.body))
  if not fn then error("[VantArmor] loader invalido", 0) end
  return fn()
end
return LIB
`);
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
const tamperIpSeen = new Map(); // anti-flood de reportes de volcado por IP
const authHandler = (req, res, slug) => {
  // Los navegadores no reciben nunca el código
  if (/text\/html/.test(req.get('accept') || '')) return res.status(403).type('text/plain').send('!VANTARMOR:FORBIDDEN');
  // Herramientas de descarga identificadas (curl, Python, etc.) reciben señuelo
  if (isLoaderProbe(req)) return sendAuthDecoy(req, res);
  // Los parámetros llegan por GET (loaders viejos) o por POST JSON (nuevos): se mezclan aquí
  const q = { ...req.query, ...((req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) ? req.body : {}) };
  // Loader v4: la key, el HWID y la firma viajan dentro del blob t ofuscado, no en la URL
  if (q.t) {
    const _tb = decodeTblob(q.t);
    if (_tb) Object.assign(q, _tb);
    else if (Number(String(q.ver || '0')) >= 4) return res.status(403).type('text/plain').send('!VANTARMOR:VERIFY_FAILED');
  }
  const qver = Number(String(q.ver || '0')) || 0;
  const FAIL_CODES = new Set(['KEY_INVALID', 'KEY_REQUIRED', 'SCRIPT_NOT_FOUND']);
  const reply = code => {
    // Solo los fallos pasan por el contador: una key válida nunca se bloquea aunque su IP tenga fallos previos
    if (FAIL_CODES.has(code)) {
      if (authBlocked(req.ip)) return res.type('text/plain').status(429).send('!VANTARMOR:RATE_LIMITED');
      noteAuthFail(req.ip);
    }
    return res.type('text/plain').send(`!VANTARMOR:${code}`);
  };

  const script = stmt.scriptBySlug.get(slug);
  if (!script) {
    const gone = db.prepare('SELECT 1 FROM deleted_scripts WHERE slug = ?').get(slug);
    return reply(gone ? 'SCRIPT_DELETED' : 'SCRIPT_NOT_FOUND');
  }
  if (maintenanceAllOn() && !isOwnerId(script.user_id)) return reply('MAINTENANCE_ALL');
  if (script.maintenance) return reply('MAINTENANCE');
  // Kill switch de versión: si se define LOADER_MIN_VERSION, un loader más viejo recibe UPDATE_REQUIRED
  const _minVer = Number(process.env.LOADER_MIN_VERSION || 0) || 0;
  if (_minVer > 0 && qver < _minVer) return reply('UPDATE_REQUIRED');
  // ID de Roblox de quien ejecuta (lo manda el loader desde el juego; vacío si no llegó)
  const rbxid = /^\d{1,20}$/.test(String(q.rbxid || '')) ? String(q.rbxid) : '';
  // Firma del loader (v3.1+): si la peticion trae cs se valida; los loaders viejos pasan sin ella
  if (q.cs !== undefined && q.cs !== null && String(q.cs).trim() !== '') {
    const _ckey = String(q.key || '').trim().slice(0, 64);
    const _chw = String(q.hwid || '').slice(0, 128);
    const _ct = Number(String(q.ct || ''));
    const _now = Math.floor(Date.now() / 1000);
    const _sigOk = Number.isInteger(_ct) && _ct > 0 && Math.abs(_now - _ct * 10) <= 20
      && authSig(scriptAuthSecret(script), String(q.cn || ''), _ckey, _chw, String(_ct)) === String(q.cs).trim().toLowerCase();
    if (!_sigOk) return reply('VERIFY_FAILED');
  }
  // El loader avisa cuando loadstring fue interceptado (volcado). Solo avisa al dueño: no banea.
  if (q.tamper === '1') {
    // soft=1 = aviso blando: el entorno trae herramientas de volcado pero nada enganchado.
    // Se registra y se avisa al dueño, y la ejecución sigue (un ejecutor con saveinstance de
    // fábrica no echa al jugador). Sin soft: enganche real, se corta.
    const soft = String(q.soft || '') === '1';
    const tKey = String(q.key || '').trim().slice(0, 64);
    const tHwid = /^[\x21-\x7E]{8,128}$/.test(String(q.hwid || '')) ? String(q.hwid) : '';
    const keyRow = tKey ? keyForScript(tKey, script) : null;
    const tDiscord = keyRow?.discord_id || null;
    const nowS = Math.floor(Date.now() / 1000);
    try {
      db.prepare('INSERT INTO dump_events (script_id, key, hwid, ip, discord_id, soft, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(script.id, tKey || null, tHwid || null, req.ip || null, tDiscord, soft ? 1 : 0, nowS);
    } catch { /* el registro nunca rompe la entrega */ }
    // El contador solo cuenta los enganches reales, para que el número signifique algo
    if (!soft) db.prepare('UPDATE scripts SET dump_attempts = COALESCE(dump_attempts, 0) + 1, last_dump_at = ? WHERE id = ?').run(nowS, script.id);
    // Revocación automática (opción del script): la key queda baneada sin esperar al dueño
    // Solo si el reporte viene del equipo vinculado a la key: nadie banea keys ajenas conociendo solo la key
    const autoRevoked = Boolean(!soft && script.auto_revoke_dump && keyRow && tKey && tHwid && keyRow.hwid === tHwid
      && db.prepare("UPDATE keys SET banned = 1, ban_reason = 'Volcado detectado' WHERE key = ? AND script_id = ?").run(tKey, script.id).changes);
    // Anti-flood por IP: más de 8 reportes en 10 min desde la misma IP no llegan al dueño
    const _floodKey = `ip|${req.ip}`;
    const _flood = tamperIpSeen.get(_floodKey) || { n: 0, t: Date.now() };
    if (Date.now() - _flood.t > 10 * 60 * 1000) { _flood.n = 0; _flood.t = Date.now(); }
    _flood.n++;
    tamperIpSeen.set(_floodKey, _flood);
    const seenKey = `${script.id}|${soft ? 's' : 'h'}|${tKey}|${tHwid}`;
    const last = tamperSeen.get(seenKey) || 0;
    // Aviso duro: uno cada 10 min por key y HWID. Aviso blando: uno cada 45 min
    if (Date.now() - last > (soft ? 45 * 60 * 1000 : 10 * 60 * 1000) && _flood.n <= 8) {
      tamperSeen.set(seenKey, Date.now());
      logWithRoblox(script.id, soft ? [
        '⚠️ Entorno con herramientas de volcado (nada enganchado)',
        `• Key: \`${tKey || 'sin key'}\``,
        `• HWID: \`${tHwid || 'sin dato'}\``,
        `• Discord: ${tDiscord ? `<@${tDiscord}>` : 'sin vincular'}`,
        '• Se dejó ejecutar: el aviso es solo informativo',
      ] : [
        '🚨 Intento de dump: loadstring fue interceptado',
        `• Key: \`${tKey || 'sin key'}\``,
        `• HWID: \`${tHwid || 'sin dato'}\``,
        `• Discord: ${tDiscord ? `<@${tDiscord}>` : 'sin vincular'}`,
      ], tDiscord, rbxid);
      discordBot?.notifyTamper?.({ scriptId: script.id, key: tKey, hwid: tHwid, rbxid, discordId: tDiscord, autoRevoked, soft });
      fireWebhooks(script.user_id, 'script.tamper', { scriptId: script.id, key: tKey, hwid: tHwid, rbxid, autoRevoked, soft });
    }
    if (soft) return res.type('text/plain').send('!VANTARMOR:OK');
    return reply('TAMPERING');
  }
  // Loader viejo (ver < 4): sin entrega. Con la entrega por pasos tambien queda cerrado el camino
  // de una sola respuesta (v3): todo loader que no sea el nuevo recibe UPDATE_REQUIRED y el
  // usuario ve el aviso de actualizar.
  if (qver < 6) return reply('UPDATE_REQUIRED');
  if (script.ffa) {
    const ffaHwid = String(q.hwid || '').slice(0, 128);
    countExecution(script.id, req.ip, script.user_id);
    logWithRoblox(script.id, [
      '🟢 Script ejecutado (FFA)',
      ...(String(q.lt) === '1' ? ['• Ejecutor: desconocido (baja confianza)'] : []),
      `• HWID: \`${/^[\x21-\x7E]{8,128}$/.test(ffaHwid) ? ffaHwid : 'sin dato'}\``,
      `• ID del script: \`${script.loader_id || script.id}\``,
    ], null, rbxid);
    return startAuthSession(res, script, { key: null, rawHwid: ffaHwid, hwid: ffaHwid, ip: req.ip });
  }

  const key = String(q.key || '').trim().slice(0, 64);
  const rawHwid = String(q.hwid || '').slice(0, 128);
  // Solo caracteres imprimibles (sin espacios ni control): evita basura y texto que rompa los logs
  let hwid = /^[\x21-\x7E]{8,128}$/.test(rawHwid) ? rawHwid : '';
  if (!key) return reply('KEY_REQUIRED');
  if (scriptBanned(script.id, 'ip', req.ip)) return reply('BLACKLISTED');
  const k = keyForScript(key, script);
  const cloneSharing = k && k.project_id != null && (projectOfKey.get(k.project_id) || {}).allow_hwid_clone_sharing === 1;
  if (!k) return reply('KEY_INVALID');
  if (k.banned) return reply('BLACKLISTED');
  if (k.expires_at && k.expires_at * 1000 < Date.now()) return reply('KEY_EXPIRED');
  if (k.discord_id && db.prepare('SELECT 1 FROM bot_blacklist WHERE script_id = ? AND discord_id = ?').get(script.id, k.discord_id)) {
    return reply('BLACKLISTED');
  }
  if (hwid && scriptBanned(script.id, 'hwid', hwid)) return reply('BLACKLISTED');
  // Si GetClientId() falló en el ejecutor, usar la IP como identificador de dispositivo alternativo
  // para evitar rechazar al jugador con VERIFY_FAILED cuando el HWID no llegó por error del ejecutor
  if (!hwid && req.ip) hwid = `ip:${req.ip}`;
  // Bloqueo de equipo apagado: la key sirve en cualquier equipo, sin vincularla ni avisar de compartida
  if (script.hwid_lock !== 0 && !cloneSharing) {
  if (!hwid) return reply('VERIFY_FAILED');
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
  }
  // Limite de ejecuciones por key (opcional): al alcanzarlo la key deja de servir
  if (k.exec_limit && (k.exec_count || 0) >= k.exec_limit) return reply('EXEC_LIMIT');
  // key_days (estilo de la referencia): key en stock sin fecha; el reloj arranca con la primera ejecucion valida
  if (!k.expires_at && k.key_days) {
    const _exp = Math.floor(Date.now() / 1000) + k.key_days * 86400;
    const _act = db.prepare('UPDATE keys SET expires_at = ? WHERE key = ? AND expires_at IS NULL').run(_exp, key);
    k.expires_at = _act.changes ? _exp : (db.prepare('SELECT expires_at FROM keys WHERE key = ?').get(key)?.expires_at ?? null);
    if (k.expires_at && k.expires_at * 1000 < Date.now()) return reply('KEY_EXPIRED');
  }
  const run = db.prepare('UPDATE keys SET last_ip = ?, exec_count = COALESCE(exec_count, 0) + 1 WHERE key = ? RETURNING exec_count')
    .get(req.ip || null, key);
  countExecution(script.id, req.ip, script.user_id);
  logWithRoblox(script.id, [
    '🟢 Script ejecutado',
    ...(String(q.lt) === '1' ? ['• Ejecutor: desconocido (baja confianza)'] : []),
    `• Key: \`${key}\``,
    `• HWID: \`${hwid}\``,
    `• Discord ID: ${k.discord_id ? `\`${k.discord_id}\`` : 'sin vincular'}`,
    `• ID del script: \`${script.loader_id || script.id}\``,
    `• Veces que esta key ejecutó este script: ${run?.exec_count ?? 1}`,
  ], k.discord_id, rbxid);
  return startAuthSession(res, script, { key, rawHwid, hwid, ip: req.ip });
};
// Ruta antigua (por slug): se mantiene para bootstraps que ya estuvieran en ejecución
app.get('/scripts/hosted/:slug/auth', (req, res) => authHandler(req, res, req.params.slug));
// Ruta nueva: el bootstrap lleva la key aleatoria por script (loader_id) en ?s=, no el slug
app.get('/v1/a', (req, res) => {
  if (isLoaderProbe(req)) return sendAuthDecoy(req, res);
  const sk = String(req.query.s || '');
  const row = /^[0-9a-f]{40}$/.test(sk) ? stmt.scriptByLoaderId.get(sk) : null;
  return authHandler(req, res, row ? row.slug : '');
});
// Autenticación por POST (JSON): la key y el HWID viajan en el cuerpo, no en la URL,
// así no acaban en logs de proxy ni de Railway. Content-Type flexible: algunos ejecutores fuerzan text/plain.
app.post('/v1/a', express.json({ type: () => true, limit: '8kb' }), (req, res) => {
  const b = (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) ? req.body : {};
  const row = /^[0-9a-f]{40}$/.test(String(b.s || '')) ? stmt.scriptByLoaderId.get(String(b.s)) : null;
  return authHandler(req, res, row ? row.slug : '');
});
app.post('/scripts/hosted/:slug/auth', express.json({ type: () => true, limit: '8kb' }), (req, res) => authHandler(req, res, req.params.slug));

// Chequeo de key sin entrega (equivale a la libreria check_key de la referencia): un script puede
// validar la key ANTES del loadstring y mostrar su propio mensaje. Solo lectura: no vincula HWID,
// no cuenta ejecucion, y los fallos pasan por el mismo antifuerza-bruta que /auth.
app.get('/v1/k', (req, res) => {
  const replyK = code => res.type('text/plain').send(`!VANTARMOR:${code}`);
  const _uaK = String(req.get('user-agent') || '');
  if (/^(curl|wget|httpie)\//i.test(_uaK) || /python-requests|python-urllib|libwww-perl|postmanruntime/i.test(_uaK)) return replyK('FORBIDDEN');
  const sk = String(req.query.s || '');
  const script = /^[0-9a-f]{40}$/.test(sk) ? stmt.scriptByLoaderId.get(sk) : null;
  if (!script) {
    if (authBlocked(req.ip)) return replyK('RATE_LIMITED');
    noteAuthFail(req.ip);
    return replyK('SCRIPT_NOT_FOUND');
  }
  const key = String(req.query.key || '').trim().slice(0, 64);
  if (!key || key.length < 8) return replyK('KEY_INVALID');
  const k = keyForScript(key, script);
  const cloneSharing = k && k.project_id != null && (projectOfKey.get(k.project_id) || {}).allow_hwid_clone_sharing === 1;
  if (!k) {
    if (authBlocked(req.ip)) return replyK('RATE_LIMITED');
    noteAuthFail(req.ip);
    return replyK('KEY_INCORRECT');
  }
  if (k.banned) return replyK('KEY_BANNED');
  if (k.expires_at && k.expires_at * 1000 < Date.now()) return replyK('KEY_EXPIRED');
  if (k.exec_limit && (k.exec_count || 0) >= k.exec_limit) return replyK('KEY_EXEC_LIMIT');
  if (script.hwid_lock !== 0 && !cloneSharing) {
    const hwid = /^[\x21-\x7E]{8,128}$/.test(String(req.query.hwid || '')) ? String(req.query.hwid) : '';
    if (k.hwid && hwid && k.hwid !== hwid) return replyK('KEY_HWID_LOCKED');
    if (!k.hwid && k.last_hwid && hwid && k.last_hwid !== hwid && script.share_detection !== 0) return replyK('KEY_HWID_LOCKED');
  }
  // Datos extra (estilo de la referencia): el script los lee sin pedir nada más
  return res.type('text/plain').send([
    '!VANTARMOR:KEY_VALID',
    `expires=${k.expires_at || 0}`,
    `execs=${k.exec_count || 0}`,
    `limit=${k.exec_limit || 0}`,
    `discord=${k.discord_id || ''}`,
    'status=' + (k.hwid ? 'active' : 'reset'),
  ].join('\n'));
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
  if (!user) {
    res.clearCookie(SESSION_COOKIE);
    return res.status(401).json({ error: 'Usuario no encontrado' });
  }
  res.json({ ...user, owner: isOwnerId(req.userId), admin: ADMIN_DISCORD_IDS.includes(String(req.userId)) || isOwnerId(req.userId) });
});

// ---------- Chat de la comunidad ----------
const CHAT_MAX_CHARS = 500;
const CHAT_COOLDOWN_MS = 2000;               // un mensaje cada 2 s por usuario
const CHAT_REACTIONS = ['👍', '❤️', '😂', '🔥', '😮', '😢'];
const CHAT_SPAM_MUTE_S = 5 * 60;             // silencio automático por spam
const CHAT_STREAM_MAX = 500;                 // conexiones en vivo a la vez
const CHAT_STREAM_MAX_PER_USER = 2;
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
  if (plan === 'custom') return 'custom';
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
  if ((chatStreams.get(req.userId)?.size ?? 0) >= CHAT_STREAM_MAX_PER_USER) return res.status(429).end();

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
  const planNow = stmt.userById.get(req.userId)?.plan;
  if (planNow !== 'plus' && planNow !== 'custom') {
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
    removeUserImage(req.userId, 'profile');
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

// Subida directa de foto (recortada a cuadrado en el navegador). Se guarda en la base y se sirve desde /images.
app.post('/api/me/avatar/upload', requireAuth, requirePerkPlan, async (req, res) => {
  const kind = req.body?.kind;
  if (kind !== 'profile' && kind !== 'bot') return res.status(400).json({ error: 'Tipo de foto inválido' });
  const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+=*)$/.exec(String(req.body?.dataUrl ?? ''));
  if (!m) return res.status(400).json({ error: 'Elige una imagen (png, jpg, webp o gif)' });
  const type = m[1];
  const b64 = m[2];
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length || buf.length > 1024 * 1024) return res.status(400).json({ error: 'La imagen es demasiado grande' });
  if (kind === 'bot') {
    if (!discordBot?.setGuildAvatarFor) return res.status(503).json({ error: 'El bot todavía no está conectado' });
    try {
      await discordBot.setGuildAvatarFor(req.userId, { buf, type });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }
  saveUserImage(req.userId, kind, type, b64);
  const url = `/images/${req.userId}/${kind}?v=${Date.now()}`;
  if (kind === 'profile') db.prepare('UPDATE users SET custom_avatar = ? WHERE id = ?').run(url, req.userId);
  else db.prepare('UPDATE users SET bot_avatar = ? WHERE id = ?').run(url, req.userId);
  res.json({ ok: true, avatarUrl: url });
});

// Imagen de Precios o Bienvenida desde la galería. La URL pública la usa el bot en el embed.
app.post('/api/me/image/upload', requireAuth, (req, res, next) => (req.body?.kind === 'welcome' ? requirePlusPlan : requirePerkPlan)(req, res, next), (req, res) => {
  const kind = req.body?.kind;
  if (kind !== 'prices' && kind !== 'welcome') return res.status(400).json({ error: 'Tipo de imagen inválido' });
  const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+=*)$/.exec(String(req.body?.dataUrl ?? ''));
  if (!m) return res.status(400).json({ error: 'Elige una imagen (png, jpg, webp o gif)' });
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length || buf.length > 4 * 1024 * 1024) return res.status(400).json({ error: 'La imagen es demasiado grande (máximo 4 MB)' });
  saveUserImage(req.userId, kind, m[1], m[2]);
  res.json({ ok: true, url: `${APP_URL}/images/${req.userId}/${kind}?v=${Date.now()}` });
});

// Imágenes subidas: públicas (son avatares que se ven en el chat y en los paneles)
app.get('/images/:userId/:kind', (req, res) => {
  if (!/^\d{5,25}$/.test(req.params.userId) || !['profile', 'bot', 'prices', 'welcome'].includes(req.params.kind)) return res.status(404).end();
  const row = db.prepare('SELECT mime, data FROM user_images WHERE user_id = ? AND kind = ?').get(req.params.userId, req.params.kind);
  if (!row) return res.status(404).end();
  let buf;
  try {
    buf = row.data.startsWith('file:')
      ? fs.readFileSync(path.join(IMAGES_DIR, path.basename(row.data.slice(5))))
      : Buffer.from(row.data, 'base64'); // filas antiguas que aún no migraron
  } catch { return res.status(404).end(); }
  res.set({ 'Content-Type': row.mime, 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff' });
  res.send(buf);
});

// Foto del bot solo en los servidores donde el creador tiene su panel. Vacío = quitarla.
app.post('/api/me/bot-avatar', requireAuth, requirePerkPlan, async (req, res) => {
  const raw = String(req.body?.url ?? '').trim();
  if (!raw) {
    if (discordBot?.setGuildAvatarFor) await discordBot.setGuildAvatarFor(req.userId, null).catch(() => {});
    db.prepare('UPDATE users SET bot_avatar = NULL WHERE id = ?').run(req.userId);
    removeUserImage(req.userId, 'bot');
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
// Versión que está corriendo: commit de Railway y huella del motor de Ofuscador 4 (público, sin datos sensibles)
const STARTED_AT = new Date().toISOString();
app.get('/api/version', (req, res) => {
  const sha = process.env.RAILWAY_GIT_COMMIT_SHA || '';
  res.json({
    commit: sha ? sha.slice(0, 7) : 'desconocido',
    commitFull: sha || null,
    engine: NEXT_ENGINE_VERSION,
    startedAt: STARTED_AT,
  });
});

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

// ---- Panel de admin global (/admin): solo los Discord IDs de ADMIN_DISCORD_IDS ----
function requireAdminUser(req, res, next) {
  const token = (req.get('authorization') || '').replace(/^Bearer /, '');
  const expected = process.env.ADMIN_API_TOKEN || '';
  if (expected && token && token.length === expected.length
      && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))) return next();
  return requireAuth(req, res, () => {
    if (!ADMIN_DISCORD_IDS.includes(String(req.userId)) && !isOwnerId(req.userId)) return res.status(403).json({ error: 'No tienes acceso al panel de admin' });
    next();
  });
}

function adminAudit(actorId, action, detail) {
  try { db.prepare('INSERT INTO admin_audit (actor_id, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?)').run(String(actorId), action, String(detail || ''), Date.now()); } catch { /* el log nunca rompe la peticion */ }
}

app.get('/api/admin/overview', requireAdminUser, (req, res) => {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' });
  const one = q => db.prepare(q).get().n;
  res.json({
    me: req.userId,
    maintenance: maintenanceState(),
    deploy: {
      deployment_id: process.env.RAILWAY_DEPLOYMENT_ID || null,
      commit: process.env.RAILWAY_GIT_COMMIT_SHA || null,
      environment: process.env.RAILWAY_ENVIRONMENT_NAME || null,
      started_at: BOOT_AT,
      uptime_s: Math.floor(process.uptime()),
      node: process.version,
    },
    deploys: db.prepare('SELECT id, deployment_id, commit_sha, started_at FROM app_deploys ORDER BY started_at DESC LIMIT 10').all(),
    stats: {
      users: one('SELECT COUNT(*) n FROM users'),
      scripts: one('SELECT COUNT(*) n FROM scripts'),
      keys_active: one('SELECT COUNT(*) n FROM keys WHERE banned = 0'),
      exec_today: one(`SELECT COALESCE(SUM(n), 0) n FROM execution_daily WHERE day = '${today}'`),
      loader_downloads_24h: one(`SELECT COUNT(*) n FROM loader_downloads WHERE created_at >= ${Date.now() - 24 * 3600 * 1000}`),
      tickets_open: one(`SELECT COUNT(*) n FROM support_tickets WHERE status = 'open'`),
      custom_pending: one(`SELECT COUNT(*) n FROM custom_plan_requests WHERE status = 'pending'`),
    },
    audit: db.prepare('SELECT actor_id, action, detail, created_at FROM admin_audit ORDER BY id DESC LIMIT 15').all(),
  });
});

app.post('/api/admin/maintenance', requireAdminUser, (req, res) => {
  const b = req.body || {};
  if (typeof b.site === 'boolean') appSet('maintenance', b.site ? '1' : '0');
  if (typeof b.loader === 'boolean') appSet('maintenance_loader', b.loader ? '1' : '0');
  if (typeof b.message === 'string') appSet('maintenance_msg', b.message.slice(0, 200));
  adminAudit(req.userId, 'maintenance', `site=${maintenanceState().site ? 'on' : 'off'} loader=${maintenanceState().loader ? 'on' : 'off'}`);
  res.json({ ok: true, maintenance: maintenanceState() });
});
// ---- Solicitudes Custom (solo dueño) ----
app.get('/api/owner/custom-requests', requireOwnerApi, (req, res) => {
  res.json(db.prepare(`SELECT r.id, r.user_id, u.username, r.scripts, r.obfuscations, r.panels, r.payment_method, r.contact, r.status, r.created_at, r.decided_at
    FROM custom_plan_requests r LEFT JOIN users u ON u.id = r.user_id
    ORDER BY (r.status = 'pending') DESC, r.created_at DESC LIMIT 100`).all());
});
// Aprobar: pasa el usuario a Custom con esos límites (sin vencimiento)
app.post('/api/owner/custom-requests/:id/approve', requireOwnerApi, (req, res) => {
  const row = db.prepare('SELECT * FROM custom_plan_requests WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Solicitud no encontrada' });
  if (row.status !== 'pending') return res.status(409).json({ error: 'La solicitud ya fue revisada' });
  const now = Math.floor(Date.now() / 1000);
  db.transaction(() => {
    db.prepare("UPDATE users SET plan = 'custom', plan_expires_at = NULL, plan_expired_at = NULL, custom_scripts = ?, custom_obfuscations = ?, custom_panels = ? WHERE id = ?")
      .run(row.scripts, row.obfuscations, row.panels, row.user_id);
    db.prepare("UPDATE custom_plan_requests SET status = 'approved', decided_at = ? WHERE id = ?").run(now, row.id);
  })();
  auditLog(req.userId, 'custom_approve', row.user_id, `${row.scripts} scripts / ${row.obfuscations} ofuscaciones / ${row.panels} paneles`);
  res.json({ ok: true });
});
app.post('/api/owner/custom-requests/:id/reject', requireOwnerApi, (req, res) => {
  const info = db.prepare("UPDATE custom_plan_requests SET status = 'rejected', decided_at = ? WHERE id = ? AND status = 'pending'")
    .run(Math.floor(Date.now() / 1000), Number(req.params.id));
  if (!info.changes) return res.status(404).json({ error: 'Solicitud no encontrada o ya revisada' });
  auditLog(req.userId, 'custom_reject', req.params.id, '');
  res.json({ ok: true });
});
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
const PLAN_KEY_PREFIX = { premium: 'PREMIUM-', plus: 'PLUS-', custom: 'CUSTOM-' };
app.post('/api/owner/plan-keys', requireOwnerApi, (req, res) => {
  const plan = ['premium', 'plus', 'custom'].includes(req.body?.plan) ? req.body.plan : null;
  if (!plan) return res.status(400).json({ error: 'Plan inválido' });
  // Duración en días (1 a 3650). Si no viene, 30 días como antes.
  const days = req.body?.days === undefined || req.body.days === null ? PLAN_DAYS_DEFAULT : Number(req.body.days);
  if (!Number.isInteger(days) || days < 1 || days > 3650) return res.status(400).json({ error: 'La duración debe estar entre 1 y 3650 días' });
  // La key empieza por el tipo de plan (PREMIUM-, PLUS-, CUSTOM-) para saber qué es sin abrirla
  const key = PLAN_KEY_PREFIX[plan] + crypto.randomBytes(24).toString('base64url'); // uso único
  db.prepare('INSERT INTO plan_keys (key, plan, days, created_at) VALUES (?, ?, ?, ?)').run(key, plan, days, Math.floor(Date.now() / 1000));
  auditLog(req.userId, 'plan_key_create', plan, `${days} días`);
  res.json({ key, plan, days });
});
// Borrar una key sin usar
app.delete('/api/owner/plan-keys/:key', requireOwnerApi, (req, res) => {
  const row = db.prepare('SELECT used_by FROM plan_keys WHERE key = ?').get(req.params.key);
  if (!row) return res.status(404).json({ error: 'Key no encontrada' });
  if (row.used_by) return res.status(409).json({ error: 'Esta key ya fue canjeada. Usa "Quitar plan" o "+ días".' });
  db.prepare('DELETE FROM plan_keys WHERE key = ? AND used_by IS NULL').run(req.params.key);
  auditLog(req.userId, 'plan_key_delete', req.params.key.slice(0, 10) + '…', '');
  res.json({ ok: true });
});
// Dar más días: a una key sin usar le suma a su duración; a una ya canjeada le suma al plan del usuario
app.post('/api/owner/plan-keys/:key/extend', requireOwnerApi, (req, res) => {
  const days = Number(req.body?.days);
  if (!Number.isInteger(days) || days < 1 || days > 3650) return res.status(400).json({ error: 'La cantidad debe estar entre 1 y 3650 días' });
  const row = db.prepare('SELECT * FROM plan_keys WHERE key = ?').get(req.params.key);
  if (!row) return res.status(404).json({ error: 'Key no encontrada' });
  if (!row.used_by) {
    db.prepare('UPDATE plan_keys SET days = COALESCE(days, ?) + ? WHERE key = ? AND used_by IS NULL').run(PLAN_DAYS_DEFAULT, days, req.params.key);
    auditLog(req.userId, 'plan_key_extend', req.params.key.slice(0, 10) + '…', `+${days} días (sin usar)`);
    return res.json({ ok: true, mode: 'key' });
  }
  const u = db.prepare('SELECT plan, plan_expires_at FROM users WHERE id = ?').get(row.used_by);
  if (!u || u.plan !== row.plan || !u.plan_expires_at) return res.status(409).json({ error: 'El plan de ese usuario ya no es de esta key o no vence' });
  db.prepare('UPDATE users SET plan_expires_at = plan_expires_at + ? WHERE id = ?').run(days * 86400, row.used_by);
  auditLog(req.userId, 'plan_extend', row.used_by, `+${days} días`);
  res.json({ ok: true, mode: 'user' });
});
// Quitar el plan al usuario que canjeó la key (vuelve a Free)
app.post('/api/owner/plan-keys/:key/revoke', requireOwnerApi, (req, res) => {
  const row = db.prepare('SELECT * FROM plan_keys WHERE key = ?').get(req.params.key);
  if (!row) return res.status(404).json({ error: 'Key no encontrada' });
  if (!row.used_by) return res.status(409).json({ error: 'Esta key aún no fue canjeada; bórrala en su lugar' });
  db.prepare("UPDATE users SET plan = 'free', plan_expires_at = NULL, plan_expired_at = NULL WHERE id = ? AND plan = ?").run(row.used_by, row.plan);
  auditLog(req.userId, 'plan_revoke', row.used_by, row.plan);
  res.json({ ok: true });
});

// ---- Usuarios (solo dueño): ver planes y cambiarlos ----
app.get('/api/owner/obfuscators', requireOwnerApi, (req, res) => {
  res.json(Object.entries(OBF_CONFIG).map(([id, c]) => ({ id, ready: Boolean(c.dir) })));
});

app.get('/api/owner/users', requireOwnerApi, (req, res) => {
  res.json(db.prepare(`SELECT u.id, u.username, u.avatar, u.custom_avatar, u.plan, u.obf_used, u.staff_role, u.plan_expires_at,
      (SELECT COUNT(*) FROM scripts s WHERE s.user_id = u.id) AS scripts
    FROM users u ORDER BY u.id DESC LIMIT 500`).all().map(({ custom_avatar, avatar, ...u }) => ({
      ...u,
      avatar_url: custom_avatar || (avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${avatar}.png?size=64` : defaultDiscordAvatar(u.id)),
      role: roleOf(u.id, u.plan, u.staff_role),
    })));
});
app.post('/api/owner/users/:id/plan', requireOwnerApi, (req, res) => {
  const plan = ['free', 'premium', 'plus', 'custom'].includes(req.body?.plan) ? req.body.plan : null;
  if (!plan) return res.status(400).json({ error: 'Plan inválido' });
  const expiresAt = plan === 'free' || plan === 'custom' ? null : Math.floor(Date.now() / 1000) + MONTH_SECONDS;
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

// Reinicia ya los contadores de scripts, ofuscaciones y keys (sin esperar a los 15 días / al mes). Solo el dueño.
app.post('/api/owner/users/:id/reset-quota', requireOwnerApi, (req, res) => {
  if (!quota.resetNow(req.params.id)) return res.status(404).json({ error: 'Usuario no encontrado' });
  auditLog(req.userId, 'quota_reset', req.params.id, 'manual');
  res.json({ ok: true });
});

// Foto por defecto de Discord (la misma que muestra Discord cuando el usuario no tiene avatar)
const defaultDiscordAvatar = id => { try { return `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(id) >> 22n) % 6n)}.png`; } catch { return null; } };
// Respaldo descargable para el dueño: copia en vivo de la base (se borra después de enviarla)
app.get('/api/owner/backup', requireOwnerApi, async (req, res) => {
  // SQLite: la copia se genera en memoria, sin escribir otra base completa en el volumen
  if (typeof db.serialize === 'function') {
    try {
      const copy = db.serialize();
      auditLog(req.userId, 'settings', 'respaldo descargado', '');
      res.set({
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="vantarmor-${ecuadorDay(Date.now())}.db"`,
      });
      return res.send(copy);
    } catch (err) {
      console.error('[Respaldo] Descarga fallida:', err.message);
      return res.status(500).json({ error: 'No se pudo crear el respaldo', detail: String(err?.message || err).slice(0, 300) });
    }
  }
  // PostgreSQL: se exporta a un archivo temporal y se descarga
  const file = path.join(BACKUP_DIR, `manual-${Date.now()}.db`);
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    await db.backup(file);
    auditLog(req.userId, 'settings', 'respaldo descargado', '');
    res.download(file, `vantarmor-${ecuadorDay(Date.now())}.db`, () => fs.rmSync(file, { force: true }));
  } catch (err) {
    fs.rmSync(file, { force: true });
    console.error('[Respaldo] Descarga fallida:', err.message);
    res.status(500).json({ error: 'No se pudo crear el respaldo', detail: String(err?.message || err).slice(0, 300) });
  }
});

// Webhook protegido: el ejecutor manda { t, n, p }. La URL nunca viaja al cliente.
app.post('/v1/w', express.json({ type: () => true, limit: '12kb' }), async (req, res) => {
  const deny = () => res.status(403).json({ ok: false });
  const body = req.body || {};
  const entry = webhookSessions.get(String(body.t || ''));
  if (!entry || entry.expires < Date.now()) return deny();
  const script = db.prepare('SELECT id FROM scripts WHERE id = ?').get(entry.scriptId);
  if (!script) return deny();
  if (entry.key) {
    const k = keyForScript(entry.key, script);
    if (!k || k.banned || (k.expires_at && k.expires_at * 1000 < Date.now())) return deny();
  }
  // 30 envíos por minuto por IP (igual que la referencia)
  const now = Date.now();
  const arr = (webhookRate.get(String(req.ip || '')) || []).filter(x => x > now - 60_000);
  if (arr.length >= 30) return res.status(429).json({ ok: false });
  arr.push(now);
  webhookRate.set(String(req.ip || ''), arr);
  const hook = webhookStmt.byScript.all(script.id).find(h => h.name === String(body.n || ''));
  if (!hook) return res.status(404).json({ ok: false });
  const payload = body.p;
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return res.status(400).json({ ok: false });
  if (payload.embeds && (!Array.isArray(payload.embeds) || payload.embeds.length > 3)) return res.status(400).json({ ok: false });
  let json;
  try { json = JSON.stringify(payload); } catch { return res.status(400).json({ ok: false }); }
  if (json.length > 7000) return res.status(413).json({ ok: false });
  // Variables del servidor: el cliente no puede falsearlas
  const info = entry.key ? keyForScript(entry.key, script) : null;
  let country = '';
  try { country = countryOf(req.ip) || ''; } catch { /* país desconocido no rompe el envío */ }
  json = json
    .replaceAll('%DISCORD_ID%', info && info.discord_id ? String(info.discord_id) : '')
    .replaceAll('%CLIENT_IP%', String(req.ip || ''))
    .replaceAll('%COUNTRY_CODE%', country)
    .replaceAll('%USER_KEY%', entry.key || '');
  try {
    await fetch(hook.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json, signal: AbortSignal.timeout(5000) });
  } catch { /* el webhook nunca rompe el loader */ }
  res.status(204).end();
});

// Bloque remoto (Fase 1): el ejecutor pide la expresión de un --@remote:nombre con el token de /auth
app.get('/scripts/hosted/:slug/remote', (req, res) => {
  const deny = () => res.status(403).type('text/plain').send('!VANTARMOR:REMOTE_DENIED');
  const entry = remoteTokens.get(String(req.query.token || ''));
  if (!entry || entry.expires < Date.now() || entry.slug !== req.params.slug || entry.ip !== (req.ip || null)) return deny();
  if (++entry.calls > REMOTE_MAX_CALLS) return deny();
  const script = stmt.scriptBySlug.get(req.params.slug);
  if (!script || script.id !== entry.scriptId) return deny();
  // La key se vuelve a revisar en cada pedido: si la banean o expira, deja de servir de inmediato
  if (entry.key) {
    const k = keyForScript(entry.key, script);
    if (!k || k.banned || (k.expires_at && k.expires_at * 1000 < Date.now())) return deny();
  }
  const body = remoteBlocks(script.source || '').get(String(req.query.name || ''));
  if (body === undefined) return deny();
  // El cuerpo del bloque nunca sale en claro: mismo tratamiento que el payload base.
  const out = remoteProtectedBody(script, body);
  if (!out) return deny();
  res.type('text/plain').send(out);
});

// Dueño: compacta la base SQLite para devolver al volumen el espacio libre de páginas borradas.
// VACUUM necesita espacio libre igual al tamaño de la base, así que se niega si no hay margen.
app.post('/api/owner/compact', requireOwnerApi, (req, res) => {
  if (process.env.DB_ENGINE === 'postgres') return res.status(409).json({ error: 'La compactación solo aplica al modo SQLite' });
  const mb = bytes => `${(bytes / 1048576).toFixed(1)} MB`;
  try {
    const before = fs.statSync(DATABASE_PATH).size;
    const fsInfo = fs.statfsSync(path.dirname(DATABASE_PATH));
    const free = fsInfo.bavail * fsInfo.bsize;
    if (free < before * 1.1) {
      return res.status(409).json({ error: `No hay espacio para compactar ahora: libre ${mb(free)}, la base pesa ${mb(before)}. Al reiniciar el servicio la base se compacta sola (usa una copia temporal fuera del volumen); si aun asi no alcanza, amplía el volumen en Railway.` });
    }
    db.exec('VACUUM');
    const after = fs.statSync(DATABASE_PATH).size;
    auditLog(req.userId, 'settings', 'base compactada', `${mb(before)} -> ${mb(after)}`);
    res.json({ ok: true, message: `Base compactada: ${mb(before)} -> ${mb(after)}` });
  } catch (err) {
    console.error('[Compactar] Fallido:', err.message);
    res.status(500).json({ error: 'No se pudo compactar', detail: String(err?.message || err).slice(0, 300) });
  }
});

// Dueño: activa o desactiva la entrega del código ofuscado para un script (para probarlo en móvil antes de usarlo en todos)
app.post('/api/owner/serve-protected', requireOwnerApi, (req, res) => {
  const scriptId = Number(req.body?.scriptId);
  if (!Number.isInteger(scriptId) || scriptId < 1) return res.status(400).json({ error: 'scriptId inválido' });
  const on = req.body?.on ? 1 : 0;
  if (on && !db.prepare('SELECT content FROM scripts WHERE id = ?').get(scriptId)?.content) {
    return res.status(404).json({ error: 'Script no encontrado' });
  }
  const info = db.prepare('UPDATE scripts SET serve_protected = ? WHERE id = ?').run(on, scriptId);
  if (!info.changes) return res.status(404).json({ error: 'Script no encontrado' });
  auditLog(req.userId, 'settings', on ? 'entrega ofuscada activada' : 'entrega ofuscada desactivada', `script ${scriptId}`);
  res.json({ ok: true, scriptId, serveProtected: on });
});

// Restaurar una copia (.db). El archivo se valida y queda pendiente: se aplica al reiniciar el servicio.
app.post('/api/owner/import-db', requireOwnerApi, async (req, res) => {
  if (process.env.DB_ENGINE === 'postgres') {
    return res.status(409).json({ error: 'La base está en PostgreSQL. Quita DB_ENGINE para restaurar una copia SQLite.' });
  }
  // La copia se escribe en disco mientras llega (no se carga entera en memoria, que tumbaba el servicio)
  const pending = `${DATABASE_PATH}.import`;
  const part = `${pending}.part`;
  const IMPORT_MAX = 300 * 1024 * 1024;
  try {
    let size = 0;
    let head = Buffer.alloc(0);
    const sniff = new Transform({
      transform(chunk, _enc, cb) {
        size += chunk.length;
        if (size > IMPORT_MAX) return cb(new Error('la copia supera 300 MB'));
        if (head.length < 16) head = Buffer.concat([head, chunk]).subarray(0, 16);
        cb(null, chunk);
      },
    });
    await pipeline(req, sniff, fs.createWriteStream(part));
    if (size < 100 || head.toString('latin1') !== 'SQLite format 3\u0000') throw new Error('el archivo no es una base SQLite válida');
    const Database = createRequire(import.meta.url)('better-sqlite3');
    const check = new Database(part, { readonly: true, fileMustExist: true });
    let integrity, counts;
    try {
      integrity = check.pragma('quick_check', { simple: true });
      const count = table => { try { return check.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n; } catch { return null; } };
      counts = { usuarios: count('users'), scripts: count('scripts'), keys: count('keys') };
    } finally { check.close(); }
    if (integrity !== 'ok') throw new Error(`la verificación de la base falló (${integrity})`);
    fs.renameSync(part, pending);
    auditLog(req.userId, 'settings', 'copia restaurada (pendiente de reinicio)', `${size} bytes`);
    res.json({ ok: true, bytes: size, counts, message: 'Copia recibida. Reinicia el servicio web en Railway para aplicarla.' });
  } catch (err) {
    fs.rmSync(part, { force: true });
    res.status(400).json({ error: `No se pudo usar el archivo: ${err.message}` });
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
// Descargas recientes del loader con IP (solo dueño)
app.get('/api/owner/loader-downloads', requireOwnerApi, (req, res) => {
  const since = Math.floor(Date.now() / 1000) - LOADER_LOG_DAYS * 86400;
  res.json(db.prepare(`SELECT ld.slug, ld.ip, ld.created_at, s.name AS script_name
    FROM loader_downloads ld LEFT JOIN scripts s ON s.id = ld.script_id
    WHERE ld.created_at >= ? ORDER BY ld.created_at DESC LIMIT 300`).all(since));
});

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

// Difusión: manda un anuncio a los canales de anuncios de todos los servidores (solo el dueño)
app.get('/api/owner/broadcast', requireOwnerApi, (req, res) => {
  res.json(discordBot?.broadcastState ?? { running: false, total: 0, sent: 0, skipped: 0, failed: [] });
});
app.post('/api/owner/broadcast', requireOwnerApi, (req, res) => {
  const title = String(req.body?.title ?? '').trim();
  const description = String(req.body?.description ?? '').trim();
  if (!title || title.length > 256) return res.status(400).json({ error: 'Título requerido (máx. 256)' });
  if (!description || description.length > 2000) return res.status(400).json({ error: 'Mensaje requerido (máx. 2000)' });
  if (!discordBot?.startBroadcast) return res.status(503).json({ error: 'El bot todavía no está conectado' });
  try {
    const { total } = discordBot.startBroadcast({ title, description });
    auditLog(req.userId, 'broadcast', String(total), title);
    res.json({ ok: true, total });
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

app.get('/api/scripts', requireAuth, (req, res) => {
  res.json(stmt.scriptsByUser.all(req.userId));
});

// ---------- Proyectos (agrupan scripts) ----------
const PROJECT_LIMIT = 30;
app.get('/api/projects', requireAuth, (req, res) => {
  res.json(db.prepare(`SELECT p.id, p.name, p.logs_webhook, p.alert_webhook, p.allow_hwid_reset, p.hwid_reset_cooldown_days, p.auto_delete_expired, p.allow_hwid_clone_sharing,
    (SELECT COUNT(*) FROM scripts s WHERE s.project_id = p.id) AS scripts
    FROM projects p WHERE p.user_id = ? ORDER BY p.id DESC`).all(req.userId));
});

// Valida y limpia los ajustes de un proyecto (webhooks de Discord)
function projectFields(body) {
  const cleanUrl = v => {
    const s = String(v ?? '').trim();
    if (!s) return null;
    return /^https:\/\/(canary\.|ptb\.)?discord(app)?\.com\/api\/webhooks\//.test(s) ? s.slice(0, 300) : undefined;
  };
  const logs = cleanUrl(body?.logsWebhook);
  if (logs === undefined) return { error: 'El webhook de logs debe ser una URL de webhook de Discord' };
  const alert = cleanUrl(body?.alertWebhook);
  if (alert === undefined) return { error: 'El webhook de alertas debe ser una URL de webhook de Discord' };
  const cooldown = (body?.hwidResetCooldownDays === undefined || body?.hwidResetCooldownDays === null || body?.hwidResetCooldownDays === '') ? null : Number(body.hwidResetCooldownDays);
  if (cooldown !== null && (!Number.isInteger(cooldown) || cooldown < 0 || cooldown > 365)) return { error: 'El cooldown debe estar entre 0 y 365 días' };
  return {
    logs_webhook: logs, alert_webhook: alert,
    allow_hwid_reset: body?.allowHwidReset === false ? 0 : 1,
    hwid_reset_cooldown_days: cooldown,
    auto_delete_expired: body?.autoDeleteExpired === true ? 1 : 0,
    allow_hwid_clone_sharing: body?.allowHwidCloneSharing === true ? 1 : 0,
  };
}

app.post('/api/projects', requireAuth, (req, res) => {
  if (maintenanceBlock(req, res)) return;
  const name = String(req.body?.name ?? '').trim();
  if (!name || name.length > 40) return res.status(400).json({ error: 'El nombre debe tener entre 1 y 40 caracteres' });
  const count = db.prepare('SELECT COUNT(*) AS n FROM projects WHERE user_id = ?').get(req.userId).n;
  if (count >= PROJECT_LIMIT) return res.status(403).json({ error: `Máximo ${PROJECT_LIMIT} proyectos` });
  const f = projectFields(req.body);
  if (f.error) return res.status(400).json({ error: f.error });
  const info = db.prepare(`INSERT INTO projects (user_id, name, created_at, logs_webhook, alert_webhook, allow_hwid_reset, hwid_reset_cooldown_days, auto_delete_expired, allow_hwid_clone_sharing)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(req.userId, name, Math.floor(Date.now() / 1000), f.logs_webhook, f.alert_webhook, f.allow_hwid_reset, f.hwid_reset_cooldown_days, f.auto_delete_expired, f.allow_hwid_clone_sharing);
  res.json({ id: Number(info.lastInsertRowid), name, scripts: 0 });
});

// Editar los ajustes de un proyecto
app.put('/api/projects/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT id FROM projects WHERE id = ? AND user_id = ?').get(id, req.userId)) return res.status(404).json({ error: 'Proyecto no encontrado' });
  const f = projectFields(req.body);
  if (f.error) return res.status(400).json({ error: f.error });
  db.prepare(`UPDATE projects SET logs_webhook = ?, alert_webhook = ?, allow_hwid_reset = ?, hwid_reset_cooldown_days = ?, auto_delete_expired = ?, allow_hwid_clone_sharing = ? WHERE id = ? AND user_id = ?`)
    .run(f.logs_webhook, f.alert_webhook, f.allow_hwid_reset, f.hwid_reset_cooldown_days, f.auto_delete_expired, f.allow_hwid_clone_sharing, id, req.userId);
  res.json({ ok: true });
});

// Borrar un proyecto: sus scripts y sus keys pasan al proyecto mas viejo que quede (nunca quedan sueltos)
app.post('/api/projects/:id/delete', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT id FROM projects WHERE id = ? AND user_id = ?').get(id, req.userId)) return res.status(404).json({ error: 'Proyecto no encontrado' });
  const other = db.prepare('SELECT id FROM projects WHERE user_id = ? AND id != ? ORDER BY id ASC LIMIT 1').get(req.userId, id);
  const scriptCount = db.prepare('SELECT COUNT(*) AS n FROM scripts WHERE project_id = ?').get(id).n;
  const keyCount = db.prepare('SELECT COUNT(*) AS n FROM keys WHERE project_id = ?').get(id).n;
  if (!other && (scriptCount > 0 || keyCount > 0)) return res.status(400).json({ error: 'Este proyecto tiene scripts o keys: crea otro proyecto o vacíalo primero' });
  db.transaction(() => {
    if (other) {
      db.prepare('UPDATE scripts SET project_id = ? WHERE project_id = ? AND user_id = ?').run(other.id, id, req.userId);
      db.prepare('UPDATE keys SET project_id = ? WHERE project_id = ?').run(other.id, id);
    }
    db.prepare('DELETE FROM bot_project_rules WHERE project_id = ?').run(id);
    db.prepare('DELETE FROM projects WHERE id = ? AND user_id = ?').run(id, req.userId);
  })();
  res.json({ ok: true });
});

// Mover un script a un proyecto (projectId vacío = sin proyecto)
app.post('/api/scripts/:id/project', requireAuth, (req, res) => {
  const script = stmt.scriptOwned.get(Number(req.params.id), req.userId);
  if (!script) return res.status(403).json({ error: 'No autorizado' });
  const raw = req.body?.projectId;
  let projectId = null;
  if (raw !== null && raw !== undefined && raw !== '') {
    projectId = Number(raw);
    if (!Number.isInteger(projectId) || !db.prepare('SELECT 1 FROM projects WHERE id = ? AND user_id = ?').get(projectId, req.userId)) {
      return res.status(400).json({ error: 'Proyecto inválido' });
    }
  }
  db.prepare('UPDATE scripts SET project_id = ? WHERE id = ?').run(projectId, script.id);
  res.json({ ok: true });
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
  const obfuscator = OBFUSCATORS.includes(req.body?.obfuscator) ? req.body.obfuscator : 'next';
  res.json(analyzePerf(source, { obfuscator, vm: req.body?.clydeVm !== false }));
});

// Respuesta de error al guardar un script: mensajes claros según la causa, y un código de referencia
// para los casos desconocidos (así el log del servidor se puede encontrar).
function saveErrorResponse(res, err, label) {
  if (err?.status) return res.status(err.status).json({ error: err.message });
  const code = String(err?.code || '');
  const ref = crypto.randomBytes(3).toString('hex');
  console.error(`[${label}] ref ${ref} ${code}:`, err);
  if (code === 'SQLITE_FULL' || /database or disk is full/i.test(String(err?.message))) {
    return res.status(507).json({ error: 'El servidor se quedó sin espacio en disco. Avisa al dueño y vuelve a intentar después.' });
  }
  if (code === 'ERR_STRING_TOO_LONG' || err instanceof RangeError) {
    return res.status(413).json({ error: 'El script es demasiado grande para procesarlo. Prueba con un script más corto.' });
  }
  const causa = String(err?.message || '').slice(0, 200);
  return res.status(500).json({ error: `Error del servidor al guardar (ref ${ref}). Inténtalo de nuevo; si sigue, avisa con esa referencia.` + (causa ? ` Causa técnica: ${causa}` : '') });
}

app.post('/api/scripts', requireAuth, async (req, res) => {
  if (maintenanceBlock(req, res)) return;
  const input = validateScriptInput(req.body || {});
  if (input.error) return res.status(400).json({ error: input.error });
  // Un script siempre vive dentro de un proyecto (estilo Vantarmor): hay que crearlo primero
  const _pjId = Number(req.body?.projectId);
  if (!Number.isInteger(_pjId) || !db.prepare('SELECT 1 FROM projects WHERE id = ? AND user_id = ?').get(_pjId, req.userId)) {
    return res.status(400).json({ error: 'Elige un proyecto: crea uno primero si no tienes ninguno.' });
  }
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
    const remoteErr = validateRemoteBlocks(input.source).error || (hasStrayMarkers(input.source) ? 'Hay marcadores --@remote sueltos fuera de un bloque.' : null);
    if (remoteErr) return res.status(422).json({ error: remoteErr });
    const _wh = parseWebhookMarkers(input.source);
    if (_wh.error) return res.status(422).json({ error: _wh.error });
    const _init = typeof req.body?.initCode === 'string' && (req.method === 'POST' || req.body.initCode.trim() !== '') ? req.body.initCode : undefined;
    if (_init !== undefined && _init.length > 4000) return res.status(422).json({ error: 'El código pre-auth no puede pasar de 4000 caracteres.' });
    const code = stripWebhookMarkers(stripRemoteBlocks(input.source)); // lo que se compila y ofusca: sin los bloques secretos ni las URLs
    const srcErr = await checkLuauSyntax(code);
    if (srcErr) return res.status(422).json({ error: `Tu código no compila: ${srcErr}` });
    const guardSecret = crypto.randomBytes(16).toString('hex');
    const content = input.obfuscator === 'none' ? code : await obfuscate(code, input.obfuscator, { vm: input.clydeVm === 1, mode: input.obfMode, guard: scriptGuardValue(guardSecret) });
    const outErr = input.obfuscator === 'none' ? null : await checkLuauSyntax(content);
    if (outErr) return res.status(422).json({ error: `La versión ofuscada no compila. Avisa al equipo con este mensaje: ${outErr}` });
    const info = stmt.scriptInsert.run(
      req.userId, _pjId, input.name, uniqueSlug(input.name), input.isFfa ? 1 : 0,
      input.obfuscator, input.obfMode, guardSecret, input.source, content, input.hwidResetHours, input.shareDetection, input.clydeVm, input.autoRevokeDump, input.hwidLock, Math.floor(Date.now() / 1000), input.version || '',
    );
    db.prepare('UPDATE scripts SET loader_id = ? WHERE id = ?').run(crypto.randomBytes(20).toString('hex'), info.lastInsertRowid);
    db.prepare('UPDATE scripts SET perf_level = ? WHERE id = ?').run(analyzePerf(input.source, { obfuscator: input.obfuscator, vm: input.clydeVm === 1 }).level, info.lastInsertRowid);
    // Solo los scripts nuevos usan la entrega en dos pasos; los existentes quedan como estaban (secure_fetch = 0)
    db.prepare('UPDATE scripts SET secure_fetch = 1 WHERE id = ?').run(info.lastInsertRowid);
    saveScriptExtras(Number(info.lastInsertRowid), _wh.list, _init);
    if (!input.isFfa) stmt.obfIncrement.run(req.userId);
    if (input.obfuscator === 'luau') luauBumpStmt.run(req.userId, luauDay());
    db.prepare('UPDATE users SET scripts_period = COALESCE(scripts_period, 0) + 1 WHERE id = ?').run(req.userId);
    res.status(201).json({ ok: true, id: info.lastInsertRowid });
  } catch (err) {
    saveErrorResponse(res, err, 'Crear script');
  }
});

// Eliminar un script junto con sus keys y todo lo que el bot tiene ligado a él
app.delete('/api/scripts/:id', requireAuth, (req, res) => {
  const script = stmt.scriptOwned.get(req.params.id, req.userId);
  if (!script) return res.status(404).json({ error: 'Script no encontrado' });
  db.transaction(() => {
    db.prepare('DELETE FROM keys WHERE script_id = ?').run(script.id);
    for (const table of ['bot_panels', 'bot_access_rules', 'bot_blacklist', 'script_webhooks']) {
      db.prepare(`DELETE FROM ${table} WHERE script_id = ?`).run(script.id);
    }
    db.prepare('DELETE FROM scripts WHERE id = ? AND user_id = ?').run(script.id, req.userId);
    db.prepare('INSERT INTO deleted_scripts (script_id, user_id, slug, name, deleted_at) VALUES (?, ?, ?, ?, ?)').run(script.id, req.userId, script.slug, script.name, Math.floor(Date.now() / 1000));
  })();
  res.json({ ok: true });
});

app.put('/api/scripts/:id', requireAuth, async (req, res) => {
  const script = stmt.scriptOwned.get(Number(req.params.id), req.userId);
  if (!script) return res.status(404).json({ error: 'Script no encontrado' });

  const input = validateScriptInput(req.body || {}, script);
  if (input.error) return res.status(400).json({ error: input.error });
  if (!isPaidPlanId(req.userId) && input.hwidResetHours === 0) input.hwidResetHours = 24;
  const quotaMsg = quotaError(req.userId, { isNewScript: false, isFfa: input.isFfa });
  if (quotaMsg) return res.status(403).json({ error: quotaMsg });
  if (input.obfuscator === 'luau' && !input.isFfa && luauUsedToday(req.userId) >= LUAU_DAILY_LIMIT) {
    return res.status(403).json({ error: `Ya usaste tus ${LUAU_DAILY_LIMIT} compilaciones de hoy con el Ofuscador 3. Vuelve mañana.` });
  }

  try {
    const remoteErr = validateRemoteBlocks(input.source).error || (hasStrayMarkers(input.source) ? 'Hay marcadores --@remote sueltos fuera de un bloque.' : null);
    if (remoteErr) return res.status(422).json({ error: remoteErr });
    const _wh = parseWebhookMarkers(input.source);
    if (_wh.error) return res.status(422).json({ error: _wh.error });
    const _init = typeof req.body?.initCode === 'string' && (req.method === 'POST' || req.body.initCode.trim() !== '') ? req.body.initCode : undefined;
    if (_init !== undefined && _init.length > 4000) return res.status(422).json({ error: 'El código pre-auth no puede pasar de 4000 caracteres.' });
    const code = stripWebhookMarkers(stripRemoteBlocks(input.source)); // lo que se compila y ofusca: sin los bloques secretos ni las URLs
    const srcErr = await checkLuauSyntax(code);
    if (srcErr) return res.status(422).json({ error: `Tu código no compila: ${srcErr}` });
    const guardSecret = scriptGuardSecret(script);
    const content = input.obfuscator === 'none' ? code : await obfuscate(code, input.obfuscator, { vm: input.clydeVm === 1, mode: input.obfMode, guard: scriptGuardValue(guardSecret) });
    const outErr = input.obfuscator === 'none' ? null : await checkLuauSyntax(content);
    if (outErr) return res.status(422).json({ error: `La versión ofuscada no compila. Avisa al equipo con este mensaje: ${outErr}` });
    stmt.scriptUpdate.run(
      input.name, input.isFfa ? 1 : 0, input.obfuscator, input.obfMode, guardSecret, input.source, content, input.hwidResetHours, input.shareDetection, input.clydeVm, input.autoRevokeDump, input.hwidLock, Math.floor(Date.now() / 1000), input.version ? input.version : null,
      script.id, req.userId,
    );
    db.prepare('UPDATE scripts SET perf_level = ? WHERE id = ?').run(analyzePerf(input.source, { obfuscator: input.obfuscator, vm: input.clydeVm === 1 }).level, script.id);
    if (!input.isFfa) stmt.obfIncrement.run(req.userId);
    if (input.obfuscator === 'luau' && !input.isFfa) luauBumpStmt.run(req.userId, luauDay());
    saveScriptExtras(script.id, _wh.list, _init);
    res.json({ ok: true });
  } catch (err) {
    saveErrorResponse(res, err, 'Editar script');
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
import { startDiscordAiBot } from './lib/discord-ai-bot.js';
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

// Código protegido (lo que sirve el loader). Solo lo ve el dueño del script.
app.get('/api/scripts/:id/protected', requireAuth, (req, res) => {
  const script = stmt.scriptOwned.get(Number(req.params.id), req.userId);
  if (!script) return res.status(404).json({ error: 'Script no encontrado' });
  // Ofuscador 3 en pausa: la vista previa muestra lo mismo que sirve el loader (copia propia)
  let shown = script.content || '';
  if (script.obfuscator === 'luau') {
    const pl = script.source ? stripWebhookMarkers(stripRemoteBlocks(script.source)) : '';
    shown = protectedBase(script, pl) || '';
  }
  res.json({ name: script.name, obfuscator: script.obfuscator, content: shown });
});
// Borrar keys propias (una o varias, máximo 100 por petición)
const ownedKeyStmt = db.prepare('SELECT k.key FROM keys k LEFT JOIN scripts s ON s.id = k.script_id LEFT JOIN projects p ON p.id = k.project_id WHERE k.key = ? AND (s.user_id = ? OR p.user_id = ?)');
const deleteKeyStmt = db.prepare('DELETE FROM keys WHERE key = ?');
app.post('/api/keys/delete', requireAuth, (req, res) => {
  const list = Array.isArray(req.body?.keys) ? req.body.keys.map(String).slice(0, 100) : [];
  if (!list.length) return res.status(400).json({ error: 'No hay keys para borrar' });
  let deleted = 0;
  db.transaction(() => {
    for (const k of list) {
      if (ownedKeyStmt.get(k, req.userId, req.userId)) { deleteKeyStmt.run(k); deleted++; }
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
  const rows = stmt.keysByUser.all(req.userId, req.userId);
  for (const r of rows) { try { r.wm = keyWatermark(r.script_id, r.key); } catch (e) {} }
  res.json(rows);
});

// ---------- Baneos del creador ----------
// Se puede banear por HWID, IP o usuario de Discord (solo en ese script)
const ownedKey = db.prepare('SELECT k.* FROM keys k LEFT JOIN scripts s ON s.id = k.script_id LEFT JOIN projects p ON p.id = k.project_id WHERE k.key = ? AND (s.user_id = ? OR p.user_id = ?)');
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
    const k = ownedKey.get(req.params.key, req.userId, req.userId);
    if (!k) return res.status(404).json({ error: 'Key no encontrada' });
    const kind = String(req.body?.kind || '');
    if (!['hwid', 'ip', 'user'].includes(kind)) return res.status(400).json({ error: 'Tipo de baneo inválido' });
    const reason = String(req.body?.reason || 'Baneado por el creador').slice(0, 200);
    const out = applyBan(k, kind, reason, req.userId, on);
    if (out.error) return res.status(out.status).json({ error: out.error });
    if (on) fireWebhooks(ownerOfKey(k.key), 'key.banned', { key: k.key, scriptId: k.script_id, projectId: k.project_id ?? null, kind, reason });
    res.json({ ok: true });
  };
}
// Reinicio de HWID (equivale a /resethwid de la referencia): limite por key y espera por script
function resetKeyHwid(k, script, { force = false } = {}) {
  const nowS = Math.floor(Date.now() / 1000);
  const hours = Number(script?.hwid_reset_hours ?? 24) || 0;   // 0 = sin espera
  const limit = Number(script?.hwid_reset_limit ?? 3) || 0;    // 0 = sin limite
  if (!force && limit > 0 && (k.hwid_resets || 0) >= limit) {
    return { error: `Esta key ya usó sus ${limit} reinicios de HWID. Súbelo en los ajustes del script o usa "forzar".`, status: 403 };
  }
  if (!force && hours > 0 && k.hwid_reset_at && nowS - k.hwid_reset_at < hours * 3600) {
    const mins = Math.max(1, Math.ceil((hours * 3600 - (nowS - k.hwid_reset_at)) / 60));
    return { error: `Todavía no: esta key puede reiniciar su HWID en ${mins} min.`, status: 429 };
  }
  db.prepare(`UPDATE keys SET hwid = NULL, last_hwid = COALESCE(hwid, last_hwid), pending_hwid = NULL,
    hwid_reset_at = ?, hwid_resets = COALESCE(hwid_resets, 0) + 1 WHERE key = ?`).run(nowS, k.key);
  return { ok: true, resets: (k.hwid_resets || 0) + 1 };
}
app.post('/api/keys/:key/reset-hwid', requireAuth, (req, res) => {
  if (maintenanceBlock(req, res)) return;
  const k = ownedKey.get(req.params.key, req.userId, req.userId);
  if (!k) return res.status(404).json({ error: 'Key no encontrada' });
  let script;
  if (k.project_id != null) {
    const p = projectOfKey.get(k.project_id);
    if (p && p.allow_hwid_reset === 0) return res.status(403).json({ error: 'Este proyecto tiene el reinicio de HWID desactivado' });
    script = { hwid_reset_hours: p && p.hwid_reset_cooldown_days ? p.hwid_reset_cooldown_days * 24 : 24, hwid_reset_limit: null };
  } else {
    script = db.prepare('SELECT hwid_reset_hours, hwid_reset_limit FROM scripts WHERE id = ?').get(k.script_id);
  }
  const out = resetKeyHwid(k, script, { force: req.body?.force === true });
  if (out.error) return res.status(out.status).json({ error: out.error });
  fireWebhooks(ownerOfKey(k.key), 'key.hwid_reset', { key: k.key, scriptId: k.script_id, projectId: k.project_id ?? null, resets: out.resets });
  res.json({ ok: true, resets: out.resets });
});
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
// Webhooks del proyecto (estilo Vantarmor): 'logs' recibe ejecuciones correctas, 'alert' intentos de crack y baneos
function fireProjectWebhook(projectId, kind, data) {
  if (projectId == null) return;
  try {
    const p = projectOfKey.get(projectId);
    if (!p) return;
    const url = String((kind === 'logs' ? p.logs_webhook : p.alert_webhook) || '').trim();
    if (!/^https:\/\/(canary\.|ptb\.)?discord(app)?\.com\/api\/webhooks\//.test(url)) return;
    const fields = Object.entries(data || {}).map(([name, value]) => ({ name, value: String(value).slice(0, 1000) || 'sin dato' }));
    const embed = { title: 'VantArmor', color: kind === 'logs' ? 0x22c55e : 0xef4444, fields, timestamp: new Date().toISOString() };
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'VantArmor', embeds: [embed] }) }).catch(() => {});
  } catch { /* nunca rompe la accion principal */ }
}
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
  // Las keys se crean para un script o para un proyecto (key de proyecto: sirve en todos sus scripts)
  const rawScript = req.body?.scriptId;
  const rawProject = req.body?.projectId;
  const scriptId = (rawScript === undefined || rawScript === null || rawScript === '') ? null : Number(rawScript);
  const projectId = (rawProject === undefined || rawProject === null || rawProject === '') ? null : Number(rawProject);
  const amount = req.body?.amount === undefined ? 1 : Number(req.body.amount);
  const days = req.body?.days === undefined || req.body.days === null ? null : Number(req.body.days);
  // Duración exacta en segundos (de 1 hora a 10 años). Si viene, tiene prioridad sobre days.
  const seconds = req.body?.seconds === undefined || req.body.seconds === null ? null : Number(req.body.seconds);

  if ((scriptId === null) === (projectId === null)) return res.status(400).json({ error: 'Indica un script o un proyecto (no ambos)' });
  if (scriptId !== null && !Number.isInteger(scriptId)) return res.status(400).json({ error: 'scriptId inválido' });
  if (projectId !== null && !Number.isInteger(projectId)) return res.status(400).json({ error: 'projectId inválido' });
  if (!Number.isInteger(amount) || amount < 1 || amount > 50) return res.status(400).json({ error: 'La cantidad debe estar entre 1 y 50' });
  if (days !== null && (!Number.isInteger(days) || days < 1 || days > 3650)) return res.status(400).json({ error: 'Días inválidos' });
  if (seconds !== null && (!Number.isInteger(seconds) || seconds < 3600 || seconds > 3650 * 86400)) {
    return res.status(400).json({ error: 'La duración debe estar entre 1 hora y 10 años' });
  }

  let target = null;
  if (scriptId !== null) {
    const script = stmt.scriptOwned.get(scriptId, req.userId);
    if (!script) return res.status(403).json({ error: 'No autorizado' });
    target = { scriptId: script.id, projectId: null };
  } else {
    const project = db.prepare('SELECT id FROM projects WHERE id = ? AND user_id = ?').get(projectId, req.userId);
    if (!project) return res.status(403).json({ error: 'No autorizado' });
    target = { scriptId: null, projectId: project.id };
  }

  // startOnUse (equivalente a key_days de la referencia): key en stock, el reloj arranca en la primera ejecucion
  const startOnUse = req.body?.startOnUse === true && !!(seconds || days);
  const keyDays = startOnUse ? Math.max(1, Math.round((seconds || days * 86400) / 86400)) : null;
  const expiresAt = startOnUse ? null : seconds ? Math.floor(Date.now() / 1000) + seconds : days ? Math.floor(Date.now() / 1000) + days * 86400 : null;

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
        stmt.keyInsert.run(k, target.scriptId, expiresAt, keyDays, target.projectId);
        list.push(k);
      }
      return list;
    })();
    fireWebhooks(req.userId, 'key.created', { scriptId: target.scriptId, projectId: target.projectId, count: generated.length, keys: generated });
    res.json({ keys: generated });
  } catch (err) {
    console.error('Create keys error:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ==========================================
// 6b. RECOMPENSAS (codigos que canjean keys, estilo Vantarmor: rewards -> keydrop)
// ==========================================
db.exec(`CREATE TABLE IF NOT EXISTS rewards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  script_id INTEGER NOT NULL,
  key_days INTEGER NOT NULL DEFAULT 30,
  max_uses INTEGER NOT NULL DEFAULT 1,
  uses INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER,
  created_at INTEGER
)`);

const rewardByCode = db.prepare('SELECT * FROM rewards WHERE code = ?');
const rewardInsert = db.prepare('INSERT INTO rewards (code, script_id, key_days, max_uses, uses, created_by, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)');
const rewardInc = db.prepare('UPDATE rewards SET uses = uses + 1 WHERE id = ?');
const rewardDelete = db.prepare('DELETE FROM rewards WHERE id = ?');
const rewardsAll = db.prepare('SELECT r.*, s.name AS script_name FROM rewards r LEFT JOIN scripts s ON s.id = r.script_id ORDER BY r.id DESC');
const normRewardCode = v => String(v || '').trim().toUpperCase().slice(0, 40);

app.get('/api/rewards', requireAuth, (req, res) => {
  if (!isOwnerId(req.userId)) return res.status(403).json({ error: 'No autorizado' });
  res.json({ rewards: rewardsAll.all() });
});

app.post('/api/rewards', requireAuth, (req, res) => {
  if (!isOwnerId(req.userId)) return res.status(403).json({ error: 'No autorizado' });
  const code = normRewardCode(req.body?.code);
  const scriptId = Number(req.body?.scriptId);
  const keyDays = req.body?.keyDays === undefined ? 30 : Number(req.body.keyDays);
  const maxUses = req.body?.maxUses === undefined ? 1 : Number(req.body.maxUses);
  if (!/^[A-Z0-9_-]{4,40}$/.test(code)) return res.status(400).json({ error: 'Código inválido (4-40 caracteres, letras y números)' });
  if (!Number.isInteger(scriptId)) return res.status(400).json({ error: 'scriptId inválido' });
  if (!db.prepare('SELECT id FROM scripts WHERE id = ?').get(scriptId)) return res.status(400).json({ error: 'Script no encontrado' });
  if (!Number.isInteger(keyDays) || keyDays < 1 || keyDays > 3650) return res.status(400).json({ error: 'Días inválidos (1-3650)' });
  if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 10000) return res.status(400).json({ error: 'Usos inválidos (1-10000)' });
  try {
    rewardInsert.run(code, scriptId, keyDays, maxUses, req.userId, Math.floor(Date.now() / 1000));
    res.json({ ok: true });
  } catch (err) {
    if (String(err.message || '').includes('UNIQUE')) return res.status(409).json({ error: 'Ese código ya existe' });
    console.error('Create reward error:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.delete('/api/rewards/:id', requireAuth, (req, res) => {
  if (!isOwnerId(req.userId)) return res.status(403).json({ error: 'No autorizado' });
  rewardDelete.run(Number(req.params.id) || 0);
  res.json({ ok: true });
});

// Canje: el codigo regala una key del script elegido (key en stock, el reloj arranca en la primera ejecucion)
app.post('/api/rewards/redeem', requireAuth, (req, res) => {
  const code = normRewardCode(req.body?.code);
  if (!code) return res.status(400).json({ error: 'Escribe un código' });
  const r = rewardByCode.get(code);
  if (!r) return res.status(404).json({ error: 'Código no válido' });
  if (r.uses >= r.max_uses) return res.status(410).json({ error: 'Este código ya se agotó' });
  const script = db.prepare('SELECT id, user_id FROM scripts WHERE id = ?').get(r.script_id);
  if (!script) return res.status(410).json({ error: 'El script de esta recompensa ya no existe' });
  let k;
  try {
    k = db.transaction(() => {
      let key;
      do { key = Array.from(crypto.randomBytes(32), b => KEY_ALPHABET[b % KEY_ALPHABET.length]).join(''); }
      while (db.prepare('SELECT 1 FROM keys WHERE key = ?').get(key));
      stmt.keyInsert.run(key, script.id, null, r.key_days, null);
      rewardInc.run(r.id);
      return key;
    })();
  } catch (err) {
    console.error('Redeem reward error:', err);
    return res.status(500).json({ error: 'Error del servidor' });
  }
  fireWebhooks(script.user_id, 'key.created', { scriptId: script.id, count: 1, keys: [k] });
  res.json({ key: k, scriptId: script.id, keyDays: r.key_days });
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
    obfuscate: (source, obf, opts) => obfuscate(source, obf, opts), // /hostproyect usa el mismo obfuscador que la web
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
    // La caché de compilaciones es solo una optimización: se borra a los 1 día para no llenar el volumen
    db.prepare('DELETE FROM obf_cache WHERE created_at < ?').run(Math.floor(Date.now() / 1000) - 86400);
    db.prepare('DELETE FROM dump_events WHERE created_at < ?').run(Math.floor(Date.now() / 1000) - 30 * 86400);
    // Chat de la comunidad: 3 días, igual que dice la política de privacidad (antes no se borraba nunca)
    const chatCut = t - CHAT_KEEP_SECONDS;
    db.prepare('DELETE FROM web_chat_reactions WHERE message_id IN (SELECT id FROM web_chat WHERE created_at < ?)').run(chatCut);
    db.prepare('DELETE FROM web_chat_reports WHERE message_id IN (SELECT id FROM web_chat WHERE created_at < ?)').run(chatCut);
    const chat = db.prepare('DELETE FROM web_chat WHERE created_at < ?').run(chatCut).changes;
    if (chat) console.log(`[Limpieza] ${chat} mensajes del chat borrados (más de 3 días).`);
    if (logs) console.log(`[Limpieza] ${logs} logs de scripts borrados (más de 1 día).`);
    // Devuelve al volumen las páginas libres que dejaron los DELETE (solo si la base está en modo incremental)
    if (process.env.DB_ENGINE !== 'postgres' && db.pragma('auto_vacuum', { simple: true }) === 2) {
      db.prepare('PRAGMA incremental_vacuum').all();
    }
  } catch (err) { console.error('[Limpieza] Error:', err.message); }
}
const CHAT_KEEP_SECONDS = 3 * 86400;
pruneOldData();
setInterval(pruneOldData, 60 * 60_000).unref();

// Ya no se guardan respaldos automáticos en el volumen (ocupaban varias veces el tamaño de la base).
// El dueño sigue pudiendo descargar una copia al momento desde su panel (/api/owner/backup).
// Al arrancar se borran las copias viejas que hubiera en la carpeta.
const BACKUP_DIR = path.join(path.dirname(DATABASE_PATH), 'backups');
try {
  if (fs.existsSync(BACKUP_DIR)) {
    fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
    console.log('[Respaldo] Copias automáticas antiguas borradas del volumen.');
  }
} catch (err) { console.error('[Respaldo] No se pudo borrar la carpeta de respaldos:', err.message); }

// Errores que no pasan por una ruta: respuesta JSON clara (en vez de HTML o "Error del servidor" sin detalle)
// 404 final sin HTML por defecto: loaders con protocolo !VANTARMOR, API con JSON, web con su página
app.use((req, res) => {
  if (LOADER_PATH_RE.test(req.path) || req.path.startsWith('/v1/')) return res.status(404).type('text/plain').send('!VANTARMOR:FORBIDDEN');
  if (req.path.startsWith('/api/')) return res.status(404).json({ status: 'error', code: 404, message: 'Not found' });
  return res.status(404).sendFile(path.join(__dirname, '..', 'frontend', 'errores.html'));
});

app.use((err, req, res, next) => {
  if (LOADER_PATH_RE.test(req.path) || req.path.startsWith('/v1/')) {
    return res.status(err?.type === 'entity.too.large' ? 413 : 500).type('text/plain').send('!VANTARMOR:SERVER_ERROR');
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'El script es demasiado grande. El límite es de 2 MB de código.' });
  }
  if (res.headersSent) return next(err);
  console.error('Error no controlado:', err);
  res.status(err?.status && err.expose ? err.status : 500).json({
    error: err?.status && err.expose ? err.message : 'Error del servidor. Inténtalo de nuevo.',
  });
});

try {
  db.prepare('INSERT INTO app_deploys (deployment_id, commit_sha, started_at) VALUES (?, ?, ?)')
    .run(process.env.RAILWAY_DEPLOYMENT_ID || null, process.env.RAILWAY_GIT_COMMIT_SHA || null, BOOT_AT);
} catch (err) { console.error('[Deploys] No se pudo registrar el arranque:', err.message); }

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Servidor Vantarmor corriendo en el puerto ${PORT}`);
  startDiscordAiBot(db);
});
