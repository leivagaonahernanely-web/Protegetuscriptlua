/*
 * Anuncio nativo de Adsterra (Native Banner). Se monta en el <div id="native-ad"> de la página.
 * No se muestra a quien tiene un plan de pago activo (Premium, Plus o Custom).
 * Si no existe ese contenedor, no hace nada.
 */
(function () {
  var KEY = '54bdc2640666492b6dc879657257e15e';

  function mount(slot) {
    var container = document.createElement('div');
    container.id = 'container-' + KEY;
    slot.appendChild(container);
    var lib = document.createElement('script');
    lib.async = true;
    lib.setAttribute('data-cfasync', 'false');
    lib.src = 'https://bauval.org/21/' + KEY;
    slot.appendChild(lib);
  }

  // Plan pagado vigente: Custom no tiene fecha de vencimiento; Premium y Plus sí
  function hasPaidPlan(me) {
    var paid = ['premium', 'plus', 'custom'].indexOf(me.plan) !== -1;
    if (!paid) return false;
    if (me.plan_expires_at == null) return true;
    return me.plan_expires_at > Math.floor(Date.now() / 1000);
  }

  try {
    var slot = document.getElementById('native-ad');
    if (!slot) return;
    slot.style.display = 'none'; // oculto hasta saber el plan: nadie de pago lo ve ni por un instante
    fetch('/api/me', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (me) {
        if (me && hasPaidPlan(me)) return;
        slot.style.display = '';
        mount(slot);
      })
      .catch(function () {
        // Sin sesión o sin conexión: se muestra el anuncio como a un visitante normal
        slot.style.display = '';
        mount(slot);
      });
  } catch (e) {
    // Si el anuncio no carga, la página sigue normal
  }
})();
