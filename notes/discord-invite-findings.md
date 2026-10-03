# Hallazgos externos sobre invitación Discord

- Fuente oficial OAuth2: https://docs.discord.com/developers/topics/oauth2
  - El scope `bot` coloca el bot en el servidor seleccionado.
  - `applications.commands` permite comandos; la documentación indica que está incluido por defecto con `bot`.
- Fuente oficial Application Resource: https://docs.discord.com/developers/resources/application
  - `bot_public=false`: solo el owner de la aplicación puede añadir el bot a servidores.
  - `bot_require_code_grant=true`: el bot solo se une después del flujo OAuth2 completo de authorization code grant.
- El enlace actualmente generado por la aplicación es `https://discord.com/oauth2/authorize?client_id=1519073151856803930&permissions=268520448&scope=bot+applications.commands&integration_type=0`.
- Los permisos 268520448 corresponden a View Channel, Send Messages, Embed Links, Read Message History y Manage Roles.
- Diagnóstico probable para que otros usuarios no puedan añadirlo: activar Public Bot en Discord Developer Portal y desactivar Requires OAuth2 Code Grant, si están configurados de forma restrictiva. La URL de invitación actual sí contiene `bot` y `applications.commands` y no contiene `redirect_uri`.
