import asyncio
import datetime as dt
import logging
import os
import secrets
import string

import discord
from discord import app_commands
from discord.ext import commands
from dotenv import load_dotenv

load_dotenv()
TOKEN = os.getenv('DISCORD_BOT_TOKEN')
if not TOKEN:
    raise ValueError('DISCORD_BOT_TOKEN no está configurado')
OWNER_ID = int(os.getenv('ADMIN_DISCORD_ID', '1501316920975036611'))
DOMAIN = os.getenv('DOMINIO', 'https://vantaprotect.up.railway.app').rstrip('/')
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger('VantaProtectBot')

intents = discord.Intents.default()
intents.members = True
bot = commands.Bot(command_prefix='!', intents=intents, help_command=None)


def models():
    from app import app, db, User, License, Script, HWIDBan, AccessLog, RolePermission, Warning, PriceConfig
    return app, db, User, License, Script, HWIDBan, AccessLog, RolePermission, Warning, PriceConfig


def key_value():
    return ''.join(secrets.choice(string.ascii_letters + string.digits) for _ in range(32))


def owner(user: discord.abc.User) -> bool:
    return user.id == OWNER_ID


def has_manager_role(interaction: discord.Interaction, RolePermission) -> bool:
    if owner(interaction.user):
        return True
    role_ids = {str(role.id) for role in getattr(interaction.user, 'roles', [])}
    guild_id = str(interaction.guild_id or '')
    return RolePermission.query.filter(RolePermission.guild_id == guild_id, RolePermission.role_id.in_(role_ids), RolePermission.enabled.is_(True)).first() is not None


def permission_error():
    return discord.Embed(title='Sin permisos', description='Necesitas el rol de gestión configurado por el owner.', color=0xff5864)


def new_key(License):
    value = key_value()
    while License.query.filter_by(key=value).first():
        value = key_value()
    return value


async def require_manager(interaction, RolePermission):
    if has_manager_role(interaction, RolePermission):
        return True
    await interaction.response.send_message(embed=permission_error(), ephemeral=True)
    return False


@bot.tree.command(name='generatekey', description='Genera una key aleatoria de 32 caracteres')
@app_commands.describe(duration='Duración: 0 permanente, 7d, 30d, 1y', script_hash='ID del script; vacío usa el primero activo')
async def generatekey(interaction: discord.Interaction, duration: str = '0', script_hash: str = ''):
    app, db, User, License, Script, HWIDBan, AccessLog, RolePermission, Warning, PriceConfig = models()
    with app.app_context():
        if not await require_manager(interaction, RolePermission): return
        script = Script.query.filter_by(hash_id=script_hash, active=True).first() if script_hash else Script.query.filter_by(active=True).first()
        if not script:
            await interaction.response.send_message('No hay un script activo disponible.', ephemeral=True); return
        expires = app_module_expiry(duration)
        key = new_key(License)
        lic = License(key=key, script_hash=script.hash_id, expires_at=expires, created_by=None)
        db.session.add(lic); db.session.commit()
        await interaction.response.send_message(f'✅ Key generada\n`{key}`\nScript: `{script.name}`\nExpira: `{expires.strftime("%Y-%m-%d") if expires else "Permanente"}`', ephemeral=True)


def app_module_expiry(duration):
    if duration == '0': return None
    try:
        amount, unit = int(duration[:-1]), duration[-1].lower()
        days = amount * (365 if unit == 'y' else 30 if unit == 'm' else 1)
        return dt.datetime.utcnow() + dt.timedelta(days=days)
    except (ValueError, IndexError):
        return dt.datetime.utcnow() + dt.timedelta(days=30)


@bot.tree.command(name='deletekey', description='Desactiva una key')
@app_commands.describe(key='Key de 32 caracteres')
async def deletekey(interaction: discord.Interaction, key: str):
    app, db, User, License, Script, HWIDBan, AccessLog, RolePermission, Warning, PriceConfig = models()
    with app.app_context():
        if not await require_manager(interaction, RolePermission): return
        lic = License.query.filter_by(key=key.strip()).first()
        if not lic:
            await interaction.response.send_message('Key no encontrada.', ephemeral=True); return
        lic.active = False; db.session.commit()
        await interaction.response.send_message(f'✅ Key `{key}` desactivada.', ephemeral=True)


