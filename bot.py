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
    key_input = ui.TextInput(label="Clave", max_length=32, required=True)
    async def on_submit(self, interaction):
        clave = self.key_input.value.strip()
        hwid = f"user_{interaction.user.id}"
        try:
            res = requests.post(f"{API_URL}/redeem", json={"key": clave, "hwid": hwid}, timeout=10)
            data = res.json()
            if data.get("ok"):
                user_active_keys[interaction.user.id] = clave
                await interaction.response.send_message("✅ Clave activada!", ephemeral=True)
            else:
                await interaction.response.send_message(f"❌ {data.get('msg')}", ephemeral=True)
        except:
            await interaction.response.send_message("❌ Error de conexión", ephemeral=True)

class PanelView(ui.View):
    def __init__(self, script_id: int, script_name: str):
        super().__init__(timeout=None)
        self.script_id = script_id
        self.script_name = script_name

    @ui.button(label="📜 View Script", style=discord.ButtonStyle.primary)
    async def view_script(self, interaction, button):
        if interaction.user.id not in user_active_keys:
            await interaction.response.send_message("❌ Necesitas clave, compra en ticket 🎟️", ephemeral=True)
            return
        clave = user_active_keys[interaction.user.id]
        hwid = f"user_{interaction.user.id}"
        try:
            res = requests.post(f"{API_URL}/get-script", json={"key": clave, "hwid": hwid}, timeout=10)
            data = res.json()
            if data.get("ok"):
                codigo = f"""```lua
-- {self.script_name}
script_key = "{clave}"
loadstring(game:HttpGet("{API_URL.replace('/api','')}/api/verify?key={clave}&hwid={hwid}"))()
```"""
                await interaction.response.send_message(f"✅ Tu código:\n{codigo}", ephemeral=True)
            else:
                await interaction.response.send_message("❌ Clave inválida", ephemeral=True)
        except:
            await interaction.response.send_message("❌ Error", ephemeral=True)

    @ui.button(label="🔑 Redeem Key", style=discord.ButtonStyle.success)
    async def redeem(self, interaction, button):
        await interaction.response.send_modal(RedeemModal())

    @ui.button(label="⚙️ Reset HWID", style=discord.ButtonStyle.danger)
    async def reset(self, interaction, button):
        if interaction.user.id not in user_active_keys:
            await interaction.response.send_message("❌ Sin clave activa", ephemeral=True)
            return
        clave = user_active_keys[interaction.user.id]
        try:
            requests.post(f"{API_URL}/reset-hwid", json={"key": clave}, timeout=10)
            del user_active_keys[interaction.user.id]
            await interaction.response.send_message("✅ HWID restablecido", ephemeral=True)
        except:
            await interaction.response.send_message("❌ Error", ephemeral=True)

@tree.command(name="panel", description="Abrir panel del script")
async def panel(interaction, script: str = "Kz's Duels"):
    if not interaction.user.guild_permissions.administrator:
        await interaction.response.send_message("❌ Solo admins", ephemeral=True)
        return
    embed = discord.Embed(title=f"⚔️ {script}", description="Sistema de protección activo", color=0x5865F2)
    await interaction.response.send_message(embed=embed, view=PanelView(1, script))

@tree.command(name="generatekey", description="Generar clave")
@app_commands.describe(duracion="Horas (0 = permanente)")
async def generatekey(interaction, duracion: int = 0):
    if not interaction.user.guild_permissions.administrator:
        await interaction.response.send_message("❌ Solo admins", ephemeral=True)
        return
    try:
        res = requests.post(f"{API_URL}/generate-key", json={"duration": duracion}, timeout=10)
        data = res.json()
        if data.get("success"):
            tiempo = "Permanente" if duracion == 0 else f"{duracion}h"
            await interaction.response.send_message(f"✅ Clave: `{data['key']}`\n⏱️ {tiempo}", ephemeral=True)
        else:
            await interaction.response.send_message("❌ Error", ephemeral=True)
    except:
        await interaction.response.send_message("❌ Error de conexión", ephemeral=True)

@bot.event
async def on_ready():
    await tree.sync()
    print(f"✅ Bot conectado como {bot.user}")

bot.run(BOT_TOKEN)
