// Selector de idioma. El español es el original de la página.
// Los demás idiomas se traducen automáticamente con Google Translate.
// La elección se guarda en la cookie googtrans (la lee Google Translate al cargar).
(function () {
  const LANGS = [
    ['es', 'Español'], ['en', 'English'], ['pt', 'Português'], ['fr', 'Français'],
    ['de', 'Deutsch'], ['it', 'Italiano'], ['ru', 'Русский'], ['ja', '日本語'], ['zh-CN', '中文'],
  ];

  const current = () => {
    const m = document.cookie.match(/(?:^|;\s*)googtrans=\/es\/([^;]+)/);
    return m ? decodeURIComponent(m[1]) : 'es';
  };
  // Guarda la elección en la cookie (para recordarla al volver a entrar).
  const saveCookie = code => {
    const value = code === 'es' ? '' : `/es/${code}`;
    const age = code === 'es' ? 'max-age=0' : 'max-age=31536000';
    document.cookie = `googtrans=${value}; path=/; ${age}`;
    document.cookie = `googtrans=${value}; path=/; domain=${location.hostname}; ${age}`;
  };
  // Cambia el idioma usando el selector interno de Google Translate (también para volver al español,
  // que es el idioma original de la página). Si el traductor aún no cargó, recarga la página.
  const setLang = code => {
    saveCookie(code);
    const combo = document.querySelector('.goog-te-combo');
    if (combo) {
      combo.value = code;
      combo.dispatchEvent(new Event('change'));
    } else {
      location.reload();
    }
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

  // Contenedor oculto que usa Google Translate.
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
  sel.value = current();
  sel.addEventListener('change', () => setLang(sel.value));

  const slot = document.getElementById('langSlot');
  if (slot) slot.appendChild(sel);

  // El <html> queda en español: así Chrome no ofrece traducir la página "del chino al español".

  window.vmGtInit = () => {
    if (!window.google || !google.translate) return;
    new google.translate.TranslateElement({
      pageLanguage: 'es',
      includedLanguages: LANGS.map(l => l[0]).join(','),
      autoDisplay: false,
    }, 'google_translate_element');
  };
  const s = document.createElement('script');
  s.src = 'https://translate.google.com/translate_a/element.js?cb=vmGtInit';
  s.async = true;
  document.head.appendChild(s);
})();
