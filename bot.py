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
        lic.discord_id = str(user.id); lic.hwid = None; db.session.commit()
        await interaction.response.send_message(f'✅ {user.mention} fue whitelisted para `{key}`.', ephemeral=True)


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


@bot.tree.command(name='panel', description='Muestra el panel web de VantaProtect')
async def panel(interaction: discord.Interaction):
    await interaction.response.send_message(f'🛡️ Panel VantaProtect: {DOMAIN}/dashboard', ephemeral=True)


@bot.event
async def on_ready():
    try:
        synced = await bot.tree.sync()
        logger.info('Bot conectado como %s; %s comandos sincronizados', bot.user, len(synced))
    except Exception:
        logger.exception('Error sincronizando comandos')


if __name__ == '__main__':
    bot.run(TOKEN)
