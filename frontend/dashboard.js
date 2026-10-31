(() => {
  'use strict';

  // ---------- CONFIG ----------
  const PLAN_LIMITS = {
    free:    { scripts: 5,        keys: 100, obf: 5 },
    premium: { scripts: 10,       keys: Infinity, obf: 30 },
    plus:    { scripts: Infinity, keys: Infinity, obf: Infinity },
  };
  const PLAN_LABELS = { free: 'Free', premium: 'Premium', plus: 'Premium Plus' };
  const OBFUSCATORS = {
    real:       'Ofuscador 1 · recomendado',
    obscura:    'Ofuscador 2',
    luau:       'Ofuscador 3 · Premium Plus · 2 compilaciones por día',
    none:       'Sin ofuscar (solo key)',
  };
  const NAV = {
    dashboard: { title: 'Dashboard', sub: 'Resumen de tu cuenta' },
    profile:   { title: 'Perfil', sub: 'Foto de perfil y foto del bot en tu servidor' },
    precios:   { title: 'Precios', sub: 'Publica tu tabla de precios en tu servidor (solo planes pagos)' },
    bienvenida: { title: 'Bienvenida', sub: 'Mensaje para nuevos miembros de tu servidor (solo Premium Plus)' },
    scripts:   { title: 'Scripts',   sub: 'Código, protección y loader de cada script' },
    keys:      { title: 'Keys',      sub: 'Licencias generadas' },
    blacklist: { title: 'Blacklist', sub: 'Bloquea usuarios de Discord, IPs o HWID en tus scripts' },
    chat:      { title: 'Chat',      sub: 'Chat de la comunidad de Vantarmor' },
    plans:     { title: 'Planes',    sub: 'Elige el plan que necesitas' },
    soporte:   { title: 'Soporte',   sub: 'Preguntas frecuentes y tus tickets' },
    stats: { title: 'Estadísticas', sub: 'Ejecuciones de tus scripts y de dónde vienen' },
    ownerpanel: { title: 'Panel del dueño', sub: 'Ofuscador 3, ventas, mantenimiento y registro (solo dueño)' },
    planskeys: { title: 'Plans keys', sub: 'Keys de Premium y Premium Plus (solo dueño)' },
    publisher: { title: 'Publisher',  sub: 'Scripts subidos en formato source (solo dueño)' },
    users:     { title: 'Usuarios',   sub: 'Plan y uso de cada usuario (solo dueño)' },
    auth:      { title: 'Sesión',    sub: 'Problema al verificar tu cuenta' },
  };
  const SOON_MS = 7 * 24 * 3600 * 1000;
  // Cada cuánto puede reiniciar el HWID un comprador (horas; 0 = desactivado)
  const HWID_OPTIONS = [[24, 'Cada 24 h (recomendado)'], [0, 'Desactivado'], [6, 'Cada 6 h'], [12, 'Cada 12 h'], [48, 'Cada 48 h'], [72, 'Cada 72 h'], [168, 'Cada semana']];
  const MAX_CODE_BYTES = 2 * 1024 * 1024;
  const AUTH_LOOP_KEY = 'vp_auth_redirects';
  const ICON_COPY = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

  // ---------- STATE ----------
  let user = null;
  let scripts = [];
  let keys = [];
  let scriptsError = false;
  let scriptsLoaded = false;
  let keysLoaded = false;
  let keysError = false;
  const selected = new Set();

  // ---------- HELPERS ----------
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
  const isMobile = () => window.matchMedia('(max-width: 1023px)').matches;
  const scriptName = id => scripts.find(s => s.id === id)?.name || 'Desconocido';
  const maskKey = key => key.length > 16 ? `${key.slice(0, 12)}…${key.slice(-4)}` : key;
  const fmtDate = ts => ts
    ? new Date(ts * 1000).toLocaleDateString('es-EC', { day: '2-digit', month: 'short', year: 'numeric' })
    : 'Nunca';
  const loaderFor = s => (protectionOf(s) === 'ffa' ? '' : 'script_key = "KEY"; ')
    + `loadstring(game:HttpGet("${location.origin}${s.loader_id ? `/files/v1/loaders/${s.loader_id}.lua` : `/scripts/hosted/${s.slug}`}"))()`;
  const byteLen = s => new TextEncoder().encode(s).length;
  const fmtKB = b => (b / 1024).toFixed(1) + ' KB';
  const csvCell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;

  function planKey(p) {
    const v = String(p || 'free').toLowerCase();
    if (v.includes('plus')) return 'plus';
    if (v.includes('premium')) return 'premium';
    return 'free';
  }

  function keyStatus(k) {
    if (k.banned) return { id: 'banned', label: 'Baneada', cls: 'bad' };
    if (k.expires_at && k.expires_at * 1000 < Date.now()) return { id: 'expired', label: 'Expirada', cls: 'warn' };
    return { id: 'active', label: 'Activa', cls: 'ok' };
  }

  // Protección del script: 'ffa' (sin key) o 'protected' (con key y ofuscador)
  const protectionOf = s => (s.ffa ? 'ffa' : 'protected');
  // Scripts viejos con Clyde se muestran como Ofuscador 1 al editarlos: al guardar se regeneran con ese
  const obfuscatorOf = s => (OBFUSCATORS[s.obfuscator] ? s.obfuscator : 'real');

  async function api(path, opts = {}) {
    const headers = opts.body ? { 'Content-Type': 'application/json' } : {};
    const res = await fetch(path, { credentials: 'include', ...opts, headers });
    let data = null;
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) {
      const err = new Error((data && data.error) || `Error ${res.status}`);
      err.status = res.status;
      err.code = data && data.code;
      err.invite = data && data.invite;
      throw err;
    }
    return data;
  }

  function toast(msg, type = 'ok') {
    const t = document.createElement('div');
    t.className = `toast ${type === 'error' ? 'error' : ''}`;
    t.textContent = msg;
    $('toasts').appendChild(t);
    setTimeout(() => t.remove(), 3000);
  }

  async function copyText(text, msg = 'Copiado al portapapeles') {
    try {
      await navigator.clipboard.writeText(text);
    } catch (_) {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch (__) {}
      ta.remove();
    }
    toast(msg);
  }

  function download(name, content) {
    const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function setBusy(btn, busy) {
    btn.classList.toggle('busy', busy);
    btn.disabled = busy;
  }

  // ---------- NAV ----------
  function setSidebar(open) {
    $('sidebar').classList.toggle('collapsed', !open);
    $('scrim').classList.toggle('show', open && isMobile());
    $('menuBtn').setAttribute('aria-expanded', String(open));
  }

  const OWNER_VIEWS = new Set(['ownerpanel', 'planskeys', 'publisher', 'users']);
  function showView(name) {
    if (OWNER_VIEWS.has(name) && !(user && user.owner)) name = 'dashboard';
    document.querySelectorAll('.nav-item[data-nav]').forEach(b => {
      const on = b.dataset.nav === name;
      b.classList.toggle('active', on);
      if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.dataset.view === name));
    if (name === 'soporte') loadSupport();
    if (name === 'stats') { loadExecStats(); }
    if (name === 'profile' && hasPerkPlan()) { loadWebhooks(); loadActivity(); }
    $('pageTitle').firstChild.textContent = NAV[name].title;
    $('pageSub').textContent = NAV[name].sub;
    if (name === 'profile') renderProfile();
    if (name === 'precios') loadPricesForm();
    if (name === 'bienvenida') loadWelcomeForm();
    if (name === 'chat') startChatPolling(); else stopChatPolling();
    if (name === 'blacklist') loadBlacklist();
    if (isMobile()) setSidebar(false);
  }

  // ---------- MODAL ----------
  function openModal(title, html, boxClass = '') {
    $('modalTitle').textContent = title;
    $('modalBox').className = `modal ${boxClass}`;
    $('modalBody').innerHTML = html;
    $('modal').hidden = false;
    setTimeout(() => $('modalBody').querySelector('input, select, textarea')?.focus(), 30);
  }
  function closeModal() { $('modal').hidden = true; }

  // Plan Free: antes de crear scripts debe unirse al servidor de Discord. El aviso sale cada vez hasta que confirme
  function showDiscordGate(invite) {
    const url = invite || 'https://discord.gg/FUjbTN69';
    openModal('Únete a nuestro Discord', `
      <p>Para crear scripts con el plan Free necesitas estar en nuestro servidor de Discord.</p>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:14px">
        <a class="btn btn-ghost" href="${url}" target="_blank" rel="noopener">Unirme al servidor</a>
        <button class="btn" type="button" id="dcVerify">Ya me uní</button>
      </div>
      <p class="hint" style="margin-top:14px">Este aviso aparecerá cada vez que intentes crear un script hasta que confirmes que te uniste.</p>`);
    $('dcVerify').addEventListener('click', async () => {
      const btn = $('dcVerify');
      setBusy(btn, true);
      try {
        await api('/api/discord/joined', { method: 'POST' });
        toast('¡Listo! Ya puedes crear scripts');
        closeModal();
      } catch (err) { toast(err.message, 'error'); setBusy(btn, false); }
    });
  }

  // ---------- PERFIL: foto de perfil y foto del bot en tu servidor (por URL) ----------
  function setPreview(el, src, fallback) {
    el.innerHTML = '';
    if (src) {
      const img = document.createElement('img');
      img.alt = '';
      img.src = src;
      img.style.cssText = 'width:100%;height:100%;object-fit:cover';
      img.onerror = () => { el.textContent = fallback; };
      el.appendChild(img);
    } else {
      el.textContent = fallback;
    }
  }

  function renderProfile() {
    if (!user) return;
    $('pfProfile').value = user.custom_avatar || '';
    $('pfBot').value = user.bot_avatar || '';
    const discordAv = user.avatar && user.id
      ? `https://cdn.discordapp.com/avatars/${encodeURIComponent(user.id)}/${encodeURIComponent(user.avatar)}.png`
      : null;
    setPreview($('pvProfile'), user.custom_avatar || discordAv, (user.username || '?').charAt(0).toUpperCase());
    setPreview($('pvBot'), user.bot_avatar || null, 'Bot');

    // Encabezado: foto, plan, vencimiento y contadores
    setPreview($('pfHeroAv'), user.custom_avatar || discordAv, (user.username || '?').charAt(0).toUpperCase());
    $('pfHeroName').textContent = user.username || 'Usuario';
    const pk = planKey(user.plan);
    const planBadge = $('pfHeroPlan');
    planBadge.textContent = PLAN_LABELS[pk];
    planBadge.className = `badge ${pk === 'free' ? 'neutral' : 'ok'}`;
    $('pfHeroExp').textContent = pk === 'free' ? 'Plan gratuito'
      : user.plan_expires_at ? `Vence ${fmtDate(user.plan_expires_at)}` : 'Sin fecha de vencimiento';
    $('pfStatScripts').textContent = scriptsLoaded && !scriptsError ? scripts.length : '—';
    $('pfStatKeys').textContent = keysLoaded && !keysError ? keys.length : '—';
    $('pfStatObf').textContent = user.obf_used ?? 0;
  }

  $('pfProfileSave').addEventListener('click', async () => {
    try {
      const data = await api('/api/me/avatar', { method: 'POST', body: JSON.stringify({ url: $('pfProfile').value.trim() }) });
      user.custom_avatar = data.avatarUrl;
      renderUser();
      renderProfile();
      toast(data.avatarUrl ? 'Foto de perfil guardada' : 'Ahora se usa la foto de Discord');
    } catch (err) { toast(err.message, 'error'); }
  });
  $('pfProfileClear').addEventListener('click', () => { $('pfProfile').value = ''; $('pfProfileSave').click(); });

  // Foto subida desde el dispositivo: se recorta a cuadrado y se redimensiona en el navegador
  function fileToSquareDataUrl(file, size = 256) {
    return new Promise((resolve, reject) => {
      if (!file.type.startsWith('image/')) return reject(new Error('Elige una imagen (png, jpg, webp o gif)'));
      if (file.size > 15 * 1024 * 1024) return reject(new Error('La imagen pesa demasiado (máximo 15 MB)'));
      const src = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const side = Math.min(img.width, img.height);
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        canvas.getContext('2d').drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
        URL.revokeObjectURL(src);
        resolve(canvas.toDataURL('image/webp', 0.9));
      };
      img.onerror = () => { URL.revokeObjectURL(src); reject(new Error('No pude leer esa imagen')); };
      img.src = src;
    });
  }
  async function uploadPhoto(kind, file, btn) {
    setBusy(btn, true);
    try {
      const dataUrl = await fileToSquareDataUrl(file);
      const data = await api('/api/me/avatar/upload', { method: 'POST', body: JSON.stringify({ kind, dataUrl }) });
      if (kind === 'profile') { user.custom_avatar = data.avatarUrl; renderUser(); }
      else user.bot_avatar = data.avatarUrl;
      renderProfile();
      toast(kind === 'profile' ? 'Foto de perfil guardada' : 'Foto del bot guardada en tu servidor');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(btn, false);
    }
  }
  $('pfProfileUpload').addEventListener('click', () => $('pfProfileFile').click());
  $('pfProfileFile').addEventListener('change', e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) uploadPhoto('profile', file, $('pfProfileUpload'));
  });
  $('pfBotUpload').addEventListener('click', () => $('pfBotFile').click());
  $('pfBotFile').addEventListener('change', e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) uploadPhoto('bot', file, $('pfBotUpload'));
  });

  $('pfBotSave').addEventListener('click', async () => {
    const url = $('pfBot').value.trim();
    try {
      await api('/api/me/bot-avatar', { method: 'POST', body: JSON.stringify({ url }) });
      user.bot_avatar = url || null;
      renderProfile();
      toast(url ? 'Foto del bot guardada en tu servidor' : 'Foto del bot quitada');
    } catch (err) { toast(err.message, 'error'); }
  });
  $('pfBotClear').addEventListener('click', () => { $('pfBot').value = ''; $('pfBotSave').click(); });


  function codeFieldHtml(initial = '') {
    return `
      <div class="input-group">
        <label for="fCode">Código del script</label>
        <div class="toolbar" style="margin-bottom:10px">
          <label class="btn ghost sm file-btn" style="cursor:pointer">
            Subir archivo .lua
            <input type="file" id="fFile" accept=".lua,.txt,text/plain">
          </label>
          <span class="hint" id="fFileName">o pega el código abajo</span>
        </div>
        <textarea id="fCode" class="textarea" spellcheck="false" placeholder="-- Pega aquí tu script Lua">${esc(initial)}</textarea>
        <div class="code-meta"><span id="fCodeSize">0 KB de 2 MB</span></div>
        <div id="perfPanel" class="perf" hidden></div>
      </div>`;
  }

  // ---------- REVISIÓN DE RENDIMIENTO ----------
  const PERF_LABEL = { alto: 'Alto', medio: 'Medio', bajo: 'Bajo' };
  const SEV_LABEL = { high: 'Alto', medium: 'Medio', low: 'Bajo' };
  const perfClass = l => (l === 'alto' ? 'bad' : l === 'medio' ? 'warn' : 'ok');
  let perfTimer = null;
  let perfSeq = 0;
  function schedulePerf() { clearTimeout(perfTimer); perfTimer = setTimeout(runPerf, 450); }
  async function runPerf() {
    const panel = $('perfPanel');
    if (!panel) return;
    const source = $('fCode')?.value || '';
    if (!source.trim()) { panel.hidden = true; return; }
    const seq = ++perfSeq;
    const body = {
      source,
      obfuscator: $('fObf')?.value || 'real',
      clydeVm: $('vmGroup')?.querySelector('input')?.checked ?? true,
    };
    try {
      const r = await api('/api/perf-check', { method: 'POST', body: JSON.stringify(body) });
      if (seq !== perfSeq) return;
      panel.hidden = false;
      panel.innerHTML = perfHtml(r);
    } catch (_) { /* el editor sigue funcionando aunque no haya revisión */ }
  }
  function perfHtml(r) {
    const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    const head = `<div class="perf-head">
        <span class="badge ${perfClass(r.level)}">Rendimiento ${PERF_LABEL[r.level]}</span>
        <span class="perf-stats">${plural(r.loops, 'bucle', 'bucles')} · ${plural(r.hot, 'callback por frame', 'callbacks por frame')}</span>
      </div>`;
    if (!r.findings.length) return `${head}<p class="perf-ok">Sin problemas detectados en el código.</p>`;
    const items = r.findings.map(f => `
      <li>
        <span class="perf-sev ${f.severity}">${SEV_LABEL[f.severity]}</span>
        <div>
          <div class="perf-title">${esc(f.title)} <span class="perf-line">línea ${f.line}</span></div>
          <div class="perf-tip">${esc(f.tip)}</div>
        </div>
      </li>`).join('');
    return `${head}<ul class="perf-list">${items}</ul>`;
  }

  function wireCodeField() {
    const ta = $('fCode');
    ta.addEventListener('input', schedulePerf);
    const update = () => {
      const size = byteLen(ta.value);
      $('fCodeSize').innerHTML = `<span class="${size > MAX_CODE_BYTES ? 'over' : ''}">${fmtKB(size)} de 2 MB</span>`;
    };
    ta.addEventListener('input', update);
    update();

    $('fFile').addEventListener('change', async e => {
      const file = e.target.files[0];
      if (!file) return;
      if (file.size > MAX_CODE_BYTES) {
        toast('El archivo supera 2 MB', 'error');
        e.target.value = '';
        return;
      }
      ta.value = await file.text();
      $('fFileName').textContent = file.name;
      update();
    });
  }

  // Selector de protección: FFA o Protegido, y si es Protegido, el ofuscador
  function protectionHtml(s = {}) {
    const current = s.ffa === undefined ? 'protected' : protectionOf(s);
    const currentObf = s.id ? obfuscatorOf(s) : 'real';
    return `
      <div class="input-group">
        <span class="label">Protección</span>
        <div class="choice-grid">
          <label class="choice">
            <input type="radio" name="protection" value="ffa" ${current === 'ffa' ? 'checked' : ''}>
            <span><b>FFA</b><small>Sin key. Cualquiera puede ejecutarlo.</small></span>
          </label>
          <label class="choice">
            <input type="radio" name="protection" value="protected" ${current === 'protected' ? 'checked' : ''}>
            <span><b>Protegido</b><small>Requiere key válida y se ofusca.</small></span>
          </label>
        </div>
      </div>
      <div class="input-group" id="obfGroup">
        <label for="fObf">Ofuscador</label>
        <select id="fObf" name="obfuscator" class="field block">
          ${Object.entries(OBFUSCATORS).map(([val, label]) =>
            `<option value="${val}" ${val === currentObf ? 'selected' : ''} ${val === 'luau' && !hasPlusPlan() ? 'disabled' : ''}>${label}</option>`).join('')}
        </select>
        <div class="hint">Se aplica en el servidor al guardar el script. Para Roblox (Luau) recomendamos el Ofuscador 1.</div>
        <label id="vmGroup" style="display:flex;gap:10px;align-items:flex-start;margin-top:12px;cursor:pointer">
          <input type="checkbox" name="clydeVm" ${s.clyde_vm ? 'checked' : ''} style="margin-top:3px">
          <span><b>Máquina virtual</b><small style="display:block;color:var(--text-soft)">Más protección, pero puede bajar los FPS del juego. Solo aplica al Ofuscador 1.</small></span>
        </label>
        <div id="vmWarn" hidden style="margin-top:10px;padding:10px 12px;border-radius:10px;background:var(--warn-bg);border:1px solid rgba(251,191,36,.25);font-size:13px;color:var(--text-soft)">
          Detectamos código que corre cada frame (RenderStepped, Heartbeat o Stepped). Con VM puede bajar los FPS.
          <button type="button" class="btn ghost sm" id="vmOff" style="margin-top:8px">Desactivar VM</button>
        </div>
        <button type="button" class="btn ghost sm" id="macroBtn" hidden style="margin-top:8px">Macros de rendimiento (Ofuscador 3)</button>
      </div>

      <div class="input-group" id="hwidGroup">
        <label for="fHwid">Reinicio de HWID</label>
        <select id="fHwid" name="hwidReset" class="field block">
          ${HWID_OPTIONS.map(([h, label]) => {
            const paid = hasPerkPlan();
            const current = !paid && (s.hwid_reset_hours ?? 24) === 0 ? 24 : (s.hwid_reset_hours ?? 24);
            const disabled = !paid && h === 0;
            return `<option value="${h}" ${h === current ? 'selected' : ''} ${disabled ? 'disabled' : ''}>${disabled ? `${label} (solo planes pagos)` : label}</option>`;
          }).join('')}
        </select>
        <div class="hint">Cada cuánto puede reiniciar su HWID un comprador. Si lo desactivas, el botón Reset HWID del panel queda gris. El creador siempre puede usar /resethwid. "Desactivado" es solo para Premium y Premium Plus.</div>
        <label style="display:flex;gap:10px;align-items:flex-start;margin-top:12px;cursor:pointer">
          <input type="checkbox" name="shareDetection" ${(s.share_detection ?? 1) !== 0 ? 'checked' : ''} style="margin-top:3px">
          <span><b>Detectar keys compartidas</b><small style="display:block;color:var(--text-soft)">A la 1.ª vez que se use desde otro equipo, avisa al dueño de la key. A la 2.ª, avisa con más fuerza. A la 3.ª, elimina la key y bloquea al usuario en este script.</small></span>
        </label>
        <label style="display:flex;gap:10px;align-items:flex-start;margin-top:12px;cursor:pointer">
          <input type="checkbox" name="autoRevokeDump" ${s.auto_revoke_dump ? 'checked' : ''} style="margin-top:3px">
          <span><b>Revocar key al detectar dump</b><small style="display:block;color:var(--text-soft)">Si el loader detecta un volcador con una key de este script, la key queda bloqueada al instante. Te avisamos igual, y puedes devolverle el acceso desde el aviso.</small></span>
        </label>
      </div>`;
  }

  function wireProtection() {
    const sync = () => {
      const isProtected = document.querySelector('input[name="protection"]:checked')?.value === 'protected';
      // El ofuscador se elige en FFA y en protegido; el reinicio de HWID solo aplica a protegido
      $('hwidGroup').hidden = !isProtected;
      $('macroBtn').hidden = $('fObf').value !== 'luau';
        $('vmGroup').hidden = true; // la máquina virtual ya no se ofrece
      const vmOn = $('vmGroup').querySelector('input')?.checked;
      const hot = hotRanges($('fCode')?.value || '').length > 0;
      $('vmWarn').hidden = true;
      schedulePerf();
    };
    document.querySelectorAll('input[name="protection"]').forEach(r => r.addEventListener('change', sync));
    $('fObf').addEventListener('change', sync);
    $('vmGroup').querySelector('input').addEventListener('change', sync);
    $('fCode')?.addEventListener('input', sync);
    $('vmOff').addEventListener('click', () => { $('vmGroup').querySelector('input').checked = false; sync(); });
    sync();
  }

  function openScriptModal() {
    openModal('Nuevo script', `
      <form id="formScript" novalidate>
        <div class="input-group">
          <label for="fName">Nombre</label>
          <input id="fName" name="name" class="field block" required maxlength="60" autocomplete="off">
        </div>
        ${codeFieldHtml()}
        ${protectionHtml()}
        <div class="form-actions">
          <button type="button" class="btn ghost" data-close>Cancelar</button>
          <button type="submit" class="btn">Crear script</button>
        </div>
      </form>`, 'wide');
    wireCodeField();
    wireProtection();
    $('formScript').addEventListener('submit', submitScript);
  }

  async function openEditScriptModal(id) {
    let s = scripts.find(x => String(x.id) === String(id));
    // Si la lista no estaba cargada o quedó vieja, la recarga antes de rendirse
    if (!s) { await loadData(); s = scripts.find(x => String(x.id) === String(id)); }
    if (!s) { toast('No se pudo cargar ese script. Recarga la página e inténtalo de nuevo.', 'error'); return; }
    openModal(`Editar ${s.name}`, `
      <form id="formEditScript" novalidate>
        <div class="input-group">
          <label for="fName">Nombre</label>
          <input id="fName" name="name" class="field block" required maxlength="60" value="${esc(s.name)}" autocomplete="off">
        </div>
        ${codeFieldHtml()}
        ${protectionHtml(s)}
        <details class="ver-box">
          <summary>Historial de versiones</summary>
          <div id="verList" class="ver-list"></div>
        </details>
        <div class="form-actions">
          <button type="button" class="btn ghost" data-close>Cancelar</button>
          <button type="submit" class="btn">Guardar cambios</button>
        </div>
      </form>`, 'wide');
    wireCodeField();
    wireProtection();
    $('formEditScript').addEventListener('submit', e => submitScript(e, s.id));
    $('verList').addEventListener('click', async e => {
      const b = e.target.closest('[data-ver-load]');
      if (!b) return;
      setBusy(b, true);
      try {
        const v = await api(`/api/scripts/${encodeURIComponent(b.dataset.verScript)}/versions/${encodeURIComponent(b.dataset.verLoad)}`);
        $('fCode').value = v.source;
        $('fCode').dispatchEvent(new Event('input'));
        toast('Versión cargada en el editor. Revisa y guarda para aplicarla.');
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        setBusy(b, false);
      }
    });
    loadVersions(s.id);
  }

  async function loadVersions(scriptId) {
    const box = $('verList');
    if (!box) return;
    box.innerHTML = '<p class="hint">Cargando versiones…</p>';
    try {
      const list = await api(`/api/scripts/${encodeURIComponent(scriptId)}/versions`);
      if (!list.length) {
        box.innerHTML = '<p class="hint">Aún no hay versiones. Se guarda una cada vez que cambias el código.</p>';
        return;
      }
      box.innerHTML = list.map(v => `
        <div class="ver-row">
          <div class="ver-meta">
            <b>${esc(v.name)}</b>
            <span class="hint">${new Date(v.created_at * 1000).toLocaleString('es-EC', { dateStyle: 'short', timeStyle: 'short' })} · ${esc(OBFUSCATORS[v.obfuscator] ?? v.obfuscator)} · <span class="mono">${esc(String(v.source_hash).slice(0, 12))}</span></span>
          </div>
          <button type="button" class="btn ghost sm" data-ver-load="${esc(v.id)}" data-ver-script="${esc(scriptId)}">Cargar en el editor</button>
        </div>`).join('');
    } catch (err) {
      box.innerHTML = `<p class="hint">${esc(err.message)}</p>`;
    }
  }

  function openKeysModal(preselect = '') {
    if (!scripts.length) { toast('Crea un script primero', 'error'); return; }
    const DUR_OPTS = [['', 'Nunca'], ['3600', '1 hora'], ['21600', '6 horas'], ['86400', '1 día'], ['604800', '7 días'],
      ['1296000', '15 días'], ['2592000', '30 días'], ['7776000', '90 días'], ['31536000', '1 año'], ['custom', 'Personalizado']];
    const UNIT_SECONDS = { horas: 3600, dias: 86400, meses: 2592000, anios: 31536000 };
    const MAX_KEY_SECONDS = 3650 * 86400;
    const AMOUNT_PRESETS = [1, 5, 10, 25, 50];
    openModal('Generar keys', `
      <p class="card-sub" style="margin:-6px 0 20px">Crea keys vinculadas a un script. Podrás copiarlas al terminar.</p>
      <form id="formKeys" novalidate>
        <div class="input-group">
          <label for="fScript">Script</label>
          <select id="fScript" name="scriptId" class="field block">
            ${scripts.map(s => `<option value="${esc(s.id)}" ${String(s.id) === String(preselect) ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
          </select>
        </div>

        <div class="input-group">
          <span class="label" id="amountLabel">Cantidad</span>
          <div class="stepper" role="group" aria-labelledby="amountLabel">
            <button type="button" class="step-btn" data-step="-1" aria-label="Quitar una key">−</button>
            <input id="fAmount" type="number" name="amount" class="step-input" value="1" min="1" max="50" inputmode="numeric" aria-describedby="amountHint">
            <button type="button" class="step-btn" data-step="1" aria-label="Agregar una key">+</button>
          </div>
          <div class="chips" data-amount-presets>
            ${AMOUNT_PRESETS.map(n => `<button type="button" class="chip" data-preset="${n}">${n}</button>`).join('')}
          </div>
          <div class="hint" id="amountHint">Entre 1 y 50 keys por generación.</div>
        </div>

        <div class="input-group">
          <span class="label" id="durLabel">Duración</span>
          <div class="chips seg" role="radiogroup" aria-labelledby="durLabel">
            ${DUR_OPTS.map(([v, t], i) => `
              <label class="chip">
                <input type="radio" name="dur" value="${v}" ${i === 0 ? 'checked' : ''}>
                <span>${t}</span>
              </label>`).join('')}
          </div>
          <div class="custom-dur" id="customDur" hidden>
            <input id="fCustomN" type="number" name="customN" class="field" value="1" min="1" max="3650" inputmode="numeric" aria-label="Cantidad de tiempo">
            <select id="fCustomUnit" name="customUnit" class="field" aria-label="Unidad de tiempo">
              <option value="horas">horas</option>
              <option value="dias" selected>días</option>
              <option value="meses">meses</option>
              <option value="anios">años</option>
            </select>
          </div>
        </div>

        <div class="keys-summary" id="keysSummary" aria-live="polite"></div>

        <div class="form-actions">
          <button type="button" class="btn ghost" data-close>Cancelar</button>
          <button type="submit" class="btn" id="keysSubmit">Generar 1 key</button>
        </div>
      </form>`);

    const form = $('formKeys');
    const amountEl = $('fAmount');
    const scriptEl = $('fScript');
    const summary = $('keysSummary');
    const submitBtn = $('keysSubmit');

    const clampAmount = (n) => Math.min(50, Math.max(1, Number.isFinite(n) ? Math.floor(n) : 1));
    // Duración en segundos (null = no expira). Devuelve NaN si el personalizado no es válido.
    const currentSeconds = () => {
      const choice = form.querySelector('input[name="dur"]:checked')?.value || '';
      if (choice === 'custom') {
        const n = parseInt($('fCustomN').value, 10);
        const unit = $('fCustomUnit').value;
        const secs = n * (UNIT_SECONDS[unit] || 86400);
        return Number.isInteger(n) && n >= 1 && secs >= 3600 && secs <= MAX_KEY_SECONDS ? secs : NaN;
      }
      return choice ? Number(choice) : null;
    };
    const humanDur = secs => {
      if (secs >= 31536000) return `${Math.round(secs / 31536000)} ${Math.round(secs / 31536000) === 1 ? 'año' : 'años'}`;
      if (secs >= 2592000) return `${Math.round(secs / 2592000)} meses`;
      if (secs >= 86400) return `${Math.round(secs / 86400)} ${Math.round(secs / 86400) === 1 ? 'día' : 'días'}`;
      return `${Math.round(secs / 3600)} ${Math.round(secs / 3600) === 1 ? 'hora' : 'horas'}`;
    };
    const refresh = () => {
      const n = clampAmount(parseInt(amountEl.value, 10));
      const secs = currentSeconds();
      $('customDur').hidden = form.querySelector('input[name="dur"]:checked')?.value !== 'custom';
      const expiry = secs === null ? 'no expiran' : Number.isNaN(secs) ? 'con una duración no válida (de 1 hora a 10 años)' : `expiran en ${humanDur(secs)}`;
      summary.innerHTML = `Se crearán <strong>${n} ${n === 1 ? 'key' : 'keys'}</strong> para <strong>${esc(scriptName(parseInt(scriptEl.value, 10)))}</strong> que ${expiry}.`;
      submitBtn.textContent = `Generar ${n} ${n === 1 ? 'key' : 'keys'}`;
      form.querySelectorAll('[data-preset]').forEach(b => b.classList.toggle('on', Number(b.dataset.preset) === n));
      form.querySelector('[data-step="-1"]').disabled = n <= 1;
      form.querySelector('[data-step="1"]').disabled = n >= 50;
    };
    const setAmount = (n) => { amountEl.value = clampAmount(n); refresh(); };

    form.querySelectorAll('[data-step]').forEach(b => b.addEventListener('click', () => setAmount(parseInt(amountEl.value, 10) + Number(b.dataset.step))));
    form.querySelectorAll('[data-preset]').forEach(b => b.addEventListener('click', () => setAmount(Number(b.dataset.preset))));
    amountEl.addEventListener('input', refresh);
    amountEl.addEventListener('blur', () => setAmount(parseInt(amountEl.value, 10)));
    form.querySelectorAll('input[name="dur"]').forEach(r => r.addEventListener('change', refresh));
    $('fCustomN').addEventListener('input', refresh);
    $('fCustomUnit').addEventListener('change', refresh);
    scriptEl.addEventListener('change', refresh);
    form.addEventListener('submit', submitKeys);
    refresh();
  }

  function showGenerated(newKeys, scriptLabel) {
    const text = newKeys.map(k => k.key).join('\n');
    const count = newKeys.length;
    openModal(`${count} ${count === 1 ? 'key generada' : 'keys generadas'}`, `
      <p class="card-sub" style="margin:-6px 0 16px">Script: <strong>${esc(scriptLabel)}</strong>. Cópialas ahora; siempre puedes volver a verlas en Keys.</p>
      <ul class="key-list">
        ${newKeys.map((k, i) => `
          <li class="key-row">
            <span class="key-idx">${String(i + 1).padStart(2, '0')}</span>
            <code class="key-val">${esc(k.key)}</code>
            <button type="button" class="btn ghost sm" data-copy="${esc(k.key)}">Copiar</button>
          </li>`).join('')}
      </ul>
      <div class="toolbar" style="margin-top:16px">
        <button class="btn" id="genCopyAll">Copiar todas</button>
        <button class="btn ghost" id="genCsv">Descargar CSV</button>
        <span style="flex:1"></span>
        <button class="btn ghost" data-close>Cerrar</button>
      </div>`, 'wide');
    $('modalBody').querySelectorAll('[data-copy]').forEach(b => b.addEventListener('click', () => copyText(b.dataset.copy, 'Key copiada')));
    $('genCopyAll').onclick = () => copyText(text, 'Keys copiadas');
    $('genCsv').onclick = () => {
      const rows = newKeys.map(k => [k.key, scriptLabel].map(csvCell).join(',')).join('\n');
      download('keys_nuevas.csv', `key,script\n${rows}`);
    };
  }

  // ---------- SUBMITS ----------
  async function submitScript(e, editId = null) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    const name = String(fd.get('name') || '').trim();
    const code = $('fCode').value;
    const protection = fd.get('protection') || 'protected';
    const obfuscator = fd.get('obfuscator') || 'real';

    if (!name) { toast('Escribe un nombre', 'error'); return; }
    if (!editId && !code.trim()) { toast('Agrega el código del script', 'error'); return; }
    if (code && byteLen(code) > MAX_CODE_BYTES) { toast('El código supera 2 MB', 'error'); return; }
    if (!OBFUSCATORS[obfuscator]) { toast('Elige un ofuscador', 'error'); return; }

    const body = {
      name,
      ffa: protection === 'ffa',
      // El ofuscador se elige en FFA y en protegido
      obfuscator,
      hwidResetHours: Number(fd.get('hwidReset') ?? 24),
      shareDetection: fd.get('shareDetection') === 'on',
      autoRevokeDump: fd.get('autoRevokeDump') === 'on',
      clydeVm: fd.get('clydeVm') === 'on',
    };
    if (code.trim()) body.code = code;

    const btn = form.querySelector('[type="submit"]');
    setBusy(btn, true);
    try {
      if (editId) {
        await api(`/api/scripts/${encodeURIComponent(editId)}`, { method: 'PUT', body: JSON.stringify(body) });
        toast('Script actualizado');
      } else {
        await api('/api/scripts', { method: 'POST', body: JSON.stringify(body) });
        toast('Script creado');
      }
      closeModal();
      await loadData();
    } catch (err) {
      if (err.code === 'DISCORD_REQUIRED') { showDiscordGate(err.invite); return; }
      toast(err.message, 'error');
      setBusy(btn, false);
    }
  }

  async function openProtectedCode(id) {
    try {
      const d = await api(`/api/scripts/${encodeURIComponent(id)}/protected`);
      const label = OBFUSCATORS[d.obfuscator] || d.obfuscator;
      openModal(`Código protegido: ${d.name}`, `
        <p class="card-sub" style="margin:-6px 0 12px">Ofuscador: <strong>${esc(label)}</strong>. Este es el código que sirve el loader.</p>
        <pre class="code-view">${esc(d.content)}</pre>
        <div class="form-actions">
          <button type="button" class="btn ghost" data-close>Cerrar</button>
          <button type="button" class="btn" id="protCopy">Copiar</button>
        </div>`);
      $('protCopy').addEventListener('click', () => {
        navigator.clipboard.writeText(d.content).then(() => toast('Código copiado'), () => toast('No se pudo copiar', 'error'));
      });
    } catch (err) { toast(err.message, 'error'); }
  }

  async function submitKeys(e) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    const scriptId = parseInt(fd.get('scriptId'), 10);
    const amount = Math.min(50, Math.max(1, parseInt(fd.get('amount'), 10) || 1));
    // Misma lógica que currentSeconds() del formulario
    const choice = fd.get('dur') || '';
    let secs = null;
    if (choice === 'custom') {
      const n = parseInt(fd.get('customN'), 10);
      const unitSecs = { horas: 3600, dias: 86400, meses: 2592000, anios: 31536000 }[fd.get('customUnit')] || 86400;
      secs = n * unitSecs;
      if (!Number.isInteger(n) || n < 1 || secs < 3600 || secs > 3650 * 86400) {
        toast('La duración debe estar entre 1 hora y 10 años', 'error');
        return;
      }
    } else if (choice) {
      secs = Number(choice);
    }
    const btn = form.querySelector('[type="submit"]');
    setBusy(btn, true);
    try {
      const data = await api('/api/keys', { method: 'POST', body: JSON.stringify({ scriptId, amount, seconds: secs }) });
      await loadData();
      showGenerated(data.keys, scriptName(scriptId));
    } catch (err) {
      toast(err.message, 'error');
      setBusy(btn, false);
    }
  }

  // ---------- RENDER ----------
  function renderUser() {
    if (!user) return;
    $('userName').textContent = user.username || 'Usuario';
    $('userPlan').textContent = PLAN_LABELS[planKey(user.plan)];
    const av = $('userAvatar');
    av.innerHTML = '';
    const src = user.custom_avatar
      || (user.avatar && user.id ? `https://cdn.discordapp.com/avatars/${encodeURIComponent(user.id)}/${encodeURIComponent(user.avatar)}.png` : null);
    if (src) {
      const img = document.createElement('img');
      img.alt = '';
      img.src = src;
      img.onerror = () => { av.textContent = (user.username || '?').charAt(0).toUpperCase(); };
      av.appendChild(img);
    } else {
      av.textContent = (user.username || '?').charAt(0).toUpperCase();
    }
  }

  function renderCounts() {
    $('navScripts').textContent = scriptsError ? '—' : scripts.length;
    $('navKeys').textContent = keysError ? '—' : keys.length;
  }

  function renderDashboard() {
    const plan = planKey(user?.plan);
    const lim = PLAN_LIMITS[plan];
    const active = keys.filter(k => keyStatus(k).id === 'active');
    const now = Date.now();
    const expiring = active
      .filter(k => k.expires_at && k.expires_at * 1000 - now <= SOON_MS)
      .sort((a, b) => a.expires_at - b.expires_at);

    $('statPlan').textContent = PLAN_LABELS[plan];

    $('statScripts').textContent = scriptsError ? '—' : scripts.length;
    const obfUsed = user?.obf_used ?? 0;
    $('subScripts').textContent = (Number.isFinite(lim.scripts) ? `de ${lim.scripts} permitidos` : 'Ilimitados')
      + ` · ${obfUsed}${Number.isFinite(lim.obf) ? `/${lim.obf}` : ''} ofuscaciones usadas`;
    $('meterScripts').style.width = Number.isFinite(lim.scripts) ? `${Math.min(100, scripts.length / lim.scripts * 100)}%` : '100%';

    $('statKeys').textContent = keysError ? '—' : active.length;
    $('subKeys').textContent = Number.isFinite(lim.keys) ? `${keys.length} de ${lim.keys} generadas` : `${keys.length} generadas en total`;
    $('meterKeys').style.width = Number.isFinite(lim.keys) ? `${Math.min(100, keys.length / lim.keys * 100)}%` : '100%';

    $('statExpiring').textContent = keysError ? '—' : expiring.length;

    const dash = $('dashScripts');
    if (scriptsError || keysError) {
      dash.innerHTML = `<div class="list-row"><div class="grow meta">No se pudieron cargar los datos. Pulsa Actualizar.</div></div>`;
    } else if (!scripts.length) {
      dash.innerHTML = `<div class="list-row"><div class="grow meta">Aún no tienes scripts.</div></div>`;
    } else {
      dash.innerHTML = scripts.map(s => {
        const mine = keys.filter(k => k.script_id === s.id);
        const act = mine.filter(k => keyStatus(k).id === 'active').length;
        const pct = mine.length ? Math.round(act / mine.length * 100) : 0;
        return `
          <div class="list-row">
            <div class="grow">
              <div class="name">${esc(s.name)}</div>
              <div class="meta">${act} activas de ${mine.length}</div>
              <div class="mini-meter"><span style="width:${pct}%"></span></div>
            </div>
          </div>`;
      }).join('');
    }

    const exp = $('dashExpiring');
    if (keysError) {
      exp.innerHTML = `<div class="list-row"><div class="grow meta">No se pudieron cargar las keys.</div></div>`;
    } else if (!expiring.length) {
      exp.innerHTML = `<div class="list-row"><div class="grow meta">Ninguna key vence en los próximos 7 días.</div></div>`;
    } else {
      exp.innerHTML = expiring.slice(0, 6).map(k => `
        <div class="list-row">
          <div class="grow">
            <div class="name mono" style="font-size:12px">${esc(maskKey(k.key))}</div>
            <div class="meta">${esc(scriptName(k.script_id))} · vence ${fmtDate(k.expires_at)}</div>
          </div>
          <button class="btn ghost sm" data-copy="${esc(k.key)}">Copiar</button>
        </div>`).join('');
    }
  }

  function renderScripts() {
    const grid = $('scriptsGrid');
    if (!scriptsLoaded && !scriptsError) {
      grid.innerHTML = Array.from({ length: 3 }, () => `<div class="skel-card"><span class="skel skel-line w60"></span><span class="skel skel-line"></span><span class="skel skel-line w40"></span></div>`).join('');
      return;
    }
    if (scriptsError) {
      grid.innerHTML = `<div class="empty"><h3>No se pudieron cargar los scripts</h3><p>Revisa tu conexión y pulsa Actualizar.</p></div>`;
      return;
    }
    if (!scripts.length) {
      grid.innerHTML = `<div class="empty"><h3>Aún no tienes scripts</h3><p>Sube tu primer script para empezar a generar keys.</p><button class="btn" data-open="script">+ Nuevo script</button></div>`;
      return;
    }
    grid.innerHTML = scripts.map(s => {
      const mine = keysError ? [] : keys.filter(k => k.script_id === s.id);
      const act = mine.filter(k => keyStatus(k).id === 'active').length;
      const loader = loaderFor(s);
      const isFfa = protectionOf(s) === 'ffa';
      const vmTag = obfuscatorOf(s) === 'clyde' && s.clyde_vm ? ' · VM' : '';
      const meta = isFfa ? `FFA · sin key · ${OBFUSCATORS[obfuscatorOf(s)] ?? ''}` : `Protegido · ${OBFUSCATORS[obfuscatorOf(s)]}${vmTag}`;
      return `
        <article class="card script-card">
          <div class="row">
            <h4 class="script-name" title="${esc(s.name)}">${esc(s.name)}</h4>
            <span class="badge ${isFfa ? 'bad' : 'ok'}">${isFfa ? 'FFA' : 'Protegido'}</span>
            ${s.perf_level ? `<span class="badge ${perfClass(s.perf_level)}">Rendimiento ${PERF_LABEL[s.perf_level] ?? ''}</span>` : ''}
            ${s.maintenance ? '<span class="badge bad">En mantenimiento</span>' : ''}
          </div>
          <div class="script-meta">${esc(meta)}</div>
          <div class="script-stats">
            <div><b>${mine.length}</b>keys</div>
            <div><b>${act}</b>activas</div>
          </div>
          <button class="loader-box" type="button" data-copy="${esc(loader)}" data-msg="Loader copiado" aria-label="Copiar loader de ${esc(s.name)}">
            <span class="loader-text">${esc(loader)}</span>${ICON_COPY}
          </button>
          <div class="row">
            <button class="btn ghost sm" data-edit="${esc(s.id)}">Editar</button>
            <button class="btn ghost sm" data-protected="${esc(s.id)}">Ver código protegido</button>
            <button class="btn ghost sm" data-maint="${esc(s.id)}" data-on="${s.maintenance ? 1 : 0}">${s.maintenance ? 'Quitar mantenimiento' : 'Poner en mantenimiento'}</button>
            <button class="btn ghost sm" data-delete="${esc(s.id)}" data-name="${esc(s.name)}">Eliminar</button>
            <button class="btn ghost sm" data-view-keys="${esc(s.id)}">Ver keys</button>
            <button class="btn sm" data-gen="${esc(s.id)}">+ Keys</button>
          </div>
        </article>`;
    }).join('');
  }

  function filteredKeys() {
    const q = $('keySearch').value.trim().toLowerCase();
    const scriptId = $('keyScript').value;
    const filter = $('keyFilter').value;
    return keys
      .map(k => ({ k, st: keyStatus(k), script: scriptName(k.script_id) }))
      .filter(r =>
        (scriptId === 'all' || String(r.k.script_id) === scriptId) &&
        (filter === 'all' || r.st.id === filter) &&
        (!q || r.script.toLowerCase().includes(q) || r.k.key.toLowerCase().includes(q))
      );
  }

  function renderKeyScriptFilter() {
    const sel = $('keyScript');
    const current = sel.value || 'all';
    sel.innerHTML = `<option value="all">Todos los scripts</option>` +
      scripts.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
    sel.value = [...sel.options].some(o => o.value === current) ? current : 'all';
  }

  function renderKeys() {
    const tbody = $('keysTable');
    if (!keysLoaded && !keysError) {
      tbody.innerHTML = Array.from({ length: 4 }, () => `<tr class="skel-row"><td colspan="6"><span class="skel skel-line"></span></td></tr>`).join('');
      updateBulk();
      return;
    }
    if (keysError) {
      tbody.innerHTML = `<tr><td colspan="6" class="center">No se pudieron cargar las keys.</td></tr>`;
      updateBulk();
      return;
    }
    if (!keys.length) {
      tbody.innerHTML = `<tr><td colspan="6" class="center"><div class="empty-inline"><span>Todavía no has generado keys.</span> <button class="btn sm" data-open="keys">+ Generar keys</button></div></td></tr>`;
      updateBulk();
      return;
    }
    const rows = filteredKeys();
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="6" class="center">Ninguna key coincide con los filtros.</td></tr>`;
      updateBulk();
      return;
    }
    tbody.innerHTML = rows.map(({ k, st, script }) => `
      <tr class="${selected.has(k.key) ? 'selected' : ''}">
        <td><input type="checkbox" class="check" data-select="${esc(k.key)}" ${selected.has(k.key) ? 'checked' : ''} aria-label="Seleccionar key"></td>
        <td class="key-cell" data-label="Licencia">${esc(maskKey(k.key))}</td>
        <td data-label="Script">${esc(script)}</td>
        <td data-label="Estado"><span class="badge ${st.cls}">${st.label}</span></td>
        <td data-label="Expiración">${fmtDate(k.expires_at)}</td>
        <td class="key-actions" style="text-align:right"><button class="btn ghost sm" data-copy="${esc(k.key)}" data-msg="Key copiada">Copiar</button> <button class="btn ghost sm" data-ban-key="${esc(k.key)}">Banear</button> <button class="btn ghost sm" data-del-key="${esc(k.key)}">Eliminar</button></td>
      </tr>`).join('');
    updateBulk();
  }

  function updateBulk() {
    const visible = keysError ? [] : filteredKeys().map(r => r.k.key);
    const n = selected.size;
    $('bulkBar').hidden = n === 0;
    $('bulkCount').textContent = `${n} seleccionada${n === 1 ? '' : 's'}`;
    const all = visible.length > 0 && visible.every(key => selected.has(key));
    $('checkAll').checked = all;
    $('checkAll').indeterminate = !all && visible.some(key => selected.has(key));
  }

  function renderPlans() {
    const current = planKey(user?.plan);
    document.querySelectorAll('.plan-card').forEach(card => {
      const isCurrent = card.dataset.plan === current;
      card.classList.toggle('current', isCurrent);
      const btn = card.querySelector('[data-plan-btn]');
      btn.disabled = isCurrent;
      btn.textContent = isCurrent ? 'Plan actual' : btn.dataset.label;
    });
  }

  // ---- Asistente IA de soporte ----
  const aiHistory = [];
  const aiAdd = (role, text) => {
    const div = document.createElement('div');
    div.className = `ai-msg ${role}`;
    div.textContent = text;
    $('aiLog').appendChild(div);
    $('aiLog').scrollTop = $('aiLog').scrollHeight;
  };
  async function initAi() {
    try {
      const st = await api('/api/support/ai/status');
      $('aiCard').hidden = !st.enabled;
    } catch (_) { $('aiCard').hidden = true; }
  }
  $('aiForm').addEventListener('submit', async e => {
    e.preventDefault();
    const text = $('aiInput').value.trim();
    if (!text) return;
    const btn = $('aiSend');
    $('aiInput').value = '';
    aiAdd('user', text);
    setBusy(btn, true);
    const thinking = document.createElement('div');
    thinking.className = 'ai-msg assistant pending';
    thinking.textContent = 'Pensando…';
    $('aiLog').appendChild(thinking);
    try {
      const r = await api('/api/support/ai', { method: 'POST', body: JSON.stringify({ message: text, history: aiHistory.slice(-8) }) });
      thinking.remove();
      aiAdd('assistant', r.reply);
      aiHistory.push({ role: 'user', content: text }, { role: 'assistant', content: r.reply });
    } catch (err) {
      thinking.remove();
      aiAdd('assistant', err.message);
    } finally {
      setBusy(btn, false);
      $('aiInput').focus();
    }
  });
  initAi();

  // ---- Soporte: tickets propios (y todos, para el dueño) ----
  const SUPPORT_CAT = { key: 'Key', hwid: 'HWID', loader: 'Loader', plan: 'Plan o pago', ofuscador: 'Ofuscador', otro: 'Otro' };
  const SUPPORT_STATUS = { open: ['Abierto', 'warn'], answered: ['Respondido', 'ok'], closed: ['Cerrado', ''] };
  let supScope = 'mine';
  let supOpenId = null;
  const supBadge = status => {
    const [label, tone] = SUPPORT_STATUS[status] || [status, ''];
    return `<span class="sup-badge ${tone}">${esc(label)}</span>`;
  };
  const supDate = ts => new Date(ts * 1000).toLocaleString('es-EC', { dateStyle: 'short', timeStyle: 'short' });
  async function loadSupport() {
    $('supScope').hidden = !(user && user.owner);
    $('supList').innerHTML = '<p class="hint">Cargando tickets…</p>';
    try {
      const all = user && user.owner && supScope === 'all';
      renderSupportList(await api(`/api/support/tickets${all ? '?all=1' : ''}`));
    } catch (err) {
      $('supList').innerHTML = `<p class="hint">${esc(err.message)}</p>`;
    }
  }
  function renderSupportList(list) {
    if (!list.length) {
      $('supList').innerHTML = '<div class="empty"><h3>No tienes tickets</h3><p>Si algo no funciona, abre un ticket y te respondemos aquí.</p></div>';
      return;
    }
    const showOwner = !!(user && user.owner && supScope === 'all');
    $('supList').innerHTML = list.map(t => `
      <button type="button" class="sup-row ${t.id === supOpenId ? 'on' : ''}" data-sup-open="${esc(t.id)}">
        <span class="sup-main">
          <b>${esc(t.subject)}</b>
          <span class="hint">${esc(SUPPORT_CAT[t.category] || t.category)}${showOwner ? ` · ${esc(t.username || t.user_id)}` : ''} · ${supDate(t.updated_at)}</span>
        </span>
        ${supBadge(t.status)}
      </button>`).join('');
  }
  async function openSupportTicket(id) {
    supOpenId = Number(id);
    const box = $('supDetail');
    box.hidden = false;
    box.innerHTML = '<p class="hint">Cargando ticket…</p>';
    try {
      const { ticket, messages } = await api(`/api/support/tickets/${encodeURIComponent(id)}`);
      const closed = ticket.status === 'closed';
      box.innerHTML = `
        <div class="support-head">
          <div>
            <h3>${esc(ticket.subject)}</h3>
            <span class="hint">${esc(SUPPORT_CAT[ticket.category] || ticket.category)} · Ticket #${esc(ticket.id)} · ${supDate(ticket.created_at)}</span>
          </div>
          ${supBadge(ticket.status)}
        </div>
        <div class="sup-thread">
          ${messages.map(m => {
            const staff = !!m.is_staff;
            const who = staff ? 'Soporte Vantarmor' : (ticket.mine ? 'Tú' : 'Usuario');
            return `<div class="sup-msg ${staff ? 'staff' : 'user'}">
              <span class="hint">${esc(who)} · ${supDate(m.created_at)}</span>
              <p>${esc(m.body).replace(/\n/g, '<br>')}</p>
            </div>`;
          }).join('')}
        </div>
        ${closed ? '<p class="hint">Este ticket está cerrado. Abre uno nuevo si necesitas más ayuda.</p>' : `
        <form id="supReply" class="sup-reply" novalidate>
          <textarea class="textarea" id="supReplyText" rows="3" maxlength="2000" placeholder="Escribe tu respuesta"></textarea>
          <div class="form-actions">
            <button type="button" class="btn ghost sm" id="supClose">Cerrar ticket</button>
            <button type="submit" class="btn sm">Enviar</button>
          </div>
        </form>`}`;
      if (!closed) {
        $('supReply').addEventListener('submit', async e => {
          e.preventDefault();
          const text = $('supReplyText').value.trim();
          if (!text) return toast('Escribe tu respuesta', 'error');
          const btn = e.currentTarget.querySelector('[type="submit"]');
          setBusy(btn, true);
          try {
            await api(`/api/support/tickets/${encodeURIComponent(id)}/messages`, { method: 'POST', body: JSON.stringify({ body: text }) });
            await openSupportTicket(id);
            await loadSupport();
          } catch (err) {
            toast(err.message, 'error');
            setBusy(btn, false);
          }
        });
        $('supClose').addEventListener('click', async () => {
          if (!confirm('¿Cerrar este ticket? Ya no podrás responder.')) return;
          try {
            await api(`/api/support/tickets/${encodeURIComponent(id)}/close`, { method: 'POST' });
            toast('Ticket cerrado');
            await openSupportTicket(id);
            await loadSupport();
          } catch (err) { toast(err.message, 'error'); }
        });
      }
    } catch (err) {
      box.innerHTML = `<p class="hint">${esc(err.message)}</p>`;
    }
  }
  function openSupportNew() {
    const scriptOpts = scripts.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
    openModal('Nuevo ticket', `
      <form id="supNewForm" novalidate>
        <div class="input-group">
          <label for="supCat">Tipo de problema</label>
          <select id="supCat" class="field block" name="category">${Object.entries(SUPPORT_CAT).map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select>
        </div>
        <div class="input-group">
          <label for="supSubj">Asunto</label>
          <input id="supSubj" class="field block" name="subject" maxlength="100" placeholder="Ej.: Mi key dice que el HWID no coincide" autocomplete="off">
        </div>
        ${scripts.length ? `<div class="input-group">
          <label for="supScript">Script (opcional)</label>
          <select id="supScript" class="field block" name="scriptId"><option value="">Ninguno</option>${scriptOpts}</select>
        </div>` : ''}
        <div class="input-group">
          <label for="supBody">Describe el problema</label>
          <textarea id="supBody" class="textarea" name="body" rows="5" maxlength="2000" placeholder="Qué intentaste, qué error ves y desde qué equipo"></textarea>
          <div class="hint">No compartas tu contraseña ni tokens de tu cuenta.</div>
        </div>
        <div class="form-actions">
          <button type="button" class="btn ghost" data-close>Cancelar</button>
          <button type="submit" class="btn">Enviar ticket</button>
        </div>
      </form>`);
    $('supNewForm').addEventListener('submit', async e => {
      e.preventDefault();
      const fd = new FormData(e.currentTarget);
      const btn = e.currentTarget.querySelector('[type="submit"]');
      setBusy(btn, true);
      try {
        const data = await api('/api/support/tickets', { method: 'POST', body: JSON.stringify({
          category: fd.get('category'),
          subject: String(fd.get('subject') || ''),
          body: String(fd.get('body') || ''),
          scriptId: fd.get('scriptId') || null,
        }) });
        closeModal();
        toast('Ticket enviado');
        await loadSupport();
        await openSupportTicket(data.id);
      } catch (err) {
        toast(err.message, 'error');
        setBusy(btn, false);
      }
    });
  }
  $('supNew').addEventListener('click', openSupportNew);
  $('supList').addEventListener('click', e => {
    const b = e.target.closest('[data-sup-open]');
    if (b) openSupportTicket(b.dataset.supOpen);
  });
  document.querySelectorAll('#supScope [data-sup-scope]').forEach(b => b.addEventListener('click', () => {
    supScope = b.dataset.supScope;
    document.querySelectorAll('#supScope [data-sup-scope]').forEach(x => x.classList.toggle('on', x === b));
    loadSupport();
  }));

  // ---- Solo dueño: plans keys y publisher ----
  let ownerData = { planKeys: [], publisher: [], users: [], overview: null };
  const AUDIT_LABELS = { plan_key_create: 'Key de plan creada', user_plan: 'Plan cambiado', staff: 'Rol de staff', announce: 'Anuncio publicado', settings: 'Ajustes del sitio' };
  const fmtWhen = ts => new Date(ts * 1000).toLocaleString('es-EC', { dateStyle: 'short', timeStyle: 'short' });
  const PLAN_OPTIONS = [['free', 'Free'], ['premium', 'Premium'], ['plus', 'Premium Plus']];
  const hasPerkPlan = () => !!user && (user.plan === 'premium' || user.plan === 'plus');
  const hasPlusPlan = () => !!user && user.plan === 'plus';
  // Precios y Bienvenida se ven siempre; si no hay plan, aparecen con candado (sin redirigir)
  function applyLocks() {
    const locked = { precios: !hasPerkPlan(), bienvenida: !hasPlusPlan(), profile: !hasPerkPlan() };
    document.querySelectorAll('[data-lockable]').forEach(b => {
      const on = !!locked[b.dataset.lockable];
      b.classList.toggle('locked', on);
      if (on) b.setAttribute('aria-disabled', 'true'); else b.removeAttribute('aria-disabled');
    });
    document.querySelectorAll('.view[data-view]').forEach(v => {
      if (v.dataset.view in locked) v.classList.toggle('locked', locked[v.dataset.view]);
    });
  }
  function setPlusNav(allowed) {
    applyLocks();
  }
  function setPlanNav(allowed) {
    document.querySelectorAll('[data-plan-only]').forEach(b => { b.style.display = allowed ? '' : 'none'; });
  }
  function setOwnerNav(isOwner) {
    document.querySelectorAll('[data-owner-only]').forEach(b => { b.style.display = isOwner ? '' : 'none'; });
  }
  async function loadOwnerData() {
    if (!user || !user.owner) return;
    const [pk, pub, us, ov] = await Promise.allSettled([
      api('/api/owner/plan-keys'), api('/api/owner/publisher'), api('/api/owner/users'), api('/api/owner/overview'),
    ]);
    if (pk.status === 'fulfilled') ownerData.planKeys = pk.value;
    if (pub.status === 'fulfilled') ownerData.publisher = pub.value;
    if (us.status === 'fulfilled') ownerData.users = us.value;
    if (ov.status === 'fulfilled') ownerData.overview = ov.value;
    renderOwner();
    renderOverview();
  }


  // ---- Panel del dueño: Ofuscador 3, mantenimiento, ventas y registro ----
  function renderOverview() {
    const o = ownerData.overview;
    if (!o) {
      $('ownLuau').innerHTML = '<p class="hint">No pude cargar el resumen. Recarga la página.</p>';
      $('ownSales').innerHTML = $('ownAudit').innerHTML = '';
      return;
    }
    const l = o.luau;
    const [tone, label] = !l.configured ? ['bad', 'No configurado (falta LUO_API_KEY)']
      : l.noTokensAt ? ['bad', `Sin créditos desde ${fmtWhen(l.noTokensAt)}`]
      : ['ok', 'Operativo'];
    $('ownLuau').innerHTML = `
      <span class="badge ${tone}">${esc(label)}</span>
      <div class="owner-stat" style="margin-top:14px">
        <div><span class="card-label">Hoy</span><strong>${l.today}</strong><span class="hint">de todos los usuarios</span></div>
        <div><span class="card-label">Total</span><strong>${l.total}</strong><span class="hint">compilaciones</span></div>
      </div>
      <p class="hint" style="margin-top:14px">${l.lastError ? `Último error: <span class="mono">${esc(l.lastError)}</span>` : 'Sin errores registrados.'}</p>
      <p class="hint">La API no informa el saldo de tokens. Aquí ves las compilaciones hechas y si hubo falta de créditos.</p>`;

    const s = o.settings;

    const sa = o.sales;
    const planName = p => PLAN_OPTIONS.find(([v]) => v === p)?.[1] || p;
    const maxM = Math.max(1, ...sa.byMonth.map(m => m.count));
    $('ownSales').innerHTML = `
      <div class="owner-stat">
        ${sa.byPlan.map(p => `<div><span class="card-label">${esc(planName(p.plan))}</span><strong>${p.used}/${p.total}</strong><span class="hint">canjeadas / generadas</span></div>`).join('') || '<p class="hint">Aún no hay keys de plan.</p>'}
      </div>
      <h4 style="margin:18px 0 6px;font-size:13px">Canjes por mes (últimos 6)</h4>
      ${sa.byMonth.length ? sa.byMonth.map(m => `<div class="owner-month"><span>${esc(m.month)}</span><div class="owner-bar"><i style="width:${Math.round(m.count / maxM * 100)}%"></i></div><b>${m.count}</b></div>`).join('') : '<p class="hint">Sin canjes en los últimos 6 meses.</p>'}
      <h4 style="margin:18px 0 6px;font-size:13px">Usuarios por plan</h4>
      <p class="hint">${sa.usersByPlan.map(u => `${esc(planName(u.plan))}: <b>${u.count}</b>`).join(' · ')}</p>`;

    $('ownAudit').innerHTML = o.audit.length ? `<div class="owner-audit">${o.audit.map(a => `
      <div class="owner-audit-row"><span class="hint">${fmtWhen(a.created_at)}</span><b>${esc(AUDIT_LABELS[a.action] || a.action)}</b><span>${esc(a.target)}${a.detail ? ` <span class="hint">· ${esc(a.detail)}</span>` : ''}</span></div>`).join('')}</div>`
      : '<p class="hint">Aún no hay acciones registradas.</p>';
  }
  $('maintRetry').addEventListener('click', () => location.reload());
  // Banner y aviso de mantenimiento visibles para todos
  async function loadSiteStatus() {
    try {
      const st = await api('/api/status');
      const parts = [];
      const bs = $('botServers');
      if (bs) {
        bs.hidden = typeof st.servers !== 'number';
        bs.textContent = `Bot en ${st.servers} ${st.servers === 1 ? 'servidor' : 'servidores'}`;
      }
      const box = $('siteNotice');
      // Mantenimiento: pantalla completa para los usuarios; el dueño sigue entrando y ve el aviso normal
      // Mantenimiento total: la web entera se muestra cerrada, también al dueño
      const fullScreen = !!st.maintenance && (!(user && user.owner) || !!st.maintenanceAll);
      $('maintMsg').textContent = st.message || 'Volvemos en unos minutos.';
      $('maintNote').textContent = st.maintenanceAll ? "Todo está pausado mientras trabajamos: la web, los loaders y el bot. Volvemos pronto." : "Tus scripts y loaders siguen funcionando. Las compras y los canjes se reanudan en cuanto terminemos.";
      $('maintScreen').hidden = !fullScreen;
      document.body.style.overflow = fullScreen ? 'hidden' : '';
      if (st.maintenance && !fullScreen) parts.unshift(`<strong>Mantenimiento:</strong> ${esc(st.message || 'Estamos en mantenimiento.')}`);
      if (st.banner) parts.push(esc(st.banner));
      box.innerHTML = fullScreen ? '' : parts.join(' · ');
      box.hidden = !box.innerHTML;
      box.classList.toggle('maint', !!st.maintenance);
    } catch (_) { /* sin aviso si el estado no responde */ }
  }
  function renderUsers() {
    $('userList').innerHTML = ownerData.users.length ? ownerData.users.map(u => `
      <div class="row" style="padding:10px 0;border-top:1px solid var(--border);gap:10px;flex-wrap:wrap;">
        <b style="flex:1;min-width:160px;">${esc(u.username || u.id)}</b>
        <span style="font-size:13px;color:var(--text-soft);">${u.scripts} scripts · ${u.obf_used || 0} ofuscaciones</span>
        <select class="field" data-user-plan="${esc(u.id)}" style="min-width:150px;">
          ${PLAN_OPTIONS.map(([v, l]) => `<option value="${v}" ${v === (u.plan || 'free') ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        <button class="btn ghost sm" data-user-save="${esc(u.id)}" type="button">Guardar</button>
      </div>`).join('') : '<p class="empty-line">Aún no hay usuarios.</p>';
  }
  $('userList').addEventListener('click', async e => {
    const b = e.target.closest('[data-user-save]');
    if (!b) return;
    const sel = document.querySelector(`[data-user-plan="${CSS.escape(b.dataset.userSave)}"]`);
    setBusy(b, true);
    try {
      await api(`/api/owner/users/${encodeURIComponent(b.dataset.userSave)}/plan`, { method: 'POST', body: JSON.stringify({ plan: sel.value }) });
      toast('Plan actualizado');
      await loadOwnerData();
    } catch (err) {
      toast(err.message, 'error');
      setBusy(b, false);
    }
  });
  function renderOwner() {
    renderUsers();
    $('pkList').innerHTML = ownerData.planKeys.length ? ownerData.planKeys.map(k => `
      <div class="row" style="padding:10px 0;border-top:1px solid var(--border);gap:10px;flex-wrap:wrap;">
        <code style="word-break:break-all;flex:1;min-width:200px;">${esc(k.key)}</code>
        <span class="badge ${k.plan === 'plus' ? 'ok' : ''}">${k.plan === 'plus' ? 'Premium Plus' : 'Premium'}</span>
        <span class="badge ${k.used_by ? 'bad' : 'ok'}">${k.used_by ? 'Usada' : 'Disponible'}</span>
        <button class="btn ghost sm" data-pk-copy="${esc(k.key)}">Copiar</button>
      </div>`).join('') : '<p class="empty-line">Aún no hay keys de plan.</p>';
    $('pubList').innerHTML = ownerData.publisher.length ? ownerData.publisher.map(s => `
      <div style="padding:12px 0;border-top:1px solid var(--border);">
        <div class="row" style="gap:10px;flex-wrap:wrap;">
          <b style="flex:1;min-width:160px;">${esc(s.name)}</b>
          <span style="font-size:13px;color:var(--text-soft);">${esc(s.username || s.user_id)} · ${s.ffa ? 'FFA' : esc(s.obfuscator || '')}</span>
          <button class="btn ghost sm" data-pub-copy="${esc(s.id)}">Copiar source</button>
          <button class="btn ghost sm" data-pub-dl="${esc(s.id)}">Descargar .txt</button>
        </div>
        <pre style="margin:10px 0 0;max-height:180px;overflow:auto;background:#000;border:1px solid var(--border);border-radius:10px;padding:10px;font-size:12px;white-space:pre-wrap;">${esc(s.source || '')}</pre>
      </div>`).join('') : '<p class="empty-line">Aún no hay scripts.</p>';
  }
  $('pkGen').addEventListener('click', async e => {
    const btn = e.currentTarget;
    setBusy(btn, true);
    try {
      await api('/api/owner/plan-keys', { method: 'POST', body: JSON.stringify({ plan: $('pkPlan').value }) });
      toast('Key generada');
      await loadOwnerData();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(btn, false);
    }
  });
  $('pkList').addEventListener('click', e => {
    const b = e.target.closest('[data-pk-copy]');
    if (b) copyText(b.dataset.pkCopy, 'Key copiada');
  });
  $('pubList').addEventListener('click', e => {
    const c = e.target.closest('[data-pub-copy]');
    if (c) {
      const s = ownerData.publisher.find(x => String(x.id) === c.dataset.pubCopy);
      if (s) copyText(s.source || '', 'Source copiado');
      return;
    }
    const b = e.target.closest('[data-pub-dl]');
    if (!b) return;
    const s = ownerData.publisher.find(x => String(x.id) === b.dataset.pubDl);
    if (!s) return;
    const blob = new Blob([s.source || ''], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${s.slug || 'script'}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  function renderAll() {
    renderUser();
    renderCounts();
    renderKeyScriptFilter();
    renderDashboard();
    renderScripts();
    renderKeys();
    renderPlans();
  }

  // ---------- SESIÓN ----------
  // Evita el bucle: si /api/me falla varias veces seguidas, se muestra un aviso
  // en vez de volver a /login una y otra vez.
  function authLoopCount() {
    try {
      const now = Date.now();
      const list = (JSON.parse(sessionStorage.getItem(AUTH_LOOP_KEY)) || []).filter(t => now - t < 60000);
      return list.length;
    } catch (_) { return 0; }
  }
  function recordAuthRedirect() {
    try {
      const now = Date.now();
      const list = (JSON.parse(sessionStorage.getItem(AUTH_LOOP_KEY)) || []).filter(t => now - t < 60000);
      list.push(now);
      sessionStorage.setItem(AUTH_LOOP_KEY, JSON.stringify(list));
    } catch (_) {}
  }
  function clearAuthLoop() {
    try { sessionStorage.removeItem(AUTH_LOOP_KEY); } catch (_) {}
  }

  function showAuthError(reason = '') {
    $('userName').textContent = 'Sin sesión';
    $('authReason').textContent = reason ? `Motivo: ${reason}` : '';
    showView('auth');
    setSidebar(!isMobile());
  }

  // ---------- CHAT DE LA COMUNIDAD ----------
  let chatMessages = [];
  let chatES = null;            // conexión en vivo (SSE)
  let chatPollTimer = null;     // respaldo si la conexión en vivo no funciona
  let chatReplyTo = null;       // { id, name } del mensaje al que se responde
  let chatHasMore = false;
  let chatPickerFor = null;     // id del mensaje con el selector de reacciones abierto
  let canModerateChat = false;
  const CHAT_REACTION_EMOJIS = ['👍', '❤️', '😂', '🔥', '😮', '😢'];
  // Colores y nombre de cada rol en el chat
  const ROLE_STYLE = {
    owner:   { label: 'Owner',        color: '#ff5c7a' },
    admin:   { label: 'Admin',        color: '#5865f2' },
    plus:    { label: 'Premium Plus', color: '#2ecc71' },
    premium: { label: 'Premium',      color: '#f1c40f' },
    free:    { label: 'Free',         color: '#99aab5' },
  };
  const chatAvatar = m => m.avatar
    ? `<img src="${esc(m.avatar)}" alt="" referrerpolicy="no-referrer">`
    : esc((m.username || '?').charAt(0).toUpperCase());
  const CHAT_TZ = 'America/Guayaquil';
  const chatDayKey = ts => new Date(ts * 1000).toLocaleDateString('en-CA', { timeZone: CHAT_TZ }); // AAAA-MM-DD
  const chatTime = ts => new Date(ts * 1000).toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit', timeZone: CHAT_TZ });
  // "Hoy 14:20", "Ayer 14:20" o "27 oct 14:20"
  const chatWhen = ts => {
    const now = Date.now() / 1000;
    const d = chatDayKey(ts);
    if (d === chatDayKey(now)) return `Hoy ${chatTime(ts)}`;
    if (d === chatDayKey(now - 86400)) return `Ayer ${chatTime(ts)}`;
    const day = new Date(ts * 1000).toLocaleDateString('es-EC', { day: '2-digit', month: 'short', timeZone: CHAT_TZ });
    return `${day} ${chatTime(ts)}`;
  };
  // Separador con el día cuando cambia (como en las apps de mensajes)
  const chatDaySeparator = ts => {
    const label = chatWhen(ts).replace(/ \d{1,2}:\d{2}.*$/, '');
    return `<div class="chat-day"><span>${esc(label)}</span></div>`;
  };
  // Te mencionan si aparece @tuNombre (sin distinguir mayúsculas)
  const chatMentionsMe = text => {
    if (!user?.username) return false;
    const name = user.username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`@${name}(?!\\w)`, 'i').test(String(text));
  };
  const chatAtBottom = list => list.scrollHeight - list.scrollTop - list.clientHeight < 60;

  let chatQuery = '';
  function renderChat(scrollToEnd) {
    const list = $('chatList');
    const wasAtBottom = chatAtBottom(list);
    if (!chatMessages.length) {
      list.innerHTML = '<div class="chat-empty">Todavía no hay mensajes. ¡Escribe el primero!</div>';
      return;
    }
    const shown = chatQuery ? chatMessages.filter(m => String(m.text).toLowerCase().includes(chatQuery)) : chatMessages;
    if (!shown.length) {
      list.innerHTML = '<div class="chat-empty">Ningún mensaje coincide con la búsqueda.</div>';
      return;
    }
    const more = chatHasMore && !chatQuery ? '<button class="chat-more" id="chatMore" type="button">Cargar mensajes anteriores</button>' : '';
    let prev = null;
    list.innerHTML = more + shown.map(m => {
      const mine = !!user && m.user_id === user.id;
      const canDelete = mine || canModerateChat;
      const canMute = canModerateChat && !mine;
      const rs = ROLE_STYLE[m.role] || ROLE_STYLE.free;
      // Mensajes seguidos del mismo usuario (sin respuesta y con menos de 5 min): se agrupan
      const grouped = !!prev && prev.user_id === m.user_id && !m.reply && (m.created_at - prev.created_at) < 300;
      const newDay = !prev || chatDayKey(prev.created_at) !== chatDayKey(m.created_at);
      const daySep = newDay ? chatDaySeparator(m.created_at) : '';
      prev = m;
      const mention = !mine && chatMentionsMe(m.text);
      const chips = (m.reactions || []).filter(r => r.count > 0).map(r =>
        `<button class="chat-react${r.mine ? ' on' : ''}" data-react="${m.id}" data-emoji="${esc(r.emoji)}" type="button">${esc(r.emoji)} ${r.count}</button>`).join('');
      const picker = chatPickerFor === m.id
        ? `<span class="chat-picker">${CHAT_REACTION_EMOJIS.map(e => `<button type="button" data-react="${m.id}" data-emoji="${e}">${e}</button>`).join('')}</span>`
        : '';
      const flag = canModerateChat && m.reports ? `<button class="chat-flag" data-clear-reports="${m.id}" type="button" title="Descartar reportes">🚩 ${m.reports}</button>` : '';
      return `${daySep}<div class="chat-msg${mine ? ' mine' : ''}${grouped ? ' grouped' : ''}" data-id="${m.id}">
        <div class="chat-av">${grouped ? '' : chatAvatar(m)}</div>
        <div class="chat-bubble${mention ? ' mention' : ''}" style="flex:1;min-width:0">
          ${grouped ? '' : `<div class="chat-head"><b style="color:${rs.color}">${esc(m.username)}</b><span class="chat-badge" style="color:${rs.color}">${rs.label}</span><span title="${esc(new Date(m.created_at * 1000).toLocaleString('es-EC', { dateStyle: 'full', timeStyle: 'short', timeZone: CHAT_TZ }))}">${chatWhen(m.created_at)}</span></div>`}
          ${m.reply ? `<div class="chat-quote">↪ <b>${esc(m.reply.username)}</b>: ${esc(m.reply.text)}</div>` : ''}
          <div class="chat-text">${esc(m.text)}</div>
          <div class="chat-foot">
            ${chips}
            <button class="chat-react add" data-picker="${m.id}" type="button" title="Reaccionar">＋</button>${picker}
            <span class="chat-tools">
              <button class="chat-reply" data-reply="${m.id}" data-name="${esc(m.username)}" type="button" title="Responder">↩</button>
              ${!mine ? `<button class="chat-report" data-report="${m.id}" type="button" title="Reportar">⚑</button>` : ''}
              ${canMute ? `<button class="chat-mod" data-mute="${esc(m.user_id)}" data-name="${esc(m.username)}" type="button" title="Silenciar">🔇</button>` : ''}
              ${canDelete ? `<button class="chat-del" data-del="${m.id}" type="button" title="Borrar">🗑</button>` : ''}
            </span>
            ${flag}
          </div>
        </div>
      </div>`;
    }).join('');
    if (scrollToEnd || wasAtBottom) list.scrollTop = list.scrollHeight;
    $('chatNew').hidden = chatAtBottom(list);
  }

  // Agrega un mensaje nuevo (sin duplicar el que ya llegó por la conexión en vivo)
  function upsertChatMessage(m, scrollToEnd = false) {
    if (chatMessages.some(x => x.id === m.id)) return;
    chatMessages = chatMessages.concat([m]).slice(-300);
    renderChat(scrollToEnd);
    notifyChatMention(m);
  }

  // Aviso del navegador cuando te mencionan o responden a tu mensaje y no estás viendo la pestaña
  function notifyChatMention(m) {
    if (!user || m.user_id === user.id || !document.hidden) return;
    const mentioned = chatMentionsMe(m.text);
    const repliedToMe = m.reply && m.reply.username === user.username;
    if (!mentioned && !repliedToMe) return;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    try {
      new Notification(`${m.username} ${mentioned ? 'te mencionó' : 'respondió a tu mensaje'} en el chat`, { body: String(m.text).slice(0, 120), tag: 'vm-chat' });
    } catch (_) { /* el navegador puede bloquear avisos: no pasa nada */ }
  }
  $('chatSearch').addEventListener('input', e => { chatQuery = e.target.value.trim().toLowerCase(); renderChat(false); });
  $('chatNotify').addEventListener('click', async () => {
    if (!('Notification' in window)) { toast('Tu navegador no permite avisos', 'error'); return; }
    const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    toast(perm === 'granted' ? 'Te avisaremos cuando te mencionen' : 'Avisos desactivados en el navegador', perm === 'granted' ? 'ok' : 'error');
  });

  // Primera carga: últimos mensajes. Después pide solo los nuevos (after = último id)
  async function loadChat({ scrollToEnd = false } = {}) {
    try {
      const last = chatMessages.length ? chatMessages[chatMessages.length - 1].id : 0;
      const data = await api(`/api/chat${last ? `?after=${last}` : ''}`);
      canModerateChat = !!data.canModerate;
      $('chatOnline').textContent = `🟢 ${data.online} en línea`;
      $('chatWordsBtn').hidden = !canModerateChat;
      if (!last) { chatMessages = data.messages; chatHasMore = data.hasMore; }
      else if (data.messages.length) chatMessages = chatMessages.concat(data.messages).slice(-300);
      else return;
      renderChat(scrollToEnd || !last);
    } catch (err) {
      if (!chatMessages.length) $('chatList').innerHTML = `<div class="chat-empty">No se pudo cargar el chat: ${esc(err.message)}</div>`;
    }
  }

  async function loadOlderChat() {
    const oldest = chatMessages[0];
    if (!oldest) return;
    const list = $('chatList');
    const before = list.scrollHeight;
    try {
      const data = await api(`/api/chat?before=${oldest.id}`);
      chatMessages = data.messages.concat(chatMessages);
      chatHasMore = data.hasMore;
      renderChat(false);
      list.scrollTop += list.scrollHeight - before; // conserva la posición de lectura
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // Conexión en vivo: si falla, pasa a consultar cada 4 s
  function connectChatStream() {
    if (chatES || !window.EventSource) return false;
    const es = new EventSource('/api/chat/stream');
    chatES = es;
    const parse = e => JSON.parse(e.data);
    es.addEventListener('message', e => {
      const m = parse(e);
      upsertChatMessage(m, m.user_id === user?.id);
    });
    es.addEventListener('delete', e => {
      const { id } = parse(e);
      chatMessages = chatMessages.filter(m => m.id !== id);
      renderChat(false);
    });
    es.addEventListener('reactions', e => {
      const { messageId, counts } = parse(e);
      const m = chatMessages.find(x => x.id === messageId);
      if (!m) return;
      const mineNow = new Set((m.reactions || []).filter(r => r.mine).map(r => r.emoji));
      m.reactions = CHAT_REACTION_EMOJIS.map(emoji => ({ emoji, count: counts[emoji] || 0, mine: mineNow.has(emoji) }));
      renderChat(false);
    });
    es.addEventListener('reports', e => {
      const { messageId, count } = parse(e);
      const m = chatMessages.find(x => x.id === messageId);
      if (!m) return;
      m.reports = count;
      renderChat(false);
    });
    es.addEventListener('online', e => { $('chatOnline').textContent = `🟢 ${parse(e).online} en línea`; });
    es.onerror = () => {
      es.close();
      chatES = null;
      startChatFallback();
    };
    return true;
  }

  function startChatFallback() {
    if (chatPollTimer) return;
    chatPollTimer = setInterval(() => { if (!document.hidden) loadChat(); }, 4000);
  }

  function startChatPolling() {
    stopChatPolling();
    loadChat({ scrollToEnd: true }).then(() => {
      if (!connectChatStream()) startChatFallback();
    });
  }
  function stopChatPolling() {
    if (chatES) { chatES.close(); chatES = null; }
    if (chatPollTimer) { clearInterval(chatPollTimer); chatPollTimer = null; }
  }

  function setChatReply(id, name) {
    chatReplyTo = { id: Number(id), name };
    $('chatReplyingText').textContent = `Respondiendo a ${name}`;
    $('chatReplying').hidden = false;
    $('chatInput').focus();
  }
  function clearChatReply() {
    chatReplyTo = null;
    $('chatReplying').hidden = true;
  }
  $('chatReplyCancel').addEventListener('click', clearChatReply);
  $('chatNew').addEventListener('click', () => {
    const list = $('chatList');
    list.scrollTop = list.scrollHeight;
    $('chatNew').hidden = true;
  });
  $('chatList').addEventListener('scroll', () => {
    const list = $('chatList');
    if (chatAtBottom(list)) $('chatNew').hidden = true;
  });

  $('chatForm').addEventListener('submit', async e => {
    e.preventDefault();
    const input = $('chatInput');
    const text = input.value.trim();
    if (!text) return;
    $('chatSend').disabled = true;
    try {
      const data = await api('/api/chat', { method: 'POST', body: JSON.stringify({ text, replyTo: chatReplyTo?.id ?? null }) });
      input.value = '';
      clearChatReply();
      upsertChatMessage(data.message, true);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      $('chatSend').disabled = false;
      input.focus();
    }
  });

  $('chatList').addEventListener('click', async e => {
    if (e.target.closest('#chatMore')) return loadOlderChat();

    const react = e.target.closest('[data-react]');
    if (react) {
      try {
        const data = await api(`/api/chat/${react.dataset.react}/react`, { method: 'POST', body: JSON.stringify({ emoji: react.dataset.emoji }) });
        const m = chatMessages.find(x => String(x.id) === react.dataset.react);
        if (m) m.reactions = CHAT_REACTION_EMOJIS.map(emoji => ({ emoji, count: data.counts[emoji] || 0, mine: data.mine.includes(emoji) }));
        chatPickerFor = null;
        renderChat(false);
      } catch (err) { toast(err.message, 'error'); }
      return;
    }
    const picker = e.target.closest('[data-picker]');
    if (picker) {
      const id = Number(picker.dataset.picker);
      chatPickerFor = chatPickerFor === id ? null : id;
      renderChat(false);
      return;
    }
    const reply = e.target.closest('[data-reply]');
    if (reply) return setChatReply(reply.dataset.reply, reply.dataset.name);

    const report = e.target.closest('[data-report]');
    if (report) {
      const reason = prompt('¿Por qué reportas este mensaje? (opcional)', '');
      if (reason === null) return;
      try {
        await api(`/api/chat/${report.dataset.report}/report`, { method: 'POST', body: JSON.stringify({ reason }) });
        toast('Reporte enviado. Gracias.');
      } catch (err) { toast(err.message, 'error'); }
      return;
    }
    const clear = e.target.closest('[data-clear-reports]');
    if (clear) {
      if (!confirm('¿Descartar los reportes de este mensaje?')) return;
      try {
        await api(`/api/chat/${clear.dataset.clearReports}/reports`, { method: 'DELETE' });
        const m = chatMessages.find(x => String(x.id) === clear.dataset.clearReports);
        if (m) m.reports = 0;
        renderChat(false);
      } catch (err) { toast(err.message, 'error'); }
      return;
    }

    const mute = e.target.closest('[data-mute]');
    if (mute) {
      const minutes = prompt(`Minutos de silencio para ${mute.dataset.name} (0 para quitarlo)`, '10');
      if (minutes === null) return;
      try {
        await api('/api/chat/mute', { method: 'POST', body: JSON.stringify({ userId: mute.dataset.mute, minutes: Number(minutes) }) });
        toast('Listo');
      } catch (err) { toast(err.message, 'error'); }
      return;
    }
    const btn = e.target.closest('[data-del]');
    if (!btn) return;
    if (!confirm('¿Borrar este mensaje?')) return;
    try {
      await api(`/api/chat/${btn.dataset.del}`, { method: 'DELETE' });
      chatMessages = chatMessages.filter(m => String(m.id) !== btn.dataset.del);
      renderChat(false);
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // Palabras bloqueadas (solo staff)
  async function renderChatWords() {
    const box = $('chatWords');
    try {
      const data = await api('/api/chat/words');
      box.innerHTML = `
        <div class="chat-words-form">
          <input id="chatWordInput" class="field" type="text" maxlength="40" placeholder="Nueva palabra bloqueada" aria-label="Nueva palabra">
          <button class="btn sm" id="chatWordAdd" type="button">Agregar</button>
        </div>
        <div class="chat-words-list">${data.words.length
          ? data.words.map(w => `<span class="chat-word">${esc(w)} <button type="button" data-word="${esc(w)}" aria-label="Quitar ${esc(w)}">✕</button></span>`).join('')
          : '<span class="muted">No hay palabras bloqueadas.</span>'}</div>`;
    } catch (err) {
      box.innerHTML = `<span class="muted">${esc(err.message)}</span>`;
    }
  }
  $('chatWordsBtn').addEventListener('click', () => {
    const box = $('chatWords');
    box.hidden = !box.hidden;
    if (!box.hidden) renderChatWords();
  });
  $('chatWords').addEventListener('click', async e => {
    if (e.target.closest('#chatWordAdd')) {
      const word = $('chatWordInput').value.trim();
      if (!word) return;
      try {
        await api('/api/chat/words', { method: 'POST', body: JSON.stringify({ word }) });
        renderChatWords();
      } catch (err) { toast(err.message, 'error'); }
      return;
    }
    const rm = e.target.closest('[data-word]');
    if (rm) {
      try {
        await api(`/api/chat/words/${encodeURIComponent(rm.dataset.word)}`, { method: 'DELETE' });
        renderChatWords();
      } catch (err) { toast(err.message, 'error'); }
    }
  });

  // ---------- ESTADÍSTICAS DE EJECUCIÓN ----------
  let execDays = 7;
  const dayKey = offset => new Date(Date.now() - offset * 86400000).toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' });
  // ---- Estadísticas: ejecuciones por país (mapa D3 con zoom, ranking y KPI). Solo código de país. ----
  const GEO_NAMES = typeof Intl.DisplayNames === 'function' ? new Intl.DisplayNames(['es'], { type: 'region' }) : null;
  const countryName = code => { try { return GEO_NAMES?.of(code) || code; } catch { return code; } };
  const flagOf = code => /^[A-Z]{2}$/.test(code || '') ? String.fromCodePoint(...[...code].map(c => 127397 + c.charCodeAt(0))) : '';
  let geoMapState = null; // { g, zoom, svg, path, features, alphaByNum, byCode }

  async function buildGeoMap() {
    const d3 = window.d3;
    const svg = d3.select($('geoMap'));
    const [world, meta] = await Promise.all([
      fetch('https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-50m.json').then(r => r.json()),
      fetch('https://cdn.jsdelivr.net/npm/world-countries@5.0.0/countries.json').then(r => r.json()),
    ]);
    const alphaByNum = new Map(meta.map(c => [String(c.ccn3 || '').padStart(3, '0'), c.cca2]));
    const latlngByCode = new Map(meta.map(c => [c.cca2, c.latlng]));
    const features = window.topojson.feature(world, world.objects.countries).features;
    const width = 960, height = 470;
    svg.attr('viewBox', `0 0 ${width} ${height}`).attr('preserveAspectRatio', 'xMidYMid meet');
    svg.selectAll('*').remove();
    const projection = d3.geoNaturalEarth1().fitSize([width - 20, height - 20], { type: 'Sphere' }).translate([width / 2, height / 2]);
    const path = d3.geoPath(projection);
    const g = svg.append('g');
    g.append('path').attr('class', 'sphere').attr('d', path({ type: 'Sphere' }));
    g.append('path').attr('class', 'grat').attr('d', path(d3.geoGraticule10()));
    const paths = g.selectAll('path.country').data(features).join('path')
      .attr('class', 'country').attr('d', path);
    g.append('g').attr('class', 'labels');
    g.append('g').attr('class', 'dots');
    const zoom = d3.zoom().scaleExtent([1, 8]).translateExtent([[0, 0], [width, height]])
      .on('zoom', e => g.attr('transform', e.transform));
    svg.call(zoom);
    geoMapState = { g, zoom, svg, path, projection, paths, features, alphaByNum, latlngByCode, byCode: new Map() };
    paths.each(function (f) {
      const code = alphaByNum.get(String(f.id).padStart(3, '0'));
      if (code) geoMapState.byCode.set(code, { el: this, f });
    });
  }

  function colorGeoMap(counts, max) {
    const d3 = window.d3;
    const { g, path, projection, byCode, latlngByCode } = geoMapState;
    const top = Math.max(2, max);
    // Escala logarítmica: los países pequeños en volumen también se distinguen
    const scale = d3.scaleSequentialLog(d3.interpolateRgb('#3d3d4f', '#ffffff')).domain([1, top]).clamp(true);
    const tip = $('geoTip');
    const wrap = $('geoMap').parentNode;
    const bindTip = (sel, code, n) => {
      sel.on('mouseenter', () => {
        tip.innerHTML = `<b>${flagOf(code)} ${esc(countryName(code))}</b>${n.toLocaleString('es-EC')} ejecuciones`;
        tip.hidden = false;
      }).on('mousemove', event => {
        const [x, y] = d3.pointer(event, wrap);
        tip.style.left = `${x}px`;
        tip.style.top = `${y}px`;
      }).on('mouseleave', () => { tip.hidden = true; });
    };
    geoMapState.paths.each(function (f) {
      const code = geoMapState.alphaByNum.get(String(f.id).padStart(3, '0'));
      const n = code ? counts.get(code) || 0 : 0;
      const el = d3.select(this);
      el.classed('has', n > 0).attr('fill', n ? scale(n) : null);
      el.on('mouseenter', null).on('mousemove', null).on('mouseleave', null);
      if (n) bindTip(el, code, n);
    });
    // Países tan pequeños que no se ven en el mapa: punto en su ubicación real
    const dots = g.select('g.dots');
    dots.selectAll('*').remove();
    [...counts.entries()].forEach(([code, n]) => {
      const hit = byCode.get(code);
      const ll = latlngByCode.get(code);
      if (!hit || !ll) return;
      const [[x0, y0], [x1, y1]] = path.bounds(hit.f);
      if (x1 - x0 >= 6 && y1 - y0 >= 6) return;
      const [x, y] = projection([ll[1], ll[0]]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      const r = 3 + 3 * Math.sqrt(n / top);
      const dot = dots.append('circle').attr('class', 'dot').attr('cx', x).attr('cy', y).attr('r', r)
        .attr('fill', scale(n));
      bindTip(dot, code, n);
    });
    // Etiquetas de los 5 países con más ejecuciones
    const labels = g.select('g.labels');
    labels.selectAll('*').remove();
    const topFive = [...counts.entries()].sort((x, y) => y[1] - x[1]).slice(0, 5);
    topFive.forEach(([code]) => {
      const hit = byCode.get(code);
      if (!hit) return;
      const [x, y] = path.centroid(hit.f);
      if (!Number.isFinite(x)) return;
      labels.append('text').attr('class', 'lbl').attr('x', x).attr('y', y).attr('text-anchor', 'middle').text(code);
    });
    // Resalta el país al pasar el cursor sobre la lista
    $('geoList').querySelectorAll('[data-code]').forEach(li => {
      li.onmouseenter = () => { const hit = byCode.get(li.dataset.code); if (hit) d3.select(hit.el).classed('hl', true); };
      li.onmouseleave = () => { const hit = byCode.get(li.dataset.code); if (hit) d3.select(hit.el).classed('hl', false); };
    });
    $('geoMax').textContent = max.toLocaleString('es-EC');
  }

  // D3 y topojson solo se cargan cuando se abre Estadísticas (no pesan en el resto del dashboard)
  let mapLibsPromise = null;
  const loadScript = src => new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.async = true;
    s.onload = resolve; s.onerror = () => reject(new Error(src));
    document.head.appendChild(s);
  });
  function ensureD3() {
    if (window.d3 && window.topojson) return Promise.resolve(true);
    if (!mapLibsPromise) {
      mapLibsPromise = Promise.all([
        loadScript('https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js'),
        loadScript('https://cdn.jsdelivr.net/npm/topojson-client@3.1.0/dist/topojson-client.min.js'),
      ]).then(() => true, () => { mapLibsPromise = null; return false; });
    }
    return mapLibsPromise;
  }

  // Filtro de estadísticas por script y datos actuales para exportar
  let statScript = 'all';
  let statCache = null;
  const statQuery = () => (statScript === 'all' ? '' : `&script=${encodeURIComponent(statScript)}`);
  function renderStatScript() {
    const sel = $('statScript');
    sel.innerHTML = '<option value="all">Todos los scripts</option>' +
      scripts.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
    sel.value = [...sel.options].some(o => o.value === statScript) ? statScript : 'all';
    statScript = sel.value;
  }
  $('statScript').addEventListener('change', e => { statScript = e.target.value; loadExecStats(); });
  $('statCsv').addEventListener('click', () => {
    if (!statCache) { toast('Aún no hay datos para exportar', 'error'); return; }
    const rows = [['Sección', 'Clave', 'Valor']];
    (statCache.byDay || []).forEach(d => rows.push(['Ejecuciones por día', d.day, d.n]));
    (statCache.byScript || []).forEach(s => rows.push(['Scripts', s.name, s.n]));
    (statCache.countries || []).forEach(c => rows.push(['Países (30 días)', c.country, c.n]));
    const csv = '\ufeff' + rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `vantarmor-estadisticas-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  async function loadGeoStats() {
    const list = $('geoList');
    const sub = $('geoSub');
    try {
      const [data, ex] = await Promise.all([api(`/api/stats/countries?days=30${statQuery()}`), api(`/api/stats/executions?days=30${statQuery()}`)]);
      statCache = { ...(statCache || {}), countries: data.countries };
      const counts = new Map(data.countries.map(c => [c.country, c.n]));
      const max = Math.max(1, ...data.countries.map(c => c.n));
      const top = data.countries[0];
      sub.textContent = data.total
        ? `${data.total.toLocaleString('es-EC')} ejecuciones · últimos ${data.days} días`
        : `Últimos ${data.days} días`;
      $('kpiTotal').textContent = ex.total.toLocaleString('es-EC');
      const delta = ex.prevTotal ? Math.round((ex.total - ex.prevTotal) / ex.prevTotal * 100) : null;
      const subEl = $('kpiTotalSub');
      subEl.className = 'kpi-sub' + (delta == null ? '' : delta >= 0 ? ' up' : ' down');
      subEl.textContent = delta != null
        ? `${delta >= 0 ? '▲' : '▼'} ${Math.abs(delta)}% vs. 30 días anteriores`
        : (ex.total ? 'De todos tus scripts' : 'Aún sin ejecuciones');
      $('kpiCountries').textContent = data.countries.length;
      $('kpiTop').textContent = top ? `${flagOf(top.country)} ${countryName(top.country)}` : '—';
      $('kpiTopSub').textContent = top ? `${Math.round(top.n / data.total * 100)}% de las ejecuciones` : '';
      $('kpiAvg').textContent = Math.round(ex.total / 30).toLocaleString('es-EC');
      list.innerHTML = data.countries.length
        ? data.countries.slice(0, 10).map((c, i) => `
          <li class="geo-row" data-code="${esc(c.country)}">
            <span class="geo-rank">${i + 1}</span>
            <span class="geo-name">${flagOf(c.country)} ${esc(countryName(c.country))}</span>
            <span class="geo-num">${c.n.toLocaleString('es-EC')}<small>${Math.round(c.n / data.total * 100)}%</small></span>
            <div class="geo-bar"><i style="width:${Math.round(c.n / max * 100)}%"></i></div></li>`).join('')
        : '<li class="geo-empty">Aún no hay ejecuciones con país registrado.</li>';
      if (!(await ensureD3())) {
        $('geoMap').closest('.geo-map-wrap').classList.add('geo-off');
        return;
      }
      try {
        if (!geoMapState) await buildGeoMap();
        colorGeoMap(counts, max);
      } catch (mapErr) {
        $('geoMap').closest('.geo-map-wrap').classList.add('geo-off');
      }
    } catch (err) {
      list.innerHTML = '<li class="geo-empty">No se pudieron cargar los países.</li>';
    }
  }

  $('geoZoomIn').addEventListener('click', () => geoMapState && geoMapState.svg.transition().call(geoMapState.zoom.scaleBy, 1.6));
  $('geoZoomOut').addEventListener('click', () => geoMapState && geoMapState.svg.transition().call(geoMapState.zoom.scaleBy, 1 / 1.6));
  $('geoReset').addEventListener('click', () => geoMapState && geoMapState.svg.transition().call(geoMapState.zoom.transform, window.d3.zoomIdentity));

  async function loadExecStats() {
    try {
      renderStatScript();
      loadGeoStats();
      const data = await api(`/api/stats/executions?days=${execDays}${statQuery()}`);
      statCache = { ...(statCache || {}), byDay: data.byDay, byScript: data.byScript };
      const counts = new Map(data.byDay.map(r => [r.day, r.n]));
      const series = Array.from({ length: execDays }, (_, i) => {
        const day = dayKey(execDays - 1 - i);
        return { day, n: counts.get(day) || 0 };
      });
      renderExecChart(series);
      renderUnusedKeys();
      try {
        const hr = await api(`/api/stats/hourly?days=${execDays}${statQuery()}`);
        renderHourChart(hr.hours);
      } catch (_) {
        $('hourChart').innerHTML = '<div class="empty-line">No se pudo cargar la hora de las ejecuciones.</div>';
      }
      const maxS = Math.max(1, ...data.byScript.map(s => s.n));
      const totS = Math.max(1, data.byScript.reduce((a, s) => a + s.n, 0));
      $('execTop').innerHTML = data.byScript.length
        ? `<div class="top-scripts"><h4>Scripts con más ejecuciones</h4>${data.byScript.map((s, i) => `
            <div class="ts-row">
              <span class="geo-rank">${i + 1}</span>
              <span class="geo-name">${esc(s.name)}</span>
              <span class="geo-num">${s.n.toLocaleString('es-EC')}<small>${Math.round(s.n / totS * 100)}%</small></span>
              <div class="geo-bar"><i style="width:${Math.round(s.n / maxS * 100)}%"></i></div>
            </div>`).join('')}</div>`
        : '<p class="empty-line">Sin ejecuciones en este período.</p>';
    } catch (err) {
      $('execChart').innerHTML = '<div class="empty-line">No se pudieron cargar las estadísticas.</div>';
    }
  }
  // Redondea el máximo del eje a un valor "bonito" (1, 2, 5 × 10^n)
  function niceMax(v) {
    if (v <= 4) return 4;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    const f = v / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
  }
  let execSeries = null;
  function renderExecChart(series) {
    execSeries = series;
    // Se dibuja con el ancho real del contenedor para que los textos no se encojan en móvil
    const host = $('execChart');
    const W = Math.max(300, Math.round(host.clientWidth || 640));
    const small = W < 520;
    const H = small ? 190 : 210, L = small ? 34 : 40, R = 10, T = 22, B = 28;
    const plotW = W - L - R, plotH = H - T - B;
    const n = series.length;
    const max = niceMax(Math.max(1, ...series.map(s => s.n)));
    const total = series.reduce((acc, s) => acc + s.n, 0);
    const avg = total / n;
    const peak = Math.max(...series.map(s => s.n));
    const slot = plotW / n;
    const bw = Math.max(3, slot * 0.62);
    const y = v => T + plotH - (v / max) * plotH;
    const short = day => `${day.slice(8, 10)}/${day.slice(5, 7)}`;
    const grid = [0, 0.25, 0.5, 0.75, 1].map(f => {
      const v = f * max, yy = y(v).toFixed(1);
      return `<line class="grid" x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}"/>
        <text class="axis" x="${L - 8}" y="${(Number(yy) + 4).toFixed(1)}" text-anchor="end">${Math.round(v).toLocaleString('es-EC')}</text>`;
    }).join('');
    const showAllValues = n <= 7;
    const bars = series.map((s, i) => {
      const x = L + i * slot + (slot - bw) / 2;
      const h = (s.n / max) * plotH;
      const top = T + plotH - h;
      const isLast = i === n - 1;
      const cx = (x + bw / 2).toFixed(1);
      const val = (showAllValues || (s.n === peak && s.n > 0))
        ? `<text class="val" x="${cx}" y="${Math.max(12, top - 6).toFixed(1)}" text-anchor="middle">${s.n.toLocaleString('es-EC')}</text>` : '';
      const dayLabel = (n <= 7 || i % 5 === 0 || isLast)
        ? `<text class="axis" x="${cx}" y="${H - 8}" text-anchor="middle">${short(s.day)}</text>` : '';
      return `<rect class="bar${isLast ? ' bar-last' : ''}" x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(h, s.n ? 2 : 0).toFixed(1)}" rx="5" fill="url(#${isLast ? 'barHot' : 'barSilver'})"/>${val}${dayLabel}
        <rect class="hit" data-i="${i}" x="${(L + i * slot).toFixed(1)}" y="${T}" width="${slot.toFixed(1)}" height="${plotH}"/>`;
    }).join('');
    const avgLine = avg > 0
      ? `<line class="avg" x1="${L}" x2="${W - R}" y1="${y(avg).toFixed(1)}" y2="${y(avg).toFixed(1)}"/>
         <text class="avg-lbl" x="${W - R}" y="${(y(avg) - 6).toFixed(1)}" text-anchor="end">${small ? 'prom.' : 'promedio'} ${Math.round(avg).toLocaleString('es-EC')}</text>` : '';
    const defs = `<defs>
      <linearGradient id="barSilver" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#c9c9d4"/><stop offset="1" stop-color="#3a3a46"/></linearGradient>
      <linearGradient id="barHot" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#9a9aaa"/></linearGradient>
    </defs>`;
    host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Ejecuciones por día" class="exec-svg">${defs}${grid}${avgLine}${bars}</svg>
      <div class="chart-tip" id="execTip" hidden></div>`;
    const svg = host.querySelector('svg');
    const tip = $('execTip');
    const show = e => {
      const hit = e.target.closest && e.target.closest('.hit');
      if (!hit) { tip.hidden = true; return; }
      const s = series[Number(hit.dataset.i)];
      tip.innerHTML = `<b>${short(s.day)}</b>${s.n.toLocaleString('es-EC')} ejecuciones`;
      tip.hidden = false;
      const box = host.getBoundingClientRect();
      tip.style.left = `${Math.min(e.clientX - box.left, box.width - 12)}px`;
      tip.style.top = `${e.clientY - box.top}px`;
    };
    svg.addEventListener('pointermove', show);
    svg.addEventListener('pointerdown', show);
    svg.addEventListener('pointerleave', () => { tip.hidden = true; });
  }
  // Ejecuciones por hora del día (24 columnas, hora pico resaltada)
  function renderHourChart(hours) {
    const byHour = new Map(hours.map(h => [h.hour, h.n]));
    const vals = Array.from({ length: 24 }, (_, h) => byHour.get(h) || 0);
    const total = vals.reduce((a, b) => a + b, 0);
    if (!total) { $('hourChart').innerHTML = '<p class="empty-line">Sin ejecuciones en este período.</p>'; return; }
    const max = Math.max(...vals);
    const peak = vals.indexOf(max);
    const pad = h => String(h).padStart(2, '0');
    $('hourChart').innerHTML = `
      <div class="hour-bars">${vals.map((n, h) => `
        <div class="hour-col${h === peak ? ' peak' : ''}" title="${pad(h)}:00 · ${n.toLocaleString('es-EC')} ejecuciones">
          <i style="height:${n ? Math.max(3, Math.round(n / max * 100)) : 0}%"></i>
          <span>${h % 3 === 0 ? pad(h) : ''}</span>
        </div>`).join('')}
      </div>
      <p class="hour-note">Hora pico: <b>${pad(peak)}:00</b> con ${max.toLocaleString('es-EC')} ejecuciones</p>`;
  }

  // Keys activas que nadie ha usado todavía (sin HWID), por script
  function renderUnusedKeys() {
    const box = $('unusedList');
    if (!keysLoaded) { box.innerHTML = '<p class="hint">Cargando keys…</p>'; return; }
    const active = keys.filter(k => !k.banned && keyStatus(k).id === 'active');
    const pending = active.filter(k => !k.hwid);
    $('unusedSub').textContent = `${pending.length} de ${active.length} keys activas aún sin usar`;
    if (!pending.length) { box.innerHTML = '<p class="empty-line">Todas tus keys activas ya fueron usadas.</p>'; return; }
    const per = new Map();
    pending.forEach(k => per.set(k.script_id, (per.get(k.script_id) || 0) + 1));
    const rows = [...per.entries()].sort((a, b) => b[1] - a[1]);
    const max = rows[0][1];
    box.innerHTML = `<div class="top-scripts">${rows.map(([id, n]) => {
      const total = active.filter(k => k.script_id === id).length;
      return `<div class="ts-row">
        <span class="geo-rank">•</span>
        <span class="geo-name">${esc(scriptName(id))}</span>
        <span class="geo-num">${n}<small>de ${total}</small></span>
        <div class="geo-bar"><i style="width:${Math.round(n / max * 100)}%"></i></div>
      </div>`;
    }).join('')}</div>`;
  }

  let execResizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(execResizeTimer);
    execResizeTimer = setTimeout(() => { if (execSeries && $('execChart').clientWidth) renderExecChart(execSeries); }, 150);
  });
  document.querySelectorAll('[data-exec-days]').forEach(b => b.addEventListener('click', () => {
    execDays = Number(b.dataset.execDays);
    document.querySelectorAll('[data-exec-days]').forEach(x => {
      const on = x === b;
      x.classList.toggle('on', on);
      x.setAttribute('aria-pressed', String(on));
    });
    loadExecStats();
  }));

  // ---------- PRECIOS DEL CREADOR (solo planes pagos) ----------
  let pricesGuilds = [];
  function fillPriceChannels() {
    const guild = pricesGuilds.find(g => g.id === $('prGuild').value);
    const channels = guild ? guild.channels : [];
    $('prCh').innerHTML = channels.length
      ? channels.map(c => `<option value="${esc(c.id)}">${esc(c.parent ? `${c.parent} / ` : '')}#${esc(c.name)}</option>`).join('')
      : '<option value="">Sin canales</option>';
  }
  async function loadPricesForm() {
    if (!hasPerkPlan()) return;
    try {
      const data = await api('/api/prices');
      pricesGuilds = data.guilds || [];
      const saved = pricesGuilds.find(g => g.channels.some(c => c.id === data.channelId));
      $('prGuild').innerHTML = pricesGuilds.length
        ? pricesGuilds.map(g => `<option value="${esc(g.id)}" ${saved && g.id === saved.id ? 'selected' : ''}>${esc(g.name)}</option>`).join('')
        : '<option value="">No eres dueño ni mod de ningún servidor donde esté el bot</option>';
      fillPriceChannels();
      if (saved) $('prCh').value = data.channelId;
      $('prChId').value = '';
      $('prImg').value = data.imageUrl || '';
    } catch (err) {
      toast(err.message, 'error');
    }
  }
  $('prGuild').addEventListener('change', fillPriceChannels);
  $('prSend').addEventListener('click', async () => {
    const title = $('prTitle').value.trim() || 'Precios';
    const description = $('prBody').value.trim();
    const channelId = $('prChId').value.trim() || $('prCh').value;
    if (!channelId) return toast('Elige un canal o pega su ID', 'error');
    if (!description) return toast('Escribe el contenido', 'error');
    if (!confirm(`¿Publicar "${title}" en el canal elegido?`)) return;
    $('prSend').disabled = true;
    try {
      await api('/api/prices', { method: 'POST', body: JSON.stringify({ title, description, channelId, imageUrl: $('prImg').value.trim() }) });
      toast('Precios publicados');
      $('prBody').value = '';
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      $('prSend').disabled = false;
    }
  });

  // ---------- BIENVENIDA (solo Premium Plus) ----------
  let welcomeGuilds = [];
  const WELCOME_DEFAULT_TEXT = 'Bienvenido {user} a {server}!';
  function fillWelcomeChannels() {
    const guild = welcomeGuilds.find(g => g.id === $('weGuild').value);
    const channels = guild ? guild.channels : [];
    $('weCh').innerHTML = channels.length
      ? channels.map(c => `<option value="${esc(c.id)}">${esc(c.parent ? `${c.parent} / ` : '')}#${esc(c.name)}</option>`).join('')
      : '<option value="">Sin canales</option>';
  }
  async function loadWelcomeForm() {
    if (!hasPlusPlan()) return;
    try {
      const data = await api('/api/welcome');
      welcomeGuilds = data.guilds || [];
      const saved = welcomeGuilds.find(g => g.id === data.guildId || g.channels.some(c => c.id === data.channelId));
      $('weGuild').innerHTML = welcomeGuilds.length
        ? welcomeGuilds.map(g => `<option value="${esc(g.id)}" ${saved && g.id === saved.id ? 'selected' : ''}>${esc(g.name)}</option>`).join('')
        : '<option value="">No eres dueño ni mod de ningún servidor donde esté el bot</option>';
      fillWelcomeChannels();
      if (data.channelId) $('weCh').value = data.channelId;
      $('weChId').value = '';
      $('weText').value = data.text || WELCOME_DEFAULT_TEXT;
      $('weImg').value = data.imageUrl || '';
    } catch (err) {
      toast(err.message, 'error');
    }
  }
  $('weGuild').addEventListener('change', fillWelcomeChannels);
  $('weSave').addEventListener('click', async () => {
    const channelId = $('weChId').value.trim() || $('weCh').value;
    if (!channelId) return toast('Elige un canal o pega su ID', 'error');
    $('weSave').disabled = true;
    try {
      await api('/api/welcome', { method: 'POST', body: JSON.stringify({
        channelId, text: $('weText').value.trim(), imageUrl: $('weImg').value.trim(),
      }) });
      toast('Bienvenida guardada');
      await loadWelcomeForm();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      $('weSave').disabled = false;
    }
  });
  $('weOff').addEventListener('click', async () => {
    if (!confirm('¿Desactivar la bienvenida?')) return;
    try {
      await api('/api/welcome', { method: 'DELETE' });
      toast('Bienvenida desactivada');
      await loadWelcomeForm();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // ---------- BORRAR KEYS ----------
  async function deleteKeys(list) {
    if (!list.length) return;
    if (!confirm(`¿Eliminar ${list.length} key(s)? No se puede deshacer.`)) return;
    try {
      const data = await api('/api/keys/delete', { method: 'POST', body: JSON.stringify({ keys: list }) });
      list.forEach(k => selected.delete(k));
      toast(`${data.deleted} key(s) eliminada(s)`);
      await loadData();
    } catch (err) {
      toast(err.message, 'error');
    }
  }
  $('keysTable').addEventListener('click', e => {
    const b = e.target.closest('[data-del-key]');
    if (b) deleteKeys([b.dataset.delKey]);
    const ban = e.target.closest('[data-ban-key]');
    if (ban) openBanModal(ban.dataset.banKey);
  });

  // ---------- AVISO DE VENCIMIENTO DEL PLAN ----------
  function renderPlanAlert() {
    const box = $('planAlert');
    if (!box || !user) return;
    const now = Date.now() / 1000;
    const paid = user.plan === 'premium' || user.plan === 'plus';
    const name = user.plan === 'plus' ? 'Premium Plus' : 'Premium';
    const discord = '<a href="https://discord.gg/FUjbTN69" target="_blank" rel="noopener">nuestro Discord</a>';
    let html = '';
    if (paid && user.plan_expires_at && user.plan_expires_at - now < 3 * 86400) {
      const dias = Math.max(1, Math.ceil((user.plan_expires_at - now) / 86400));
      html = `<b>En ${dias} día${dias === 1 ? '' : 's'} tu plan ${name} pasará a Free.</b> Para seguir, canjea una key nueva en Planes (se compra en ${discord}).`;
    } else if (!paid && user.plan_expired_at && now - user.plan_expired_at < 300) {
      // El aviso de redirección a Free solo se muestra 5 minutos
      html = `<b>Tu plan se acabó y se redirigió al plan Free.</b> Para volver a Premium, canjea una key nueva en Planes (se compra en ${discord}).`;
    }
    if (!html) { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    box.innerHTML = `<div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center">
      <div>${html}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn" type="button" data-plan-renew>Renovar</button>
        ${paid ? '<button class="btn ghost" type="button" data-plan-stay>Seguir con Free</button>' : ''}
      </div></div>`;
  }
  setInterval(renderPlanAlert, 30_000);
  $('planAlert').addEventListener('click', async e => {
    if (e.target.closest('[data-plan-renew]')) { showView('plans'); return; }
    if (e.target.closest('[data-plan-stay]')) {
      try {
        await api('/api/plan/stay-free', { method: 'POST' });
        toast('Ahora tienes el plan Free');
        await loadData();
      } catch (err) { toast(err.message, 'error'); }
    }
  });

  // ---------- MACROS DE RENDIMIENTO (Ofuscador 3) ----------
  // Callbacks que corren cada frame: se detectan por texto y se toma el bloque hasta su 'end' con la misma sangría
  const HOT_EVENT_RE = /\b(RenderStepped|Heartbeat|Stepped|PreRender|PreSimulation|PostSimulation)\s*:\s*[Cc]onnect\s*\(/;
  function hotRanges(code) {
    const lines = code.split('\n');
    const ranges = [];
    lines.forEach((ln, i) => {
      if (!HOT_EVENT_RE.test(ln)) return;
      const indent = ln.match(/^\s*/)[0];
      let end = lines.length - 1;
      for (let j = i + 1; j < lines.length; j++) {
        if (/^\s*end\)?\s*$/.test(lines[j]) && lines[j].match(/^\s*/)[0] === indent) { end = j; break; }
      }
      ranges.push([i, end]);
    });
    return ranges;
  }
  const inHot = (line, ranges) => ranges.some(([a, b]) => line >= a && line <= b);

  // Profundidad de { ( al inicio de cada línea (aprox.: ignora comentarios y textos).
  // Dentro de una tabla o de unos paréntesis no se puede poner una sentencia como la macro.
  function bracketDepths(lines) {
    let depth = 0;
    return lines.map(ln => {
      const at = depth;
      const clean = ln.replace(/--.*$/, '').replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""');
      for (const ch of clean) {
        if (ch === '{' || ch === '(') depth++;
        else if (ch === '}' || ch === ')') depth = Math.max(0, depth - 1);
      }
      return at;
    });
  }

  // Busca funciones en el código (por texto). Las macros van justo encima de la función,
  // solo donde una sentencia es válida (fuera de tablas y de paréntesis).
  function findLuauFunctions(code) {
    const lines = code.split('\n');
    const depths = bracketDepths(lines);
    const re = /^(\s*)(?:local\s+)?function\s+([\w.:]+)\s*\(|^(\s*)(?:local\s+)?([\w.]+)\s*=\s*function\s*\(/;
    const out = [];
    lines.forEach((ln, i) => {
      const m = ln.match(re);
      if (!m) return;
      if (depths[i] > 0) return; // dentro de una tabla o de paréntesis: la macro rompería el código
      if (i > 0 && /LUO_/.test(lines[i - 1])) return; // ya tiene una macro
      const indent = m[1] ?? m[3] ?? '';
      const name = m[2] ?? m[4];
      let end = i;
      // Función en una sola línea (termina en la misma línea)
      if (!/\bend\b/.test(ln)) end = lines.length - 1;
      for (let j = i + 1; j < lines.length && end === lines.length - 1; j++) {
        const e = lines[j].match(/^(\s*)end\b/);
        if (e && e[1] === indent) { end = j; break; }
      }
      out.push({ line: i, indent, name, count: end - i + 1 });
    });
    return out;
  }
  function openMacroPicker() {
    const fns = findLuauFunctions($('fCode').value);
    if (!fns.length) { toast('No encontré funciones en el código', 'error'); return; }
    const hot = hotRanges($('fCode').value);
    const codeLines = $('fCode').value.split('\n');
    // Solo lo que cuesta: funciones con bucles (for, while, repeat) o que corren cada frame
    const LOOP_RE = /\b(for|while|repeat)\b/;
    fns.forEach(f => {
      f.loop = codeLines.slice(f.line, f.line + f.count).some(l => LOOP_RE.test(l));
      f.heavy = f.loop || inHot(f.line, hot);
    });
    const heavyCount = fns.filter(f => f.heavy).length;
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:1000;padding:16px';
    wrap.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" style="max-width:520px;width:100%">
        <h3>Macros de rendimiento</h3>
        <p class="hint">Las funciones marcadas salen de la VM: corren más rápido, pero quedan menos protegidas.</p>
        <label style="display:flex;gap:8px;align-items:center;margin-top:10px;cursor:pointer">
          <input type="checkbox" data-mc-only checked>
          <span>Mostrar solo las que tienen bucles o corren cada frame (${heavyCount})</span>
        </label>
        <div style="max-height:320px;overflow:auto;margin-top:8px">
          ${fns.map((f, i) => `
            <label data-mc-row="${f.heavy ? 1 : 0}" style="display:flex;gap:8px;align-items:center;padding:6px 0">
              <input type="checkbox" data-mc="${i}" ${f.heavy ? 'checked' : ''}>
              <span><code>${esc(f.name)}</code> · línea ${f.line + 1} · ${f.count} líneas${f.loop ? ' · <b>bucle</b>' : ''}${inHot(f.line, hot) ? ' · <b>corre cada frame</b>' : ''}</span>
            </label>`).join('')}
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
          <button class="btn ghost" type="button" data-mc-cancel>Cancelar</button>
          <button class="btn" type="button" data-mc-apply>Aplicar al código</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    wrap.querySelector('[data-mc-cancel]').addEventListener('click', () => wrap.remove());
    const applyFilter = () => {
      const only = wrap.querySelector('[data-mc-only]').checked;
      wrap.querySelectorAll('[data-mc-row]').forEach(r => { r.hidden = only && r.dataset.mcRow !== '1'; });
    };
    wrap.querySelector('[data-mc-only]').addEventListener('change', applyFilter);
    applyFilter();
    wrap.querySelector('[data-mc-apply]').addEventListener('click', () => {
      const chosen = [...wrap.querySelectorAll('[data-mc]:checked')].map(c => fns[Number(c.dataset.mc)]);
      if (!chosen.length) { toast('Marca al menos una función', 'error'); return; }
      const lines = $('fCode').value.split('\n');
      // De abajo hacia arriba para que no se muevan los números de línea
      for (const f of [...chosen].sort((a, b) => b.line - a.line)) lines.splice(f.line, 0, `${f.indent}LUO_NO_VIRTUALIZE()`);
      $('fCode').value = lines.join('\n');
      wrap.remove();
      toast(`Macro agregada a ${chosen.length} función(es). Guarda el script para aplicarla`);
    });
  }
  document.addEventListener('click', e => { if (e.target.closest('#macroBtn')) openMacroPicker(); });

  // ---------- WEBHOOKS (perfil) ----------
  const WH_EVENT_LABEL = { 'key.created': 'Key creada', 'key.banned': 'Key baneada', 'key.shared': 'Key compartida', 'script.tamper': 'Intento de dump', 'webhook.test': 'Prueba' };
  async function loadActivity() {
    const box = $('pfActivity');
    if (!box) return;
    box.innerHTML = '<p class="hint">Cargando actividad…</p>';
    try {
      const { redemptions, logs } = await api('/api/me/activity');
      const rows = [
        ...redemptions.map(r => ({ at: r.used_at, text: `Canjeaste una key de ${PLAN_LABELS[planKey(r.plan)] || r.plan}` })),
        ...logs.map(l => ({ at: l.created_at, text: `${l.script_name || 'Script'}: ${l.text}` })),
      ].sort((a, b) => b.at - a.at).slice(0, 30);
      box.innerHTML = rows.length
        ? rows.map(r => `<div class="activity-row"><span class="hint">${fmtDate(r.at)}</span><span>${esc(r.text)}</span></div>`).join('')
        : '<p class="hint">Aún no hay actividad.</p>';
    } catch (err) {
      box.innerHTML = `<p class="hint">No pude cargar la actividad: ${esc(err.message)}</p>`;
    }
  }

  async function loadWebhooks() {
    const box = $('whList');
    if (!box) return;
    box.innerHTML = '<p class="hint">Cargando webhooks…</p>';
    try {
      const list = await api('/api/webhooks');
      if (!list.length) { box.innerHTML = '<p class="hint">Todavía no tienes webhooks.</p>'; return; }
      box.innerHTML = list.map(w => {
        const st = w.last_status == null && !w.last_error ? 'Sin envíos todavía'
          : w.last_error ? `Último envío con error: ${esc(w.last_error)}`
          : `Último envío: HTTP ${w.last_status}`;
        return `
          <div class="ver-row" style="padding:10px 0;border-top:1px solid var(--border)">
            <div class="ver-meta" style="min-width:0">
              <b style="word-break:break-all">${esc(w.url)}</b>
              <span class="hint">${w.events.map(e => esc(WH_EVENT_LABEL[e] || e)).join(' · ')}</span>
              <span class="hint">${st}</span>
            </div>
            <span style="display:flex;gap:6px;flex-wrap:wrap">
              <button class="btn ghost sm" type="button" data-wh-test="${esc(w.id)}">Probar</button>
              <button class="btn ghost sm" type="button" data-wh-del="${esc(w.id)}">Eliminar</button>
            </span>
          </div>`;
      }).join('');
    } catch (err) {
      box.innerHTML = `<p class="hint">${esc(err.message)}</p>`;
    }
  }
  $('whForm').addEventListener('submit', async e => {
    e.preventDefault();
    const events = [...document.querySelectorAll('input[name="whEv"]:checked')].map(c => c.value);
    const btn = e.submitter || e.target.querySelector('button[type="submit"]');
    setBusy(btn, true);
    try {
      const r = await api('/api/webhooks', { method: 'POST', body: JSON.stringify({ url: $('whUrl').value.trim(), events }) });
      $('whUrl').value = '';
      openModal('Webhook creado', `
        <p class="hint">Guarda este secreto ahora. Sirve para verificar la firma de cada envío (HMAC-SHA256 del cuerpo). No se vuelve a mostrar.</p>
        <div class="input-group"><input class="field block mono" readonly value="${esc(r.secret)}"></div>`);
      loadWebhooks();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(btn, false);
    }
  });
  $('whList').addEventListener('click', async e => {
    const test = e.target.closest('[data-wh-test]');
    const del = e.target.closest('[data-wh-del]');
    if (test) {
      setBusy(test, true);
      try {
        const r = await api(`/api/webhooks/${encodeURIComponent(test.dataset.whTest)}/test`, { method: 'POST' });
        toast(r.last_error ? `Falló: ${r.last_error}` : `Respondió HTTP ${r.last_status}`, r.last_error ? 'error' : 'ok');
      } catch (err) { toast(err.message, 'error'); }
      finally { setBusy(test, false); loadWebhooks(); }
    } else if (del) {
      if (!confirm('¿Eliminar este webhook?')) return;
      try {
        await api(`/api/webhooks/${encodeURIComponent(del.dataset.whDel)}`, { method: 'DELETE' });
        toast('Webhook eliminado');
        loadWebhooks();
      } catch (err) { toast(err.message, 'error'); }
    }
  });

  // ---------- BLACKLIST (web) ----------
  async function loadBlacklist() {
    let data;
    try { data = await api('/api/blacklist'); } catch (err) { toast(err.message, 'error'); return; }
    const current = $('blScript').value;
    $('blScript').innerHTML = data.scripts.length
      ? data.scripts.map(s => `<option value="${s.id}" ${String(s.id) === current ? 'selected' : ''}>${esc(s.name)}</option>`).join('')
      : '<option value="">Sin scripts</option>';
    const opt = v => document.querySelector(`#blKind option[value="${v}"]`);
    $('blUsers').innerHTML = data.users.length
      ? data.users.map(u => `<tr>
          <td>${esc(u.script)}</td><td>${esc(u.discord_id)}</td><td>${esc(u.reason || '')}</td><td>${fmtDate(u.created_at)}</td>
          <td style="text-align:right"><button class="btn ghost sm" data-bl-remove="user" data-bl-script="${esc(u.script_id)}" data-bl-value="${esc(u.discord_id)}">Quitar</button></td>
        </tr>`).join('')
      : '<tr><td colspan="5" class="center">Ningún usuario de Discord bloqueado.</td></tr>';
    const kindName = { hwid: 'HWID', ip: 'IP', user: 'Usuario' };
    $('blBans').innerHTML = data.bans.length
      ? data.bans.map(b => `<tr>
          <td>${esc(b.script)}</td><td>${kindName[b.kind] || esc(b.kind)}</td><td class="key-cell">${esc(b.value)}</td><td>${esc(b.reason || '')}</td><td>${fmtDate(b.created_at)}</td>
          <td style="text-align:right"><button class="btn ghost sm" data-bl-remove="${esc(b.kind)}" data-bl-script="${esc(b.script_id)}" data-bl-value="${esc(b.value)}">Quitar</button></td>
        </tr>`).join('')
      : '<tr><td colspan="6" class="center">Ninguna IP ni HWID bloqueado.</td></tr>';
  }
  $('blForm').addEventListener('submit', async e => {
    e.preventDefault();
    const body = {
      scriptId: Number($('blScript').value),
      kind: $('blKind').value,
      value: $('blValue').value.trim(),
      reason: $('blReason').value.trim(),
    };
    if (!body.scriptId) { toast('Elige un script', 'error'); return; }
    try {
      await api('/api/blacklist', { method: 'POST', body: JSON.stringify(body) });
      toast('Bloqueado');
      $('blValue').value = '';
      $('blReason').value = '';
      await loadBlacklist();
    } catch (err) { toast(err.message, 'error'); }
  });
  $('blLists').addEventListener('click', async e => {
    const b = e.target.closest('[data-bl-remove]');
    if (!b) return;
    try {
      await api('/api/blacklist/remove', { method: 'POST', body: JSON.stringify({ scriptId: Number(b.dataset.blScript), kind: b.dataset.blRemove, value: b.dataset.blValue }) });
      toast('Quitado de la blacklist');
      await loadBlacklist();
    } catch (err) { toast(err.message, 'error'); }
  });

  // Baneos desde la key: HWID, IP o usuario de Discord (todos los planes)
  function openBanModal(keyStr) {
    const k = keys.find(x => x.key === keyStr);
    if (!k) return;
    const paid = hasPerkPlan();
    const item = (kind, title, value, needsPaid) => {
      const locked = needsPaid && !paid;
      const disabled = locked || !value;
      const note = locked ? 'Solo Premium y Premium Plus' : !value ? 'Todavía no hay datos de esta key' : '';
      return `
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px 0">
          <div><b>${title}</b>${note ? `<small style="display:block;opacity:.7">${note}</small>` : ''}</div>
          <div style="display:flex;gap:6px">
            <button class="btn ghost sm" data-ban="${kind}" ${disabled ? 'disabled' : ''}>Banear</button>
            <button class="btn ghost sm" data-unban="${kind}" ${disabled ? 'disabled' : ''}>Quitar</button>
          </div>
        </div>`;
    };
    openModal('Banear key', `
      <p class="hint">Banear bloquea el acceso al script. Quitar el baneo lo desbloquea.</p>
      ${item('hwid', 'HWID del equipo', k.hwid, false)}
      ${item('ip', 'IP del usuario', k.last_ip, false)}
      ${item('user', 'Usuario de Discord', k.discord_id, false)}`);
    $('modalBody').querySelectorAll('[data-ban],[data-unban]').forEach(btn => btn.addEventListener('click', async () => {
      const on = btn.hasAttribute('data-ban');
      const kind = btn.dataset.ban || btn.dataset.unban;
      setBusy(btn, true);
      try {
        await api(`/api/keys/${encodeURIComponent(keyStr)}/${on ? 'ban' : 'unban'}`, { method: 'POST', body: JSON.stringify({ kind }) });
        toast(on ? 'Baneo aplicado' : 'Baneo quitado');
        closeModal();
        await loadData();
      } catch (err) { toast(err.message, 'error'); setBusy(btn, false); }
    }));
  }
  $('bulkDelete').addEventListener('click', () => deleteKeys([...selected]));
  $('bulkBan').addEventListener('click', async () => {
    const list = keys.filter(k => selected.has(k.key) && k.hwid);
    if (!list.length) { toast('Ninguna de las seleccionadas tiene HWID registrado', 'error'); return; }
    if (!confirm(`¿Banear el HWID de ${list.length} key(s)? Los equipos quedarán bloqueados.`)) return;
    let ok = 0;
    for (const k of list) {
      try {
        await api(`/api/keys/${encodeURIComponent(k.key)}/ban`, { method: 'POST', body: JSON.stringify({ kind: 'hwid' }) });
        ok++;
      } catch (_) { /* se cuenta abajo */ }
    }
    toast(`Baneo aplicado a ${ok} de ${list.length}`, ok === list.length ? 'ok' : 'error');
    selected.clear();
    await loadData();
  });

  // ---------- DATA ----------
  async function loadData() {
    try {
      user = await api('/api/me');
      renderPlanAlert();
    } catch (err) {
      if (err.status === 401 || err.status === 403) {
        if (authLoopCount() >= 2) {
          // Ya redirigimos dos veces en el último minuto: detenemos el bucle
          showAuthError(err.message);
          return;
        }
        recordAuthRedirect();
        location.href = '/login';
        return;
      }
      $('userName').textContent = 'Sin conexión';
      toast(`No se pudo cargar tu cuenta: ${err.message}`, 'error');
      scriptsError = true;
      keysError = true;
      renderScripts();
      renderKeys();
      return;
    }

    clearAuthLoop();
    setOwnerNav(!!user.owner);
    loadSiteStatus();
    setInterval(loadSiteStatus, 60000);
    loadExecStats();
    setPlanNav(hasPerkPlan());
    setPlusNav(hasPlusPlan());
    loadOwnerData();

    renderScripts();
    renderKeys();
    const [s, k] = await Promise.allSettled([api('/api/scripts'), api('/api/keys')]);
    if (s.status === 'fulfilled') { scripts = s.value; scriptsError = false; } else scriptsError = true;
    if (k.status === 'fulfilled') { keys = k.value; keysError = false; } else keysError = true;
    scriptsLoaded = true;
    keysLoaded = true;

    const existing = new Set(keys.map(x => x.key));
    selected.forEach(key => { if (!existing.has(key)) selected.delete(key); });

    renderAll();
  }

  // ---------- EVENTS ----------
  document.addEventListener('click', e => {
    const t = e.target;

    const nav = t.closest('[data-nav]');
    if (nav) { showView(nav.dataset.nav); return; }

    const go = t.closest('[data-go]');
    if (go) { showView(go.dataset.go); return; }

    const open = t.closest('[data-open]');
    if (open) {
      if (open.dataset.open === 'script') openScriptModal();
      else openKeysModal();
      return;
    }

    const maint = t.closest('[data-maint]');
    if (maint) {
      const on = maint.dataset.on !== '1';
      api(`/api/scripts/${encodeURIComponent(maint.dataset.maint)}/maintenance`, { method: 'POST', body: JSON.stringify({ on }) })
        .then(() => { toast(on ? 'Script en mantenimiento' : 'Mantenimiento quitado'); return loadData(); })
        .catch(err => toast(err.message, 'error'));
      return;
    }

    const edit = t.closest('[data-edit]');
    if (edit) { openEditScriptModal(edit.dataset.edit); return; }

    const prot = t.closest('[data-protected]');
    if (prot) { openProtectedCode(prot.dataset.protected); return; }

    const del = t.closest('[data-delete]');
    if (del) {
      if (confirm(`¿Eliminar "${del.dataset.name}"? Se borran también sus keys. No se puede deshacer.`)) {
        api(`/api/scripts/${encodeURIComponent(del.dataset.delete)}`, { method: 'DELETE' })
          .then(() => { toast('Script eliminado'); return loadData(); })
          .catch(err => toast(err.message, 'error'));
      }
      return;
    }

    const gen = t.closest('[data-gen]');
    if (gen) { openKeysModal(gen.dataset.gen); return; }

    const vk = t.closest('[data-view-keys]');
    if (vk) {
      $('keyScript').value = vk.dataset.viewKeys;
      $('keySearch').value = '';
      $('keyFilter').value = 'all';
      renderKeys();
      showView('keys');
      return;
    }

    const copy = t.closest('[data-copy]');
    if (copy) { copyText(copy.dataset.copy, copy.dataset.msg || 'Copiado al portapapeles'); return; }

    if (t.closest('[data-close]') || t.id === 'modal') { closeModal(); return; }
  });

  document.addEventListener('change', e => {
    const cb = e.target.closest('[data-select]');
    if (!cb) return;
    cb.checked ? selected.add(cb.dataset.select) : selected.delete(cb.dataset.select);
    cb.closest('tr').classList.toggle('selected', cb.checked);
    updateBulk();
  });

  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (!$('modal').hidden) closeModal();
    else if (isMobile() && !$('sidebar').classList.contains('collapsed')) setSidebar(false);
  });

  $('userAvatar').addEventListener('click', () => showView('profile'));
  $('userAvatar').title = 'Mi perfil';
  $('userAvatar').style.cursor = 'pointer';

  $('menuBtn').addEventListener('click', () => setSidebar($('sidebar').classList.contains('collapsed')));
  $('scrim').addEventListener('click', () => setSidebar(false));

  $('refreshBtn').addEventListener('click', async e => {
    setBusy(e.currentTarget, true);
    await loadData();
    setBusy(e.currentTarget, false);
  });

  // Invitar bot: el link viene del servidor (depende de DISCORD_CLIENT_ID)
  (async () => {
    try {
      const cfg = await api('/api/config');
      if (cfg && cfg.botInviteUrl) {
        const a = $('inviteBotBtn');
        a.href = cfg.botInviteUrl;
        a.style.display = '';
      }
    } catch (_) { /* sin config, el botón queda oculto */ }
  })();

  // Botones de mejora de plan: llevan al bloque de canje
  document.querySelectorAll('[data-plan-btn]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      $('redeemBox').style.display = '';
      $('redeemBox').scrollIntoView({ behavior: 'smooth', block: 'center' });
      $('redeemInput').focus();
    });
  });

  // Canje de key de plan
  $('redeemForm').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = e.currentTarget.querySelector('button[type="submit"]');
    const key = $('redeemInput').value.trim();
    if (key.length < 32) { toast('La key es demasiado corta', 'error'); return; }
    setBusy(btn, true);
    try {
      const res = await api('/api/plan/redeem', { method: 'POST', body: JSON.stringify({ key }) });
      $('redeemInput').value = '';
      toast(`Plan ${res.plan === 'plus' ? 'Premium Plus' : 'Premium'} activado`);
      await loadData();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(btn, false);
    }
  });

  $('retryAuth').addEventListener('click', () => {
    clearAuthLoop();
    location.reload();
  });

  $('keySearch').addEventListener('input', renderKeys);
  $('keyScript').addEventListener('change', renderKeys);
  $('keyFilter').addEventListener('change', renderKeys);

  $('checkAll').addEventListener('change', e => {
    filteredKeys().forEach(({ k }) => e.target.checked ? selected.add(k.key) : selected.delete(k.key));
    renderKeys();
  });
  $('bulkClear').addEventListener('click', () => { selected.clear(); renderKeys(); });
  $('bulkCopy').addEventListener('click', () => {
    const list = keys.filter(k => selected.has(k.key)).map(k => k.key).join('\n');
    copyText(list, `${selected.size} keys copiadas`);
  });

  $('exportBtn').addEventListener('click', () => {
    const rows = filteredKeys();
    if (!rows.length) { toast('No hay keys para exportar', 'error'); return; }
    const body = rows.map(({ k, st, script }) =>
      [k.key, script, st.label, k.expires_at ? new Date(k.expires_at * 1000).toISOString() : 'Nunca']
        .map(csvCell).join(',')).join('\n');
    download('keys_vantarmor.csv', `key,script,estado,expiracion\n${body}`);
  });

  window.addEventListener('resize', () => {
    if (!isMobile()) $('scrim').classList.remove('show');
  });

  // ---------- INIT ----------
  setSidebar(!isMobile());
  loadData();
})();
