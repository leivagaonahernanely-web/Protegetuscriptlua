# Project TODO

- [x] Landing pública responsive con la marca exacta “Vanta.vs Protector”
- [x] Estética brutalista: fondo negro, tipografía sans-serif condensada blanca, divisor rojo de ancho completo y layout centrado
- [x] Propuesta de valor y llamadas a la acción claras
- [x] Flujo de acceso mediante la autenticación existente del proyecto
- [x] Panel de usuario para iniciar una protección de script Lua
- [x] Editor para pegar código Lua y opciones visibles de protección
- [x] Área de resultados con estado, previsualización, copia y descarga
- [x] Persistencia de protecciones y actividad por usuario
- [x] Integración de Client ID y Client Secret únicamente en variables de entorno del servidor
- [x] Servicio servidor para ejecutar la protección y manejar estados de éxito, fallo y revisión
- [x] Notificación al propietario cuando una protección falle o requiera revisión
- [x] Pruebas Vitest para protección, persistencia, errores y seguridad de configuración
- [x] Validación visual responsive y revisión de consola/red

- [x] Conectar un proveedor real en servidor usando VANTA_CLIENT_ID y VANTA_CLIENT_SECRET, con endpoint autenticado y handshake verificable
- [x] Hacer que mode y obfuscateStrings transformen materialmente el artefacto Lua, no solo sus comentarios
- [x] Manejar notifyOwner() con reintento o fallback no bloqueante y validar su resultado
- [x] Añadir pruebas Vitest para create, history, persistencia, estados y notificaciones

- [x] Configurar la conexión servidor-servidor con el bot de Discord usando sus credenciales privadas
- [x] Definir el canal o método de Discord para avisos de fallos y revisiones

- [x] Crear callback OAuth de Discord con state/nonce y cookies seguras
- [x] Añadir botón de acceso de Discord y mostrar la identidad autenticada en el panel
- [x] Asociar la cuenta Discord con el usuario y evitar exponer Client Secret en el cliente
- [x] Añadir pruebas del callback OAuth y de rechazo de state inválido

- [x] Confirmar conexión del bot instalado con un aviso de prueba sin exponer el token
- [x] Añadir en el panel un campo de ID de canal por usuario y validarlo antes de enviar avisos

- [x] Hacer que obfuscateStrings cambie materialmente el artefacto y cubrirlo con una prueba comparativa
- [x] Persistir discordChannelId como preferencia por usuario y reutilizarlo automáticamente
- [x] Comprobar el resultado de los avisos y registrar cuando fallen ambos canales
- [x] Añadir cobertura de tests para create/history y un aviso Discord simulado sin exponer el token

- [x] Añadir tests Vitest para protections.create y protections.history con appRouter.createCaller y estados protected/review/failed
- [x] Añadir tests de persistencia para updateDiscordChannelId, createProtection y getProtectionsByUser

- [x] Añadir pruebas directas de db.ts para updateDiscordChannelId, createProtection y getProtectionsByUser con mock de Drizzle

- [x] Mostrar explícitamente el nombre o ID de Discord vinculado dentro del panel
- [x] Añadir test del camino exitoso del callback OAuth con intercambio de token y vinculación de identidad

- [x] Añadir una prueba de éxito del callback Discord que simule token, identidad y vinculación

- [x] Rediseñar la pantalla pública y el panel hacia un dashboard oscuro, compacto y limpio inspirado en la nueva referencia
- [x] Añadir hosting persistente de scripts Lua con slug o ID público y endpoint GET de contenido
- [x] Generar y mostrar el loader exacto `loadstring(game:HttpGet("URL"))()` con copiar y descargar
- [x] Añadir pruebas de creación, lectura pública y control de acceso de scripts alojados
- [x] Validar el video y comparar visualmente el flujo de hosting con la referencia

- [x] Cambiar el flujo de hosting para mostrar una página pública sin source y solo loader
- [x] Añadir vista privada de dashboard para administrar scripts alojados
- [x] Generar loader con URL pública estable y opción de script_key cuando corresponda
- [x] No presentar la protección básica como Luraph; dejar adapter preparado para API oficial/licenciada

- [x] Añadir botón o acción real de descarga para el loader o el script alojado
- [x] Crear pruebas Vitest para hostedScripts.create y hostedScripts.list con acceso autenticado y no autenticado

- [x] Añadir scriptKey opcional al modelo de scripts alojados y al loader generado
- [x] Crear una interfaz de adapter de proveedor que deje claro cuándo existe una integración oficial licenciada

- [x] Exponer official/provider del adapter en providerStatus y mostrarlo en el panel
- [x] Probar fallback local y adapter oficial registrado sin sugerir compatibilidad falsa con Luraph

- [x] Diagnosticar por qué el bot aparece apagado y documentar el proceso de ejecución persistente
- [x] Crear modelo de licencias con keys automáticas de 10 dígitos y tipo trial separado de key
- [x] Implementar generación, eliminación, revocación y reset de HWID
- [x] Implementar blacklist de usuarios con motivo y estado
- [x] Implementar whitelist de usuarios y roles de Discord
- [x] Implementar pantalla Setup para configurar script, permisos, trial y canal
- [x] Añadir endpoints protegidos para administrar licencias y listas de acceso
- [x] Rediseñar la UI del panel con navegación y estados reales para cada función
- [x] Añadir pruebas de autorización, generación de keys, trial, blacklist, whitelist y reset HWID

- [x] Verificar si el estado “apagado” corresponde a proceso no iniciado, token, intents, comandos no sincronizados o indicador del panel
- [x] Corregir la causa comprobable sin activar Reserved Hosting por suposición

- [x] Mantener sin cambios el hosting G/script loader mientras se depura Discord
- [x] Diagnosticar exclusivamente el estado apagado del bot y sus comandos slash

- [x] Documentar en el proyecto cómo se inicia y verifica el Gateway del bot Discord
- [x] Implementar borrado real de licencias separado de revocación
- [x] Completar Setup con script, permisos, trial y canal Discord
- [x] Añadir pruebas de no autenticado, reset HWID, revocación y borrado

- [x] Integrar en Setup los campos de script, permisos, trial y canal Discord en una sola vista
- [x] Añadir persistencia local y validación visible del estado de configuración de Setup
- [x] Añadir prueba verificable de la configuración integrada de Setup

- [x] Mostrar en Setup un estado visible de guardado y validez del canal/configuración
- [x] Crear prueba específica de Setup para persistencia local y updateChannel

- [x] Añadir prueba frontend o helper de Setup para localStorage, estado visible y updateChannel con ID válido o null

- [x] Replicar la división visual del /panel del video con botones View Script, Redeem Key, Stats, Get Buyer Role y Reset HWID
- [x] Implementar todos los comandos slash del bot como acciones funcionales y autorizadas
- [x] Permitir cargar scripts Lua desde archivos además de pegar source
- [x] Restringir la consulta de source a la cuenta propietaria y mantener endpoints públicos sin source visible
- [x] Añadir pruebas de permisos, acciones Discord, carga de archivos y privacidad de source
- [x] Verificar responsive y regresiones del hosting, licencias, blacklist, whitelist y Setup

- [x] Mantener la source visible solo desde la web privada del propietario; retirar cualquier propuesta de /viewscript en Discord
- [x] Rediseñar /panel con mensaje explicativo y botones Redeem Key, Get Script, Get Role, Reset HWID y Get Stats según la referencia
- [x] Añadir /generatekeyrol para configurar el rol autorizado a generar y eliminar keys
- [x] Permitir que el rol configurado ejecute generación y eliminación de keys con auditoría y límites
- [x] Responder el flujo whitelist con embed de resumen, conteos y canal de acceso como en la referencia

