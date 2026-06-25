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
# CLASE PARA GUARDAR EL ÚLTIMO RESET DE CADA USUARIO
# ============================================================
last_reset = {}  # {discord_id: datetime}

# ============================================================
# COMANDO /panel
# ============================================================

@bot.tree.command(name="panel", description="Abre el panel de control del script")
async def panel(interaction: discord.Interaction):
    """Panel principal con todos los botones"""
    
    # Verificar si el usuario tiene key
    from app import db, License, User, Script
    
    user = User.query.filter_by(discord_id=str(interaction.user.id)).first()
    if not user:
        await interaction.response.send_message("❌ No estás registrado. Inicia sesión en la web primero.", ephemeral=True)
        return
    
    # Buscar licencia del usuario
    license = License.query.filter_by(hwid=str(interaction.user.id)).first()
    if not license:
        license = License.query.filter_by(created_by=user.id).first()
    
    # Buscar script (el primero activo)
    script = Script.query.filter_by(active=True).first()
    if not script:
        await interaction.response.send_message("❌ No hay scripts disponibles.", ephemeral=True)
        return
    
    # Crear embed
    embed = discord.Embed(
        title=f"🛡️ {script.name} - Panel de Control",
        description=script.description or "Script protegido con LuauProtect",
        color=0x5865F2,
        timestamp=datetime.datetime.utcnow()
    )
    
    # Estado de la licencia
    if license and license.is_valid():
        embed.add_field(name="✅ Estado", value="Activa", inline=True)
        embed.add_field(name="🔑 Key", value=f"`{license.key}`", inline=True)
        embed.add_field(name="🖥️ HWID", value=f"`{license.hwid or 'Sin asignar'}`", inline=True)
        embed.add_field(name="📊 Usos", value=f"{license.used_count} (Ilimitado)", inline=True)
        embed.add_field(name="📅 Expira", value=license.expires_at.strftime('%d/%m/%Y') if license.expires_at else "Nunca", inline=True)
        embed.set_footer(text="¡Todos los botones están disponibles!")
    else:
        embed.add_field(name="⚠️ Estado", value="Sin licencia", inline=False)
        embed.add_field(name="🔑 Acción", value="Usa 'Redeem Key' para canjear tu key", inline=False)
        embed.set_footer(text="⚠️ Compra tu key primero para acceder a todas las funciones!")
    
    # Botones
    view = discord.ui.View(timeout=300)
    
    # Botón View Script
    view.add_item(discord.ui.Button(
        label="📜 View Script",
        style=discord.ButtonStyle.primary,
        custom_id="view_script"
    ))
    
    # Botón Redeem Key
    view.add_item(discord.ui.Button(
        label="🔑 Redeem Key",
        style=discord.ButtonStyle.success,
        custom_id="redeem_key"
    ))
    
    # Botón Key Info
    view.add_item(discord.ui.Button(
        label="ℹ️ Key Info",
        style=discord.ButtonStyle.secondary,
        custom_id="key_info"
    ))
    
    # Botón Reset HWID
    view.add_item(discord.ui.Button(
        label="🔄 Reset HWID",
        style=discord.ButtonStyle.danger,
        custom_id="reset_hwid"
    ))
    
    await interaction.response.send_message(embed=embed, view=view)

# ============================================================
# MANEJADOR DE BOTONES DEL PANEL
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
# 1. VIEW SCRIPT (Con tu key automática)
# ============================================================