@bot.tree.command(name='generatekeyrol', description='Configura un rol de gestión para keys y whitelist')
@app_commands.describe(role='Rol que podrá ejecutar comandos de gestión')
async def generatekeyrol(interaction: discord.Interaction, role: discord.Role):
    app, db, User, License, Script, HWIDBan, AccessLog, RolePermission, Warning, PriceConfig = models()
    with app.app_context():
        if not owner(interaction.user):
            await interaction.response.send_message('Solo el owner puede configurar roles.', ephemeral=True); return
        item = RolePermission.query.filter_by(role_id=str(role.id)).first()
        if not item:
            item = RolePermission(guild_id=str(interaction.guild_id), role_id=str(role.id), role_name=role.name, enabled=True); db.session.add(item)
        else: item.enabled = True; item.role_name = role.name
        db.session.commit()
        await interaction.response.send_message(f'✅ El rol {role.mention} ahora puede generar/eliminar keys y administrar whitelist.', ephemeral=True)


@bot.tree.command(name='ungeneratekeyrol', description='Quita permisos de gestión a un rol')
@app_commands.describe(role='Rol que dejará de gestionar keys')
async def ungeneratekeyrol(interaction: discord.Interaction, role: discord.Role):
    app, db, User, License, Script, HWIDBan, AccessLog, RolePermission, Warning, PriceConfig = models()
    with app.app_context():
        if not owner(interaction.user):
            await interaction.response.send_message('Solo el owner puede configurar roles.', ephemeral=True); return
        item = RolePermission.query.filter_by(role_id=str(role.id)).first()
        if item: item.enabled = False; db.session.commit()
        await interaction.response.send_message(f'✅ El rol {role.mention} ya no tiene permisos de gestión.', ephemeral=True)


@bot.tree.command(name='whitelist', description='Asocia una key a un usuario de Discord')
@app_commands.describe(user='Usuario autorizado', key='Key de 32 caracteres')
async def whitelist(interaction: discord.Interaction, user: discord.Member, key: str):
    app, db, User, License, Script, HWIDBan, AccessLog, RolePermission, Warning, PriceConfig = models()
    with app.app_context():
        if not await require_manager(interaction, RolePermission): return
        lic = License.query.filter_by(key=key.strip()).first()
        if not lic: await interaction.response.send_message('Key no encontrada.', ephemeral=True); return
        lic.discord_id = str(user.id); lic.hwid = None
        script=Script.query.filter_by(hash_id=lic.script_hash).first()
        creator=User.query.filter_by(id=script.owner_id).first() if script else None
        db.session.commit()
        if not creator or not creator.panel_guild_id or not creator.panel_channel_id or not creator.panel_message_id:
            await interaction.response.send_message(f'{user.mention} You have been whitelisted!\nConfigura primero `/panel` para publicar el panel.', ephemeral=True); return
        panel_url=f'https://discord.com/channels/{creator.panel_guild_id}/{creator.panel_channel_id}/{creator.panel_message_id}'
        await interaction.response.send_message(f'{user.mention} You have been whitelisted!\nYou can access the script via this message --> {panel_url}')


@bot.tree.command(name='unwhitelist', description='Quita la asociación de usuario de una key')
@app_commands.describe(key='Key de 32 caracteres')
async def unwhitelist(interaction: discord.Interaction, key: str):
    app, db, User, License, Script, HWIDBan, AccessLog, RolePermission, Warning, PriceConfig = models()
    with app.app_context():
        if not await require_manager(interaction, RolePermission): return
        lic = License.query.filter_by(key=key.strip()).first()
        if not lic: await interaction.response.send_message('Key no encontrada.', ephemeral=True); return
        lic.discord_id = None; lic.hwid = None; db.session.commit()
        await interaction.response.send_message(f'✅ Whitelist retirada de `{key}`.', ephemeral=True)


@bot.tree.command(name='dropkey', description='Publica un drop con cuenta regresiva y una key por mensaje')
@app_commands.describe(amount='Cantidad obligatoria de keys a dropear', duration='Duración de las keys', script_hash='ID opcional del script')
async def dropkey(interaction: discord.Interaction, amount: app_commands.Range[int, 1, 100], duration: str = '0', script_hash: str = ''):
    app, db, User, License, Script, HWIDBan, AccessLog, RolePermission, Warning, PriceConfig = models()
    with app.app_context():
        if not await require_manager(interaction, RolePermission): return
        script = Script.query.filter_by(hash_id=script_hash, active=True).first() if script_hash else Script.query.filter_by(active=True).first()
        if not script: await interaction.response.send_message('No hay un script activo.', ephemeral=True); return
        keys = []
        expires = app_module_expiry(duration)
        for _ in range(amount):
            value = new_key(License); keys.append(value); db.session.add(License(key=value, script_hash=script.hash_id, expires_at=expires))
        db.session.commit()
    await interaction.response.send_message('# Key drop!!\n@everyone', allowed_mentions=discord.AllowedMentions(everyone=True))
    for n in range(amount, 0, -1):
        await interaction.channel.send(str(n))
        await asyncio.sleep(1)
    await interaction.channel.send('# GO!!')
    for value in keys:
        await interaction.channel.send(f'`{value}`')


