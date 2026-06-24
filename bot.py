import discord
from discord import app_commands, ui
import requests
import os

API_URL = os.getenv("API_URL", "https://protegetuscriptlua-production.up.railway.app/api")
BOT_TOKEN = os.getenv("BOT_TOKEN")

intents = discord.Intents.default()
intents.message_content = True
bot = discord.Client(intents=intents)
tree = app_commands.CommandTree(bot)

user_active_keys = {}

class RedeemModal(ui.Modal, title="🔑 Activar tu Clave"):
    key_input = ui.TextInput(
        label="Escribe tu clave",
        placeholder="Ej: A1B2C3D4E5F6G7H8",
        required=True,
        max_length=32
    )
    async def on_submit(self, interaction: discord.Interaction):
        clave = self.key_input.value.strip()
        hwid = f"user_{interaction.user.id}"
        try:
            res = requests.post(f"{API_URL}/redeem", json={"key": clave, "hwid": hwid}, timeout=10)
            data = res.json()
            if data.get("ok"):
                user_active_keys[interaction.user.id] = clave
                await interaction.response.send_message("✅ Clave activada correctamente!", ephemeral=True)
            else:
                await interaction.response.send_message(f"❌ {data.get('msg')}", ephemeral=True)
        except:
            await interaction.response.send_message("❌ Error de conexión con el servidor", ephemeral=True)

class PanelView(ui.View):
    def __init__(self, script_id: int, script_name: str):
        super().__init__(timeout=None)
        self.script_id = script_id
        self.script_name = script_name

    @ui.button(label="📜 Obtener Script", style=discord.ButtonStyle.primary)
    async def view_script(self, interaction: discord.Interaction, button: ui.Button):
        if interaction.user.id not in user_active_keys:
            await interaction.response.send_message("❌ No tienes una clave activa. Usa el botón \"Activar Clave\" primero.", ephemeral=True)
            return
        clave = user_active_keys[interaction.user.id]
        hwid = f"user_{interaction.user.id}"
        try:
            res = requests.post(f"{API_URL}/get-script", json={"key": clave, "hwid": hwid}, timeout=10)
            data = res.json()
            if data.get("ok"):
                codigo = f"""```lua
-- 🛡️ {self.script_name}
-- Protegido por Luau Protect
script_key = "{clave}"

-- Código de verificación
loadstring(game:HttpGet("https://protegetuscriptlua-production.up.railway.app/api/verify?key={clave}&hwid={hwid}"))()
```"""
                await interaction.response.send_message(f"✅ Tu código:\n{codigo}", ephemeral=True)
            else:
                await interaction.response.send_message("❌ Clave inválida o expirada", ephemeral=True)
        except:
            await interaction.response.send_message("❌ Error al conectar", ephemeral=True)

    @ui.button(label="🔑 Activar Clave", style=discord.ButtonStyle.success)
    async def redeem_key(self, interaction: discord.Interaction, button: ui.Button):
        await interaction.response.send_modal(RedeemModal())

    @ui.button(label="ℹ️ Información", style=discord.ButtonStyle.secondary)
    async def info(self, interaction: discord.Interaction, button: ui.Button):
        if interaction.user.id not in user_active_keys:
            await interaction.response.send_message("❌ Sin clave activa", ephemeral=True)
            return
        await interaction.response.send_message(f"🔑 Clave: `{user_active_keys[interaction.user.id]}`", ephemeral=True)

@tree.command(name="panel", description="Abre el panel de protección del script")
async def panel(interaction: discord.Interaction, script: str = "Mi Script"):
    if not interaction.user.guild_permissions.administrator:
        await interaction.response.send_message("❌ Solo administradores pueden usar este comando", ephemeral=True)
        return
    embed = discord.Embed(
        title=f"🛡️ Luau Protect - {script}",
        description="Sistema de protección HWID + Claves activo\n\nUsa los botones abajo para activar tu clave o obtener el script.",
        color=0x5865F2
    )
    embed.set_footer(text="Protector de scripts Roblox | Versión 2.0")
    await interaction.response.send_message(embed=embed, view=PanelView(script_id=1, script_name=script))

@tree.command(name="generarclave", description="Genera una nueva clave de acceso")
@app_commands.describe(duracion="Duración en horas (0 = para siempre)")
async def generarclave(interaction: discord.Interaction, duracion: int = 0):
    if not interaction.user.guild_permissions.administrator:
        await interaction.response.send_message("❌ No tienes permisos", ephemeral=True)
        return
    try:
        res = requests.post(f"{API_URL}/generate-key", json={"duration": duracion, "script_id": 1}, timeout=10)
        data = res.json()
        if data.get("success"):
            tiempo = "Permanente" if duracion == 0 else f"{duracion} horas"
            await interaction.response.send_message(f"✅ Clave generada:\n`{data['key']}`\n⏱️ Validez: {tiempo}", ephemeral=True)
        else:
            await interaction.response.send_message("❌ Error al generar", ephemeral=True)
    except:
        await interaction.response.send_message("❌ Error de conexión", ephemeral=True)

@bot.event
async def on_ready():
    await tree.sync()
    print(f"✅ Bot conectado: {bot.user}")
    print("✅ Comandos sincronizados")

bot.run(BOT_TOKEN)
 
