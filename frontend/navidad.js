/*
 * Tema de Navidad (temporal).
 * Para quitarlo cuando termine la temporada:
 *   1. Borra este archivo (frontend/navidad.js).
 *   2. Borra las líneas que digan "NAVIDAD" en el <head> de las páginas de frontend/*.html
 *      (buscar con: grep -rn "NAVIDAD" frontend).
 * No toca el HTML ni el CSS de las páginas: solo agrega una franja y la nieve.
 */
(function () {
  try {
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    var css = [
      '.navidad-bar{position:fixed;top:0;left:0;right:0;height:4px;z-index:9998;pointer-events:none;',
      'background:linear-gradient(90deg,#c8102e 0 12%,#ffffff 12% 16%,#1f7a3a 16% 28%,#ffffff 28% 32%,#c8102e 32% 44%,#ffffff 44% 48%,#1f7a3a 48% 60%,#ffffff 60% 64%,#c8102e 64% 76%,#ffffff 76% 80%,#1f7a3a 80% 92%,#ffffff 92% 96%,#c8102e 96%)}',
      '.navidad-snow{position:fixed;inset:0;overflow:hidden;pointer-events:none;z-index:9997}',
      '.navidad-flake{position:absolute;top:-12px;border-radius:50%;background:rgba(255,255,255,.85);',
      'box-shadow:0 0 4px rgba(255,255,255,.6);animation-name:navidad-fall;animation-timing-function:linear;animation-iteration-count:infinite}',
      '@keyframes navidad-fall{0%{transform:translate3d(0,0,0)}50%{transform:translate3d(18px,50vh,0)}100%{transform:translate3d(-12px,110vh,0)}}',
      '@media (prefers-reduced-motion: reduce){.navidad-flake{animation:none;display:none}}'
    ].join('');

    var style = document.createElement('style');
    style.id = 'navidad-style';
    style.textContent = css;
    document.head.appendChild(style);

    var bar = document.createElement('div');
    bar.className = 'navidad-bar';
    bar.setAttribute('aria-hidden', 'true');
    document.body.appendChild(bar);

    if (reduce) return;

    var snow = document.createElement('div');
    snow.className = 'navidad-snow';
    snow.setAttribute('aria-hidden', 'true');
    for (var i = 0; i < 45; i++) {
      var f = document.createElement('span');
      f.className = 'navidad-flake';
      var size = 3 + Math.random() * 5;
      f.style.width = size + 'px';
      f.style.height = size + 'px';
      f.style.left = (Math.random() * 100) + '%';
      f.style.opacity = (0.35 + Math.random() * 0.6).toFixed(2);
      f.style.animationDuration = (9 + Math.random() * 12).toFixed(1) + 's';
      f.style.animationDelay = (-Math.random() * 20).toFixed(1) + 's';
      snow.appendChild(f);
    }
    document.body.appendChild(snow);
  } catch (e) {
    // Si algo falla, la página se ve normal
  }
})();
