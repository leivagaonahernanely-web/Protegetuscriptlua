import discord
from discord import app_commands
import requests
import os

API_URL = os.getenv("API_URL", "https://tu-url.up.railway.app/api")
BOT_TOKEN = os.getenv("BOT_TOKEN", "")

intents = discord.Intents.default()
bot = discord.Client(intents=intents)
tree = app_commands.CommandTree(bot)

@tree.command(name="generar", description="Generar clave de acceso")
@app_commands.describe(panel="ID del panel", duracion="Horas (0 = permanente)", nota="Descripción")
async def generar(interaction, panel: int, duracion: int = 0, nota: str = ""):
    if not interaction.user.guild_permissions.administrator:
        return await interaction.response.send_message("❌ Sin permisos", ephemeral=True)
    try:
        res = requests.post(f"{API_URL}/generate-key", json={
            "panel_id": panel,
            "duration": duracion,
            "note": nota
        }, timeout=10)
        data = res.json()
        if data["success"]:
            await interaction.response.send_message(
                f"✅ Clave: `{data['key']}`\n⏱️ Duración: {'Permanente' if duracion == 0 else f'{duracion}h'}\n📝 Nota: {nota or 'Ninguna'}",
                ephemeral=True
            )
        else:
            await interaction.response.send_message("❌ Error al generar", ephemeral=True)
    except:
        await interaction.response.send_message("❌ Sin conexión", ephemeral=True)

@bot.event
async def on_ready():
    await tree.sync()
    print(f"✅ Bot conectado: {bot.user}")

bot.run(BOT_TOKEN)