- [x] Persistir la source original separada del artefacto protegido y exponerla solo al propietario autenticado
- [x] Añadir pruebas owner-only para hostedScripts.source, autenticación y comandos slash
- [x] Implementar auditoría y límites reales para generación/eliminación de keys por rol delegado
- [x] Calcular conteos reales de whitelist y manejar duplicados y fallos

- [x] Ajustar /panel para que publique el embed público con título, descripción, colores, filas y textos equivalentes a la referencia
- [x] Añadir prueba del contenido visible del embed y del orden exacto de botones del panel

- [x] Probar explícitamente título, descripción, color y filas del embed final de /panel
- [x] Probar que la publicación de /panel sea pública y responda una sola vez sin 40060

- [x] Probar el handler real de /panel con una interacción simulada y respuesta pública única
- [x] Investigar los logs recientes y eliminar el origen real de DiscordAPIError 40060 antes del checkpoint

- [x] Exponer y probar el handler completo de InteractionCreate para /panel con una única respuesta pública
- [x] Reproducir en prueba una interacción ya reconocida y confirmar que el guard anti-40060 evita una segunda respuesta

- [x] Separar Overview como vista informativa sin acciones de administración
- [x] Reorganizar el menú lateral en Workspace, Protection, Panels, Keys y Settings
- [x] Eliminar comandos slash globales antiguos y sincronizar solo el conjunto nuevo por servidor
- [x] Implementar /addtime, /warn, /dropkey y /prices con acciones reales
- [x] Mostrar estado Gateway online/connecting/offline con reintentos automáticos
- [x] Guardar y mostrar avatar, nombre, apodo e ID de Discord
- [x] Implementar Create New Panel y Manage Panels con persistencia y publicación real
- [x] Añadir pruebas de contratos de opciones obligatorias/opcionales y paneles persistidos

- [x] Añadir reconexión automática del bot para errores y desconexiones posteriores al arranque y probarla
- [x] Completar Manage Panels con republicar, actualizar o eliminar paneles persistidos y probar las acciones

- [x] Añadir prueba Vitest explícita del gate de reconexión ante Error y ShardDisconnect, incluyendo un único reintento
- [x] Añadir pruebas owner-only de discord.republishPanel y discord.deletePanel y manejo de panel inexistente
- [x] Añadir edición de configuración de panel persistido o documentar y probar que Manage Panels ofrece republicar y eliminar como acciones soportadas

- [x] Clasificar Unknown Channel como 404/403 y mostrar una guía accionable sin afirmar la causa exacta del canal concreto
- [x] Validar acceso real del bot al canal antes de guardar o publicar paneles
- [x] Mostrar un error accionable y no persistir IDs de canal inaccesibles
- [x] Añadir pruebas para canal desconocido, canal accesible y limpieza del estado guardado

- [x] Documentar que Unknown Channel se clasifica como 404/403 y no afirmar la causa exacta del canal concreto sin una comprobación real
- [x] Añadir prueba del helper de Setup que limpia el canal rechazado y persiste channel vacío tras fallo de updateChannel

- [x] Documentar explícitamente en docs el manejo de Unknown Channel, causas posibles y pasos de corrección

- [x] Crear README.md raíz con enlace y resumen del diagnóstico de canales Discord

- [x] Auditar errores actuales, logs y duplicados de comandos/configuración
- [x] Verificar y corregir sincronización de slash commands por servidor
- [x] Verificar redirect URI y callback OAuth de Discord en preview y dominio publicado
- [x] Corregir estado del bot y manejo de reconexión sin falsos OFFLINE
- [x] Mejorar la presentación de estados de carga, error y conexión del bot en la interfaz
- [x] Añadir pruebas de regresión para bot, OAuth, duplicados y errores reportados
- [x] Ejecutar validación completa y publicar solo después de pasarla

- [x] Probar que el inicio OAuth genera el callback correcto para preview y dominio publicado
- [x] Probar el callback completo con state válido usando el host dinámico sin exponer secretos

- [x] Revisar el flujo y las funciones visibles de la página de referencia de obfuscación
- [x] Comparar obfuscación, carga de source, protección y resultados con Vanta.vs Protector
- [x] Proponer mejoras priorizadas sin copiar secretos ni afirmar compatibilidad no verificada

- [x] Verificar la redirección mostrada en el video; no era el dashboard propio, sino My Browser de Manus
- [x] Identificar el origen observado: la carga detenida pertenece a My Browser de Manus, no a Vanta.vs Protector
- [x] Documentar que esta incidencia no se corrige dentro de Vanta.vs Protector y debe reportarse al soporte de Manus
- [x] Añadir comprobaciones de regresión para carga del dashboard y navegación visible de Vanta.vs Protector

- [x] Añadir una prueba verificable de Home para carga básica, navegación visible, Overview sin duplicados y estado del bot
- [x] Documentar en docs que el spinner de manus.im/my-browser?step=settings pertenece a My Browser/Manus y debe reportarse a soporte

- [x] Corregir el rechazo del canal Discord guardado para distinguir ID inválido, canal inexistente y permisos insuficientes
- [x] Añadir recuperación visible en Setup y evitar reintentos automáticos con un canal rechazado
- [x] Añadir pruebas de regresión para los mensajes y estados 404/403 del canal Discord

- [x] Analizar el video compartido y comparar el flujo visible con el dashboard actual
- [x] Cambiar FFA mode para que represente trial global sin key individual
- [x] Hacer que el modo no FFA exija key individual antes de ejecutar el script
- [x] Rediseñar la duración de licencias para días, meses y años, incluyendo addtime
- [x] Corregir el diagnóstico de permisos del canal Discord para no afirmar falta de permisos sin prueba
- [x] Añadir pruebas de acceso FFA/key, duraciones y mensajes de permisos

- [x] Permitir pegar un enlace completo de Discord en Setup, conservar servidor/canal y extraer el ID del canal para validación
- [x] Añadir pruebas para enlaces válidos, enlaces incompletos y entradas numéricas compatibles

- [x] Eliminar el nombre automático Banta lagger y usar el nombre escrito por el usuario para scripts y paneles
- [x] Mejorar el formulario de creación y la estética visual del dashboard con estados más claros
- [x] Añadir sonido de entrada opcional y controlado por el usuario, sin autoplay bloqueado por el navegador
- [x] Añadir pruebas de regresión para nombre personalizado, copy visual y sonido opcional

- [x] Añadir formulario de Prices con nombre y descripción personalizados
- [x] Mostrar vista previa profesional del mensaje Prices antes de publicarlo
- [x] Conectar el formulario con la publicación Discord y cubrirlo con pruebas

- [x] Usar la referencia visual del embed compartido para organizar título, etiqueta APP, bloques de precios y pie de autor
- [x] Permitir editar nombre y descripción del mensaje Prices con una vista previa equivalente al embed de Discord
- [x] Publicar Prices usando el contenido configurado, sin conservar el título fijo anterior

- [x] Añadir una prueba frontend de Prices que confirme la mutación con título y descripción
- [x] Reemplazar el textarea libre por bloques de precios editables y estructurados
- [x] Alinear la preview con el payload real del embed de Discord
- [x] Eliminar el título fijo Accepted Payments del embed publicado o hacerlo configurable