async def view_script(interaction: discord.Interaction):
    from app import db, License, User, Script
    
    # Buscar usuario
    user = User.query.filter_by(discord_id=str(interaction.user.id)).first()
    if not user:
        await interaction.response.send_message("❌ No estás registrado.", ephemeral=True)
        return
    
    # Buscar licencia del usuario
    license = License.query.filter_by(hwid=str(interaction.user.id)).first()
    if not license:
        license = License.query.filter_by(created_by=user.id).first()
    
    if not license or not license.is_valid():
        await interaction.response.send_message(
            "❌ **No tienes una key válida.**\n"
            "Compra tu key primero usando el botón **'Redeem Key'**.",
            ephemeral=True
        )
        return
    
    # Buscar script
    script = Script.query.filter_by(hash_id=license.script_hash, active=True).first()
    if not script:
        script = Script.query.filter_by(active=True).first()
    
    if not script:
        await interaction.response.send_message("❌ No hay scripts disponibles.", ephemeral=True)
        return
    
    # 🔥 LOADER CON LA KEY AUTOMÁTICA
    loader = f'loadstring(game:HttpGet("{DOMINIO}/api/load/{script.hash_id}?key={license.key}&hwid="..tostring({{}}):gsub("table: ","")))()'
    
    embed = discord.Embed(
        title=f"📜 {script.name} - Loader",
        description="Copia este código en tu ejecutor de Roblox",
        color=0x5865F2,
        timestamp=datetime.datetime.utcnow()
    )
    embed.add_field(name="🔑 Key Usada", value=f"`{license.key}`", inline=False)
    embed.add_field(name="📋 Loader", value=f"```lua\n{loader}\n```", inline=False)
    embed.set_footer(text="LuauProtect Pro")
    
    # Botón para copiar
    view = discord.ui.View()
    view.add_item(discord.ui.Button(
        label="📋 Copiar Loader",
        style=discord.ButtonStyle.primary,
        custom_id="copy_loader"
    ))
    
    await interaction.response.send_message(embed=embed, view=view, ephemeral=True)

# ============================================================
# 2. REDEEM KEY (Canjear Key)
# ============================================================

class KeyModal(discord.ui.Modal, title="🔑 Canjear Key"):
    key_input = discord.ui.TextInput(
        label="Key",
        placeholder="Ingresa tu key aquí...",
        style=discord.TextStyle.short,
        required=True,
        min_length=10,
        max_length=64
    )
    
    async def on_submit(self, interaction: discord.Interaction):
        from app import db, License, User, Script
        
        key = self.key_input.value.strip()
        
        # Buscar licencia
        license = License.query.filter_by(key=key, active=True).first()
        if not license:
            await interaction.response.send_message("❌ Key inválida o inactiva.", ephemeral=True)
            return
        
        # Verificar si la key ya tiene HWID
        if license.hwid and license.hwid != str(interaction.user.id):
            await interaction.response.send_message("❌ Esta key ya está en uso por otro usuario.", ephemeral=True)
            return
        
        # Asignar HWID (si no tiene)
        if not license.hwid:
            license.hwid = str(interaction.user.id)
            db.session.commit()
        
        # Buscar script
        script = Script.query.filter_by(hash_id=license.script_hash).first()
        
        embed = discord.Embed(
            title="✅ Key Canjeada Exitosamente",
            color=0x2ecc71,
            timestamp=datetime.datetime.utcnow()
        )
        embed.add_field(name="🔑 Key", value=f"`{key}`", inline=False)
        embed.add_field(name="📜 Script", value=script.name if script else "Desconocido", inline=True)
        embed.add_field(name="📅 Expira", value=license.expires_at.strftime('%d/%m/%Y') if license.expires_at else "Nunca", inline=True)
        embed.add_field(name="🖥️ HWID", value=f"`{license.hwid}`", inline=True)
        embed.set_footer(text="LuauProtect Pro")
        
        await interaction.response.send_message(embed=embed, ephemeral=True)

async def redeem_key(interaction: discord.Interaction):
    await interaction.response.send_modal(KeyModal())

# ============================================================
# 3. KEY INFO (Info de tu key)
# ============================================================

