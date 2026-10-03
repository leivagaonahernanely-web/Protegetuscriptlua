# Diagnóstico de canales Discord

## Error `Unknown Channel`

Vanta.vs Protector verifica el canal con la API de Discord antes de guardar la preferencia o publicar un panel. Un rechazo HTTP **404** se muestra como “Discord no encuentra ese canal o el bot no tiene acceso”; el sistema no afirma cuál de esas causas es la responsable sin una comprobación real del servidor. Un rechazo **403** significa que Discord denegó la operación por permisos.

Para corregirlo, activa **Developer Mode** en Discord, copia el ID del canal directamente desde el canal correcto y comprueba que el bot esté instalado en el mismo servidor. En el canal, el bot debe tener como mínimo **View Channel** y **Send Messages**. Si el canal es un hilo, una categoría o pertenece a otro servidor, selecciona un canal de texto accesible. Guarda de nuevo el ID desde Setup; si Discord lo rechaza, la aplicación limpia el valor rechazado del estado local y no persiste la preferencia inaccesible.

La validación de este flujo se cubre con pruebas para ID mal formado, canal accesible, respuestas 404 y limpieza de la configuración local tras un fallo. El token del bot nunca se envía al navegador.