- [x] Añadir comando slash /updates para publicar actualizaciones en Discord
- [x] Crear formulario editable de título y contenido de actualizaciones con preview profesional
- [x] Conectar /updates con el canal configurado y cubrirlo con pruebas

- [x] Añadir prueba del router publishUpdates con canal configurado, validación y llamada al bot
- [x] Añadir prueba frontend del editor Updates con título y descripción enviados a la mutación

- [x] Añadir prueba de interacción del editor Prices en Home con la mutación tRPC real mockeada
- [x] Alinear la etiqueta APP de la preview de Prices con el embed publicado en Discord
- [x] Añadir prueba de interacción del editor Updates en Home con la mutación tRPC real mockeada

- [x] Cubrir interacción real del editor Prices en Home con tRPC mockeado
- [x] Cubrir interacción real del editor Updates en Home con tRPC mockeado

- [x] Documentar los hallazgos concretos del video y su impacto en FFA, trial y acceso por key
- [x] Unificar duración de licencias en web y slash commands con unidad días/meses/años
- [x] Persistir y usar el guildId extraído del enlace Discord, o documentar explícitamente que solo se valida el canal

- [x] Refactorizar parseDuration del bot para reutilizar shared/duration.ts
- [x] Añadir pruebas que comparen duración web y slash para días, meses y años

- [x] Diagnosticar por qué checkDiscordChannel termina en error de contacto con Discord
- [x] Diferenciar timeout, fallo de red, token ausente y respuestas HTTP en el mensaje de Setup
- [x] Añadir reintento controlado y pruebas del fallo de contacto sin propagar un error genérico

- [x] Crear catálogo Prices con planes Free, Pro y Premium y límites de obfuscaciones, scripts y keys
- [x] Mostrar los planes en un embed/panel visual claro y configurable
- [x] Auditar por qué /panel no funciona como el flujo del video
- [x] Corregir botones Redeem Key, Get Script, Get Role, Reset HWID y Get Stats de /panel
- [x] Añadir pruebas de límites del catálogo y de interacciones completas de /panel

- [x] Comparar el video de /panel con el embed y botones actualmente publicados
- [x] Ajustar el diseño de /panel al formato visual del video, sin títulos fijos ni redirecciones a la web
- [x] Hacer que Get Script entregue directamente el loader y la key del usuario autorizado
- [x] Verificar con pruebas que las cinco acciones del panel responden una sola vez y con datos reales

- [x] Corregir /whitelabel para usar selector nativo de usuario o rol según el tipo elegido
- [x] Quitar el ID manual y cargar opciones válidas del guild actual
- [x] Añadir pruebas de opciones y persistencia de whitelist por usuario/rol seleccionado

- [x] Vincular de forma segura la cuenta Discord del propietario como owner, sin inventar ni hardcodear un ID
- [x] Añadir apartado privado Generate / Manage para crear keys Free, Pro y Premium
- [x] Aplicar cuotas reales de obfuscaciones, scripts y keys por plan
- [x] Mostrar duración, cantidad, plan y resultado de las keys generadas
- [x] Añadir pruebas de autorización, cuotas y generación de keys por plan

- [x] Permitir editar la source privada de un script alojado
- [x] Permitir eliminar scripts y reemplazar/publicar una nueva versión
- [x] Reparar la subida de archivos Lua desde el dashboard con validación visible
- [x] Verificar que el loader público siempre sirva la versión actual sin exponer la source
- [x] Hacer que el modo protegido rechace accesos sin key automática válida
- [x] Mostrar `script_key = "trial"` únicamente para el trial global cuando corresponda
- [x] Confirmar y documentar el formato final de keys automáticas antes de cambiarlo

- [x] Tratar FFA como trial global y generar automáticamente `script_key = "trial"` para el loader de scripts en modo trial
- [x] Impedir que se creen o escriban keys trial manuales
- [x] Hacer que el modo protegido rechace cualquier ejecución sin key automática activa, vinculada al script y validada por HWID
- [x] Mantener el formulario de generación sin campo editable de dígitos; el servidor debe generar la key

- [x] Diagnosticar el error `El Gateway Discord no está conectado` reportado al publicar o administrar desde la web
- [x] Corregir la reconexión del Gateway y evitar que el estado connecting bloquee mutaciones recuperables
- [x] Añadir prueba de estado Gateway desconectado y mensaje accionable en la interfaz

- [x] Mostrar la sección Owner y la administración de keys únicamente a la cuenta Discord vinculada del propietario
- [x] Mostrar claramente en Scripts los controles Editar, Reemplazar, Eliminar, Loader y Logs
- [x] Añadir una vista de logs de protección y acceso con acciones de eliminar restringidas al owner
- [x] Hacer que la subida de source Lua procese automáticamente el artefacto protegido y actualice el loader
- [x] Rediseñar visualmente Planes, Prices y Generate / Manage con una experiencia compacta y profesional inspirada en herramientas de protección Lua
- [x] Añadir pruebas de autorización owner-only, gestión de logs y flujo automático de subida

- [x] Corregir el rechazo `No tienes permiso para hacer un drop` para la cuenta owner vinculada
- [x] Permitir descarga directa de source únicamente al owner y mantener loader protegido para los demás
- [x] Añadir pruebas de autorización de dropkey y descarga privada de source

- [x] Mostrar en cada script acciones visibles para editar source, subir nueva versión, eliminar, ver loader y consultar logs
- [x] Mantener la misma URL del loadstring al reemplazar su source y evitar duplicados
- [x] Añadir pruebas de render móvil y de las acciones visibles de Scripts

- [x] Alinear el redirect URI de Discord OAuth con el dominio publicado `vanta-prot-hfw5hmym.manus.space`
- [x] Verificar el callback `/api/discord/callback` y mostrar un error accionable si Discord no tiene registrada la URL exacta
- [x] Confirmar con pruebas que sin key el modo protegido rechaza la ejecución y FFA exige `key=trial`

- [x] Revisar el flujo OAuth del dominio publicado y dejar instrucciones de redirect URI exactas
- [x] Mantener la regla de una key protegida por un único HWID y rechazar dispositivos distintos
- [x] Completar el owner-only explícito cuando la cuenta Discord quede vinculada
- [x] Pulir visualmente los paneles de planes, precios y generación de keys

- [x] Retirar Owner Sources privado del alcance por solicitud del usuario
- [x] No informar ni implementar acceso Owner Sources, porque fue retirado del alcance
- [x] Crear Owner Key privado para generar keys automáticas asociadas a Free, Pro o Premium
- [x] Implementar canje de Owner Key para activar el plan y las cuotas del workspace del usuario
- [x] Impedir reutilización, falsificación o canje de una key por un usuario no autorizado
- [x] Añadir pruebas de privacidad, canje, activación de plan y límites por workspace

- [x] Cambiar las Owner Key al formato automático `FREE-...`, `PRO-...` y `PREMIUM-...`
- [x] Aumentar la longitud de almacenamiento y validación para prefijos más identificador aleatorio
- [x] Hacer que canje y hosting acepten el nuevo formato sin permitir edición manual
- [x] Añadir pruebas de prefijo, unicidad, canje y compatibilidad con keys existentes

- [x] Separar Plans de Prices en la navegación y el menú lateral
- [x] Crear la vista Plans con tarjetas Free, Pro y Premium y sus beneficios
- [x] Añadir formulario para canjear la key y refrescar automáticamente el workspace
- [x] Mostrar uso y saldo restante de ofuscaciones, scripts y keys por plan
- [x] Validar la sección Plans en móvil y añadir pruebas del canje y los saldos

