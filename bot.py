import os
import discord
from discord.ext import commands
import asyncio
import datetime
import logging
from dotenv import load_dotenv

load_dotenv()
logging.basicConfig(level=logging.INFO)

TOKEN = os.getenv("DISCORD_BOT_TOKEN", "")
ADMIN_ID = int(os.getenv("ADMIN_DISCORD_ID", "1501316920975036611"))

intents = discord.Intents.default()
intents.message_content = True
intents.members = True

bot = commands.Bot(command_prefix="!", intents=intents, help_command=None)

@bot.event
async def on_ready():
    print(f"✅ Bot conectado como {bot.user}")
    print(f"✅ Versión: {discord.__version__}")
    await bot.change_presence(activity=discord.Game(name="Protegiendo scripts | LuaProtect"))

def es_admin(ctx):
    return ctx.author.id == ADMIN_ID

@bot.command(name="generarclave", aliases=["gclave"])
@commands.check(es_admin)
async def generar_clave(ctx, hash_script: str, dias: int = 30, usos: int = 1):
    from app import db, License, generar_clave_licencia
    try:
        clave = generar_clave_licencia()
        expira = datetime.datetime.utcnow() + datetime.timedelta(days=dias)
        nueva = License(
            key=clave,
            script_hash=hash_script,
            max_uses=usos,
            expires_at=expira,
            created_by=ADMIN_ID
        )
        db.session.add(nueva)
        db.session.commit()
        embed = discord.Embed(
            title="🔑 Licencia Generada",
            color=0x2ecc71,
            timestamp=datetime.datetime.utcnow()
        )
        embed.add_field(name="Clave", value=f"`{clave}`", inline=False)
        embed.add_field(name="Script", value=f"`{hash_script}`", inline=True)
        embed.add_field(name="Días", value=f"{dias}", inline=True)
        embed.add_field(name="Usos", value=f"{usos}", inline=True)
        embed.set_footer(text="LuaProtect v2.1")
        await ctx.send(embed=embed)
    except Exception as e:
        await ctx.send(f"❌ Error: {str(e)}")

@bot.command(name="resetearhwid", aliases=["rhwid"])
@commands.check(es_admin)
async def resetear_hwid(ctx, clave: str):
    from app import db, License
    licencia = License.query.filter_by(key=clave).first()
    if not licencia:
        await ctx.send("❌ Licencia no encontrada")
        return
    licencia.hwid = None
    licencia.ip_register = None
    db.session.commit()
    await ctx.send(f"✅ HWID restablecido para la clave: `{clave}`")

@bot.command(name="desactivarclave", aliases=["dclave"])
@commands.check(es_admin)
async def desactivar_clave(ctx, clave: str):
    from app import db, License
    licencia = License.query.filter_by(key=clave).first()
    if not licencia:
        await ctx.send("❌ Licencia no encontrada")
        return
    licencia.active = False
    db.session.commit()
    await ctx.send(f"✅ Licencia desactivada: `{clave}`")

@bot.event
async def on_command_error(ctx, error):
    if isinstance(error, commands.CheckFailure):
        await ctx.send("❌ No tienes permisos para usar este comando")
    elif isinstance(error, commands.MissingRequiredArgument):
        await ctx.send("❌ Faltan datos: Ejemplo `!generarclave HASH_SCRIPT 30 1`")
    else:
        print(f"Error: {error}")

if __name__ == "__main__":
    if not TOKEN:
        print("❌ ERROR: No se encontró el token del bot")
    else:
        bot.run(TOKEN)
 