async def key_info(interaction: discord.Interaction):
    from app import db, License, User, Script
    
    user = User.query.filter_by(discord_id=str(interaction.user.id)).first()
    if not user:
        await interaction.response.send_message("❌ No estás registrado.", ephemeral=True)
        return
    
    license = License.query.filter_by(hwid=str(interaction.user.id)).first()
    if not license:
        license = License.query.filter_by(created_by=user.id).first()
    
    if not license or not license.is_valid():
        await interaction.response.send_message(
            "❌ **No tienes una key válida.**\n"
            "Compra tu key primero usando el botón **'Redeem Key'**.",
            ephemeral=True
        )
        return
    
    script = Script.query.filter_by(hash_id=license.script_hash).first()
    
    embed = discord.Embed(
        title="ℹ️ Información de tu Key",
        color=0x3498db,
        timestamp=datetime.datetime.utcnow()
    )
    embed.add_field(name="🔑 Key", value=f"`{license.key}`", inline=False)
    embed.add_field(name="📜 Script", value=script.name if script else "Desconocido", inline=True)
    embed.add_field(name="✅ Estado", value="Activa" if license.active else "Inactiva", inline=True)
    embed.add_field(name="🖥️ HWID", value=f"`{license.hwid or 'Sin asignar'}`", inline=True)
    embed.add_field(name="📊 Usos", value=f"{license.used_count} (Ilimitado)", inline=True)
    embed.add_field(name="📅 Expira", value=license.expires_at.strftime('%d/%m/%Y %H:%M') if license.expires_at else "Nunca", inline=True)
    embed.add_field(name="📅 Creada", value=license.created_at.strftime('%d/%m/%Y %H:%M'), inline=True)
    embed.set_footer(text="LuauProtect Pro")
    
    await interaction.response.send_message(embed=embed, ephemeral=True)

# ============================================================
# 4. RESET HWID (1 vez cada 24 horas)
# ============================================================