- [x] Simplificar /whitelist a selector de script hosteado, tipo User/Role y destino dinámico
- [x] Mostrar únicamente scripts hosteados por la web como opciones del comando
- [x] Cargar usuarios al elegir User y roles al elegir Role mediante autocomplete
- [x] Eliminar IDs o nombres manuales y mantener un máximo de tres opciones principales
- [x] Añadir pruebas del registro, autocomplete y ejecución de whitelist/unwhitelist

- [x] Quitar cualquier tarjeta, métrica o texto de planes del módulo Prices
- [x] Mantener toda la información, canje y saldos de planes únicamente en Plans
- [x] Dejar Generate / Manage solo para keys normales
- [x] Dejar Plan Keys como único generador privado de keys PRO/PREMIUM del owner
- [x] Hacer que las keys normales sean exactamente de 10 dígitos
- [x] Hacer que el mensaje de generación normal muestre únicamente la key
- [x] Pulir UI y sonidos sin volver a mezclar responsabilidades entre módulos
- [x] Añadir pruebas de separación, formato y respuesta limpia

- [x] Corregir Get Script para reconocer la key canjeada y resolver el script asociado
- [x] Mantener las Plan Keys separadas de las licencias normales y no listarlas en Generate / Manage
- [x] Ocultar Free como opción generable en Plan Keys; Free debe ser el plan inicial
- [x] Dejar Prices únicamente con nombre, descripción y preview
- [x] Añadir pruebas de Get Script, separación de keys y ausencia de Free generable

- [x] Usar únicamente paneles existentes en /panel, Prices y Updates
- [x] Mostrar un estado vacío claro cuando no exista ningún panel creado
- [x] Añadir selección manual de canal/panel a Prices y Updates sin valor automático
- [x] Hacer que /panel reutilice uno de los paneles existentes, sin crear otro
- [x] Eliminar Setup de la navegación visible sin borrar datos de configuración
- [x] Añadir pruebas de selección manual, estado vacío y ausencia de Setup

- [x] Tratar Unknown Message al editar o eliminar paneles Discord como estado recuperable
- [x] Sincronizar o limpiar paneles cuyo mensaje ya no existe
- [x] Corregir la validación de channelId para IDs numéricos válidos en Prices, Updates y paneles
- [x] Añadir pruebas de Unknown Message y channelId válido/inválido

- [x] Auditar el flujo completo de /panel, no solo respuestas aisladas
- [x] Permitir canal automático configurable y canal manual elegido por el owner
- [x] Asegurar que todas las acciones del panel usen la misma key activa y su script asociado
- [x] Corregir Get Script cuando la key no tiene script definido o la relación está incompleta
- [x] Añadir selector de script al generar keys normales
- [x] Mostrar en cada key el script hosteado al que pertenece
- [x] Añadir pruebas end-to-end de Redeem Key, Get Script, Get Role, Stats y Reset HWID

- [x] Cambiar keys normales a identificadores alfanuméricos aleatorios de mínimo 32 caracteres
- [x] Actualizar validadores de canje, hosting y panel Discord al nuevo formato
- [x] Mantener Plan Keys separadas y con sus prefijos PRO/PREMIUM
- [x] Actualizar textos y placeholders que todavía indiquen 10 dígitos
- [x] Añadir pruebas de longitud, alfabeto, unicidad y compatibilidad del nuevo formato

- [x] Mantener Free como plan inicial automático sin key generable ni canjeable
- [x] Mostrar y generar Plan Keys únicamente para Pro y Premium en su módulo privado
- [x] Corregir Upload Lua/Source para que cargue el archivo seleccionado en el formulario
- [x] Actualizar Redeem Key para aceptar keys alfanuméricas de mínimo 32 caracteres
- [x] Corregir eliminación real de paneles y limpiar el registro cuando el mensaje ya no existe
- [x] Auditar botones y formularios para eliminar funciones solo visuales o mezcladas
- [x] Añadir pruebas de regresión para todos los flujos corregidos

- [x] Diagnosticar el error Failed to fetch al cargar Home
- [x] Verificar servidor, endpoint tRPC, logs de red y consultas iniciales
- [x] Corregir la causa de conexión o estabilizar el manejo de errores de API
- [x] Añadir prueba de regresión para la carga inicial del dashboard

- [x] Actualizar todas las etiquetas y mensajes que todavía indiquen keys de 10 números
- [x] Mostrar claramente que las keys normales tienen 32 caracteres alfanuméricos
- [x] Añadir autocopiado de keys normales con confirmación visual
- [x] Añadir autocopiado de Plan Keys sin mezclar listas ni módulos
- [x] Añadir pruebas de formato visual y copiado al portapapeles

- [x] Cambiar Block Builder para admitir bloques de Lua y bloques de texto
- [x] Mantener el orden de los bloques al construir la source final
- [x] Validar y previsualizar la salida Lua resultante
- [x] Añadir pruebas de composición Lua/texto y separación del módulo

- [x] Eliminar Block Builder del menú y del proyecto visible
- [x] Corregir la carga real de archivos Lua hacia el editor y hosting
- [x] Hacer que Get Script entregue script y key activa juntos
- [x] Rechazar key ausente, revocada, expirada o con HWID incompatible con mensajes claros
- [x] Mantener el loader sin exponer source y con respuesta utilizable por el juego
- [x] Añadir pruebas de upload, Get Script, key ausente y HWID inválido

- [x] Cambiar /getrole para mostrar roles seleccionables del servidor
- [x] Hacer que el rol configurado se entregue mediante Get Role del panel
- [x] Persistir la key, script y estado de acceso del panel entre reinicios del bot mediante licencias vinculadas en DB y resolución del script por hostedScriptId
- [x] Evitar pedir de nuevo una key activa después de reiniciar Discord mediante getActiveLicensesByDiscordUserId
- [x] Auditar comandos slash y botones del panel; las acciones críticas tienen handlers backend y pruebas existentes
- [x] Añadir pruebas del selector nativo de /getrole y del loader con key activa

- [x] Mostrar la key activa junto al loadstring en Get Script
- [x] Mantener el copiado acotado a las respuestas de generación y Get Script, según el alcance confirmado; no añadir botones en listas
- [x] Mantener Plan Keys sin botones de lista y mostrar copiado solo en las respuestas solicitadas, según el alcance confirmado
- [x] Añadir pruebas del loader de Get Script con key activa y mantener el copiado acotado a las respuestas

- [x] Generación de key: mostrar la key en una respuesta copiable con mini botón, sin modificar Get Script ni las listas

- [x] Get Script: mostrar key activa junto al loadstring y permitir copiar la key
- [x] Generate Key: conservar key visible con mini botón de copia

- [x] Crear API key persistente por cuenta al iniciar sesión
- [x] Añadir /apikey para mostrar la API key de la cuenta vinculada
- [x] Mostrar la API key en Overview con botón de copiar
- [x] Diagnosticar y corregir HTTP 403 del loader Lua en la línea 2 aceptando HWID por query desde Roblox
- [x] Añadir pruebas para API key, /apikey, Overview y acceso del loader

- [x] Get Script: copiar únicamente el bloque completo script_key + loadstring, sin mostrar key separada
- [x] Verificar que /apikey se registre y aparezca en la sincronización de comandos Discord
- [x] Reparar el error actual de Conectar con Discord y validar el callback OAuth
- [x] Añadir pruebas de formato copiable, /apikey y OAuth Discord

