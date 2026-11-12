// Selector de idioma. El español es el original de la página.
// Los demás idiomas se traducen automáticamente con Google Translate.
// La elección se guarda (localStorage + cookie googtrans) y se vuelve a aplicar
// sola al entrar, y el contenido que el panel crea después también se traduce.
(function () {
  const LANGS = [
    ['es', 'Español'], ['en', 'English'], ['pt', 'Português'], ['fr', 'Français'],
    ['de', 'Deutsch'], ['it', 'Italiano'], ['ru', 'Русский'], ['ja', '日本語'], ['zh-CN', '中文'],
  ];
  const LS_KEY = 'vm-lang';

  const current = () => {
    // Puede haber varias cookies googtrans (host-only, de dominio y la que escribe el propio
    // traductor): gana la primera con valor real, no la vacia.
    let out = '';
    for (const part of document.cookie.split(/;\s*/)) {
      const m = part.match(/^googtrans=\/es\/([^;]+)$/);
      if (m && m[1]) { out = decodeURIComponent(m[1]); break; }
    }
    return out || 'es';
  };
  // Eleccion guardada: localStorage o la cookie vm-lang (por si borran uno de los dos).
  const readVmCookie = () => {
    const m = document.cookie.match(/(?:^|;\s*)vm-lang=([^;]*)/);
    return m ? decodeURIComponent(m[1]).trim() : '';
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

  // Primera visita (sin idioma guardado ni cookie): se detecta el idioma del navegador
  // (región del visitante) y queda guardado como si lo hubiera elegido. Después manda su elección.
  if (!saved()) {
    const mapLang = c => {
      const l = String(c || '').toLowerCase();
      const t = l.indexOf('-') > -1 ? l.slice(0, l.indexOf('-')) : l;
      if (t === 'zh') return 'zh-CN';
      const set = { es: 'es', en: 'en', pt: 'pt', fr: 'fr', de: 'de', it: 'it', ru: 'ru', ja: 'ja' };
      return set[t] || '';
    };
    const cand = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || '']).filter(Boolean);
    let pick = '';
    for (let i = 0; i < cand.length && !pick; i++) pick = mapLang(cand[i]);
    if (pick) {
      try { localStorage.setItem(LS_KEY, pick); } catch (e) { /* sin localStorage: queda la cookie */ }
      saveCookie(pick);
    }
  }

  // Idioma deseado: lo que el usuario eligió antes, o el de la cookie.
  const want = saved() || current();
  if (want && want !== current()) saveCookie(want); // sincroniza la cookie para la próxima carga

  let translating = false;
  const busy = () => { translating = true; setTimeout(() => { translating = false; }, 2500); };

  let gtInstance = null;

  // Aplica un idioma con el combo interno de Google Translate. Devuelve true si existía el combo.
  const applyCombo = code => {
    const combo = document.querySelector('.goog-te-combo');
    if (!combo) return false;
    busy();
    combo.value = code;
    combo.dispatchEvent(new Event('change'));
    return true;
  };
  // Traduce un bloque (o toda la página) sin volver al español: Google Translate recuerda
  // el original de lo ya traducido, así que solo procesa el contenido nuevo. Evita el
  // parpadeo español que se veía cada vez que el panel actualizaba datos.
  const applySection = node => {
    try {
      if (gtInstance && typeof gtInstance.translateSection === 'function') {
        gtInstance.translateSection(node, want);
        return true;
      }
    } catch (e) { /* si no existe el método, combo de reserva */ }
    return false;
  };
  // Re-traducir el contenido nuevo del panel: primero por sección (sin parpadeo) y, si el
  // traductor no lo permite, vuelve al español y vuelve a aplicar como antes.
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

  const setLang = code => {
    try { localStorage.setItem(LS_KEY, code); } catch (e) { /* sin localStorage: queda la cookie */ }
    saveCookie(code);
    if (code === 'es') { busy(); applyCombo('es') || location.reload(); return; }
    if (!applyCombo(code)) location.reload(); // si el traductor aún no cargó, la cookie ya está guardada
  };

  const css = `
    .vm-lang { appearance: none; padding: 8px 28px 8px 12px; border-radius: 10px; font: 600 12px/1 inherit, system-ui, sans-serif;
      color: #f5f5f8; background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.14); cursor: pointer;
      background-image: linear-gradient(45deg, transparent 50%, #c9c9d4 50%), linear-gradient(135deg, #c9c9d4 50%, transparent 50%);
      background-position: calc(100% - 14px) 50%, calc(100% - 9px) 50%; background-size: 5px 5px; background-repeat: no-repeat; }
    .vm-lang option { background: #14141c; color: #f5f5f8; }
    .vm-lang:focus-visible { outline: 2px solid #c9c9d4; outline-offset: 2px; }
    #google_translate_element { display: none; }
    .goog-te-banner-frame, .skiptranslate { display: none !important; }
    body { top: 0 !important; }`;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const hidden = document.createElement('div');
  hidden.id = 'google_translate_element';
  document.body.appendChild(hidden);

  const sel = document.createElement('select');
  sel.className = 'vm-lang notranslate';
  sel.setAttribute('aria-label', 'Idioma / Language');
  LANGS.forEach(([code, name]) => {
    const o = document.createElement('option');
    o.value = code;
    o.textContent = name;
    sel.appendChild(o);
  });
  sel.value = want || 'es';
  sel.addEventListener('change', () => setLang(sel.value));

  const slot = document.getElementById('langSlot');
  if (slot) slot.appendChild(sel);

  // Placeholders y comentarios dentro de <pre>/<code>: el traductor de Google no los toca.
  // Espejos: cada texto se copia a un nodo oculto que el traductor sí procesa, y el resultado
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

  // Contenido dinámico: el panel crea HTML después de cargar; Google Translate no
  // traduce lo nuevo por sí solo, así que se vuelve a aplicar cuando aparece.
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
      includedLanguages: LANGS.map(l => l[0]).join(','),
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
})();
