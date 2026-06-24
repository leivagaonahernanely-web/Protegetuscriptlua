import os
import discord
from discord.ext import commands
import datetime
from dotenv import load_dotenv

load_dotenv()

# ✅ SOLO LEE DESDE VARIABLES, NUNCA ESCRITO AQUÍ
TOKEN = os.getenv("DISCORD_BOT_TOKEN", "")
ADMIN_ID = int(os.getenv("ADMIN_DISCORD_ID", "1501316920975036611"))

intents = discord.Intents.default()
intents.message_content = True
intents.members = True

bot = commands.Bot(command_prefix="!", intents=intents, help_command=None)

@bot.event
async def on_ready():
    print(f"✅ Bot conectado como {bot.user}")
    await bot.change_presence(activity=discord.Activity(type=discord.ActivityType.watching, name="tus scripts | LuaProtect v2.2"))

def es_admin(ctx):
    return ctx.author.id == ADMIN_ID

@bot.command(name="generar", aliases=["gclave"])
@commands.check(es_admin)
async def generar_clave(ctx, hash_script: str, dias: int = 30, usos: int = 1):
    from app import db, License, generar_clave_licencia
    try:
        clave = generar_clave_licencia()
        expira = datetime.datetime.utcnow() + datetime.timedelta(days=dias)
        nueva = License(key=clave, script_hash=hash_script, max_uses=usos, expires_at=expira, created_by=ADMIN_ID)
        db.session.add(nueva)
        db.session.commit()
        embed = discord.Embed(title="🔑 Licencia Generada", color=0x2ecc71, timestamp=datetime.datetime.utcnow())
        embed.add_field(name="Clave", value=f"`{clave}`", inline=False)
        embed.add_field(name="Script", value=f"`{hash_script}`", inline=True)
        embed.add_field(name="Duración", value=f"{dias} días", inline=True)
        embed.add_field(name="Usos", value=f"{usos}", inline=True)
        embed.set_footer(text="LuaProtect v2.2")
        await ctx.send(embed=embed)
    except Exception as e:
        await ctx.send(f"❌ Error: {str(e)}")

@bot.command(name="reset", aliases=["rhwid"])
@commands.check(es_admin)
async def reset_hwid(ctx, clave: str):
    from app import db, License
    lic = License.query.filter_by(key=clave).first()
    if not lic:
        await ctx.send("❌ Clave no encontrada")
        return
    lic.hwid = None
    lic.ip_register = None
    db.session.commit()
    await ctx.send(f"✅ HWID restablecido para: `{clave}`")

@bot.command(name="desactivar", aliases=["dclave"])
@commands.check(es_admin)
async def desactivar_clave(ctx, clave: str):
    from app import db, License
    lic = License.query.filter_by(key=clave).first()
    if not lic:
        await ctx.send("❌ Clave no encontrada")
        return
    lic.active = False
    db.session.commit()
    await ctx.send(f"✅ Clave desactivada: `{clave}`")

@bot.command(name="activar", aliases=["aclave"])
@commands.check(es_admin)
async def activar_clave(ctx, clave: str):
    from app import db, License
    lic = License.query.filter_by(key=clave).first()
    if not lic:
        await ctx.send("❌ Clave no encontrada")
        return
    lic.active = True
    db.session.commit()
    await ctx.send(f"✅ Clave activada: `{clave}`")

@bot.command(name="ayuda", aliases=["help"])
async def ayuda(ctx):
    embed = discord.Embed(title="📚 Comandos del Bot", color=0x3498db)
    embed.add_field(name="!generar <hash> [días] [usos]", value="Crea una nueva licencia", inline=False)
    embed.add_field(name="!reset <clave>", value="Restablece HWID de una licencia", inline=False)
    embed.add_field(name="!desactivar <clave>", value="Bloquea una licencia", inline=False)
    embed.add_field(name="!activar <clave>", value="Reactiva una licencia", inline=False)
    await ctx.send(embed=embed)

if __name__ == "__main__":
    if not TOKEN:
        print("❌ ERROR: Token no encontrado en variables de entorno")
    else:
        bot.run(TOKEN)
 
