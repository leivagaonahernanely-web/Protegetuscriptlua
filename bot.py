import discord
from discord import app_commands
from discord.ui import View, Button, Modal, TextInput
from discord.ext import commands
import requests

# ---------------- CONFIGURACIÓN ----------------
TOKEN = "AQUÍ_PON_TU_TOKEN_DEL_BOT"
DOMINIO = "https://protegetuscriptlua-production.up.railway.app"
API_URL = f"{DOMINIO}/api"
# -------------------------------------------------

intents = discord.Intents.default()
intents.message_content = True
intents.guilds = True

bot = commands.Bot(command_prefix="!", intents=intents)
tree = bot.tree

# ---------------- VISTA CON BOTONES ----------------
class PanelView(View):
    def __init__(self):
        super().__init__(timeout=None)
        self.add_item(Button(label="📜 View Script", style=discord.ButtonStyle.blurple, url=f"{DOMINIO}/scripts"))
        self.add_item(Button(label="🔑 Redeem Key", style=discord.ButtonStyle.green, url=f"{DOMINIO}/api/verify"))
        self.add_item(Button(label="📊 Key Info", style=discord.ButtonStyle.grey, url=f"{DOMINIO}/keys"))
        self.add_item(Button(label="⚙️ Reset HWID", style=discord.ButtonStyle.red, custom_id="reset_hwid"))

    @discord.ui.button(label="⚙️ Reset HWID", style=discord.ButtonStyle.red, custom_id="reset_hwid")
    async def reset_hwid(self, interaction: discord.Interaction, button: Button):
        # Ventana SOLO para quien pulsó
        await interaction.response.send_modal(ResetHWIDModal())

class ResetHWIDModal(Modal, title="Restablecer HWID"):
    key = TextInput(label="Ingresa tu clave", placeholder="XXXXXXXXXXXXXXXX", required=True, max_length=16)

    async def on_submit(self, interaction: discord.Interaction):
        try:
            res = requests.post(f"{API_URL}/reset-hwid", json={"key": self.key.value.strip()}, timeout=10)
            data = res.json()
            if data.get("success"):
                # Mensaje SOLO para el usuario
                await interaction.response.send_message("✅ HWID restablecido correctamente. Ya puedes usar la clave en otro equipo.", ephemeral=True)
            else:
                await interaction.response.send_message(f"❌ Error: {data.get('error', 'Clave inválida o inactiva')}", ephemeral=True)
        except:
            await interaction.response.send_message("❌ No se pudo conectar con el servidor.", ephemeral=True)

# ---------------- COMANDO /PANEL ----------------
@tree.command(name="panel", description="Muestra el panel de control")
async def panel(interaction: discord.Interaction):
    embed = discord.Embed(
        title="🔐 ProtectorScripts - Panel de Control",
        description="Bienvenido. Usa los botones abajo para gestionar tus claves y scripts.",
        color=discord.Color.blue()
    )
    embed.add_field(name="📜 View Script", value="Accede a tus scripts protegidos", inline=False)
    embed.add_field(name="🔑 Redeem Key", value="Activa tu clave y vincula tu equipo", inline=False)
    embed.add_field(name="📊 Key Info", value="Consulta estado y vencimiento", inline=False)
    embed.add_field(name="⚙️ Reset HWID", value="Desvincula la clave de este equipo", inline=False)
    embed.set_footer(text="ProtectorScripts • Sistema de protección")

    # ✅ El mensaje LO VEN TODOS
    await interaction.response.send_message(embed=embed, view=PanelView(), ephemeral=False)

@bot.event
async def on_ready():
    print(f"✅ Bot conectado como: {bot.user}")
    try:
        await tree.sync()
        print("✅ Comandos / sincronizados")
    except Exception as e:
        print(f"❌ Error al sincronizar: {e}")

if __name__ == "__main__":
    bot.run(TOKEN)
