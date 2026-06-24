# ==================================================
# LUA PROTECT - BOT DE DISCORD
# Versión: 2.0.0
# ==================================================

import os
import discord
from discord import app_commands
from discord.ext import commands
from discord.ui import View, Button, Modal, TextInput, Select
import requests
from datetime import datetime
import logging
import traceback

# ==================================================
# ⚙️ CONFIGURACIÓN
# ==================================================

BOT_TOKEN = os.getenv("DISCORD_BOT_TOKEN", "PON_AQUÍ_TU_TOKEN_DEL_BOT")
API_BASE = "https://protegetuscriptlua-production.up.railway.app/api"
DOMINIO = "https://protegetuscriptlua-production.up.railway.app"
API_VERSION = "v2"

# Configuración de intents
intents = discord.Intents.default()
intents.message_content = True
intents.guilds = True
intents.members = True
intents.presences = True

bot = commands.Bot(command_prefix="!", intents=intents, help_command=None)
tree = bot.tree

# Logs
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("LuaProtectBot")

# ==================================================
# 🖥️ ELEMENTOS DE INTERFAZ
# ==================================================

class ResetHWIDModal(Modal, title="🔄 Restablecer HWID de Clave"):
    clave = TextInput(
        label="Clave de acceso",
        placeholder="Ejemplo: A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6",
        required=True,
        max_length=32,
        min_length=16
    )

    async def on_submit(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=True)
        try:
            res = requests.post(
                f"{API_BASE}/reset-key-hwid",
                json={"key": self.clave.value.strip()},
                timeout=15
            )
            data = res.json()

            if data.get("success"):
                embed = discord.Embed(
                    title="✅ Operación Exitosa",
                    description=data.get("message", "HWID restablecido correctamente"),
                    color=discord.Color.green(),
                    timestamp=datetime.utcnow()
                )
                embed.set_footer(text=f"Solicitado por {interaction.user.name}")
            else:
                embed = discord.Embed(
                    title="❌ Error",
                    description=data.get("error", "No se pudo procesar la solicitud"),
                    color=discord.Color.red(),
                    timestamp=datetime.utcnow()
                )

            await interaction.followup.send(embed=embed, ephemeral=True)

        except Exception as e:
            logger.error(f"Error en reset HWID: {str(e)}")
            await interaction.followup.send(
                "❌ Error de conexión con el servidor. Intenta más tarde.",
                ephemeral=True
            )


class BanHWIDModal(Modal, title="🚫 Bloquear HWID"):
    hwid = TextInput(
        label="HWID del dispositivo",
        placeholder="Ingresa el HWID completo",
        required=True,
        max_length=255
    )
    motivo = TextInput(
        label="Motivo del bloqueo",
        placeholder="Ej: Distribución no autorizada",
        required=False,
        max_length=255,
        default="Sin motivo especificado"
    )

    async def on_submit(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=True)
        try:
            res = requests.post(
                f"{API_BASE}/ban-hwid",
                json={
                    "hwid": self.hwid.value.strip(),
                    "reason": self.motivo.value.strip()
                },
                timeout=15
            )
            data = res.json()

            if data.get("success"):
                embed = discord.Embed(
                    title="✅ HWID Bloqueado",
                    description=f"El dispositivo ha sido bloqueado permanentemente.\n**Motivo:** {self.motivo.value}",
                    color=discord.Color.orange(),
                    timestamp=datetime.utcnow()
                )
            else:
                embed = discord.Embed(
                    title="❌ Error",
                    description=data.get("error", "No se pudo bloquear el HWID"),
                    color=discord.Color.red()
                )

            await interaction.followup.send(embed=embed, ephemeral=True)

        except Exception as e:
            logger.error(f"Error al bloquear HWID: {str(e)}")
            await interaction.followup.send("❌ Error de conexión", ephemeral=True)


