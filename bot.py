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
        label="Escribe tu clave aquí",
        placeholder="Ej: XBKX9IOOBAFVRUJWJ9UUSEN7",
        required=True,
        max_length=32
    )
    async def on_submit(self, interaction: discord.Interaction):
        clave = self.key_input.value.strip()
        hwid = f"user_{interaction.user.id}"
        try:
            res = requests.post(f"{API_URL}/redeem", json={"key": clave, "hwid": hwid})
            data = res.json()
            if data.get("ok"):
                user_active_keys[interaction.user.id] = clave
                await interaction.response.send_message("✅ Clave activada correctamente! Ahora usa View Script.", ephemeral=True)
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
    async def view_script(self, interaction: discord.Interaction, button: ui.Button):
        if interaction.user.id not in user_active_keys:
            embed = discord.Embed(title="❌ You Need a Key!!", description="Anda comprala en ticket 🎟️", color=0xFF0000)
            await interaction.response.send_message(embed=embed, ephemeral=True)
            return
        clave = user_active_keys[interaction.user.id]
        hwid = f"user_{interaction.user.id}"
        try:
            res = requests.post(f"{API_URL}/get-script", json={"key": clave, "hwid": hwid})
            data = res.json()
            if data.get("ok"):
                codigo = f"""```lua
-- 📜 {self.script_name}
script_key = "{clave}"

loadstring(game:HttpGet("{API_URL.replace('/api','')}/api/verify?key={clave}&hwid={hwid}"))()
```"""
                await interaction.response.send_message(f"✅ Tu código:\n{codigo}", ephemeral=True)
            else:
                await interaction.response.send_message(f"❌ {data.get('msg')}", ephemeral=True)
        except:
            await interaction.response.send_message("❌ Error", ephemeral=True)

    @ui.button(label="🔑 Redeem Key", style=discord.ButtonStyle.success)
    async def redeem_key(self, interaction: discord.Interaction, button: ui.Button):
        await interaction.response.send_modal(RedeemModal())

    @ui.button(label="📊 Key Info", style=discord.ButtonStyle.secondary)
    async def key_info(self, interaction: discord.Interaction, button: ui.Button):
        if interaction.user.id not in user_active_keys:
            await interaction.response.send_message("❌ You Need a Key!! Anda comprala en ticket 🎟️", ephemeral=True)
            return
        await interaction.response.send_message(f"🔑 Clave: `{user_active_keys[interaction.user.id]}`", ephemeral=True)

    @ui.button(label="⚙️ Reset HWID", style=discord.ButtonStyle.danger)
    async def reset_hwid(self, interaction: discord.Interaction, button: ui.Button):
        if interaction.user.id not in user_active_keys:
            await interaction.response.send_message("❌ You Need a Key!! Anda comprala en ticket 🎟️", ephemeral=True)
            return
        clave = user_active_keys[interaction.user.id]
        try:
            requests.post(f"{API_URL}/reset-hwid", json={"key": clave})
            del user_active_keys[interaction.user.id]
            await interaction.response.send_message("✅ HWID restablecido", ephemeral=True)
        except:
            await interaction.response.send_message("❌ Error", ephemeral=True)

@tree.command(name="panel", description="Abre el panel del script")
async def panel(interaction: discord.Interaction, script: str = "Kz's Duels"):
    if not interaction.user.guild_permissions.administrator:
        await interaction.response.send_message("❌ Solo administradores pueden usar este comando", ephemeral=True)
        return
    embed = discord.Embed(
        title=f"⚔️ {script}",
        description="**Kz's Duels** no es solo otro script — es tu camino directo a la cima.\nOlvídate de mecánicas injustas o demoras molestas. Aquí cada partida está optimizada para que solo tu habilidad decida el resultado.\n\nDisfruta de una ventaja táctica real con fluidez impecable y respuesta instantánea, manteniéndote siempre un paso adelante de tu rival. ¡No juegues en desventaja — juega con **Kz's**!",
        color=0x5865F2
    )
    embed.set_footer(text="Luau Protect • Sistema de protección")
    await interaction.response.send_message(embed=embed, view=PanelView(script_id=1, script_name=script))

@tree.command(name="generatekey", description="Genera una nueva clave")
@app_commands.describe(duracion="Duración en horas (0 = permanente)")
async def generatekey(interaction: discord.Interaction, duracion: int = 0):
    if not interaction.user.guild_permissions.administrator:
        await interaction.response.send_message("❌ Solo administradores", ephemeral=True)
        return
    try:
        res = requests.post(f"{API_URL}/generate-key", json={"duration": duracion})
        data = res.json()
        if data.get("success"):
            tiempo = "Permanente" if duracion == 0 else f"{duracion} horas"
            await interaction.response.send_message(f"✅ Clave: `{data['key']}`\n⏱️ Validez: {tiempo}", ephemeral=True)
        else:
            await interaction.response.send_message("❌ Error", ephemeral=True)
    except:
        await interaction.response.send_message("❌ Error de conexión", ephemeral=True)

@bot.event
async def on_ready():
    await tree.sync()
    print(f"✅ Bot listo: {bot.user}")

bot.run(BOT_TOKEN)
        