async def reset_hwid(interaction: discord.Interaction):
    from app import db, License, User
    
    user = User.query.filter_by(discord_id=str(interaction.user.id)).first()
    if not user:
        await interaction.response.send_message("❌ No estás registrado.", ephemeral=True)
        return
    
    license = License.query.filter_by(hwid=str(interaction.user.id)).first()
    if not license:
        license = License.query.filter_by(created_by=user.id).first()
    
    if not license or not license.is_valid():
        await interaction.response.send_message(
            "❌ **No tienes una key válida.**\n"
            "Compra tu key primero usando el botón **'Redeem Key'**.",
            ephemeral=True
        )
        return
    
    # Verificar límite de 24 horas
    user_id = str(interaction.user.id)
    if user_id in last_reset:
        time_since = datetime.datetime.utcnow() - last_reset[user_id]
        if time_since < datetime.timedelta(days=1):
            remaining = datetime.timedelta(days=1) - time_since
            horas = int(remaining.total_seconds() // 3600)
            minutos = int((remaining.total_seconds() % 3600) // 60)
            await interaction.response.send_message(
                f"⏳ **Debes esperar {horas}h {minutos}m para resetear nuevamente.**\n"
                "El límite es 1 reset cada 24 horas.",
                ephemeral=True
            )
            return
    
    # Resetear HWID
    license.hwid = None
    db.session.commit()
    
    # Guardar timestamp del reset
    last_reset[user_id] = datetime.datetime.utcnow()
    
    embed = discord.Embed(
        title="🔄 HWID Restablecido",
        description="Tu HWID ha sido restablecido exitosamente.",
        color=0x2ecc71,
        timestamp=datetime.datetime.utcnow()
    )
    embed.add_field(name="🔑 Key", value=f"`{license.key}`", inline=True)
    embed.add_field(name="🖥️ HWID Nuevo", value="`Sin asignar`", inline=True)
    embed.add_field(name="⏳ Próximo reset", value="Disponible en 24 horas", inline=True)
    embed.set_footer(text="LuauProtect Pro")
    
    await interaction.response.send_message(embed=embed, ephemeral=True)

# ============================================================
# 5. COPIA DE LOADER (Botón extra)
# ============================================================

@bot.tree.command(name="copiar", description="Copia el loader de tu script")
async def copiar_loader(interaction: discord.Interaction):
    from app import db, License, User, Script
    
    user = User.query.filter_by(discord_id=str(interaction.user.id)).first()
    if not user:
        await interaction.response.send_message("❌ No estás registrado.", ephemeral=True)
        return
    
    license = License.query.filter_by(hwid=str(interaction.user.id)).first()
    if not license:
        license = License.query.filter_by(created_by=user.id).first()
    
    if not license or not license.is_valid():
        await interaction.response.send_message("❌ No tienes una key válida.", ephemeral=True)
        return
    
    script = Script.query.filter_by(hash_id=license.script_hash, active=True).first()
    if not script:
        script = Script.query.filter_by(active=True).first()
    
    if not script:
        await interaction.response.send_message("❌ No hay scripts disponibles.", ephemeral=True)
        return
    
    loader = f'loadstring(game:HttpGet("{DOMINIO}/api/load/{script.hash_id}?key={license.key}&hwid="..tostring({{}}):gsub("table: ","")))()'
    
    await interaction.response.send_message(f"```lua\n{loader}\n```", ephemeral=True)

# ============================================================
# COMANDOS DE ADMIN (Ver todo)
# ============================================================

@bot.tree.command(name="admin_scripts", description="[Admin] Ver todos los scripts subidos")
async def admin_scripts(interaction: discord.Interaction):
    if interaction.user.id != ADMIN_ID:
        await interaction.response.send_message("❌ No tienes permisos.", ephemeral=True)
        return
    
    from app import Script
    
    scripts = Script.query.all()
    if not scripts:
        await interaction.response.send_message("📭 No hay scripts subidos.", ephemeral=True)
        return
    
    texto = "**📜 Scripts Subidos:**\n\n"
    for s in scripts:
        texto += f"• `{s.hash_id}` - **{s.name}** v{s.version} - 📥 {s.downloads} descargas\n"
    
    embed = discord.Embed(
        title="📜 Scripts - Panel Admin",
        description=texto,
        color=0x3498db,
        timestamp=datetime.datetime.utcnow()
    )
    embed.set_footer(text="LuauProtect Pro - Admin")
    await interaction.response.send_message(embed=embed, ephemeral=True)

@bot.tree.command(name="admin_keys", description="[Admin] Ver todas las keys")
async def admin_keys(interaction: discord.Interaction):
    if interaction.user.id != ADMIN_ID:
        await interaction.response.send_message("❌ No tienes permisos.", ephemeral=True)
        return
    
    from app import License
    
    keys = License.query.all()
    if not keys:
        await interaction.response.send_message("📭 No hay keys generadas.", ephemeral=True)
        return
    
    texto = "**🔑 Keys Generadas:**\n\n"
    for k in keys[:20]:
        estado = "✅" if k.active else "❌"
        hwid = k.hwid[:16] + "..." if k.hwid else "Sin asignar"
        texto += f"• `{k.key}` - {estado} - HWID: `{hwid}`\n"
    
    if len(keys) > 20:
        texto += f"\n_... y {len(keys) - 20} más._"
    
    embed = discord.Embed(
        title="🔑 Keys - Panel Admin",
        description=texto,
        color=0x3498db,
        timestamp=datetime.datetime.utcnow()
    )
    embed.set_footer(text="LuauProtect Pro - Admin")
    await interaction.response.send_message(embed=embed, ephemeral=True)

# ============================================================
# SINCRONIZAR COMANDOS SLASH
# ============================================================

@bot.event
async def on_ready():
    await bot.tree.sync()
    print(f"✅ Bot conectado como {bot.user}")
    print(f"✅ Comandos slash sincronizados")
    print(f"📊 Conectado a {len(bot.guilds)} servidores")

if __name__ == "__main__":
    if not TOKEN:
        print("❌ ERROR: Token no encontrado")
    else:
        bot.run(TOKEN)
