import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json());
app.use(cookieParser());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'https://protegetuscriptlua-production-41e3.up.railway.app',
  credentials: true,
}));

const {
  PORT = 3000,
  DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET,
  DISCORD_REDIRECT_URI,
  JWT_SECRET,
  DATABASE_PATH = 'vantarmor.db',
} = process.env;

// ==========================================
// 1. CONFIGURACIÓN DE LA BASE DE DATOS
// ==========================================
// Crear la carpeta /data si no existe (para evitar el crash en Railway)
if (DATABASE_PATH.startsWith('/')) {
  const dir = path.dirname(DATABASE_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
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
    slug TEXT, 
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

// ==========================================
// 2. SERVIR EL FRONTEND (CARPETA 'frotend')
// ==========================================
// Sirve los archivos estáticos desde la carpeta 'frotend'
app.use(express.static(path.join(__dirname, 'frotend')));

// Rutas explícitas por si acaso
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'frotend', 'index.html'));
});

app.get('/login.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'frotend', 'login.html'));
});

app.get('/dashboard.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'frotend', 'dashboard.html'));
});

// ==========================================
// 3. AUTENTICACIÓN CON DISCORD
// ==========================================
app.get('/auth/discord', (req, res) => {
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope: 'identify email',
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

app.get('/auth/discord/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.redirect('/login.html?error=no_code');

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
    if (!tokenData.access_token) {
      console.error('Token error:', tokenData);
      return res.redirect('/login.html?error=token_failed');
    }

    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const dUser = await userRes.json();

    // Guardar/Actualizar en base de datos
    db.prepare('INSERT OR REPLACE INTO users (id, username, avatar) VALUES (?,?,?)')
      .run(dUser.id, dUser.username, dUser.avatar);

    // Crear JWT de sesión
    const session = jwt.sign({ id: dUser.id, username: dUser.username }, JWT_SECRET, { expiresIn: '7d' });
    
    // Guardar cookie (secure: true es vital en Railway)
    res.cookie('vantarmor_session', session, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.redirect('/dashboard.html');
  } catch (err) {
    console.error('OAuth error:', err);
    res.redirect('/login.html?error=server');
  }
});

// ==========================================
// 4. API Y LOGOUT
// ==========================================
app.get('/api/me', (req, res) => {
  const token = req.cookies.vantarmor_session;
  if (!token) return res.status(401).json({ error: 'No auth' });
  
  try {
    const data = jwt.verify(token, JWT_SECRET);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(data.id);
    res.json(user);
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
});

app.get('/auth/logout', (req, res) => {
  res.clearCookie('vantarmor_session');
  res.redirect('/login.html');
});

// ==========================================
// 5. ARRANCAR SERVIDOR
// ==========================================
const serverPort = process.env.PORT || 3000;
app.listen(serverPort, '0.0.0.0', () => {
  console.log(`✅ Servidor Vantarmor corriendo en el puerto ${serverPort}`);
});
