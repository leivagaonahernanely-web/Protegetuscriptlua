

## Corrección del canal Discord rechazado

La mutación `discord.updateChannel` ahora trata la respuesta 404/403 de Discord como un resultado controlable: limpia el `discordChannelId` persistido y devuelve `{ ok: false, status, message }` en lugar de lanzar un `TRPCClientError`. Setup borra también el valor local y muestra la guía accionable como aviso de interfaz. Un canal accesible sigue devolviendo `{ ok: true, channelId }`. La creación o republicación de paneles continúa bloqueándose cuando Discord no permite publicar, porque esas acciones no pueden completarse sin acceso real al canal.

## Video SVID_20260826_123517_1.mp4: hallazgos funcionales

El análisis del video muestra un panel Discord con cinco acciones: Redeem Key, Get Script, Get Role, Reset HWID y Get Stats. Redeem Key abre un formulario de key; Get Script entrega un loader con `script_key`; Get Stats muestra expiración, estado HWID y próximo reset; Reset HWID confirma el desbloqueo. El video también muestra que `/generatekeyrol` puede fallar con un mensaje de administración insuficiente, por lo que Vanta debe reportar la respuesta real del bot y no asumir que el propietario carece de permisos.

Estos hallazgos se reflejan así: FFA / TRIAL GLOBAL entrega el artefacto sin key individual; con FFA desactivado el endpoint exige una key activa de 10 dígitos; Generate / Manage acepta duración por días, meses o años y `/addtime` acepta formatos equivalentes; Setup acepta el ID numérico o el enlace completo `https://discord.com/channels/<guild>/<channel>`, conserva localmente guild y canal y envía a la API únicamente el channel ID normalizado.
