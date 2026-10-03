# Operación del bot Discord

El bot se inicia desde `server/_core/index.ts` mediante `startDiscordBot()` después de que Express empieza a escuchar. El cliente Gateway vive en `server/discordBot.ts`, usa únicamente `DISCORD_BOT_TOKEN` del entorno del servidor y registra `/ping`, `/panel` y `/stats` cuando recibe `ClientReady`.

Para verificar el arranque, revisar los logs del servidor y buscar la línea `[Discord Bot] Online como ...; comandos slash sincronizados.`. Si aparece `DISCORD_BOT_TOKEN no está configurado`, hay que añadir el secreto desde la configuración de secretos. Si aparece un error de login, regenerar el token en Discord Developer Portal y volver a guardarlo sin publicarlo.

La web también consulta `GET /api/trpc/discord.status` para mostrar `BOT ONLINE` o `BOT OFFLINE`. El hosting de scripts funciona por solicitudes HTTP y no depende del Gateway. Para disponibilidad continua en producción, el proceso debe ejecutarse en un modo de hosting que mantenga una instancia persistente; en modo autoscale puede detenerse cuando no hay tráfico.