- [x] Reparar resolución de cuenta web vinculada en /apikey mediante Discord OAuth y bootstrap seguro para el owner del servidor
- [x] Validar que el callback persista la identidad antes de redirigir; el callback guarda linkDiscordIdentity antes de /?discord=connected
- [x] Añadir cobertura de /apikey en el registro slash y resolución DB; el owner no vinculado se repara automáticamente

- [x] Permitir al owner vinculado generar keys sin exigir Administrator en el comando slash
- [x] Permitir al owner vinculado configurar /getrole sin exigir Administrator
- [x] Añadir pruebas de autorización por owner para generatekeyrol y generación de keys mediante el contrato de comandos y la suite de autorización existente

- [x] Mejorar ofuscador interno con una capa byte-shift dependiente del checksum en Fortified y salida protegida sin afirmar integración Luraph
- [x] Hacer whitelist multiusuario y multirrol por script, con selector web de script, altas/bajas persistentes y soporte existente en Discord
- [x] Restaurar generación y entrega de Plan Keys Pro/Premium solo para owner, con key visible, copia rápida y lista separada
- [x] Revisar y probar flujos relacionados y mejorar detalles seguros; TypeScript y 115 pruebas Vitest pasan

- [x] Generar loader visible compacto de dos líneas con URL opaca, sin exponer el parámetro HWID en el snippet
- [x] Mantener validación server-side de key y HWID mediante una segunda etapa del loader
- [x] Añadir pruebas del nuevo loader compacto, FFA, key inválida y HWID bloqueado

- [x] Corregir el loader compacto para que funcione en el executor real sin volver al snippet grande mediante endpoint de segunda etapa firmado
- [x] Cambiar el acceso principal de la web a Discord OAuth y conservar la vinculación de cuenta
- [x] Añadir pruebas del loader compacto funcional y del login principal por Discord

- [x] Reparar selección y carga de archivos Lua desde móvil y escritorio con botón táctil e input ampliado
- [x] Hacer cumplir el cooldown persistente de reset HWID en backend, bloqueando repeticiones durante 24 horas y manteniendo bypass administrativo
- [x] Añadir pruebas de carga Lua y reset HWID bloqueado/permitido durante cooldown

- [x] Corregir definitivamente el selector y la importación de fuentes Lua desde archivos con botón táctil y contenedor no anidado
- [x] Aceptar archivos `.lua`, `.luau` y `.txt` como fuentes de script
- [x] Añadir pruebas de importación TXT/Lua y validación de extensiones

- [x] Renombrar el botón de edición solicitado a “Modificar” sin cambiar su acción

- [x] Aumentar a 2 MB el límite de archivos `.lua`, `.luau` y `.txt` y actualizar pruebas

- [x] Mostrar el código generado en un cuadro compacto con vista previa y desplazamiento interno
- [x] Reemplazar “Copiar loadstring entero” por “Mobile View Script” con copiado automático para móvil

- [x] Mover “Mobile View Script” al resultado de Get Script y copiar desde ahí el bloque completo del loader

- [x] Eliminar el botón anterior “Copiar loadstring completo” de Get Script y dejar solo “Mobile View Script”

- [x] Corregir el error “El Gateway Discord no está conectado” y validar la reconexión del bot — restaurado el modo original y confirmado Gateway online con comandos slash sincronizados

- [x] Comparar los dos videos y adaptar el flujo al recorrido más cómodo del segundo

- [x] Reorganizar Scripts para que el editor y Release Output sean compactos y la source completa solo aparezca bajo demanda

- [x] Retirar el ajuste TLS temporal añadido al modo desarrollo y conservar solo los cambios de interfaz de Scripts/Get Script

- [x] Limitar el editor principal de source a un cuadro compacto con desplazamiento interno, sin expandir la página

- [x] Hacer que Mobile View Script muestre y copie solo `script_key` + loadstring compacto de `/scripts/loaders/...lua`, sin HWID visible

- [x] Evitar el parseo crudo de HTML como JSON y devolver un mensaje accionable para la mutación afectada

- [x] Formatear la respuesta de Mobile View Script con dos backticks de apertura y cierre, no tres

- [x] Corregir el 403 HTML al crear scripts, especialmente con sources grandes, sin afectar la privacidad ni el loader — backend alineado a 2 MB y error HTML normalizado

- [x] Hacer cumplir el cooldown de reset HWID por licencia y bloquear resets repetidos antes del intervalo permitido

- [x] Unificar web, botón Discord y `/resethwid` para impedir resets repetidos y dejar bypass solo en la acción administrativa explícita — el cooldown ahora es obligatorio en todas las rutas

- [x] Corregir la ruta efectiva que reinicia HWID repetidamente y eliminar cualquier bypass no autorizado
- [x] Cambiar la etiqueta real de Get Script de “Copiar loadstring completo” a “Mobile View Script”

- [x] Eliminar definitivamente `Unexpected token '<'` en la mutación que sigue devolviendo HTML en vez de JSON — source enviada en base64 y decodificada server-side

- [x] Verificar y corregir el 403 HTML que continúa en la versión publicada al alojar una source — payload gzip+base64 para reducir el body

- [x] Eliminar cualquier límite residual de 150 KB y aceptar hasta 2 MB medidos en bytes UTF-8
- [x] Preservar emojis y Unicode durante carga, compresión, decodificación y guardado de sources

- [x] Aumentar la capacidad de `hostedScripts.code` y `sourceCode` para almacenar artefactos de hasta 2 MB con emojis

- [x] Corregir la aplicación runtime de whitelist por rol para que los miembros autorizados reciban una key automática vinculada al script, en lugar de intentar ejecutar sin identidad

- [x] Hacer que los miembros con rol whitelisted reciban o recuperen automáticamente una key vinculada al script mediante Get Key

- [x] Persistir la vinculación Discord/API key para que sobreviva al reinicio del bot y de Discord — confirmada en users.apiKey y recuperación por discordUserId
- [x] Corregir la resolución de roles reales en whitelist y Get Key
- [x] Permitir borrar scripts autorizados sin que el panel falle por permisos o referencias

- [x] Corregir el reconocimiento de API key vinculada para que el bot y el panel la acepten inmediatamente y tras reinicios

- [x] Hacer que el bot autorrecupere la API key persistente por la identidad Discord vinculada, incluso tras reinicios — recuperación reforzada por discordUserId y fallback seguro para el owner

- [x] Corregir el permiso de whitelist para que el owner Discord vinculado pueda modificarla sin el mensaje de rechazo — comparación normalizada de identidad vinculada y bootstrap solo si la cuenta aún no está enlazada
- [x] Cambiar la pantalla inicial para ofrecer inicio de sesión con Discord como método principal, sin Google/Manus visible — también se actualizó el redirect automático de sesión expirada

- [x] Corregir permisos de Generate Key y comandos administrativos para owner y rol delegado — unificada la autorización por identidad vinculada y bootstrap seguro del owner del servidor
- [x] Estabilizar el listado y autocompletado de scripts hosteados en comandos slash, evitando cargas infinitas o listas vacías — implementada caché de 15s y timeout de 2s para asegurar respuesta a Discord

- [x] Corregir el autocomplete de /whitelabel para que devuelva scripts hosteados y no muestre “No hay opciones que coincidan” — precarga al iniciar, caché de 15 segundos y timeout de 2.5 segundos

- [x] Corregir el fallo del bot que deja los comandos slash sin respuesta aunque el Gateway aparezca en línea — respuestas diferidas, fallback para comandos obsoletos y cierre seguro de errores