@bot.tree.command(name='hdwiban', description='Bloquea un HWID')
@app_commands.describe(hwid='HWID a bloquear', reason='Motivo')
async def hdwiban(interaction: discord.Interaction, hwid: str, reason: str = 'Bloqueado por el equipo'):
    app, db, User, License, Script, HWIDBan, AccessLog, RolePermission, Warning, PriceConfig = models()
    with app.app_context():
        if not await require_manager(interaction, RolePermission): return
        if not HWIDBan.query.filter_by(hwid=hwid).first(): db.session.add(HWIDBan(hwid=hwid, reason=reason, created_by=OWNER_ID)); db.session.commit()
        await interaction.response.send_message(f'✅ HWID `{hwid}` bloqueado.', ephemeral=True)


@bot.tree.command(name='unbanhdwi', description='Desbloquea un HWID')
@app_commands.describe(hwid='HWID a desbloquear')
async def unbanhdwi(interaction: discord.Interaction, hwid: str):
    app, db, User, License, Script, HWIDBan, AccessLog, RolePermission, Warning, PriceConfig = models()
    with app.app_context():
        if not await require_manager(interaction, RolePermission): return
        ban = HWIDBan.query.filter_by(hwid=hwid).first()
        if ban: db.session.delete(ban); db.session.commit()
        await interaction.response.send_message(f'✅ HWID `{hwid}` desbloqueado.', ephemeral=True)


@bot.tree.command(name='resethdwi', description='Resetea el HWID de una key')
@app_commands.describe(key='Key cuyo HWID se reseteará')
async def resethdwi(interaction: discord.Interaction, key: str):
    app, db, User, License, Script, HWIDBan, AccessLog, RolePermission, Warning, PriceConfig = models()
    with app.app_context():
        if not await require_manager(interaction, RolePermission): return
        lic = License.query.filter_by(key=key.strip()).first()
        if not lic: await interaction.response.send_message('Key no encontrada.', ephemeral=True); return
        lic.hwid = None; db.session.commit(); await interaction.response.send_message(f'✅ HWID reseteado para `{key}`.', ephemeral=True)


@bot.tree.command(name='warn', description='Registra una advertencia para un usuario')
@app_commands.describe(user='Usuario', reason='Motivo de la advertencia')
async def warn(interaction: discord.Interaction, user: discord.Member, reason: str):
    app, db, User, License, Script, HWIDBan, AccessLog, RolePermission, Warning, PriceConfig = models()
    with app.app_context():
        if not await require_manager(interaction, RolePermission): return
        db.session.add(Warning(discord_id=str(user.id), reason=reason, created_by=str(interaction.user.id))); db.session.commit()
        await interaction.response.send_message(f'⚠️ Advertencia registrada para {user.mention}: {reason}', ephemeral=True)


@bot.tree.command(name='prices', description='Publica los precios configurados desde la web')
async def prices(interaction: discord.Interaction):
    app, db, User, License, Script, HWIDBan, AccessLog, RolePermission, Warning, PriceConfig = models()
    with app.app_context():
        config = db.session.get(PriceConfig, 1) or PriceConfig(id=1)
        embed = discord.Embed(title=config.title, description=config.description, color=discord.Color.from_str(config.color or '#8b5cf6'))
        embed.add_field(name='Planes', value=config.body[:1024], inline=False); embed.set_footer(text='VantaProtect')
    await interaction.response.send_message(embed=embed)


