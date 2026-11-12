// Idioma del sitio. El español es el original de la página.
// Los demás idiomas se traducen automáticamente con Google Translate.
// El idioma se detecta solo del navegador (región del visitante) en la primera
// visita y queda guardado (localStorage + cookie vm-lang + cookie googtrans);
// no hay selector: la elección se vuelve a aplicar sola al entrar.
// Si la versión del sitio cambió desde la última visita, avisa con un aviso
// para recargar la página (traducido a cada idioma).
(function () {
  const LANGS = ['es', 'en', 'pt', 'fr', 'de', 'it', 'ru', 'ja', 'zh-CN'];
  const LS_KEY = 'vm-lang';
  const SUPPORTED = new Set(LANGS);

  const current = () => {
    // Puede haber varias cookies googtrans (host-only, de dominio y la que escribe el propio
    // traductor): gana la primera con valor real, no la vacia.
    let out = '';
    try {
      for (const part of document.cookie.split(/;\s*/)) {
        const m = part.match(/^googtrans=\/es\/([^;]+)$/);
        if (m && m[1]) { out = decodeURIComponent(m[1]); break; }
      }
    } catch (e) { out = ''; }
    return out || 'es';
  };
  // Eleccion guardada: localStorage o la cookie vm-lang (por si borran uno de los dos).
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
    const value = code === 'es' ? '' : `/es/${code}`;
    const age = code === 'es' ? 'max-age=0' : 'max-age=31536000';
    document.cookie = `googtrans=${value}; path=/; ${age}`;
    document.cookie = `googtrans=${value}; path=/; domain=${location.hostname}; ${age}`;
    // La eleccion tambien vive aqui: si el navegador borra localStorage o la cookie googtrans,
    // el idioma elegido no se pierde y no vuelve a saltar la deteccion automatica.
    document.cookie = `vm-lang=${code}; path=/; max-age=31536000; SameSite=Lax`;
  };

  const mapLang = c => {
    const l = String(c || '').toLowerCase();
    const t = l.indexOf('-') > -1 ? l.slice(0, l.indexOf('-')) : l;
    if (t === 'zh') return 'zh-CN'; // cualquier variante china va a chino simplificado
    return SUPPORTED.has(t) ? t : '';
  };
  // Deteccion del idioma del navegador (region del visitante), ordenada por preferencia.
  const detectLang = () => {
    const cand = (navigator.languages && navigator.languages.length
      ? navigator.languages : [navigator.language || '']).filter(Boolean);
    for (let i = 0; i < cand.length; i++) {
      const pick = mapLang(cand[i]);
      if (pick) return pick;
    }
    return '';
  };

  // Primera visita (sin idioma guardado): se detecta el idioma del navegador y queda guardado
  // como si lo hubiera elegido. Un idioma guardado que ya no se soporta se re-detecta.
  let savedVal = saved();
  if (savedVal && !SUPPORTED.has(savedVal)) savedVal = '';
  if (!savedVal) {
    const pick = detectLang();
    if (pick) {
      try { localStorage.setItem(LS_KEY, pick); } catch (e) { /* sin localStorage: queda la cookie */ }
      saveCookie(pick);
      savedVal = pick;
    }
  }
  // Anulacion manual sin selector: ?lang=en (o #lang=en). Solo si el idioma existe.
  try {
    const q = new URLSearchParams(location.search).get('lang') || (location.hash.match(/^#lang=([\w-]+)$/) || [])[1] || '';
    if (q && SUPPORTED.has(q)) { savedVal = q; try { localStorage.setItem(LS_KEY, q); } catch (e) {} saveCookie(q); }
  } catch (e) { /* sin URLSearchParams: no pasa nada */ }

  // Idioma deseado: lo que el usuario eligio antes, o el de la cookie.
  const want = savedVal || current();
  if (want && want !== current()) saveCookie(want); // sincroniza la cookie para la proxima carga

  let translating = false;
  const busy = () => { translating = true; setTimeout(() => { translating = false; }, 2500); };

  let gtInstance = null;

  // Aplica un idioma con el combo interno de Google Translate. Devuelve true si existia el combo.
  const applyCombo = code => {
    const combo = document.querySelector('.goog-te-combo');
    if (!combo) return false;
    busy();
    combo.value = code;
    combo.dispatchEvent(new Event('change'));
    return true;
  };
  // Traduce un bloque (o toda la pagina) sin volver al espanol: Google Translate recuerda
  // el original de lo ya traducido, asi que solo procesa el contenido nuevo. Evita el
  // parpadeo espanol que se veia cada vez que el panel actualizaba datos.
  const applySection = node => {
    try {
      if (gtInstance && typeof gtInstance.translateSection === 'function') {
        gtInstance.translateSection(node, want);
        return true;
      }
    } catch (e) { /* si no existe el metodo, combo de reserva */ }
    return false;
  };
  // Re-traducir el contenido nuevo del panel: primero por seccion (sin parpadeo) y, si el
  // traductor no lo permite, vuelve al espanol y vuelve a aplicar como antes.
  const retranslate = () => {
    if (applySection(document.body)) { busy(); return; }
    const combo = document.querySelector('.goog-te-combo');
    if (!combo) return;
    busy();
    combo.value = 'es';
    combo.dispatchEvent(new Event('change'));
    setTimeout(() => {
      busy();
      combo.value = want;
      combo.dispatchEvent(new Event('change'));
    }, 120);
  };

  const css = `
    #google_translate_element { display: none; }
    .goog-te-banner-frame, .skiptranslate { display: none !important; }
    body { top: 0 !important; }`;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const hidden = document.createElement('div');
  hidden.id = 'google_translate_element';
  document.body.appendChild(hidden);

  // Placeholders y comentarios dentro de <pre>/<code>: el traductor de Google no los toca.
  // Espejos: cada texto se copia a un nodo oculto que el traductor si procesa, y el resultado
  // vuelve al placeholder o al span marcado con vm-mirror-src.
  const mirrorBox = document.createElement('div');
  mirrorBox.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;overflow:hidden';
  document.body.appendChild(mirrorBox);
  const mirrors = [];
  const collectMirrors = () => {
    document.querySelectorAll('[placeholder]').forEach(el => {
      if (el._vmPh) return;
      const m = document.createElement('span');
      m.textContent = el.getAttribute('placeholder') || '';
      mirrorBox.appendChild(m);
      el._vmPh = m;
      mirrors.push({ el, m, attr: 'placeholder' });
    });
    document.querySelectorAll('.vm-mirror-src').forEach(el => {
      if (el._vmSrc) return;
      const m = document.createElement('span');
      m.textContent = el.textContent;
      mirrorBox.appendChild(m);
      el._vmSrc = m;
      mirrors.push({ el, m, attr: null });
    });
  };
  const syncMirrors = () => {
    mirrors.forEach(({ el, m, attr }) => {
      if (!m.isConnected || !el.isConnected) return;
      const t = m.textContent;
      if (!t || !t.trim()) return;
      if (attr) { if (el.getAttribute(attr) !== t) el.setAttribute(attr, t); }
      else if (el.textContent !== t) el.textContent = t;
    });
  };
  if (want && want !== 'es') {
    collectMirrors();
    setInterval(collectMirrors, 1200);
    setInterval(syncMirrors, 700);
  }

  // Contenido dinamico: el panel crea HTML despues de cargar; Google Translate no
  // traduce lo nuevo por si solo, asi que se vuelve a aplicar cuando aparece.
  if (want && want !== 'es') {
    let t = null;
    const isGoogleEdit = muts => muts.every(m =>
      Array.from(m.addedNodes).every(n => n.nodeType === 1 && /^FONT$/i.test(n.tagName)));
    const isMine = muts => muts.every(m => {
      if (mirrorBox.contains(m.target)) return true;
      if (m.target.nodeType === 1 && m.target._vmSrc) return true;
      if (m.target.parentElement && m.target.parentElement._vmSrc) return true;
      return false;
    });
    new MutationObserver(muts => {
      if (translating || isGoogleEdit(muts) || isMine(muts)) return;
      clearTimeout(t);
      collectMirrors();
      t = setTimeout(retranslate, 700);
    }).observe(document.body, { childList: true, subtree: true, characterData: false });
  }

  window.vmGtInit = () => {
    if (!window.google || !google.translate) return;
    gtInstance = new google.translate.TranslateElement({
      pageLanguage: 'es',
      includedLanguages: LANGS.join(','),
      autoDisplay: false,
    }, 'google_translate_element');
    // Aplica el idioma guardado en cuanto el combo exista (hasta ~6 s de espera)
    if (want && want !== 'es') {
      let n = 0;
      const iv = setInterval(() => {
        if (applyCombo(want) || ++n >= 20) clearInterval(iv);
      }, 300);
    }
  };
  const s = document.createElement('script');
  s.src = 'https://translate.google.com/translate_a/element.js?cb=vmGtInit';
  s.async = true;
  document.body.appendChild(s);

  // ---- Sitio desactualizado: aviso para recargar (traducido) ----
  // Compara el commit del despliegue con el guardado de la ultima visita.
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
    } catch (e) { /* sin banner: la recarga manual sigue valiendo */ }
  };
  const VER_KEY = 'vm-build';
  const buildFetch = (typeof fetch === 'function')
    ? fetch('/api/version', { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)).catch(() => null)
    : Promise.resolve(null);
  buildFetch.then(v => {
    if (!v || !v.commitFull) return; // sin dato de version: nada que comparar
    const id = String(v.commitFull);
    let prev = null;
    try { prev = localStorage.getItem(VER_KEY); } catch (e) { prev = null; }
    try { localStorage.setItem(VER_KEY, id); } catch (e) { /* sin localStorage */ }
    if (!prev) return;          // primera visita: solo se guarda el punto de partida
    if (prev === id) return;    // misma version
    let seen = false;
    try { seen = sessionStorage.getItem('vm-build-seen') === id; } catch (e) { seen = false; }
    if (seen) return;           // ya se aviso en esta sesion
    try { sessionStorage.setItem('vm-build-seen', id); } catch (e) { /* sin sessionStorage */ }
    showUpdateBar();
  });
})();