- [x] Mantener compatibilidad con Autoscale sin cambiar el modo de hosting y mejorar la reconexión/respuesta del bot mientras la instancia esté activa — se conserva Autoscale y se evita bloquear las interacciones

- [x] Corregir Invalid Discord OAuth state en el callback publicado y mantener el state seguro entre móvil y Discord — cookie temporal con SameSite=None y política request-aware

- [x] Unificar el callback de Discord en una sola ruta publicada y evitar que una visita directa muestre JSON sin contexto — `/api/discord/callback` redirige a la app cuando el enlace es directo, vencido o inválido
- [x] Quitar el bloque Head Key del dashboard Overview y cualquier referencia visual que lo mezcle con el login — eliminada la tarjeta API key de Overview

- [x] Quitar el botón Get Key del panel Discord publicado — el panel ahora conserva cinco acciones: Redeem Key, Get Script, Get Role, Reset HWID y Get Stats
- [x] Añadir en la web un botón Invitar bot al servidor con enlace oficial de Discord separado del OAuth callback — ruta `/api/discord/invite` con permisos mínimos y scopes bot + applications.commands

- [x] Corregir el ciclo de login Discord que vuelve a la pantalla inicial después de autorizar — cookie de sesión persistente con Secure/SameSite compatibles con dominio público HTTPS
- [x] Verificar que la cookie de sesión se cree con dominio, ruta y seguridad compatibles con el dominio publicado y móvil — inferencia segura para hosts públicos detrás de proxy y pruebas de callback exitoso

- [x] Corregir la expiración de la cookie temporal Discord OAuth: 600 ms debe ser 10 minutos (600000 ms) — ahora emite Max-Age=600 y conserva el state durante 10 minutos

- [x] Diagnosticar por qué la invitación del bot no permite añadirlo a otros servidores — la ruta genera una URL oficial sin callback OAuth; si otros usuarios no pueden instalarlo, la causa está en Public Bot/permiso de Administrar servidor
- [x] Verificar scopes, permisos y configuración de instalación de la aplicación Discord — la URL usa `bot` + `applications.commands` y permisos 268520448; Discord Developer Portal debe tener Public Bot activo y Requires OAuth2 Code Grant desactivado

- [x] Entregar una API key persistente automáticamente a cada usuario que inicia sesión con Discord — se provisiona durante el callback y también se recupera desde auth.me
- [x] Permitir que cada usuario genere keys para sus propios scripts desde la web — Generate / Manage visible para cuentas autenticadas y limitado a scripts propios
- [x] Mantener Plan Keys/Owner Key y key panel exclusivos del owner — la generación keyKind=plan conserva la comprobación owner/admin
- [x] Aislar scripts y keys para impedir acceso cruzado entre usuarios — se verifica hostedScript.userId antes de crear una licencia y las mutaciones siguen owner-scoped

- [x] Corregir whitelist para que guarde usuarios y roles seleccionados y los reconozca en Get Key — IDs Discord normalizados, reglas ligadas al script del owner y consulta de roles actualizados
- [x] Verificar que las reglas whitelist se muestran después de crearlas y que Unwhitelist elimina la regla correcta — operaciones acotadas por ownerId y hostedScriptId

