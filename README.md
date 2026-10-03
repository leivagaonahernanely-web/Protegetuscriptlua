# Vanta.vs Protector

Plataforma fullstack para alojar scripts Lua protegidos, generar loaders públicos y administrar licencias, whitelist, blacklist, HWID y paneles Discord desde un dashboard privado.

## Discord

El bot usa sus credenciales únicamente en el servidor. Antes de guardar un canal o publicar un panel, la aplicación consulta el acceso del bot mediante la API de Discord. Consulta el procedimiento completo para resolver `Unknown Channel`, diferenciar respuestas **404** y **403**, y comprobar el ID y los permisos en [docs/discord-channel-troubleshooting.md](docs/discord-channel-troubleshooting.md).

## Validación local

```bash
pnpm check
pnpm test
pnpm build
```

La web pública entrega únicamente el artefacto runtime o loader configurado. La source original se conserva separada y solo se consulta desde la vista privada autorizada del propietario.
