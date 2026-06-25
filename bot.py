import os
import discord
from discord.ext import commands
from discord import app_commands
import datetime
import logging
from dotenv import load_dotenv

load_dotenv()

TOKEN = os.getenv("DISCORD_BOT_TOKEN")
if not TOKEN:
    raise ValueError("❌ DISCORD_BOT_TOKEN no está configurado")

ADMIN_ID = int(os.getenv("ADMIN_DISCORD_ID", "1501316920975036611"))
DOMINIO = os.getenv("DOMINIO", "https://protegetuscriptlua-production.up.railway.app")

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("LuauProtectBot")

intents = discord.Intents.default()
intents.message_content = True
intents.members = True

bot = commands.Bot(command_prefix="!", intents=intents, help_command=None)

# ============================================================
# FUNCIÓN PARA OBTENER LA APLICACIÓN FLASK
# ============================================================

def get_app():
    from app import app, db, User, License, Script, HWIDBan, AccessLog
    return app, db, User, License, Script, HWIDBan, AccessLog

# ============================================================
# COMANDO /panel - SOLO PARA EL CREADOR (CON API KEY)
# ============================================================

@bot.tree.command(name="panel", description="Abre el panel de control del creador")
@app_commands.describe(api_key="Tu API Key personal (la que ves en el panel web)")
async def panel(interaction: discord.Interaction, api_key: str):
    """Panel exclusivo para el creador del script"""
    try:
        app, db, User, License, Script, HWIDBan, AccessLog = get_app()
        
        with app.app_context():
            # 🔥 Buscar al creador por su API Key
            user = User.query.filter_by(api_key=api_key).first()
            if not user:
                embed = discord.Embed(
                    title="❌ API Key inválida",
                    description="No eres el creador del script o la API Key es incorrecta.",
                    color=0xe74c3c
                )
                embed.add_field(name="💡 Ayuda", value="Obtén tu API Key en el panel web.", inline=False)
                await interaction.response.send_message(embed=embed, ephemeral=True)
                return
            
            # Buscar licencias generadas por el creador
            licenses = License.query.filter_by(created_by=user.id).all()
            scripts = Script.query.filter_by(owner_id=user.id, active=True).all()
            
            # 🔥 Título del panel (lo configura el creador en la web)
            panel_title = user.panel_title if user.panel_title else "Vanta_OnTop"
            panel_description = user.panel_description if user.panel_description else "Script protegido con LuauProtect"
            
            script = Script.query.filter_by(active=True).first()
            
            embed = discord.Embed(
                title=f"🛡️ {panel_title} - Panel de Control",
                description=panel_description,
                color=0x5865F2,
                timestamp=datetime.datetime.utcnow()
            )
            
            if script:
                embed.add_field(name="📜 Script", value=script.name, inline=True)
                embed.add_field(name="🔗 Web", value=f"{DOMINIO}/panel", inline=True)
                embed.add_field(name="📊 Licencias", value=f"{len(licenses)} generadas", inline=True)
                embed.add_field(name="📥 Descargas", value=f"{script.downloads}", inline=True)
            else:
                embed.add_field(name="⚠️ Info", value="Sube un script desde la web.", inline=False)
            
            embed.add_field(name="🔑 Tu API Key", value=f"`{user.api_key}`", inline=False)
            embed.set_footer(text=f"{panel_title} - Panel del creador")
            
            # 🔥 Botones FIJOS para el creador
            view = discord.ui.View(timeout=300)
            view.add_item(discord.ui.Button(label="📜 Ver Script", style=discord.ButtonStyle.primary, custom_id="view_script"))
            view.add_item(discord.ui.Button(label="🔑 Redeem Key", style=discord.ButtonStyle.success, custom_id="redeem_key"))
            view.add_item(discord.ui.Button(label="ℹ️ Key Info", style=discord.ButtonStyle.secondary, custom_id="key_info"))
            view.add_item(discord.ui.Button(label="🔄 Reset HWID", style=discord.ButtonStyle.danger, custom_id="reset_hwid"))
            view.add_item(discord.ui.Button(label="🌐 Panel Web", style=discord.ButtonStyle.link, url=f"{DOMINIO}/panel"))
            
            await interaction.response.send_message(embed=embed, view=view)
        
    except Exception as e:
        logger.error(f"Error en /panel: {str(e)}")
        embed = discord.Embed(
            title="❌ Error",
            description=f"Error al cargar el panel: {str(e)[:100]}",
            color=0xe74c3c
        )
        await interaction.response.send_message(embed=embed, ephemeral=True)

# ============================================================
# COMANDO /ping
# ============================================================

@bot.tree.command(name="ping", description="Verifica la latencia del bot")
async def ping(interaction: discord.Interaction):
    await interaction.response.send_message(f"🏓 Pong! Latencia: {round(bot.latency * 1000)}ms", ephemeral=True)

