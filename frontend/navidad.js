/*
 * Tema de Navidad (temporal).
 * Para quitarlo cuando termine la temporada:
 *   1. Borra este archivo (frontend/navidad.js).
 *   2. Borra las líneas que digan "NAVIDAD" en el <head> de las páginas de frontend/*.html
 *      (buscar con: grep -rn "NAVIDAD" frontend).
 * No toca el HTML ni el CSS de las páginas: solo agrega guirnalda, luces, nieve y un brillo suave.
 */
(function () {
  try {
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    var css = [
      /* Guirnalda: cordón y bolas de colores arriba */
      '.navidad-garland{position:fixed;top:0;left:0;right:0;height:16px;z-index:9998;pointer-events:none;',
      'background:',
      'radial-gradient(circle at 8px 6px,#e11d48 0 3.2px,transparent 3.6px) 0 0/44px 16px repeat-x,',
      'radial-gradient(circle at 30px 9px,#fbbf24 0 2.6px,transparent 3px) 0 0/44px 16px repeat-x,',
      'radial-gradient(circle at 22px 6px,#22c55e 0 3.2px,transparent 3.6px) 0 0/44px 16px repeat-x,',
      'linear-gradient(180deg,transparent 0 5px,rgba(255,255,255,.35) 5px 6px,transparent 6px)}',
      '.navidad-garland::after{content:"";position:absolute;inset:0;background:',
      'radial-gradient(circle at 15px 10px,#e0f2fe 0 1.6px,transparent 2px) 0 0/44px 16px repeat-x;opacity:.5}',
      /* Brillo frío y cálido en las esquinas, muy suave */
      '.navidad-glow{position:fixed;inset:0;pointer-events:none;z-index:9995;',
      'background:radial-gradient(900px 500px at 0% 0%,rgba(225,29,72,.10),transparent 60%),',
      'radial-gradient(900px 500px at 100% 0%,rgba(34,197,94,.08),transparent 60%),',
      'radial-gradient(1200px 380px at 50% 100%,rgba(186,230,253,.08),transparent 70%)}',
      /* Nieve en tres capas: lejos (lenta y difusa), media y cerca (rápida y nítida) */
      '.navidad-snow{position:fixed;inset:0;overflow:hidden;pointer-events:none;z-index:9997}',
      '.navidad-flake{position:absolute;top:-16px;animation-name:navidad-fall;animation-timing-function:linear;animation-iteration-count:infinite}',
      '.navidad-flake i{display:block;border-radius:50%;background:radial-gradient(circle,#fff 0 45%,rgba(255,255,255,.4) 70%,transparent 100%);',
      'animation:navidad-sway ease-in-out infinite alternate}',
      '.navidad-far{filter:blur(1px)}',
      '@keyframes navidad-fall{from{transform:translate3d(0,-20px,0)}to{transform:translate3d(0,110vh,0)}}',
      '@keyframes navidad-sway{from{transform:translateX(-14px)}to{transform:translateX(14px)}}',
      '@keyframes navidad-twinkle{0%,100%{opacity:.25}50%{opacity:1}}',
      '.navidad-star{position:fixed;width:3px;height:3px;border-radius:50%;background:#fff;pointer-events:none;z-index:9996;',
      'box-shadow:0 0 6px 1px rgba(255,255,255,.6);animation:navidad-twinkle ease-in-out infinite}',
      '@media (prefers-reduced-motion: reduce){.navidad-snow,.navidad-star{display:none}}'
    ].join('');

    var style = document.createElement('style');
    style.id = 'navidad-style';
    style.textContent = css;
    document.head.appendChild(style);

    function add(el) { el.setAttribute('aria-hidden', 'true'); document.body.appendChild(el); return el; }
    function rnd(a, b) { return a + Math.random() * (b - a); }

    add(document.createElement('div')).className = 'navidad-garland';
    add(document.createElement('div')).className = 'navidad-glow';

    if (reduce) return;

    // Estrellitas que parpadean en la parte alta, como luces de árbol
    for (var s = 0; s < 14; s++) {
      var star = document.createElement('span');
      star.className = 'navidad-star';
      star.style.left = rnd(2, 98) + '%';
      star.style.top = rnd(2, 40) + '%';
      star.style.animationDuration = rnd(2, 4).toFixed(1) + 's';
      star.style.animationDelay = (-rnd(0, 4)).toFixed(1) + 's';
      add(star);
    }

    // Nieve: 3 capas de profundidad
    var snow = add(document.createElement('div'));
    snow.className = 'navidad-snow';
    var layers = [
      { n: 26, size: [2, 4], dur: [16, 26], op: [0.2, 0.45], far: true },
      { n: 22, size: [3, 6], dur: [11, 18], op: [0.4, 0.75], far: false },
      { n: 10, size: [6, 9], dur: [8, 13], op: [0.6, 0.9], far: false },
    ];
    layers.forEach(function (L) {
      for (var i = 0; i < L.n; i++) {
        var f = document.createElement('span');
        f.className = 'navidad-flake' + (L.far ? ' navidad-far' : '');
        var size = rnd(L.size[0], L.size[1]);
        var inner = document.createElement('i');
        inner.style.width = size.toFixed(1) + 'px';
        inner.style.height = size.toFixed(1) + 'px';
        inner.style.opacity = rnd(L.op[0], L.op[1]).toFixed(2);
        inner.style.animationDuration = rnd(3, 6).toFixed(1) + 's';
        inner.style.animationDelay = (-rnd(0, 5)).toFixed(1) + 's';
        f.appendChild(inner);
        f.style.left = rnd(0, 100).toFixed(1) + '%';
        f.style.animationDuration = rnd(L.dur[0], L.dur[1]).toFixed(1) + 's';
        f.style.animationDelay = (-rnd(0, L.dur[1])).toFixed(1) + 's';
        snow.appendChild(f);
      }
    });
  } catch (e) {
    // Si algo falla, la página se ve normal
  }
})();