class PanelPrincipalView(View):
    def __init__(self):
        super().__init__(timeout=300)  # 5 minutos
        self.add_item(Button(
            label="📜 Mis Scripts",
            style=discord.ButtonStyle.blurple,
            url=f"{DOMINIO}/scripts",
            emoji="📄"
        ))
        self.add_item(Button(
            label="🔑 Mis Claves",
            style=discord.ButtonStyle.green,
            url=f"{DOMINIO}/keys",
            emoji="🔐"
        ))
        self.add_item(Button(
            label="⚙️ Paneles",
            style=discord.ButtonStyle.grey,
            url=f"{DOMINIO}/panels",
            emoji="⚙️"
        ))
        self.add_item(Button(
            label="🚫 HWID Bloqueados",
            style=discord.ButtonStyle.danger,
            url=f"{DOMINIO}/hwid-bans",
            emoji="⛔"
        ))

    @discord.ui.button(label="🔄 Resetear HWID", style=discord.ButtonStyle.primary, emoji="🔁")
    async def reset_hwid(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_modal(ResetHWIDModal())

    @discord.ui.button(label="🚫 Bloquear HWID", style=discord.ButtonStyle.danger, emoji="🛑")
    async def ban_hwid(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_modal(BanHWIDModal())


# ==================================================
# 📋 COMANDOS SLASH
# ==================================================

@tree.command(
    name="panel",
    description="Abre el panel de control principal de LuaProtect"
)
async def cmd_panel(interaction: discord.Interaction):
    embed = discord.Embed(
        title="🔐 LuaProtect v2.0 - Panel de Control",
        description="Gestiona todos tus scripts, claves y configuraciones desde un solo lugar.",
        color=discord.Color.blue(),
        timestamp=datetime.utcnow()
    )
    embed.add_field(
        name="📌 Funciones Disponibles",
        value="• Subir y proteger scripts\n• Generar claves de acceso\n• Restablecer HWID\n• Bloquear dispositivos\n• Ver estadísticas y registros",
        inline=False
    )
    embed.set_thumbnail(url="https://cdn-icons-png.flaticon.com/512/1055/1055685.png")
    embed.set_footer(text=f"Desarrollado para Roblox | Solicitado por {interaction.user.name}")

    await interaction.response.send_message(embed=embed, view=PanelPrincipalView(), ephemeral=True)


@tree.command(
    name="generatekey",
    description="Genera una nueva clave de acceso para tus scripts"
)
@app_commands.describe(
    panel_id="ID del panel al que asignar la clave",
    duracion="Duración: 1h, 6h, 12h, 1d, 3d, 7d, 15d, 30d, 90d, 1y, 0 (sin vencimiento)",
    usos="Cantidad máxima de usos (0 = sin límite)"
)
async def cmd_generatekey(
    interaction: discord.Interaction,
    panel_id: int,
    duracion: str = "24h",
    usos: int = 0
):
    await interaction.response.defer(ephemeral=True)
    try:
        res = requests.post(
            f"{API_BASE}/generate-key",
            json={
                "panel_id": panel_id,
                "duration": duracion,
                "max_uses": usos
            },
            timeout=15
        )
        data = res.json()

        if data.get("success"):
            embed = discord.Embed(
                title="✅ Clave Generada Exitosamente",
                color=discord.Color.green(),
                timestamp=datetime.utcnow()
            )
            embed.add_field(name="🔑 Clave", value=f"`{data['key']}`", inline=False)
            embed.add_field(name="⏳ Expira", value=data["expires"], inline=True)
            embed.add_field(name="🔄 Usos", value=data["max_uses"], inline=True)
            embed.add_field(
                name="📌 Formato de uso",
                value=f"```lua\nscript_key = \"{data['key']}\"\nloadstring(game:HttpGet(\"{DOMINIO}/scripts/hosted/TU_HASH.lua?key=\"..script_key..\"&hwid=\"..tostring({{}}):gsub(\"table: \",\"\")))()\n```",
                inline=False
            )
            embed.set_footer(text="⚠️ Guarda esta clave, no se volverá a mostrar completa")
        else:
            embed = discord.Embed(
                title="❌ Error",
                description=data.get("error", "No se pudo generar la clave"),
                color=discord.Color.red()
            )

        await interaction.followup.send(embed=embed, ephemeral=True)

    except Exception as e:
        logger.error(f"Error generando clave: {str(e)}")
        await interaction.followup.send(
            "❌ No se pudo conectar con el servidor. Intenta más tarde.",
            ephemeral=True
        )


@tree.command(
    name="deletekey",
    description="Elimina y desactiva una