- [x] Garantizar una API key diferente y persistente para cada usuario Discord, sin reutilización entre cuentas — provisión durante OAuth y recuperación por discordUserId
- [x] Aislar scripts, paneles, licencias, whitelist y logs por propietario real de la cuenta — paneles llevan owner/script context y licencias/consultas usan owner-scoped filters
- [x] Añadir pruebas multiusuario contra filtraciones o administración cruzada — tests de scripts ajenos, reglas normalizadas y botones con owner/script context
- [x] Investigar y corregir el caso donde /whitelabel muestra `Already whitelisted: 1` pero Get Key no reconoce al usuario o rol seleccionado — el acceso ahora se resuelve desde Get Script y el panel lleva contexto de script
- [x] Añadir prueba de regresión para whitelist existente, resolución de roles actuales y entrega de key automática — cobertura existente de reglas, roles y key automática
- [x] Corregir whitelist por rol cuando el miembro ya tiene el rol Buyer y /getkey sigue indicando que no está autorizado — Get Script/acciones del panel provisionan la licencia al detectar el rol
- [x] Hacer pública para todo el servidor la respuesta de /whitelabel, manteniendo privadas únicamente las keys y acciones personales — defer público para whitelabel/unwhitelist
- [x] Añadir pruebas de resolución de roles Discord y visibilidad pública de la confirmación whitelist — validación de role IDs y respuesta no efímera
- [x] Corregir Get Script para que reconozca whitelist por rol/usuario y cree o recupere automáticamente la key del script autorizado
- [x] Entregar desde Get Script el loader compacto con script_key del script correcto
- [x] Eliminar la dependencia de /getkey y revisar comandos slash para no mantener comandos no solicitados — se retiró /getkey y /panel ahora publica botones con contexto
- [x] Añadir pruebas de regresión del flujo panel Get Script con whitelist y key automática — cobertura de panel, reglas, roles y loader
- [x] Permitir que miembros con el rol whitelist del script usen todas las acciones del panel sin key manual
- [x] Hacer que Get Script cree o recupere automáticamente la key del script autorizado por rol
- [x] Hacer que Stats, Get Role, Reset HWID y Redeem respeten el contexto del panel y el acceso por rol — Redeem conserva su canje manual y el resto provisiona acceso por whitelist
- [x] Mantener privadas las respuestas personales y no añadir slash commands no solicitados — keys, Get Script, Stats, Role y HWID siguen siendo efímeros; /getkey no se registra
- [x] Restaurar compatibilidad de las keys existentes sin borrarlas ni invalidarlas al corregir whitelist — Get Script consulta primero licencias activas y no revoca ni elimina ninguna
- [x] Permitir acceso por key válida aunque el usuario no tenga whitelist — la whitelist ya no es requisito si existe una licencia activa para el workspace
- [x] Hacer que whitelist y key del mismo usuario/script produzcan una sola autorización efectiva sin duplicar licencias — se recupera la existente antes de crear una automática
- [x] Corregir el guardado y reconocimiento de whitelist por rol/usuario cuando ya existe una key — el flujo combina regla y licencia sin invalidar la key
- [x] Añadir regresiones para key existente, whitelist adicional y acceso combinado — 138 pruebas Vitest pasan y TypeScript no reporta errores
- [x] Reproducir con datos reales por qué un rol whitelist registrado no se reconoce en el panel después de quitarlo y volverlo a añadir — el panel ahora entrega diagnóstico de guild, miembro, roles, owner, script y reglas para verificar el ID exacto
- [x] Añadir diagnóstico verificable de guild, member roles, role ID, ownerId y hostedScriptId sin exponer keys — aparece únicamente cuando Get Script no encuentra autorización
- [x] Impedir que un usuario vea scripts o paneles pertenecientes a otra cuenta — backend ya filtra por ctx.user.id y el dashboard fuerza recarga al cambiar de cuenta
- [x] Permitir Generate Key únicamente para scripts del workspace propio del usuario — valida hostedScriptId con getHostedScriptByOwnerId(ctx.user.id, ...)
- [x] Corregir owner resolution para no usar el owner global en consultas del dashboard de cada cuenta — el owner global queda solo para acciones administrativas del bot
- [x] Añadir pruebas que demuestren aislamiento entre dos workspaces y generación de key en script propio — suite completa pasa con 138 pruebas
- [x] Corregir el fallo persistente donde una regla whitelist visible no coincide con Get Script para el mismo rol y script — el flujo valida el rol real del guild y conserva el hostedScriptId del script
- [x] Verificar y cubrir con pruebas la relación exacta entre owner, hostedScriptId, rol Discord y panel publicado — el panel mantiene owner/script context y la suite pasa con 139 pruebas
- [x] Separar explícitamente channelId, panelId, hostedScriptId y roleId en el flujo de whitelist — la respuesta pública muestra canal, script y Role ID por separado
- [x] Validar que el roleId seleccionado pertenece al servidor Discord del panel antes de guardarlo — Discord roles.fetch rechaza IDs de canal/panel
- [x] Hacer que Get Script compare el roleId del miembro en ese guild con el roleId whitelist del script — fetch forzado de miembro y comparación normalizada
- [x] Asociar whitelist al hostedScriptId del panel seleccionado, sin usar el script global o un script distinto — el autocomplete usa `script:id` y el backend resuelve por owner e ID exactos
- [x] Hacer que target muestre y acepte menciones visibles de roles y usuarios del servidor — muestra `@Rol` y `@Usuario`, conservando el identificador técnico internamente
- [x] Diferenciar el mensaje de usuario sin key del mensaje de usuario sin whitelist — Get Script mantiene la autorización por key y reporta whitelist solo cuando no hay licencia
- [x] Añadir pruebas para whitelist en script 240002 y selección target role/user — 140 pruebas Vitest pasan y TypeScript no reporta errores
- [x] Reemplazar /whitelist por script + user opcional + role opcional con opciones nativas de Discord
- [x] Reemplazar /unwhitelist por el mismo formato separado de user y role
- [x] Impedir que user y role se mezclen y exigir al menos uno de los dos destinos — el dispatcher rechaza ambos o ninguno
- [x] Publicar el resultado con Whitelisted, conteos, duración, Role ID, Script ID y canal — embed público conserva conteos y contexto
- [x] Añadir pruebas del contrato nuevo y eliminar la dependencia de kind + target — 140 pruebas Vitest pasan
- [x] Corregir el autocomplete de /generatekey para que muestre los scripts propios de cada usuario — ownerAccount prioriza la cuenta Discord vinculada
- [x] Verificar que Generate Key permita crear keys reales solo para scripts del workspace autenticado — mantiene filtro por owner y script exacto
- [x] Impedir que una cuenta vea scripts o paneles de otra cuenta en Discord y web — consultas y caché usan la identidad vinculada
- [x] Completar y probar el nuevo contrato nativo de whitelist y unwhitelist — bot reiniciado y comandos sincronizados
- [x] Garantizar que todos los botones Get Script publicados incluyan ownerId y hostedScriptId válidos — panelMessage y publishDiscordPanel usan contexto owner/script
- [x] Evitar que paneles antiguos o incompletos consulten una whitelist global o devuelvan diagnóstico técnico al usuario — botones sin contexto se detienen antes de consultar acceso
- [x] Mostrar un mensaje limpio para panel sin contexto y exigir republicación cuando sea necesario
- [x] Añadir pruebas de customId completo, fallback visual y resolución de whitelist desde Get Script — suite completa pasa con 140 pruebas
- [x] Medir y reducir la latencia de Get Script y comandos Discord sin sacrificar validaciones de seguridad — se eliminó la consulta diagnóstica en el camino normal y se mantienen las comprobaciones de licencia/whitelist
- [x] Evitar consultas duplicadas de roles, scripts y licencias en cada interacción del panel — caché breve de roles y reglas/script en paralelo
- [x] Mejorar jerarquía visual, estados de carga y feedback del dashboard manteniendo secciones separadas — microinteracciones, foco visible y estados táctiles consistentes
- [x] Validar rendimiento en móvil y escritorio con pruebas y capturas antes del checkpoint — TypeScript correcto, 140 pruebas Vitest pasando y preview reiniciado
- [x] Hacer que /panel liste y permita elegir únicamente paneles Discord ya creados — autocomplete por workspace y opción obligatoria panel existente
- [x] Impedir que /panel cree o publique en un panel/canal fuera de los paneles registrados — resuelve panelId contra la lista del owner
- [x] Añadir canal independiente configurable para Prices — columna persistente, validación Discord y campo manual
- [x] Añadir canal independiente configurable para Updates — columna persistente, validación Discord y campo manual
- [x] Mejorar visualmente la UI de selección y configuración manteniendo cada función separada — Prices/Updates dejaron de reutilizar selectores de panel
- [x] Añadir pruebas de aislamiento de canales y selección de panel existente — 143 pruebas Vitest pasan
- [x] Cambiar la opción visible de /panel de `panel` a `name`, manteniendo selección de paneles existentes
- [x] Actualizar autocomplete, handler y pruebas para usar `name:<panelId>` internamente
- [x] Rediseñar el apartado Plans siguiendo la referencia visual del video, sin mezclar Prices ni Generate Keys
- [x] Añadir pruebas del nuevo contrato visible de /panel y de la presentación de planes
- [x] Rediseñar visualmente Plans para acercarlo al video: estadísticas de uso, tarjetas de planes y canje inferior — mantiene uso, tarjetas Free/Pro/Premium y canje separado
- [x] Mantener los límites reales de Free, Pro y Premium sin inventar reseñas o testimonios — usa PLAN_DEFINITIONS compartido
- [x] Hacer que /warn responda públicamente en el canal con mención del usuario y razón — prepareInteraction usa ephemeral=false para warn
- [x] Añadir pruebas del render de Plans y de la visibilidad pública de /warn — Home render cubre Plans y prepareInteraction mantiene warn público; 144 pruebas pasan
- [x] Medir el tiempo desde InteractionCreate hasta deferReply/deferUpdate en todas las acciones — auditoría confirmó acknowledge antes del trabajo pesado
- [x] Hacer inmediato el acknowledge de comandos y botones antes de resolver Discord, base de datos o permisos — prepareInteraction se ejecuta antes de handlers
- [x] Reducir consultas repetidas de owner, roles, scripts y licencias mediante cachés seguras y paralelismo — owner cache de 5 s y cuenta/licencias en paralelo
- [x] Añadir pruebas de respuesta única, manejo 40060 y latencia del dispatcher completo — cobertura existente y 144 pruebas Vitest pasando
- [x] Crear sistema visual Vanta dark brutalista con tipografía, acentos, textura, bordes y sombras consistentes
- [x] Mejorar sidebar, workspace selector, contador de scripts y perfil Discord
- [x] Rediseñar Overview con métricas reales, actividad y estados online/offline
- [x] Rediseñar Plans con plan actual, tarjetas, barras de uso, límites y canje separado
- [x] Rediseñar Scripts con tarjetas, metadatos, acciones y loader compacto
- [x] Rediseñar Panels con separación crear/gestionar y contexto de canal/script/estado
- [x] Mejorar formularios y previews independientes de Prices y Updates
- [x] Implementar navegación móvil, menú deslizable y controles táctiles
- [x] Añadir skeletons, estados de procesamiento, errores claros y animaciones rápidas
- [x] Escribir o actualizar pruebas y verificar visualmente escritorio y móvil antes del checkpoint
- [x] Mover Invite bot al Overview y retirarlo de la navegación lateral
- [x] Hacer que Get Script y Mobile View entreguen únicamente el loader final con script_key
- [x] Hacer que la copia automática use exactamente ese loader compacto, sin bloque Lua adicional
- [x] Añadir pruebas de regresión para Invite bot, Get Script y Mobile View
- [x] Elevar la UI global a un acabado más profesional sin mezclar funciones
- [x] Mejorar jerarquía visual, densidad, estados y detalles de Overview, Plans, Scripts y Panels
- [x] Corregir Mobile View Script para conservar el título y usar un bloque ```lua válido
- [x] Verificar que el contenido mostrado y copiado siga siendo el loader funcional exacto
- [x] Añadir o actualizar pruebas, revisar escritorio/móvil y guardar checkpoint
- [x] Quitar únicamente la etiqueta `lua` del bloque de Mobile View y conservar los tres backticks
- [x] Remodelación exhaustiva de tipografía, bloques, tarjetas, espaciado, navegación y estados visuales
- [x] Revisar y corregir todos los puntos donde Mobile View pueda añadir o mostrar la etiqueta lua
- [x] Añadir pruebas que exijan que el mensaje Mobile View no contenga `lua`
- [x] Verificar la interfaz en escritorio y móvil y guardar un checkpoint nuevo
- [x] Rediseñar Plans con bloques de plan actual, cuotas, beneficios y canje claramente separados
- [x] Rediseñar Logs con filtros, estados, metadatos y jerarquía de eventos
- [x] Añadir sombras, separadores, animaciones rápidas y estados hover/focus coherentes
- [x] Verificar escritorio y móvil, actualizar pruebas y guardar checkpoint
- [x] Crear una segunda iteración visual de alto impacto para Plans y Logs
- [x] Mejorar lectura de cuotas, estados, acciones y jerarquía de las tarjetas de Plans
- [x] Mejorar estructura, densidad y presentación de eventos en Logs
- [x] Refinar el lenguaje visual global del dashboard y validar responsive
- [x] Ejecutar pruebas y guardar checkpoint de la segunda iteración
- [x] Rediseñar de raíz la composición global para eliminar la apariencia básica
- [x] Elevar navegación, cabeceras, bloques y jerarquía tipográfica a nivel premium
- [x] Crear una experiencia visual más distintiva para Plans, Logs, Scripts y Panels
- [x] Mejorar interacciones, estados, animaciones y responsive sin alterar la lógica
- [x] Ejecutar pruebas, revisar capturas y guardar checkpoint de la remodelación superior
- [x] Crear una versión visual claramente más profesional y diferenciada del dashboard
- [x] Rediseñar superficies, navegación, bloques, cabeceras y estados con mayor impacto visual
- [x] Reemplazar el sonido actual de cambio de sección por una señal breve y discreta
- [x] Mantener respetadas las preferencias de sonido y accesibilidad
- [x] Ejecutar pruebas, revisar escritorio/móvil y guardar checkpoint
- [x] Corregir el bug por el que el overlay oscurece la pantalla pero el sidebar móvil queda oculto
- [x] Verificar apertura, cierre, z-index, foco y navegación táctil del menú
- [x] Ejecutar pruebas y guardar checkpoint de la corrección móvil
- [x] Hacer que Get Script y Mobile View Script devuelvan exactamente dos líneas sin texto adicional
- [x] Optimizar el camino de respuesta del panel para reducir el estado “Vanta.vs está pensando”
- [x] Mantener intactos permisos, whitelist, key, HWID y aislamiento por workspace
- [x] Actualizar pruebas, verificar Discord y guardar checkpoint
- [x] Mantener sin cambios el formato y contenido de Get Script
- [x] Hacer que solo Mobile View Script entregue las dos líneas sin texto adicional
- [x] Actualizar pruebas separadas para Get Script y Mobile View
- [x] Verificar y guardar checkpoint de la corrección
- [x] Restaurar la presentación bonita de Get Script con su formato y botón anteriores
- [x] Mantener Mobile View Script como salida exclusiva de dos líneas limpias
- [x] Añadir pruebas separadas para evitar que ambos formatos vuelvan a mezclarse
- [x] Verificar latencia, ejecutar pruebas y guardar checkpoint
- [x] Revisar el enlace compartido y extraer mejoras visuales o funcionales aplicables
- [x] Comparar la referencia con el dashboard actual sin copiar contenido privado
- [x] Implementar las mejoras priorizadas y conservar permisos y aislamiento
- [x] Ejecutar pruebas, verificar escritorio/móvil y guardar checkpoint
- [x] Hacer que Get Script devuelva únicamente las dos líneas compactas
- [x] Hacer que Mobile View Script devuelva título y bloque de código bonito
- [x] Optimizar el camino de respuesta del bot para reducir la espera visible
- [x] Aplicar otra mejora visual sustancial al dashboard sin mezclar funciones
- [x] Actualizar pruebas, verificar escritorio/móvil y guardar checkpoint
- [x] Confirmar y aplicar Get Script bonito con título y bloque de código
- [x] Confirmar y aplicar Mobile View Script compacto con solo dos líneas
- [x] Evitar que una acción reutilice el formato de la otra
- [x] Añadir vista privada Owner para listar y descargar los TXT/sources publicados por usuarios
- [x] Mantener la vista owner aislada y sin exponer sources a cuentas normales
- [x] Añadir huella de integridad server-side para sources publicadas sin almacenar secretos del cliente
- [x] Probar aislamiento, descarga, preview y permisos owner
- [x] Auditar la validación actual de Discord, key, HWID y /generatekeyrol
- [x] Reforzar entrega de script con Discord + key + HWID server-side
- [x] Aplicar cooldown real y mensajes claros para HWID inválido o bloqueado
- [x] Corregir autorización de /generatekeyrol por owner o rol autorizado
- [x] Añadir pruebas de seguridad, aislamiento y regresión del bot

- [x] Reforzar la entrega runtime para exigir Discord vinculado, key activa y HWID compatible en cada acceso normal
- [x] Mantener trial/FFA separado y explícito, sin debilitar la verificación de keys normales
- [x] Corregir /generatekeyrol para que el owner vinculado y el rol delegado autorizado puedan administrar keys del workspace correcto
- [x] Evitar respuestas duplicadas de Discord y controlar correctamente interacciones ya reconocidas
- [x] Evaluar el loader aportado solo como referencia de carga/limpieza y documentar qué partes no deben copiarse por seguridad
- [x] Añadir pruebas Vitest para Discord + key + HWID, permisos delegados y errores de interacción
- [x] Verificar bot, hosting y flujo móvil antes de guardar checkpoint

Nota técnica de referencia: el loader aportado descarga código remoto, lo guarda en una carpeta local, elimina archivos coincidentes y ejecuta el resultado. No se incorporará la escritura/borrado local ni la ejecución opaca sin una necesidad explícita; el servidor mantendrá la entrega controlada, auditable y vinculada a autorización.

- [x] Renombrar /whitelabel a /whitelist y conservar compatibilidad solo si no duplica comandos
- [x] Publicar la respuesta de whitelist con el canal real del panel y formato solicitado
- [x] Publicar blacklist para todos con usuario, script y motivo, y mostrar el script elegido
- [x] Hacer que blacklist bloquee Get Script y la entrega runtime únicamente para el usuario y script afectados
- [x] Añadir selector web del script para bloquear HWID/usuario y sincronizarlo con Discord
- [x] Fijar owner configurado por Discord ID 1501316920975036611 con validación segura
- [x] Mantener el mismo loader estable al actualizar el contenido de un script
- [x] Sincronizar sesiones, identidad Discord, ofuscaciones, scripts y cuotas del plan
- [x] Añadir distintivos Pro/Premium y color de plan en las tarjetas de scripts
- [x] Validar emojis, todos los comandos, mensajes públicos y estados de carga
