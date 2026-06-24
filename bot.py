import os
import discord
from discord import app_commands
from discord.ui import View, Button, Modal, TextInput
from discord.ext import commands
import requests

# ---------------- CONFIGURACIÓN SEGURA ----------------
TOKEN = os.getenv("DISCORD_BOT_TOKEN")  # ✅ Se lee del entorno, no se escribe aquí
DOMINIO = "https://protegetuscriptlua-production.up.railway.app"
API_URL = f"{DOMINIO}/api"
# -------------------------------------------------

intents = discord.Intents.default()
intents.message_content = True
intents.guilds = True

bot = commands.Bot(command_prefix="!", intents=intents)
tree = bot.tree

# ---------------- VISTA CON BOTONES DEL PANEL ----------------
class PanelView(View):
    def __init__(self):
        super().__init__(timeout=None)
        self.add_item(Button(label="📜 View Script", style=discord.ButtonStyle.blurple, url=f"{DOMINIO}/scripts"))
        self.add_item(Button(label="🔑 Redeem Key", style=discord.ButtonStyle.green, url=f"{DOMINIO}/loader/"))
        self.add_item(Button(label="📊 Key Info", style=discord.ButtonStyle.grey, url=f"{DOMINIO}/keys"))
        self.add_item(Button(label="⚙️ Reset HWID", style=discord.ButtonStyle.red, custom_id="reset_hwid"))

    @discord.ui.button(label="⚙️ Reset HWID", style=discord.ButtonStyle.red, custom_id="reset_hwid")
    async def reset_hwid(self, interaction: discord.Interaction, button: Button):
        await interaction.response.send_modal(ResetHWIDModal())

# ---------------- MODAL PARA RESTABLECER HWID ----------------
class ResetHWIDModal(Modal, title="Restablecer HWID"):
    key = TextInput(label="Ingresa tu clave", placeholder="XXXXXXXXXXXXXXXX", required=True, max_length=16)

    async def on_submit(self, interaction: discord.Interaction):
        try:
            res = requests.post(f"{API_URL}/reset-hwid", json={"key": self.key.value.strip()}, timeout=10)
            data = res.json()
            if data.get("success"):
                await interaction.response.send_message("✅ HWID restablecido correctamente. Ya puedes usar la clave en otro equipo.", ephemeral=True)
            else:
                await interaction.response.send_message(f"❌ Error: {data.get('error', 'Clave inválida o inactiva')}", ephemeral=True)
        except:
            await interaction.response.send_message("❌ No se pudo conectar con el servidor.", ephemeral=True)

# ---------------- COMANDO /PANEL ----------------
@tree.command(name="panel", description="Muestra el panel de control con todas las opciones")
async def panel(interaction: discord.Interaction):
    embed = discord.Embed(
        title="🔐 ProtectorScripts - Panel de Control",
        description="Bienvenido. Usa los botones de abajo para gestionar tus claves y scripts protegidos.",
        color=discord.Color.blue()
    )
    embed.add_field(name="📜 View Script", value="Accede a tus scripts protegidos", inline=False)
    embed.add_field(name="🔑 Redeem Key", value="Activa tu clave y vincula tu equipo", inline=False)
    embed.add_field(name="📊 Key Info", value="Consulta estado, vencimiento y HWID de tu clave", inline=False)
    embed.add_field(name="⚙️ Reset HWID", value="Desvincula la clave del equipo actual", inline=False)
    embed.set_footer(text="ProtectorScripts • Sistema de protección propio")

    await interaction.response.send_message(embed=embed, view=PanelView(), ephemeral=False)

# ---------------- EVENTO AL INICIAR EL BOT ----------------
@bot.event
async def on_ready():
    print(f"✅ Bot conectado correctamente como: {bot.user}")
    try:
        await tree.sync()
        print("✅ Comandos / sincronizados y listos para usar")
    except Exception as e:
        print(f"❌ Error al sincronizar comandos: {e}")

# ---------------- EJECUTAR EL BOT ----------------
if __name__ == "__main__":
    if not TOKEN:
        raise ValueError("❌ La variable DISCORD_BOT_TOKEN no está configurada")
    bot.run(TOKEN)
