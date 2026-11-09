/*
 * Anuncio nativo de Adsterra (Native Banner). Se monta en el <div id="native-ad"> de la página.
 * Si no existe ese contenedor, no hace nada.
 */
(function () {
  try {
    var KEY = '54bdc2640666492b6dc879657257e15e';
    var slot = document.getElementById('native-ad');
    if (!slot) return;
    var container = document.createElement('div');
    container.id = 'container-' + KEY;
    slot.appendChild(container);
    var lib = document.createElement('script');
    lib.async = true;
    lib.setAttribute('data-cfasync', 'false');
    lib.src = 'https://bauval.org/21/' + KEY;
    slot.appendChild(lib);
  } catch (e) {
    // Si el anuncio no carga, la página sigue normal
  }
})();