# ============================================================
# MANEJADOR DE BOTONES
# ============================================================

@bot.event
async def on_interaction(interaction: discord.Interaction):
    if interaction.type != discord.InteractionType.component:
        return
    
    custom_id = interaction.data.get("custom_id", "")
    
    if custom_id == "view_script":
        await view_script(interaction)
    elif custom_id == "redeem_key":
        await redeem_key(interaction)
    elif custom_id == "key_info":
        await key_info(interaction)
    elif custom_id == "reset_hwid":
        await reset_hwid(interaction)

# ============================================================
# FUNCIONES DE LOS BOTONES
# ============================================================

async def view_script(interaction: discord.Interaction):
    """Ver el script - busca la licencia del usuario"""
    try:
        app, db, User, License, Script, HWIDBan, AccessLog = get_app()
        with app.app_context():
            # 🔥 Buscar licencia del usuario por su HWID (Discord ID)
            license = License.query.filter_by(hwid=str(interaction.user.id), active=True).first()
            
            if not license:
                await interaction.response.send_message(
                    "❌ **No tienes una licencia activa.**\nUsa el botón **'Redeem Key'** para canjear tu key.",
                    ephemeral=True
                )
                return
            
            script = Script.query.filter_by(hash_id=license.script_hash, active=True).first()
            if not script:
                script = Script.query.filter_by(active=True).first()
            
            if not script:
                await interaction.response.send_message("❌ No hay scripts disponibles.", ephemeral=True)
                return
            
            # 🔥 Loader con la KEY DE LICENCIA (NO API Key)
            loader = f'loadstring(game:HttpGet("{DOMINIO}/api/load/{script.hash_id}?key={license.key}&hwid="..tostring({{}}):gsub("table: ","")))()'
            
            embed = discord.Embed(
                title=f"📜 {script.name} - Loader",
                description="Copia este código en tu ejecutor de Roblox",
                color=0x5865F2
            )
            embed.add_field(name="🔑 Key Usada", value=f"`{license.key}`", inline=False)
            embed.add_field(name="📋 Loader", value=f"```lua\n{loader[:1000]}\n```", inline=False)
            embed.add_field(name="📥 Descargas", value=f"{script.downloads}", inline=True)
            embed.add_field(name="🌐 Web", value=f"[Abrir en web]({DOMINIO}/panel)", inline=False)
            
            view = discord.ui.View()
            view.add_item(discord.ui.Button(
                label="📋 Copiar Loader",
                style=discord.ButtonStyle.primary,
                custom_id="copy_loader"
            ))
            
            await interaction.response.send_message(embed=embed, view=view, ephemeral=True)
    except Exception as e:
        await interaction.response.send_message(f"❌ Error: {str(e)[:100]}", ephemeral=True)

class KeyModal(discord.ui.Modal, title="🔑 Canjear Key de Licencia"):
    key_input = discord.ui.TextInput(
        label="Key de Licencia",
        placeholder="Ingresa la key que te dio el creador...",
        style=discord.TextStyle.short,
        required=True,
        min_length=5,
        max_length=64
    )
    
    async def on_submit(self, interaction: discord.Interaction):
        try:
            app, db, User, License, Script, HWIDBan, AccessLog = get_app()
            with app.app_context():
                key = self.key_input.value.strip()
                
                # 🔥 Buscar la licencia por su key
                license = License.query.filter_by(key=key, active=True).first()
                if not license:
                    await interaction.response.send_message("❌ Key inválida o inactiva.", ephemeral=True)
                    return
                
                # Verificar si la key ya tiene HWID
                if license.hwid and license.hwid != str(interaction.user.id):
                    await interaction.response.send_message("❌ Esta key ya está en uso por otro usuario.", ephemeral=True)
                    return
                
                # Asignar HWID automáticamente
                if not license.hwid:
                    license.hwid = str(interaction.user.id)
                    db.session.commit()
                
                script = Script.query.filter_by(hash_id=license.script_hash).first()
                
                embed = discord.Embed(
                    title="✅ Key Canjeada Exitosamente",
                    description="Tu key de licencia ha sido canjeada.",
                    color=0x2ecc71
                )
                embed.add_field(name="🔑 Key", value=f"`{key}`", inline=False)
                embed.add_field(name="📜 Script", value=script.name if script else "Desconocido", inline=True)
                embed.add_field(name="📅 Estado", value="✅ Activa (Nunca expira)", inline=True)
                embed.add_field(name="📊 Usos", value="♾️ Ilimitado", inline=True)
                embed.add_field(name="🌐 Web", value=f"[Abrir panel]({DOMINIO}/panel)", inline=False)
                
                await interaction.response.send_message(embed=embed, ephemeral=True)
        except Exception as e:
            await interaction.response.send_message(f"❌ Error: {str(e)[:100]}", ephemeral=True)