class UserPanelView(discord.ui.View):
    def __init__(self):
        super().__init__(timeout=None)

    @discord.ui.button(label='Redeem Key', style=discord.ButtonStyle.primary, custom_id='vp_panel_redeem')
    async def redeem(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_modal(RedeemKeyModal())

    @discord.ui.button(label='Get Script', style=discord.ButtonStyle.success, custom_id='vp_panel_script')
    async def get_script(self, interaction: discord.Interaction, button: discord.ui.Button):
        app, db, User, License, Script, *_ = models()
        with app.app_context():
            licenses = License.query.filter_by(discord_id=str(interaction.user.id), active=True).all()
            rows=[]
            for lic in licenses:
                script=Script.query.filter_by(hash_id=lic.script_hash).first()
                if script and lic.is_valid():
                    rows.append(f"{script.name}: `script_key = \"{lic.key}\"`\n{DOMAIN}/scripts/hosted/{script.hash_id}.lua")
        if not rows:
            await interaction.response.send_message('No tienes una key whitelisteada activa.', ephemeral=True); return
        await interaction.response.send_message('\n\n'.join(rows), ephemeral=True)

    @discord.ui.button(label='Reset HWID', style=discord.ButtonStyle.secondary, custom_id='vp_panel_reset')
    async def reset_hwid(self, interaction: discord.Interaction, button: discord.ui.Button):
        app, db, User, License, Script, *_ = models()
        with app.app_context():
            changed=License.query.filter_by(discord_id=str(interaction.user.id)).update({'hwid': None})
            db.session.commit()
        await interaction.response.send_message(f'✅ HWID restablecido para {changed} key(s).', ephemeral=True)

    @discord.ui.button(label='Check Key', style=discord.ButtonStyle.secondary, custom_id='vp_panel_check')
    async def check_key(self, interaction: discord.Interaction, button: discord.ui.Button):
        app, db, User, License, Script, *_ = models()
        with app.app_context():
            licenses=License.query.filter_by(discord_id=str(interaction.user.id)).all()
            lines=[]
            for lic in licenses:
                script=Script.query.filter_by(hash_id=lic.script_hash).first()
                expiry=lic.expires_at.strftime('%Y-%m-%d') if lic.expires_at else 'Permanente'
                lines.append(f"{script.name if script else lic.script_hash} — {'Activa' if lic.is_valid() else 'Inactiva'} — HWID {'vinculado' if lic.hwid else 'sin vincular'} — Expira {expiry}")
        await interaction.response.send_message('\n'.join(lines) if lines else 'No tienes keys vinculadas.', ephemeral=True)

class RedeemKeyModal(discord.ui.Modal, title='Redeem Script Key'):
    key = discord.ui.TextInput(label='Key de script', placeholder='Pega tu key de 32 caracteres', required=True, max_length=64)
    async def on_submit(self, interaction: discord.Interaction):
        app, db, User, License, Script, *_ = models()
        with app.app_context():
            lic=License.query.filter_by(key=str(self.key).strip()).first()
            if not lic or not lic.is_valid():
                await interaction.response.send_message('Key inválida, expirada o desactivada.', ephemeral=True); return
            lic.discord_id=str(interaction.user.id); lic.hwid=None; db.session.commit()
            script=Script.query.filter_by(hash_id=lic.script_hash).first()
        await interaction.response.send_message(f'✅ Key vinculada a tu Discord para **{script.name if script else "el script"}**. Pulsa **Get Script**.', ephemeral=True)

@bot.tree.command(name='panel', description='Publica el panel del creador con sus scripts')
@app_commands.describe(channel='Canal donde se publicará el panel')
async def panel(interaction: discord.Interaction, channel: discord.TextChannel):
    app, db, User, License, Script, HWIDBan, AccessLog, RolePermission, Warning, PriceConfig = models()
    with app.app_context():
        if not await require_manager(interaction, RolePermission): return
        creator=User.query.filter_by(discord_id=str(interaction.user.id)).first()
        if not creator:
            await interaction.response.send_message('Primero inicia sesión en la web con Discord.', ephemeral=True); return
        scripts=Script.query.filter_by(owner_id=creator.id, active=True).order_by(Script.created_at.desc()).all()
        if not scripts:
            await interaction.response.send_message('No tienes scripts activos creados para mostrar.', ephemeral=True); return
        creator.panel_guild_id=str(interaction.guild_id or '')
        creator.panel_channel_id=str(channel.id)
        db.session.commit()
        names='\n'.join(f'• **{script.name}**' for script in scripts)
    embed=discord.Embed(title=creator.panel_title or 'VantaProtect', description=(creator.panel_description or 'Gestiona tus keys y scripts desde este panel.')+'\n\nScripts disponibles:\n'+names, color=discord.Color.blurple())
    embed.set_footer(text='VantaProtect · Panel de usuario')
    await interaction.response.defer(ephemeral=True)
    message=await channel.send(embed=embed, view=UserPanelView())
    with app.app_context():
        creator=User.query.filter_by(discord_id=str(interaction.user.id)).first()
        creator.panel_message_id=str(message.id); db.session.commit()
    await interaction.followup.send(f'✅ Panel publicado en {channel.mention}: {message.jump_url}', ephemeral=True)


@bot.event
async def on_ready():
    try:
        bot.add_view(UserPanelView())
        synced = await bot.tree.sync()
        logger.info('Bot conectado como %s; %s comandos sincronizados', bot.user, len(synced))
    except Exception:
        logger.exception('Error sincronizando comandos')


if __name__ == '__main__':
    bot.run(TOKEN)
