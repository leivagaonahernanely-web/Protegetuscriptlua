// Idioma del sitio. Traducciones REALES incluidas en langs.js: sin widget externo,
// sin parpadeo y sin depende de terceros. El espanol es el idioma original de la pagina.
// El idioma se detecta del navegador en la primera visita y queda guardado
// (localStorage + cookie vm-lang); no hay selector: la eleccion se vuelve a aplicar sola.
// Si la version del sitio cambio desde la ultima visita, avisa con un aviso para recargar.
(function () {
  const LANGS = ['es', 'en', 'pt', 'fr', 'de', 'it', 'ru', 'ja', 'zh-CN'];
  const LS_KEY = 'vm-lang';
  const SUPPORTED = new Set(LANGS);

  const readVmCookie = () => {
    try {
      const m = document.cookie.match(/(?:^|;\s*)vm-lang=([^;]*)/);
      return m ? decodeURIComponent(m[1]).trim() : '';
    } catch (e) { return ''; }
  };
  const saved = () => {
    let v = '';
    try { v = localStorage.getItem(LS_KEY) || ''; } catch (e) { v = ''; }
    return v || readVmCookie();
  };
  const saveCookie = code => {
    try { document.cookie = `vm-lang=${code}; path=/; max-age=31536000; SameSite=Lax`; } catch (e) {}
  };
  const mapLang = c => {
    const l = String(c || '').toLowerCase();
    const t = l.indexOf('-') > -1 ? l.slice(0, l.indexOf('-')) : l;
    if (t === 'zh') return 'zh-CN';
    return SUPPORTED.has(t) ? t : '';
  };
  const detectLang = () => {
    const cand = (navigator.languages && navigator.languages.length
      ? navigator.languages : [navigator.language || '']).filter(Boolean);
    for (let i = 0; i < cand.length; i++) {
      const pick = mapLang(cand[i]);
      if (pick) return pick;
    }
    return '';
  };

  let savedVal = saved();
  if (savedVal && !SUPPORTED.has(savedVal)) savedVal = '';
  if (!savedVal) {
    const pick = detectLang();
    if (pick) {
      try { localStorage.setItem(LS_KEY, pick); } catch (e) {}
      saveCookie(pick);
      savedVal = pick;
    }
  }
  try {
    const q = new URLSearchParams(location.search).get('lang') || (location.hash.match(/^#lang=([\w-]+)$/) || [])[1] || '';
    if (q && SUPPORTED.has(q)) { savedVal = q; try { localStorage.setItem(LS_KEY, q); } catch (e) {} saveCookie(q); }
  } catch (e) {}

  const want = savedVal || 'es';
  const DICT = (want === 'es') ? null : ((window.VM_LANGS && window.VM_LANGS[want]) || null);
  try { document.documentElement.lang = want === 'zh-CN' ? 'zh-CN' : (want || 'es'); } catch (e) {}

  // ---- Aviso de version nueva (sin cambiar) ----
  const UPDATE_TEXTS = {
    es: 'VantArmor se actualizó. Toca aquí para recargar la página.',
    en: 'VantArmor was updated. Tap here to refresh the page.',
    pt: 'O VantArmor foi atualizado. Toque aqui para atualizar a página.',
    fr: 'VantArmor a été mis à jour. Appuyez ici pour actualiser la page.',
    de: 'VantArmor wurde aktualisiert. Tippe hier, um die Seite neu zu laden.',
    it: 'VantArmor è stato aggiornato. Tocca qui per ricaricare la pagina.',
    ru: 'VantArmor обновлён. Нажмите здесь, чтобы обновить страницу.',
    ja: 'VantArmor が更新されました。ここをタップしてページを再読み込みしてください。',
    'zh-CN': 'VantArmor 已更新。点按此处刷新页面。',
  };
  const showUpdateBar = () => {
    try {
      const bar = document.createElement('div');
      bar.className = 'notranslate';
      bar.setAttribute('role', 'button');
      bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;display:flex;'
        + 'align-items:center;justify-content:center;padding:13px 16px;text-align:center;'
        + 'background:#1b1b26;color:#f5f5f8;font:600 14px/1.35 system-ui,sans-serif;'
        + 'border-top:1px solid rgba(255,255,255,.15);cursor:pointer;'
        + 'box-shadow:0 -4px 18px rgba(0,0,0,.4)';
      bar.textContent = UPDATE_TEXTS[want] || UPDATE_TEXTS.es;
      bar.addEventListener('click', () => location.reload());
      document.body.appendChild(bar);
      document.body.style.paddingBottom = '48px';
    } catch (e) {}
  };
  const VER_KEY = 'vm-build';
  const buildFetch = (typeof fetch === 'function')
    ? fetch('/api/version', { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)).catch(() => null)
    : Promise.resolve(null);
  buildFetch.then(v => {
    if (!v || !v.commitFull) return;
    const id = String(v.commitFull);
    let prev = null;
    try { prev = localStorage.getItem(VER_KEY); } catch (e) { prev = null; }
    try { localStorage.setItem(VER_KEY, id); } catch (e) {}
    if (!prev) return;
    if (prev === id) return;
    let seen = false;
    try { seen = sessionStorage.getItem('vm-build-seen') === id; } catch (e) { seen = false; }
    if (seen) return;
    try { sessionStorage.setItem('vm-build-seen', id); } catch (e) {}
    showUpdateBar();
  });

  if (!DICT) return; // espanol: la pagina ya esta en su idioma

  // ---- Aplicacion del diccionario ----
  const norm = s => String(s).replace(/\s+/g, ' ').trim();
  const SKIP = { SCRIPT: 1, STYLE: 1, PRE: 1, CODE: 1, NOSCRIPT: 1, TEXTAREA: 1 };
  let fragList = null;
  const getFragList = () => {
    if (!fragList) {
      fragList = Object.keys(DICT).filter(k => k.length >= 4)
        .sort((a, b) => b.length - a.length)
        .map(k => [new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'), 'g'), DICT[k]]);
    }
    return fragList;
  };
  let running = false;
  const apply = root => {
    if (!DICT || running) return;
    running = true;
    try {
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: n => {
          const p = n.parentNode;
          if (!p || SKIP[p.nodeName]) return NodeFilter.FILTER_REJECT;
          if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      const ns = [];
      while (w.nextNode()) ns.push(w.currentNode);
      ns.forEach(n => {
        const key = norm(n.nodeValue);
        if (!key) return;
        if (DICT[key] !== undefined) {
          if (n.nodeValue !== DICT[key]) n.nodeValue = DICT[key];
          return;
        }
        let out = n.nodeValue, hit = false;
        for (const pair of getFragList()) {
          if (pair[0].test(out)) { out = out.replace(pair[0], pair[1]); hit = true; }
          pair[0].lastIndex = 0;
        }
        if (hit) n.nodeValue = out;
      });
      if (root.querySelectorAll) {
        const els = root.querySelectorAll('[placeholder],[title],[alt],[aria-label]');
        for (let i = 0; i < els.length; i++) {
          const el = els[i];
          for (const a of ['placeholder', 'title', 'alt', 'aria-label']) {
            const val = el.getAttribute(a);
            if (!val) continue;
            const t = DICT[norm(val)];
            if (t !== undefined && val !== t) el.setAttribute(a, t);
          }
        }
      }
      const tt = norm(document.title);
      if (DICT[tt] !== undefined) document.title = DICT[tt];
    } catch (e) {}
    running = false;
  };

  apply(document.body);
  if (typeof MutationObserver === 'function') {
    let t = null;
    new MutationObserver(() => {
      if (running) return;
      clearTimeout(t);
      t = setTimeout(() => apply(document.body), 150);
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  }
})();