async def redeem_key(interaction: discord.Interaction):
    await interaction.response.send_modal(KeyModal())

async def key_info(interaction: discord.Interaction):
    try:
        app, db, User, License, Script, HWIDBan, AccessLog = get_app()
        with app.app_context():
            license = License.query.filter_by(hwid=str(interaction.user.id), active=True).first()
            
            if not license:
                await interaction.response.send_message(
                    "❌ **No tienes una licencia activa.**\nUsa el botón **'Redeem Key'** para canjear tu key.",
                    ephemeral=True
                )
                return
            
            script = Script.query.filter_by(hash_id=license.script_hash).first()
            
            embed = discord.Embed(
                title="ℹ️ Información de tu Key",
                color=0x3498db
            )
            embed.add_field(name="🔑 Key", value=f"`{license.key}`", inline=False)
            embed.add_field(name="📜 Script", value=script.name if script else "Desconocido", inline=True)
            embed.add_field(name="✅ Estado", value="✅ Activa (Nunca expira)", inline=True)
            embed.add_field(name="🖥️ HWID", value=f"`{license.hwid}`", inline=True)
            embed.add_field(name="📊 Usos", value="♾️ Ilimitado", inline=True)
            embed.add_field(name="📅 Creada", value=license.created_at.strftime('%d/%m/%Y %H:%M'), inline=True)
            embed.add_field(name="🌐 Web", value=f"[Abrir panel]({DOMINIO}/panel)", inline=False)
            
            await interaction.response.send_message(embed=embed, ephemeral=True)
    except Exception as e:
        await interaction.response.send_message(f"❌ Error: {str(e)[:100]}", ephemeral=True)

async def reset_hwid(interaction: discord.Interaction):
    try:
        app, db, User, License, Script, HWIDBan, AccessLog = get_app()
        with app.app_context():
            license = License.query.filter_by(hwid=str(interaction.user.id), active=True).first()
            
            if not license:
                await interaction.response.send_message(
                    "❌ **No tienes una licencia activa.**\nUsa el botón **'Redeem Key'** para canjear tu key.",
                    ephemeral=True
                )
                return
            
            license.hwid = None
            db.session.commit()
            
            embed = discord.Embed(
                title="🔄 HWID Restablecido",
                description="Tu HWID ha sido restablecido exitosamente.",
                color=0x2ecc71
            )
            embed.add_field(name="🔑 Key", value=f"`{license.key}`", inline=True)
            embed.add_field(name="🖥️ HWID Nuevo", value="`Sin asignar`", inline=True)
            embed.add_field(name="📅 Estado", value="✅ Puedes usarlo en otro dispositivo", inline=True)
            embed.add_field(name="🌐 Web", value=f"[Abrir panel]({DOMINIO}/panel)", inline=False)
            
            await interaction.response.send_message(embed=embed, ephemeral=True)
    except Exception as e:
        await interaction.response.send_message(f"❌ Error: {str(e)[:100]}", ephemeral=True)

# ============================================================
# COMANDOS DE ADMIN
# ============================================================

@bot.tree.command(name="stats", description="[Admin] Estadísticas del sistema")
async def stats(interaction: discord.Interaction):
    if interaction.user.id != ADMIN_ID:
        await interaction.response.send_message("❌ No tienes permisos.", ephemeral=True)
        return
    
    try:
        app, db, User, License, Script, HWIDBan, AccessLog = get_app()
        with app.app_context():
            embed = discord.Embed(
                title="📊 Estadísticas del Sistema",
                color=0x3498db
            )
            embed.add_field(name="📜 Scripts", value=f"**{Script.query.count()}**", inline=True)
            embed.add_field(name="🔑 Licencias", value=f"**{License.query.count()}**", inline=True)
            embed.add_field(name="👥 Usuarios", value=f"**{User.query.count()}**", inline=True)
            embed.add_field(name="📡 Accesos", value=f"**{AccessLog.query.count()}**", inline=True)
            embed.add_field(name="📥 Descargas", value=f"**{db.session.query(db.func.sum(Script.downloads)).scalar() or 0}**", inline=True)
            embed.set_footer(text="Vanta_OnTop - Sistema de protección")
            
            await interaction.response.send_message(embed=embed, ephemeral=True)
    except Exception as e:
        await interaction.response.send_message(f"❌ Error: {str(e)[:100]}", ephemeral=True)

# ============================================================
# SINCRONIZAR COMANDOS
# ============================================================

@bot.event
async def on_ready():
    try:
        await bot.tree.sync()
        print(f"✅ Bot conectado como {bot.user}")
        print(f"✅ Comandos slash sincronizados")
        print(f"📊 Conectado a {len(bot.guilds)} servidores")
        print(f"🛡️ Vanta_OnTop - Sistema de protección activo")
    except Exception as e:
        print(f"❌ Error sincronizando: {e}")

if __name__ == "__main__":
    bot.run(TOKEN)
