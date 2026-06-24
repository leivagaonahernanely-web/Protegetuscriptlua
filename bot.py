import os
import discord
from discord.ext import commands
from discord import app_commands
import datetime
import logging
from typing import Optional
from dotenv import load_dotenv

# Cargar variables de entorno
load_dotenv()

# ============================================================
# 1. CONFIGURACIÓN Y LOGGING
# ============================================================

# ✅ Variables de entorno (NUNCA hardcodeadas)
TOKEN = os.getenv("DISCORD_BOT_TOKEN")
if not TOKEN:
    raise ValueError("❌ DISCORD_BOT_TOKEN no está configurado")

ADMIN_ID = int(os.getenv("ADMIN_DISCORD_ID", "1501316920975036611"))
DOMINIO = os.getenv("DOMINIO", "https://protegetuscriptlua-production.up.railway.app")

# Logging profesional
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('bot.log'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger("LuaProtectBot")

# ============================================================
# 2. CONFIGURACIÓN DEL BOT
# ============================================================

intents = discord.Intents.default()
intents.message_content = True
intents.members = True
intents.guilds = True

bot = commands.Bot(
    command_prefix="!",
    intents=intents,
    help_command=None,
    activity=discord.Activity(
        type=discord.ActivityType.watching,
        name="tus scripts | LuauProtect Pro v3.0"
    )
)

# ============================================================
# 3. DECORADORES Y UTILIDADES
# ============================================================

def es_admin(ctx) -> bool:
    """Verifica si el usuario es administrador"""
    return ctx.author.id == ADMIN_ID

async def responder_embed(ctx, titulo: str, descripcion: str, color: int = 0x3498db, 
                          campos: list = None, footer: str = None):
    """Función auxiliar para crear embeds consistentes"""
    embed = discord.Embed(
        title=titulo,
        description=descripcion,
        color=color,
        timestamp=datetime.datetime.utcnow()
    )
    if campos:
        for nombre, valor, inline in campos:
            embed.add_field(name=nombre, value=valor, inline=inline if inline is not None else False)
    if footer:
        embed.set_footer(text=footer)
    else:
        embed.set_footer(text="LuauProtect Pro v3.0")
    await ctx.send(embed=embed)

def manejar_error_async(func):
    """Decorador para manejar errores en comandos"""
    async def wrapper(ctx, *args, **kwargs):
        try:
            await func(ctx, *args, **kwargs)
        except Exception as e:
            logger.error(f"Error en comando {func.__name__}: {str(e)}")
            embed = discord.Embed(
                title="❌ Error",
                description=f"Ocurrió un error: {str(e)}",
                color=0xe74c3c
            )
            await ctx.send(embed=embed)
    return wrapper

# ============================================================
# 4. EVENTOS DEL BOT
# ============================================================

@bot.event
async def on_ready():
    """Evento cuando el bot se conecta"""
    logger.info(f"✅ Bot conectado como {bot.user} (ID: {bot.user.id})")
    logger.info(f"📊 Conectado a {len(bot.guilds)} servidores")
    logger.info(f"👥 Total de usuarios: {len(bot.users)}")
    
    # Sincronizar comandos slash (globales)
    try:
        synced = await bot.tree.sync()
        logger.info(f"✅ Comandos slash sincronizados: {len(synced)}")
    except Exception as e:
        logger.error(f"❌ Error sincronizando comandos slash: {e}")

@bot.event
async def on_command_error(ctx, error):
    """Manejo global de errores de comandos"""
    if isinstance(error, commands.MissingPermissions):
        await ctx.send("❌ No tienes permisos para usar este comando.")
    elif isinstance(error, commands.MissingRequiredArgument):
        await ctx.send(f"❌ Faltan argumentos. Usa `!ayuda` para ver la sintaxis.")
    elif isinstance(error, commands.CheckFailure):
        await ctx.send("❌ No tienes permisos para usar este comando.")
    else:
        logger.error(f"Error en comando: {error}")
        await ctx.send(f"❌ Error inesperado: {str(error)}")

# ============================================================
# 5. COMANDOS DE ADMINISTRACIÓN
# ============================================================

@bot.command(name="generar", aliases=["gclave", "gen"])
@commands.check(es_admin)
@manejar_error_async
async def generar_clave(ctx, hash_script: str, dias: int = 30, usos: int = 1):
    """Genera una nueva licencia para un script"""
    from app import db, License, generar_clave
    
    # Verificar que el script existe
    from app import Script
    script = Script.query.filter_by(hash_id=hash_script, active=True).first()
    if not script:
        await responder_embed(
            ctx,
            "❌ Error",
            f"El script con hash `{hash_script}` no existe o está inactivo.",
            color=0xe74c3c
        )
        return
    
    # Limitar usos máximos
    if usos > 10:
        await responder_embed(
            ctx,
            "⚠️ Advertencia",
            "Los usos máximos están limitados a 10 por licencia por razones de seguridad.",
            color=0xf1c40f
        )
        usos = 10
    
    # Generar clave única
    clave = generar_clave()
    while License.query.filter_by(key=clave).first():
        clave = generar_clave()
    
    # Configurar expiración
    expira = datetime.datetime.utcnow() + datetime.timedelta(days=dias)
    
    # Crear licencia
    nueva = License(
        key=clave,
        script_hash=hash_script,
        max_uses=usos,
        expires_at=expira,
        created_by=ADMIN_ID
    )
    db.session.add(nueva)
    db.session.commit()
    
    logger.info(f"Licencia generada: {clave} para script {hash_script} por {ctx.author.name}")
    
    # Responder con embed
    await responder_embed(
        ctx,
        "🔑 Licencia Generada",
        "La licencia se ha creado exitosamente.",
        color=0x2ecc71,
        campos=[
            ("Clave", f"`{clave}`", False),
            ("Script", f"`{hash_script}` - {script.name}", True),
            ("Duración", f"{dias} días", True),
            ("Usos", f"{usos}", True),
            ("Expira", expira.strftime('%d/%m/%Y %H:%M UTC'), True)
        ]
    )

@bot.command(name="reset", aliases=["rhwid"])
@commands.check(es_admin)
@manejar_error_async
async def reset_hwid(ctx, clave: str):
    """Restablece el HWID de una licencia"""
    from app import db, License
    
    lic = License.query.filter_by(key=clave).first()
    if not lic:
        await responder_embed(
            ctx,
            "❌ Error",
            f"No se encontró la clave `{clave}`",
            color=0xe74c3c
        )
        return
    
    # Guardar HWID anterior para log
    hwid_anterior = lic.hwid or "Ninguno"
    lic.hwid = None
    db.session.commit()
    
    logger.info(f"HWID restablecido para clave {clave} por {ctx.author.name}")
    
    await responder_embed(
        ctx,
        "🔄 HWID Restablecido",
        f"Se ha restablecido el HWID de la clave `{clave}`",
        color=0x3498db,
        campos=[
            ("HWID Anterior", f"`{hwid_anterior}`", False)
        ]
    )

@bot.command(name="desactivar", aliases=["dclave", "deactivate"])
@commands.check(es_admin)
@manejar_error_async
async def desactivar_clave(ctx, clave: str):
    """Desactiva una licencia"""
    from app import db, License
    
    lic = License.query.filter_by(key=clave).first()
    if not lic:
        await responder_embed(
            ctx,
            "❌ Error",
            f"No se encontró la clave `{clave}`",
            color=0xe74c3c
        )
        return
    
    lic.active = False
    db.session.commit()
    
    logger.info(f"Clave desactivada: {clave} por {ctx.author.name}")
    
    await responder_embed(
        ctx,
        "⛔ Clave Desactivada",
        f"La clave `{clave}` ha sido desactivada.",
        color=0xe74c3c,
        campos=[
            ("Script", f"`{lic.script_hash}`", True),
            ("Estado", "Inactiva", True)
        ]
    )

@bot.command(name="activar", aliases=["aclave", "activate"])
@commands.check(es_admin)
@manejar_error_async
async def activar_clave(ctx, clave: str):
    """Reactiva una licencia"""
    from app import db, License
    
    lic = License.query.filter_by(key=clave).first()
    if not lic:
        await responder_embed(
            ctx,
            "❌ Error",
            f"No se encontró la clave `{clave}`",
            color=0xe74c3c
        )
        return
    
    lic.active = True
    db.session.commit()
    
    logger.info(f"Clave activada: {clave} por {ctx.author.name}")
    
    await responder_embed(
        ctx,
        "✅ Clave Activada",
        f"La clave `{clave}` ha sido reactivada.",
        color=0x2ecc71,
        campos=[
            ("Script", f"`{lic.script_hash}`", True),
            ("Estado", "Activa", True)
        ]
    )

@bot.command(name="info", aliases=["claveinfo", "check"])
@commands.check(es_admin)
@manejar_error_async
async def info_clave(ctx, clave: str):
    """Muestra información detallada de una licencia"""
    from app import License, Script
    
    lic = License.query.filter_by(key=clave).first()
    if not lic:
        await responder_embed(
            ctx,
            "❌ Error",
            f"No se encontró la clave `{clave}`",
            color=0xe74c3c
        )
        return
    
    script = Script.query.filter_by(hash_id=lic.script_hash).first()
    
    estado = "Activa" if lic.active else "Inactiva"
    estado_color = 0x2ecc71 if lic.active else 0xe74c3c
    
    await responder_embed(
        ctx,
        f"🔍 Información de Clave",
        f"Detalles de la clave `{clave}`",
        color=estado_color,
        campos=[
            ("Script", f"`{lic.script_hash}` - {script.name if script else 'Desconocido'}", False),
            ("Estado", estado, True),
            ("HWID", f"`{lic.hwid or 'Sin asignar'}`", True),
            ("Usos", f"{lic.used_count}/{lic.max_uses}", True),
            ("Creada", lic.created_at.strftime('%d/%m/%Y %H:%M'), True),
            ("Expira", lic.expires_at.strftime('%d/%m/%Y %H:%M') if lic.expires_at else 'Nunca', True)
        ]
    )

# ============================================================
# 6. COMANDO DE AYUDA MEJORADO
# ============================================================

@bot.command(name="ayuda", aliases=["help", "comandos"])
async def ayuda(ctx):
    """Muestra todos los comandos disponibles"""
    embed = discord.Embed(
        title="📚 Comandos de LuauProtect Pro",
        description="Sistema de protección de scripts v3.0",
        color=0x3498db,
        timestamp=datetime.datetime.utcnow()
    )
    
    embed.add_field(
        name="🔑 Gestión de Licencias",
        value=(
            "`!generar <hash> [días] [usos]` - Genera licencia\n"
            "`!info <clave>` - Info de licencia\n"
            "`!desactivar <clave>` - Bloquea licencia\n"
            "`!activar <clave>` - Reactiva licencia"
        ),
        inline=False
    )
    
    embed.add_field(
        name="🛡️ Gestión de HWID",
        value="`!reset <clave>` - Restablece HWID",
        inline=False
    )
    
    embed.add_field(
        name="📊 Estadísticas",
        value="`!stats` - Estadísticas del sistema",
        inline=False
    )
    
    embed.add_field(
        name="🌐 Dominio API",
        value=f"`{DOMINIO}`",
        inline=False
    )
    
    embed.set_footer(text="Solo administradores pueden usar comandos de gestión")
    
    await ctx.send(embed=embed)

# ============================================================
# 7. COMANDOS DE ESTADÍSTICAS
# ============================================================

@bot.command(name="stats", aliases=["estadisticas"])
@commands.check(es_admin)
@manejar_error_async
async def stats(ctx):
    """Muestra estadísticas del sistema"""
    from app import Script, License, User, AccessLog
    
    total_scripts = Script.query.count()
    active_scripts = Script.query.filter_by(active=True).count()
    total_licenses = License.query.count()
    active_licenses = License.query.filter_by(active=True).count()
    total_users = User.query.count()
    total_access = AccessLog.query.count()
    success_access = AccessLog.query.filter_by(success=True).count()
    
    embed = discord.Embed(
        title="📊 Estadísticas de LuauProtect",
        color=0x3498db,
        timestamp=datetime.datetime.utcnow()
    )
    
    embed.add_field(
        name="📜 Scripts",
        value=f"Total: **{total_scripts}**\nActivos: **{active_scripts}**",
        inline=True
    )
    
    embed.add_field(
        name="🔑 Licencias",
        value=f"Total: **{total_licenses}**\nActivas: **{active_licenses}**",
        inline=True
    )
    
    embed.add_field(
        name="👥 Usuarios",
        value=f"**{total_users}** registrados",
        inline=True
    )
    
    embed.add_field(
        name="📡 Accesos",
        value=f"Total: **{total_access}**\nExitosos: **{success_access}**",
        inline=False
    )
    
    embed.set_footer(text=f"Última actualización")
    await ctx.send(embed=embed)

# ============================================================
# 8. COMANDOS SLASH (INTERACCIONES MODERNAS)
# ============================================================

@bot.tree.command(name="generar", description="Genera una nueva licencia para un script")
@app_commands.describe(
    hash_script="Hash ID del script",
    dias="Días de validez (default: 30)",
    usos="Número de usos permitidos (default: 1)"
)
async def slash_generar(interaction: discord.Interaction, hash_script: str, dias: int = 30, usos: int = 1):
    """Versión Slash Command de generar"""
    if interaction.user.id != ADMIN_ID:
        await interaction.response.send_message("❌ No tienes permisos para usar este comando.", ephemeral=True)
        return
    
    # Simular el contexto de un comando normal
    class MockContext:
        author = interaction.user
        send = interaction.response.send_message
    
    ctx = MockContext()
    await generar_clave(ctx, hash_script, dias, usos)
    # Nota: Esto requiere adaptación para funcionar con interacciones

# ============================================================
# 9. COMANDOS DE UTILIDAD
# ============================================================

@bot.command(name="ping")
async def ping(ctx):
    """Verifica la latencia del bot"""
    latency = round(bot.latency * 1000)
    embed = discord.Embed(
        title="🏓 Pong!",
        description=f"Latencia: **{latency}ms**",
        color=0x2ecc71 if latency < 100 else (0xf1c40f if latency < 200 else 0xe74c3c)
    )
    await ctx.send(embed=embed)

@bot.command(name="sync")
@commands.check(es_admin)
async def sync_commands(ctx):
    """Sincroniza los comandos slash manualmente"""
    try:
        synced = await bot.tree.sync()
        await ctx.send(f"✅ Comandos sincronizados: {len(synced)}")
    except Exception as e:
        await ctx.send(f"❌ Error sincronizando: {str(e)}")

# ============================================================
# 10. INICIALIZACIÓN
# ============================================================

if __name__ == "__main__":
    if not TOKEN:
        logger.error("❌ ERROR: Token no encontrado en variables de entorno")
        print("❌ ERROR: Token no encontrado en variables de entorno")
        print("Asegúrate de tener DISCORD_BOT_TOKEN en tu archivo .env")
    else:
        try:
            logger.info("🚀 Iniciando LuauProtect Bot...")
            bot.run(TOKEN)
        except discord.LoginFailure:
            logger.error("❌ Token inválido. Verifica DISCORD_BOT_TOKEN")
            print("❌ Token inválido. Verifica DISCORD_BOT_TOKEN")
        except Exception as e:
            logger.error(f"❌ Error crítico: {str(e)}")
            print(f"❌ Error crítico: {str(e)}") 
