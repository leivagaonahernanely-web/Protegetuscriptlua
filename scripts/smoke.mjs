#!/usr/bin/env node
// Verificación rápida después de cada deploy.
//   node scripts/smoke.mjs https://vantarmor.up.railway.app
// Opcional, para probar el loader con un script real (no se imprime la key):
//   SMOKE_SLUG=<slug> SMOKE_KEY=<key> node scripts/smoke.mjs https://vantarmor.up.railway.app
// Sin dependencias: usa fetch de Node 18+.

const base = (process.argv[2] || process.env.SMOKE_URL || '').replace(/\/+$/, '');
if (!base) {
  console.error('Uso: node scripts/smoke.mjs <url-del-sitio>');
  process.exit(2);
}

let failed = 0;
const pass = (name, detail = '') => console.log(`  OK    ${name}${detail ? ` — ${detail}` : ''}`);
const fail = (name, detail = '') => { failed++; console.log(`  FALLO ${name}${detail ? ` — ${detail}` : ''}`); };

async function get(path, opts = {}) {
  const res = await fetch(base + path, { redirect: 'manual', signal: AbortSignal.timeout(15000), ...opts });
  return { status: res.status, type: res.headers.get('content-type') || '', text: await res.text() };
}

console.log(`Verificando ${base}\n`);

// 1. Versión: confirma qué commit y qué motor están corriendo
try {
  const r = await get('/api/version');
  const j = r.status === 200 ? JSON.parse(r.text) : null;
  if (!j) fail('/api/version', `HTTP ${r.status}`);
  else {
    pass('/api/version', `commit ${j.commit}, motor ${j.engine}, arrancó ${j.startedAt}`);
    if (j.commit === 'desconocido') console.log('        aviso: Railway no está entregando el commit (¿servicio sin conectar a GitHub?)');
  }
} catch (e) { fail('/api/version', e.message); }

// 2. Estado público
try {
  const r = await get('/api/status');
  if (r.status === 200 && r.type.includes('json')) pass('/api/status', 'responde JSON');
  else fail('/api/status', `HTTP ${r.status} ${r.type}`);
} catch (e) { fail('/api/status', e.message); }

// 3. Loader con un slug que no existe: debe responder SCRIPT_NOT_FOUND como texto plano
try {
  const r = await get('/scripts/hosted/no-existe-smoke-test/auth', { headers: { accept: 'text/plain' } });
  if (r.text.startsWith('!VANTARMOR:SCRIPT_NOT_FOUND')) pass('loader: slug inexistente', r.text.trim());
  else fail('loader: slug inexistente', `HTTP ${r.status}: ${r.text.slice(0, 80)}`);
} catch (e) { fail('loader: slug inexistente', e.message); }

// 4. Un navegador no debe recibir código del loader
try {
  const r = await get('/scripts/hosted/no-existe-smoke-test/auth', { headers: { accept: 'text/html' } });
  if (r.status === 403) pass('loader: bloquea navegadores');
  else fail('loader: bloquea navegadores', `HTTP ${r.status}`);
} catch (e) { fail('loader: bloquea navegadores', e.message); }

// 5. Opcional: un script real con una key real debe devolver el código
const slug = process.env.SMOKE_SLUG;
const key = process.env.SMOKE_KEY;
if (slug && key) {
  try {
    const q = new URLSearchParams({ key, hwid: 'smoke-test-hwid-0001' });
    const r = await get(`/scripts/hosted/${encodeURIComponent(slug)}/auth?${q}`, { headers: { accept: 'text/plain' } });
    if (r.text.startsWith('!VANTARMOR:CODE\n')) pass('loader: script real con key', `${r.text.length} caracteres`);
    else fail('loader: script real con key', `respondió ${r.text.split('\n')[0].slice(0, 60)}`);
  } catch (e) { fail('loader: script real con key', e.message); }
} else {
  console.log('  (omitido) loader con script real: define SMOKE_SLUG y SMOKE_KEY para probarlo');
}

console.log(failed ? `\n${failed} prueba(s) fallaron.` : '\nTodo respondió bien.');
process.exit(failed ? 1 : 0);
