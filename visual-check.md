# Verificación visual móvil — 2026-08-26

- La ruta `/` carga el dashboard autenticado en viewport móvil de 375×812 con navegación compacta y estilo oscuro consistente.
- La ruta `/dashboard` devuelve 404 porque la aplicación usa navegación interna en `/`, no una ruta independiente `/dashboard`.
- El estado visible del bot aparece como CONNECTING durante la captura; debe interpretarse junto con los logs del Gateway y no como prueba aislada de desconexión.
