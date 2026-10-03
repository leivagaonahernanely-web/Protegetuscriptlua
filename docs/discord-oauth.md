# Discord OAuth en producción

Para el dominio publicado, registra exactamente esta URI en Discord Developer Portal → OAuth2 → Redirects:

`https://vanta-prot-hfw5hmym.manus.space/api/discord/callback`

No agregues una barra `/` al final, no uses la URL de preview y no pegues la URL completa de autorización como redirect. La URL completa de autorización la genera automáticamente el botón **Conectar Discord**.

Si también pruebas en preview, registra por separado la URI que aparece en Setup, por ejemplo:

`https://3000-iv3as1cf859kyo1na8z69-7177b250.us3.manus.computer/api/discord/callback`

Después de guardar la URI, vuelve al dashboard publicado y pulsa **Conectar Discord**. Si Discord todavía muestra `redirect_uri no válido`, significa que la URI del dominio exacto aún no está guardada en la aplicación Discord o que se está usando otra aplicación/client ID.

## Acceso de scripts

Un script protegido sin key devuelve `403 Key required` y no ejecuta. Un script FFA/TRIAL requiere `key=trial` y el loader muestra `script_key = "trial"`. Una key numérica revocada, vencida o inválida también se rechaza.
