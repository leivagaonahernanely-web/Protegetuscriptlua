/*
 * Tema de Navidad (temporal).
 * Para quitarlo cuando termine la temporada:
 *   1. Borra este archivo (frontend/navidad.js).
 *   2. Borra las líneas que digan "NAVIDAD" en el <head> de las páginas de frontend/*.html
 *      (buscar con: grep -rn "NAVIDAD" frontend).
 * No toca el HTML ni el CSS de las páginas. Agrega: guirnalda con luces, nieve con copos
 * de seis puntas, una estrella fugaz de vez en cuando y un brillo frío en los bordes.
 */
(function () {
  try {
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Copos de seis puntas y guirnalda como SVG embebido (sin archivos externos)
    var FLAKE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="1.3" stroke-linecap="round">' +
      '<path d="M12 2v20M3.5 7l17 10M20.5 7l-17 10"/>' +
      '<path d="M9.5 4.6L12 6.6l2.5-2M9.5 19.4L12 17.4l2.5 2M4.8 9.6l.9 2.4 2.3-.2M19.2 14.4l-.9-2.4-2.3.2M4.8 14.4l.9-2.4-2.3-.2M19.2 9.6l-.9 2.4 2.3.2"/>' +
      '</svg>';
    var FLAKE_URL = 'url("data:image/svg+xml;utf8,' + encodeURIComponent(FLAKE_SVG) + '")';

    var WIRE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 24" preserveAspectRatio="none">' +
      '<path d="M-2 3Q30 25 62 3" fill="none" stroke="#14532d" stroke-width="6" stroke-linecap="round" stroke-dasharray="0.8 1.4" opacity=".9"/>' +
      '<path d="M-2 3Q30 25 62 3" fill="none" stroke="#166534" stroke-width="3" stroke-linecap="round" opacity=".9"/>' +
      '<path d="M-2 3Q30 25 62 3" fill="none" stroke="rgba(255,255,255,.28)" stroke-width=".8"/>' +
      '</svg>';
    var WIRE_URL = 'url("data:image/svg+xml;utf8,' + encodeURIComponent(WIRE_SVG) + '")';

    var css = [
      /* Guirnalda: swags de pino y cordón; las luces se agregan como elementos */
      '.navidad-wire{position:fixed;top:0;left:0;right:0;height:24px;z-index:9998;pointer-events:none;',
      'background-image:' + WIRE_URL + ';background-repeat:repeat-x;background-size:60px 24px}',
      '.navidad-bulb{position:absolute;top:7px;width:9px;height:12px;border-radius:50% 50% 46% 46%/60% 60% 40% 40%;',
      'animation:navidad-twinkle ease-in-out infinite;will-change:opacity}',
      '.navidad-bulb::before{content:"";position:absolute;left:2px;top:-3px;width:5px;height:3px;border-radius:2px 2px 0 0;background:#9ca3af}',
      '.navidad-bulb::after{content:"";position:absolute;left:2px;top:2px;width:2px;height:3px;border-radius:50%;background:rgba(255,255,255,.7)}',

      /* Brillo frío en bordes y tinte rojo/verde en las esquinas de arriba */
      '.navidad-glow{position:fixed;inset:0;pointer-events:none;z-index:9995;',
      'background:',
      'radial-gradient(ellipse 60% 45% at 0% 0%,rgba(225,29,72,.09),transparent 70%),',
      'radial-gradient(ellipse 60% 45% at 100% 0%,rgba(34,197,94,.08),transparent 70%),',
      'radial-gradient(ellipse 120% 40% at 50% 110%,rgba(186,230,253,.10),transparent 70%),',
      'radial-gradient(ellipse at center,transparent 62%,rgba(186,230,253,.05) 100%)}',

      /* Nieve en tres capas de profundidad */
      '.navidad-snow{position:fixed;inset:0;overflow:hidden;pointer-events:none;z-index:9997}',
      '.navidad-flake{position:absolute;top:-24px;animation-name:navidad-fall;animation-timing-function:linear;animation-iteration-count:infinite}',
      '.navidad-flake i{display:block;background-repeat:no-repeat;background-size:contain;',
      'animation:navidad-sway ease-in-out infinite alternate}',
      '.navidad-dot{border-radius:50%;background:radial-gradient(circle,#fff 0 40%,rgba(255,255,255,.35) 72%,transparent 100%)}',
      '.navidad-far{filter:blur(1.2px)}',
      '@keyframes navidad-fall{from{transform:translate3d(0,-24px,0)}to{transform:translate3d(0,112vh,0)}}',
      '@keyframes navidad-sway{from{transform:translateX(-16px) rotate(-12deg)}to{transform:translateX(16px) rotate(12deg)}}',
      '@keyframes navidad-twinkle{0%,100%{opacity:.35;filter:brightness(.7)}50%{opacity:1;filter:brightness(1.15)}}',

      /* Estrellas que parpadean en la parte alta */
      '.navidad-star{position:fixed;width:2.5px;height:2.5px;border-radius:50%;background:#fff;pointer-events:none;z-index:9996;',
      'box-shadow:0 0 6px 1px rgba(255,255,255,.55);animation:navidad-twinkle ease-in-out infinite}',

      /* Estrella fugaz: aparece cada tanto y cruza la pantalla en diagonal */
      '.navidad-shoot{position:fixed;top:6%;left:0;width:140px;height:1.5px;pointer-events:none;z-index:9996;opacity:0;',
      'background:linear-gradient(90deg,transparent,rgba(255,255,255,.9));border-radius:2px;',
      'animation:navidad-shoot 18s ease-in infinite}',
      '@keyframes navidad-shoot{0%{opacity:0;transform:translate(-160px,0) rotate(24deg)}2%{opacity:1}',
      '9%{opacity:0;transform:translate(70vw,36vh) rotate(24deg)}100%{opacity:0}}',

      '@media (prefers-reduced-motion: reduce){.navidad-snow,.navidad-star,.navidad-shoot{display:none}',
      '.navidad-bulb{animation:none}}'
    ].join('');

    var style = document.createElement('style');
    style.id = 'navidad-style';
    style.textContent = css;
    document.head.appendChild(style);

    function add(el) { el.setAttribute('aria-hidden', 'true'); document.body.appendChild(el); return el; }
    function rnd(a, b) { return a + Math.random() * (b - a); }

    // Guirnalda con luces: una luz en cada punto bajo de los swags
    var wire = add(document.createElement('div'));
    wire.className = 'navidad-wire';
    var COLORS = ['#ff4d6d', '#ffd166', '#06d6a0', '#74c0fc', '#ffffff', '#c084fc'];
    var count = Math.max(6, Math.floor(window.innerWidth / 60));
    for (var b = 0; b < count; b++) {
      var color = COLORS[b % COLORS.length];
      var bulb = document.createElement('span');
      bulb.className = 'navidad-bulb';
      bulb.style.left = (30 + b * 60 - 4.5) + 'px';
      bulb.style.background = 'radial-gradient(circle at 35% 35%,#fff 0 12%,' + color + ' 45%,' + color + '99 100%)';
      bulb.style.boxShadow = '0 0 8px 2px ' + color + '88, 0 0 18px 4px ' + color + '33';
      bulb.style.animationDuration = rnd(1.6, 3.2).toFixed(2) + 's';
      bulb.style.animationDelay = (-rnd(0, 3)).toFixed(2) + 's';
      wire.appendChild(bulb);
    }

    add(document.createElement('div')).className = 'navidad-glow';

    if (reduce) return;

    // Estrellitas en la parte alta
    for (var s = 0; s < 16; s++) {
      var star = document.createElement('span');
      star.className = 'navidad-star';
      star.style.left = rnd(2, 98).toFixed(1) + '%';
      star.style.top = rnd(3, 42).toFixed(1) + '%';
      star.style.animationDuration = rnd(2, 4.5).toFixed(1) + 's';
      star.style.animationDelay = (-rnd(0, 4)).toFixed(1) + 's';
      add(star);
    }

    // Estrella fugaz
    add(document.createElement('span')).className = 'navidad-shoot';

    // Nieve: capa lejana (puntos difusos), media y cercana (copos de seis puntas)
    var snow = add(document.createElement('div'));
    snow.className = 'navidad-snow';
    var layers = [
      { n: 28, size: [2, 4], dur: [18, 28], op: [0.2, 0.45], kind: 'dot', far: true },
      { n: 20, size: [7, 11], dur: [12, 18], op: [0.45, 0.75], kind: 'flake', far: false },
      { n: 10, size: [12, 18], dur: [9, 14], op: [0.6, 0.9], kind: 'flake', far: false },
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
        if (L.kind === 'flake') {
          inner.style.backgroundImage = FLAKE_URL;
          inner.style.animationDuration = rnd(4, 7).toFixed(1) + 's';
        } else {
          inner.className = 'navidad-dot';
          inner.style.animationDuration = rnd(5, 8).toFixed(1) + 's';
        }
        inner.style.animationDelay = (-rnd(0, 6)).toFixed(1) + 's';
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
