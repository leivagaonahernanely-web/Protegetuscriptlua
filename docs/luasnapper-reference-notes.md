# Notas de referencia: LuaSnapper / LuaMore

Fuente: videos aportados por el usuario y página `https://luamore-srdrv3xc.manus.space/dashboard/obfuscate`.

El primer video muestra un dashboard dividido en Overview, Scripts, Panels, Keys y Settings. En Scripts aparece un formulario de creación con nombre, descripción opcional, modo FFA, área de source, carga de archivo `.lua`, botón Host script y opción de protección. El resultado muestra un loadstring y enlaces alojados. La lista de scripts permite editar, activar/desactivar, eliminar y desplegar detalles con loadstring, Hosted URL y RAW URL. También se observa un estado Disabled para un script.

Funciones funcionales relevantes para comparar con Vanta.vs Protector: hosting persistente, FFA frente a acceso protegido por key, kill switch para deshabilitar un script, generación de loadstring, edición sin cambiar la URL y acciones de gestión por script. Los nombres de pestañas, iconos, colores y enlace de Discord son decisiones visuales, no pruebas de una implementación de protección concreta.


El segundo y tercer video agregan estas observaciones: Overview muestra tarjetas de Scripts, License Keys, Panels y Total Servers; incluye actividad reciente y acciones rápidas. Panels configura nombre, Role ID, canal, script objetivo, cooldown HWID y webhook. License Keys permite etiqueta, script, duración y usuario Discord opcional. Settings incluye cuenta Discord, API access, nombre del workspace y nivel de notificaciones. Se observan cargas `.lua` o `.txt` de hasta 2 MB, checkbox de obfuscación, un human check aritmético, edición de script sin cambiar la URL del loader, disable/enable, view `.lua`, key system y copiado/eliminado de keys. También aparece sharing por códigos de invitación y contadores de uso por plan.

Las mejoras más valiosas para Vanta.vs Protector serían edición versionada conservando URL, enable/disable como kill switch, detalles desplegables por script, selector de script en keys/paneles, contadores reales y controles de webhook. Human check, planes y workspace sharing son secundarios y requieren decisiones de producto antes de implementarse.
