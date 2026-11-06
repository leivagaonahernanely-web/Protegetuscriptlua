#!/usr/bin/env node
// Verificación rápida después de cada deploy. Sin dependencias (Node 18+).
//   node scripts/smoke.mjs https://vantarmor.up.railway.app
// Opcional:
//   SMOKE_EXPECT_COMMIT=<hash>   commit que debería estar corriendo (7 caracteres bastan)
//   SMOKE_ADMIN_URL=<url>        URL del servicio admin, para comprobar que tiene la versión nueva
//   SMOKE_SLUG=<slug> SMOKE_KEY=<key>   prueba el loader con un script real (la key no se imprime)

const base = (process.argv[2] || process.env.SMOKE_URL || '').replace(/\/+$/, '');
if (!base) {
  console.error('Uso: node scripts/smoke.mjs <url-del-sitio>');
  process.exit(2);
}
const adminBase = (process.env.SMOKE_ADMIN_URL || '').replace(/\/+$/, '');
const expectCommit = (process.env.SMOKE_EXPECT_COMMIT || '').trim().toLowerCase();

let failed = 0;
const pass = (name, detail = '') => console.log(`  OK     ${name}${detail ? ` — ${detail}` : ''}`);
const fail = (name, detail = '', hint = '') => {
  failed++;
  console.log(`  FALLO  ${name}${detail ? ` — ${detail}` : ''}`);
  if (hint) console.log(`         → ${hint}`);
};
const warn = (name, detail = '') => console.log(`  AVISO  ${name}${detail ? ` — ${detail}` : ''}`);

async function get(url, opts = {}) {
  const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15000), ...opts });
  return { status: res.status, type: res.headers.get('content-type') || '', text: await res.text() };
}

console.log(`Verificando ${base}\n`);

// 1. Versión del backend: ¿existe la ruta nueva y qué commit corre?
let backendHasVersion = false;
try {
  const r = await get(`${base}/api/version`);
  if (r.status === 200) {
    const j = JSON.parse(r.text);
    backendHasVersion = true;
    pass('backend /api/version', `commit ${j.commit}, motor ${String(j.engine).slice(0, 8)}, arrancó ${j.startedAt}`);
    if (j.commit === 'desconocido') {
      warn('commit', 'Railway no entrega el hash: revisa que el servicio backend esté conectado a GitHub');
    } else if (expectCommit && !j.commit.toLowerCase().startsWith(expectCommit.slice(0, 7))) {
      fail('commit esperado', `corre ${j.commit}, se esperaba ${expectCommit.slice(0, 7)}`,
        'El deploy no tomó el último commit: en Deployments usa "Deploy" del último commit, no "Redeploy"');
    } else if (expectCommit) {
      pass('commit esperado', `coincide con ${expectCommit.slice(0, 7)}`);
    }
  } else {
    fail('backend /api/version', `HTTP ${r.status}`,
      'El backend tiene código viejo (esta ruta no existe): haz Deploy del último commit del servicio backend');
  }
} catch (e) { fail('backend /api/version', e.message, 'El sitio no responde: revisa que el servicio backend esté Active'); }

// 2. Estado público
try {
  const r = await get(`${base}/api/status`);
  if (r.status === 200 && r.type.includes('json')) pass('backend /api/status', 'responde JSON');
  else fail('backend /api/status', `HTTP ${r.status} ${r.type}`, 'Revisa los Deploy Logs del backend');
} catch (e) { fail('backend /api/status', e.message); }

// 3. Loader con slug inexistente: debe responder SCRIPT_NOT_FOUND (texto plano)
try {
  const r = await get(`${base}/scripts/hosted/no-existe-smoke-test/auth`, { headers: { accept: 'text/plain' } });
  if (r.text.startsWith('!VANTARMOR:SCRIPT_NOT_FOUND')) pass('loader: slug inexistente', r.text.trim());
  else fail('loader: slug inexistente', `HTTP ${r.status}: ${r.text.slice(0, 80)}`,
    backendHasVersion ? 'El loader no responde como se espera: revisa los cambios recientes de auth' : 'Backend viejo: haz Deploy del último commit');
} catch (e) { fail('loader: slug inexistente', e.message); }

// 4. Un navegador no debe recibir código del loader
try {
  const r = await get(`${base}/scripts/hosted/no-existe-smoke-test/auth`, { headers: { accept: 'text/html' } });
  if (r.status === 403) pass('loader: bloquea navegadores');
  else fail('loader: bloquea navegadores', `HTTP ${r.status}`, 'Un navegador podría recibir código del loader');
} catch (e) { fail('loader: bloquea navegadores', e.message); }

// 5. Admin: la ruta /admin/version debe existir (401/403 sin sesión = existe; 404 = código viejo)
if (adminBase) {
  try {
    const r = await get(`${adminBase}/admin/version`);
    if (r.status === 401 || r.status === 403) pass('admin /admin/version', `existe (HTTP ${r.status} sin sesión)`);
    else if (r.status === 404) fail('admin /admin/version', 'HTTP 404',
      'El servicio admin tiene código viejo: haz Deploy del último commit del servicio admin');
    else warn('admin /admin/version', `HTTP ${r.status}`);
  } catch (e) { fail('admin /admin/version', e.message, 'El admin no responde: revisa que el servicio admin esté Active'); }
} else {
  console.log('  (omitido) admin: define SMOKE_ADMIN_URL para comprobarlo');
}

// 6. Opcional: script real con key real
const slug = process.env.SMOKE_SLUG;
const key = process.env.SMOKE_KEY;
if (slug && key) {
  try {
    const q = new URLSearchParams({ key, hwid: 'smoke-test-hwid-0001' });
    const r = await get(`${base}/scripts/hosted/${encodeURIComponent(slug)}/auth?${q}`, { headers: { accept: 'text/plain' } });
    if (r.text.startsWith('!VANTARMOR:CODE\n')) pass('loader: script real con key', `${r.text.length} caracteres`);
    else fail('loader: script real con key', `respondió ${r.text.split('\n')[0].slice(0, 60)}`,
      'Revisa la key y el script; si el código es correcto, mira el log del backend');
  } catch (e) { fail('loader: script real con key', e.message); }
} else {
  console.log('  (omitido) loader con script real: define SMOKE_SLUG y SMOKE_KEY para probarlo');
}

console.log(failed ? `\n${failed} prueba(s) fallaron.` : '\nTodo respondió bien.');
process.exit(failed ? 1 : 0);
