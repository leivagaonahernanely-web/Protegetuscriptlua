import os
import discord
from discord import app_commands
from discord.ui import View, Button, Modal, TextInput
from discord.ext import commands
import requests

# ---------------- CONFIGURACIÓN ----------------
TOKEN = os.getenv("DISCORD_BOT_TOKEN")
DOMINIO = "https://protegetuscriptlua-production.up.railway.app"
API_URL = f"{DOMINIO}/api"
# -------------------------------------------------

intents = discord.Intents.default()
intents.message_content = True
intents.guilds = True

bot = commands.Bot(command_prefix="!", intents=intents)
tree = bot.tree

# ---------------- VISTA DEL PANEL ----------------
class PanelView(View):
    def __init__(self):
        super().__init__(timeout=None)
        self.add_item(Button(label="📜 Ver Scripts", style=discord.ButtonStyle.blurple, url=f"{DOMINIO}/scripts"))
        self.add_item(Button(label="🔑 Usar Clave", style=discord.ButtonStyle.green, url=f"{DOMINIO}/loader/"))
        self.add_item(Button(label="⚙️ Reset HWID", style=discord.ButtonStyle.red, custom_id="reset_hwid"))

    @discord.ui.button(label="⚙️ Reset HWID", style=discord.ButtonStyle.red, custom_id="reset_hwid")
    async def reset_hwid(self, interaction: discord.Interaction, button: Button):
        await interaction.response.send_modal(ResetHWIDModal())

class ResetHWIDModal(Modal, title="Restablecer HWID"):
    key = TextInput(label="Clave", placeholder="XXXXXXXXXXXXXXXX", required=True, max_length=16)
    async def on_submit(self, interaction: discord.Interaction):
        try:
            res = requests.post(f"{API_URL}/reset-hwid", json={"key": self.key.value.strip()}, timeout=10)
            data = res.json()
            await interaction.response.send_message("✅ HWID restablecido" if data["success"] else f"❌ {data['error']}", ephemeral=True)
        except:
            await interaction.response.send_message("❌ Error de conexión", ephemeral=True)

# ---------------- COMANDOS ----------------
@tree.command(name="panel", description="Muestra el panel de control")
async def panel(interaction: discord.Interaction):
    embed = discord.Embed(title="🔐 LuauProtect - Panel", color=discord.Color.blue())
    embed.description = "Usa los botones o comandos para gestionar tu sistema."
    await interaction.response.send_message(embed=embed, view=PanelView())

@tree.command(name="generatekey", description="Generar clave nueva")
@app_commands.describe(panel_id="ID del panel", duration="Ej: 1h, 30d, 1y, 0")
async def generatekey(interaction: discord.Interaction, panel_id: int, duration: str = "24h"):
    await interaction.response.defer(ephemeral=True)
    try:
        res = requests.post(f"{API_URL}/generate-key", json={"panel_id": panel_id, "duration": duration}, timeout=10)
        data = res.json()
        if data["success"]:
            await interaction.followup.send(f"✅ Clave: `{data['key']}`\nExpira: {data['expires']}", ephemeral=True)
        else:
            await interaction.followup.send(f"❌ {data['error']}", ephemeral=True)
    except:
        await interaction.followup.send("❌ Error de conexión", ephemeral=True)

@tree.command(name="blacklist", description="Bloquear HWID")
@app_commands.describe(hwid="HWID o hash", motivo="Motivo del bloqueo")
async def blacklist(interaction: discord.Interaction, hwid: str, motivo: str = "Sin motivo"):
    await interaction.response.defer(ephemeral=True)
    try:
        res = requests.post(f"{API_URL}/ban-hwid", json={"hwid": hwid, "reason": motivo}, timeout=10)
        data = res.json()
        await interaction.followup.send("✅ HWID bloqueado" if data["success"] else f"❌ {data['error']}", ephemeral=True)
    except:
        await interaction.followup.send("❌ Error de conexión", ephemeral=True)

@tree.command(name="deletekey", description="Eliminar una clave")
@app_commands.describe(clave="Clave a eliminar")
async def deletekey(interaction: discord.Interaction, clave: str):
    await interaction.response.defer(ephemeral=True)
    try:
        res = requests.post(f"{API_URL}/delete-key", json={"key": clave}, timeout=10)
        data = res.json()
        await interaction.followup.send("✅ Clave eliminada" if data["success"] else f"❌ {data['error']}", ephemeral=True)
    except:
        await interaction.followup.send("❌ Error de conexión", ephemeral=True)

@tree.command(name="resetkeyhwid", description="Restablecer HWID de una clave")
@app_commands.describe(clave="Clave")
async def resetkeyhwid(interaction: discord.Interaction, clave: str):
    await interaction.response.defer(ephemeral=True)
    try:
        res = requests.post(f"{API_URL}/reset-key-hwid", json={"key": clave}, timeout=10)
        data = res.json()
        await interaction.followup.send("✅ HWID restablecido" if data["success"] else f"❌ {data['error']}", ephemeral=True)
    except:
        await interaction.followup.send("❌ Error de conexión", ephemeral=True)

@bot.event
async def on_ready():
    print(f"✅ Bot conectado como {bot.user}")
    await tree.sync()
    print("✅ Comandos listos")

if __name__ == "__main__":
    if not TOKEN:
        raise ValueError("TOKEN no configurado")
    bot.run(TOKEN)
 
