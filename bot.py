"""VantaProtect Discord bot: panel estilo Luarmor, licencias y moderación.

IMPORTANTE: guarda este archivo como UTF-8. Los emojis de este archivo son
reales; el `âœ…` que veías era un ✅ mal codificado.
"""
import datetime as dt
import logging
import os
import re
import secrets
import string
from types import SimpleNamespace
from typing import Optional

import discord
from discord import app_commands
from discord.ext import commands
from dotenv import load_dotenv

import plans
from loader_builder import build_public_loader

load_dotenv()

TOKEN = os.getenv("DISCORD_BOT_TOKEN") or os.getenv("DISCORD_TOKEN")
if not TOKEN:
    raise ValueError("DISCORD_BOT_TOKEN no está configurado")

OWNER_ID = int(os.getenv("ADMIN_DISCORD_ID", "1501316920975036611"))


def _domain() -> str:
    raw = (os.getenv("DOMINIO") or "https://vantaprotect-web-production.up.railway.app").strip().rstrip("/")
    return raw if raw.startswith("http") else "https://" + raw


DOMAIN = _domain()
HWID_RESET_COOLDOWN = dt.timedelta(hours=24)

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("VantaProtectBot")

intents = discord.Intents.default()
intents.members = True  # activar "Server Members Intent" en el Developer Portal
bot = commands.Bot(command_prefix="!", intents=intents, help_command=None)


# ============================================================
# Acceso a la app web (misma base de datos)
# ============================================================
def M():
    from app import (app, db, User, License, Script, HWIDBan, AccessLog,
                     RolePermission, Warning, PriceConfig, DiscordPanel)
    return locals()


def now() -> dt.datetime:
    return dt.datetime.utcnow()


def new_key(License) -> str:
    alphabet = string.ascii_letters + string.digits
    while True:
        value = "".join(secrets.choice(alphabet) for _ in range(32))
        if not License.query.filter_by(key=value).first():
            return value


def expiry(days: int):
    return None if not days or days < 1 else now() + dt.timedelta(days=days)


def hash_from_loader(text: str) -> Optional[str]:
    m = re.search(r"/hosted/([A-Za-z0-9_-]{8,64})\.lua", text or "")
    return m.group(1) if m else None


def is_owner(user) -> bool:
    return int(user.id) == OWNER_ID


def guild_owner(i: discord.Interaction) -> bool:
    return bool(i.guild and i.guild.owner_id == i.user.id)


def guild_admin(i: discord.Interaction) -> bool:
    perms = getattr(i.user, "guild_permissions", None)
    return bool(perms and perms.administrator)


def can_configure(i: discord.Interaction) -> bool:
    return is_owner(i.user) or guild_owner(i) or guild_admin(i)


def allowed(i: discord.Interaction, RP) -> bool:
    if can_configure(i):
        return True
    roles = {str(r.id) for r in getattr(i.user, "roles", [])}
    return RP.query.filter(
        RP.guild_id == str(i.guild_id), RP.role_id.in_(roles), RP.enabled.is_(True)
    ).first() is not None


async def manager(i: discord.Interaction, RP) -> bool:
    if allowed(i, RP):
        return True
    await i.response.send_message(
        "You don't have permission to manage this panel.\n"
        "You need the manager role that was set with `/setpanel`.",
        ephemeral=True,
    )
    return False


def get_panel(m, guild_id) -> Optional[SimpleNamespace]:
    """Copia simple del panel (segura de usar fuera del app_context)."""
    p = m["DiscordPanel"].query.filter_by(guild_id=str(guild_id)).first()
    if not p:
        return None
    return SimpleNamespace(
        guild_id=p.guild_id, channel_id=p.channel_id, message_id=p.message_id,
        project_name=p.project_name, loader_script=p.loader_script,
        manager_role_id=p.manager_role_id, buyer_role_id=p.buyer_role_id,
        logs_channel_id=p.logs_channel_id, script_hash=hash_from_loader(p.loader_script),
    )


async def require_project(i: discord.Interaction, m):
    """Devuelve (panel, script, dueño) o responde con el error y devuelve None."""
    if not i.guild:
        await i.response.send_message("This command can only be used in a server.", ephemeral=True)
        return None
    p = get_panel(m, i.guild_id)
    script = None
    if p and p.script_hash:
        script = m["Script"].query.filter_by(hash_id=p.script_hash, active=True).first()
    if not script:
        await i.response.send_message(
            "No script is linked to this server. Run `/link` with your script API key first.",
            ephemeral=True,
        )
        return None
    owner = m["db"].session.get(m["User"], script.owner_id)
    return p, script, owner


async def audit(i: discord.Interaction, p, text: str) -> None:
    if p and p.logs_channel_id and i.guild:
        channel = i.guild.get_channel(int(p.logs_channel_id))
        if channel:
            try:
                await channel.send(text)
            except discord.HTTPException:
                pass


def panel_url(p) -> str:
    return f"https://discord.com/channels/{p.guild_id}/{p.channel_id}/{p.message_id}"


def loader_for(p, key: str) -> str:
    return build_public_loader(DOMAIN, p.script_hash, key)


STATUS_TEXT = {
    "inactive": "Key is inactive",
    "expired": "Key expired",
    "max_uses": "Usage limit reached",
}


# ============================================================
# Panel de usuario (botones)
# ============================================================
class Redeem(discord.ui.Modal, title="Redeem Key"):
    value = discord.ui.TextInput(
        label="Key", placeholder="32-character script key", min_length=32, max_length=64
    )

    async def on_submit(self, i: discord.Interaction):
        m = M()
        with m["app"].app_context():
            p = get_panel(m, i.guild_id)
            if not p or not p.script_hash:
                await i.response.send_message("This server has no panel configured.", ephemeral=True)
                return
            lic = m["License"].query.filter_by(key=str(self.value).strip()).first()
            if not lic or lic.script_hash != p.script_hash:
                await i.response.send_message("Invalid key for this project.", ephemeral=True)
                return
            status = lic.status()
            if status == "blacklisted":
                await i.response.send_message(
                    f"This key is blacklisted. Reason: {lic.blacklist_reason or 'Blocked by manager'}",
                    ephemeral=True)
                return
            if status != "ok":
                await i.response.send_message(f"{STATUS_TEXT.get(status, 'Key not valid')}.", ephemeral=True)
                return
            if lic.discord_id and lic.discord_id != str(i.user.id):
                await i.response.send_message(
                    "This key was already redeemed by another user.", ephemeral=True)
                return
            if not lic.discord_id:
                lic.discord_id = str(i.user.id)
                lic.hwid = None
                m["db"].session.commit()
            buyer_role = p.buyer_role_id

        if buyer_role and i.guild:
            role = i.guild.get_role(int(buyer_role))
            if role:
                try:
                    await i.user.add_roles(role, reason="VantaProtect key redemption")
                except discord.Forbidden:
                    pass
        await i.response.send_message(
            "✅ Key redeemed. Press **Get Script** to receive your loader.", ephemeral=True)


class Panel(discord.ui.View):
    def __init__(self):
        super().__init__(timeout=None)

    async def _panel(self, i: discord.Interaction, m):
        p = get_panel(m, i.guild_id) if i.guild_id else None
        if not p or not p.script_hash:
            await i.response.send_message("This server has no panel configured.", ephemeral=True)
            return None
        return p

    @discord.ui.button(label="🔑 Redeem Key", style=discord.ButtonStyle.success, custom_id="vp:redeem")
    async def redeem(self, i: discord.Interaction, b: discord.ui.Button):
        m = M()
        with m["app"].app_context():
            p = await self._panel(i, m)
        if p:
            await i.response.send_modal(Redeem())

    @discord.ui.button(label="📜 Get Script", style=discord.ButtonStyle.primary, custom_id="vp:script")
    async def script(self, i: discord.Interaction, b: discord.ui.Button):
        m = M()
        with m["app"].app_context():
            p = await self._panel(i, m)
            if not p:
                return
            mine = m["License"].query.filter_by(
                discord_id=str(i.user.id), script_hash=p.script_hash).all()
            valid = [l for l in mine if l.status() == "ok"]
            if not valid:
                blocked = next((l for l in mine if l.status() == "blacklisted"), None)
                if blocked:
                    text = f"You are blacklisted. Reason: {blocked.blacklist_reason or 'Blocked by manager'}"
                else:
                    text = "You do not have a valid key for this project."
                await i.response.send_message(text, ephemeral=True)
                return
            script = m["Script"].query.filter_by(hash_id=p.script_hash).first()
            name = script.name if script else "Script"
            out = "\n\n".join(
                f"**{name}**\n```lua\n{loader_for(p, l.key)}\n```" for l in valid)
        await i.response.send_message(out[:1900], ephemeral=True)

    @discord.ui.button(label="👤 Get Role", style=discord.ButtonStyle.primary, custom_id="vp:role")
    async def role(self, i: discord.Interaction, b: discord.ui.Button):
        m = M()
        with m["app"].app_context():
            p = await self._panel(i, m)
            if not p:
                return
            has_key = any(
                l.status() == "ok" for l in m["License"].query.filter_by(
                    discord_id=str(i.user.id), script_hash=p.script_hash).all())
            buyer_role = p.buyer_role_id
        if not buyer_role:
            await i.response.send_message("No buyer role is configured.", ephemeral=True)
            return
        if not has_key:
            await i.response.send_message(
                "You need a valid key for this project to get the buyer role.", ephemeral=True)
            return
        role = i.guild.get_role(int(buyer_role))
        try:
            await i.user.add_roles(role, reason="VantaProtect buyer panel")
            await i.response.send_message("✅ Buyer role assigned.", ephemeral=True)
        except (discord.Forbidden, AttributeError):
            await i.response.send_message(
                "The bot cannot assign that role. Move the bot role above the buyer role.",
                ephemeral=True)

    @discord.ui.button(label="⚙️ Reset HWID", style=discord.ButtonStyle.secondary, custom_id="vp:reset")
    async def reset(self, i: discord.Interaction, b: discord.ui.Button):
        m = M()
        with m["app"].app_context():
            p = await self._panel(i, m)
            if not p:
                return
            mine = m["License"].query.filter_by(
                discord_id=str(i.user.id), script_hash=p.script_hash, active=True).all()
            done, waiting = 0, None
            for lic in mine:
                if lic.status() != "ok":
                    continue
                last = lic.last_hwid_reset
                if last and now() - last < HWID_RESET_COOLDOWN:
                    waiting = HWID_RESET_COOLDOWN - (now() - last)
                    continue
                lic.hwid = None
                lic.last_hwid_reset = now()
                done += 1
            m["db"].session.commit()
        if done:
            await i.response.send_message(f"✅ Reset HWID for {done} key(s).", ephemeral=True)
        elif waiting:
            hours = int(waiting.total_seconds() // 3600) + 1
            await i.response.send_message(
                f"You can reset your HWID again in about {hours}h.", ephemeral=True)
        else:
            await i.response.send_message("You have no valid keys to reset.", ephemeral=True)

    @discord.ui.button(label="📊 Get Stats", style=discord.ButtonStyle.secondary, custom_id="vp:stats")
    async def stats(self, i: discord.Interaction, b: discord.ui.Button):
        m = M()
        with m["app"].app_context():
            p = await self._panel(i, m)
            if not p:
                return
            mine = m["License"].query.filter_by(
                discord_id=str(i.user.id), script_hash=p.script_hash).all()
            lines = []
            for lic in mine:
                status = lic.status()
                exp = lic.expires_at.strftime("%Y-%m-%d") if lic.expires_at else "Never"
                if status == "blacklisted":
                    until = (f" until {lic.blacklist_until:%Y-%m-%d}" if lic.blacklist_until else "")
                    lines.append(
                        f"⛔ **Blacklisted**{until}\nReason: {lic.blacklist_reason or 'Blocked by manager'}")
                    continue
                lines.append(
                    f"{'🟢 Active' if status == 'ok' else '🔴 ' + STATUS_TEXT.get(status, 'Inactive')}"
                    f" | HWID {'linked' if lic.hwid else 'not linked'}"
                    f" | Expires: {exp} | Executions: {lic.used_count}")
        await i.response.send_message("\n\n".join(lines) if lines else "No linked keys.", ephemeral=True)


# ============================================================
# /link  (solo la API key del script)
# ============================================================
@bot.tree.command(name="link", description="Link your script to this server using its API key")
@app_commands.describe(api_key="The API key of your script (from the VantaProtect website)")
async def link(i: discord.Interaction, api_key: str):
    if not i.guild:
        await i.response.send_message("This command can only be used in a server.", ephemeral=True)
        return
    if not can_configure(i):
        await i.response.send_message(
            "Only the server owner or an administrator can link a script.", ephemeral=True)
        return

    m = M()
    with m["app"].app_context():
        script = m["Script"].query.filter_by(api_key=api_key.strip()).first()
        if not script:
            await i.response.send_message(
                "Invalid API key. Copy it from your script page on the website.", ephemeral=True)
            return
        if not script.active:
            await i.response.send_message("That script is disabled.", ephemeral=True)
            return
        # Una API key solo puede vincularse a UN servidor. Si se filtra, no sirve en otro.
        if script.linked_guild_id and script.linked_guild_id != str(i.guild_id):
            await i.response.send_message(
                "❌ This API key is already linked to another server.\n"
                "If it leaked, regenerate the key on the website and try again.",
                ephemeral=True)
            return
        if script.linked_guild_id == str(i.guild_id):
            await i.response.send_message(
                f"This script (**{script.name}**) is already linked to this server.", ephemeral=True)
            return

        owner = m["db"].session.get(m["User"], script.owner_id)
        loader_url = f"{DOMAIN}/scripts/hosted/{script.hash_id}.lua"

        # Si el servidor ya tenía otro script vinculado, se libera.
        panel = m["DiscordPanel"].query.filter_by(guild_id=str(i.guild_id)).first()
        if panel:
            old_hash = hash_from_loader(panel.loader_script)
            if old_hash and old_hash != script.hash_id:
                old = m["Script"].query.filter_by(hash_id=old_hash).first()
                if old and old.linked_guild_id == str(i.guild_id):
                    old.linked_guild_id = None
                    old.linked_at = None
            panel.channel_id = str(i.channel_id)
            panel.loader_script = loader_url
            panel.project_name = script.name
            panel.description = script.description or "Protected script control panel."
            panel.message_id = None
        else:
            panel = m["DiscordPanel"](
                guild_id=str(i.guild_id), channel_id=str(i.channel_id),
                created_by=owner.discord_id if owner else str(i.user.id),
                loader_script=loader_url, manager_role_id="0",
                project_name=script.name,
                description=script.description or "Protected script control panel.")
            m["db"].session.add(panel)

        script.linked_guild_id = str(i.guild_id)
        script.linked_at = now()
        m["db"].session.commit()
        name = script.name

    await i.response.send_message(
        f"✅ Script **{name}** linked to this server.\n"
        "Now run `/setpanel` to choose the manager role and create the panel.",
        ephemeral=True)


# ============================================================
# Configuración del panel
# ============================================================
@bot.tree.command(name="setpanel", description="Create the user panel in this channel")
@app_commands.describe(manager_role="Role allowed to manage the panel", buyer_role="Optional buyer role")
async def setpanel(i: discord.Interaction, manager_role: discord.Role,
                   buyer_role: Optional[discord.Role] = None):
    if not i.guild:
        await i.response.send_message("This command can only be used in a server.", ephemeral=True)
        return
    if not can_configure(i):
        await i.response.send_message(
            "Only the server owner or an administrator can configure the panel.", ephemeral=True)
        return

    m = M()
    with m["app"].app_context():
        panel = m["DiscordPanel"].query.filter_by(guild_id=str(i.guild_id)).first()
        h = hash_from_loader(panel.loader_script) if panel else None
        script = m["Script"].query.filter_by(hash_id=h, active=True).first() if h else None
        if not script:
            await i.response.send_message(
                "Link your script first with `/link api_key:...`", ephemeral=True)
            return
        owner = m["db"].session.get(m["User"], script.owner_id)

        panel.channel_id = str(i.channel_id)
        panel.manager_role_id = str(manager_role.id)
        panel.buyer_role_id = str(buyer_role.id) if buyer_role else None
        panel.project_name = script.name
        panel.description = script.description or "Protected script control panel."

        m["RolePermission"].query.filter_by(guild_id=str(i.guild_id)).delete()
        m["db"].session.add(m["RolePermission"](
            guild_id=str(i.guild_id), role_id=str(manager_role.id),
            role_name=manager_role.name, enabled=True))
        m["db"].session.commit()

        project = script.name
        author_name = owner.username if owner else i.user.display_name
        author_avatar = owner.avatar if owner and owner.avatar else i.user.display_avatar.url

    embed = discord.Embed(
        title=project,
        description=(f"This control panel is for the project: **{project}**\n\n"
                     "If you're a buyer, click on the buttons below to redeem your key, "
                     "get the script or get your role."),
        color=discord.Color.blurple())
    embed.set_author(name=author_name, icon_url=author_avatar)
    embed.set_footer(text=f"Sent by {author_name} • VantaProtect")

    await i.response.defer(ephemeral=True)
    msg = await i.channel.send(embed=embed, view=Panel())
    with m["app"].app_context():
        p = m["DiscordPanel"].query.filter_by(guild_id=str(i.guild_id)).first()
        p.message_id = str(msg.id)
        m["db"].session.commit()
    await i.followup.send(f"✅ Panel created: {msg.jump_url}", ephemeral=True)


@bot.tree.command(name="generatekeyrol", description="Set the manager role for this server panel")
@app_commands.describe(role="Manager role")
async def generatekeyrol(i: discord.Interaction, role: discord.Role):
    if not can_configure(i):
        await i.response.send_message(
            "Only the server owner or an administrator can set the manager role.", ephemeral=True)
        return
    m = M()
    with m["app"].app_context():
        old = m["RolePermission"].query.filter_by(guild_id=str(i.guild_id)).first()
        if old:
            old.role_id, old.role_name, old.enabled = str(role.id), role.name, True
        else:
            m["db"].session.add(m["RolePermission"](
                guild_id=str(i.guild_id), role_id=str(role.id), role_name=role.name, enabled=True))
        panel = m["DiscordPanel"].query.filter_by(guild_id=str(i.guild_id)).first()
        if panel:
            panel.manager_role_id = str(role.id)
        m["db"].session.commit()
    # Público: todos ven quién es el manager.
    await i.response.send_message(f"✅ Manager role set to {role.mention}.")


@bot.tree.command(name="ungeneratekeyrol", description="Remove the manager role")
async def ungeneratekeyrol(i: discord.Interaction):
    if not can_configure(i):
        await i.response.send_message(
            "Only the server owner or an administrator can remove the manager role.", ephemeral=True)
        return
    m = M()
    with m["app"].app_context():
        m["RolePermission"].query.filter_by(guild_id=str(i.guild_id)).update({"enabled": False})
        m["db"].session.commit()
    await i.response.send_message("✅ Manager role disabled.")


@bot.tree.command(name="setlogs", description="Select a channel for bot audit messages")
@app_commands.describe(channel="Log channel")
async def setlogs(i: discord.Interaction, channel: discord.TextChannel):
    m = M()
    with m["app"].app_context():
        if not await manager(i, m["RolePermission"]):
            return
        panel = m["DiscordPanel"].query.filter_by(guild_id=str(i.guild_id)).first()
        if not panel:
            await i.response.send_message("Link your script first with `/link`.", ephemeral=True)
            return
        panel.logs_channel_id = str(channel.id)
        m["db"].session.commit()
    await i.response.send_message(f"✅ Audit log channel saved: {channel.mention}", ephemeral=True)


# ============================================================
# Whitelist / keys
# ============================================================
def _reset_blacklist(lic) -> None:
    lic.blacklisted = False
    lic.blacklist_reason = None
    lic.blacklist_until = None


@bot.tree.command(name="whitelist", description="Whitelist a user for the panel project")
@app_commands.describe(user="User to whitelist", days="Days; 0 means indefinite")
async def whitelist(i: discord.Interaction, user: discord.Member, days: int = 0):
    m = M()
    with m["app"].app_context():
        if not await manager(i, m["RolePermission"]):
            return
        ctx = await require_project(i, m)
        if not ctx:
            return
        p, script, owner = ctx
        License = m["License"]
        lic = License.query.filter_by(discord_id=str(user.id), script_hash=script.hash_id).first()
        if not lic:
            ok, msg = plans.check(owner, "keys")
            if not ok:
                await i.response.send_message(msg, ephemeral=True)
                return
            lic = License(key=new_key(License), script_hash=script.hash_id, created_by=owner.id)
            plans.consume(owner, "keys")
            m["db"].session.add(lic)
        lic.discord_id = str(user.id)
        lic.active = True
        lic.hwid = None
        lic.expires_at = expiry(days)
        _reset_blacklist(lic)
        m["db"].session.commit()
        url = panel_url(p) if p.message_id else f"<#{p.channel_id}>"
        buyer_role = p.buyer_role_id

    await i.response.send_message(
        f"{user.mention} You have been whitelisted!\nYou can access the script via this message --> {url}")
    if buyer_role:
        role = i.guild.get_role(int(buyer_role))
        if role:
            try:
                await user.add_roles(role, reason="VantaProtect whitelist")
            except discord.Forbidden:
                pass
    await audit(i, p, f"✅ {i.user.mention} whitelisted {user.mention} ({days or 'indefinite'} days)")


@bot.tree.command(name="unwhitelist", description="Remove a user license")
@app_commands.describe(user="User")
async def unwhitelist(i: discord.Interaction, user: discord.Member):
    m = M()
    with m["app"].app_context():
        if not await manager(i, m["RolePermission"]):
            return
        ctx = await require_project(i, m)
        if not ctx:
            return
        p, script, _ = ctx
        n = m["License"].query.filter_by(
            discord_id=str(user.id), script_hash=script.hash_id
        ).update({"active": False, "discord_id": None, "hwid": None})
        m["db"].session.commit()
    await i.response.send_message(f"{user.mention} has been unwhitelisted.\n✅ Removed {n} license(s).")
    await audit(i, p, f"🗑️ {i.user.mention} unwhitelisted {user.mention}")


@bot.tree.command(name="mass-whitelist", description="Whitelist every member of a role")
@app_commands.describe(role="Buyer role", days="Days; 0 means indefinite")
async def mass_whitelist(i: discord.Interaction, role: discord.Role, days: int = 0):
    m = M()
    with m["app"].app_context():
        if not await manager(i, m["RolePermission"]):
            return
        ctx = await require_project(i, m)
        if not ctx:
            return
        p, script, owner = ctx
        License = m["License"]
        members = [x for x in role.members if not x.bot]
        existing = {
            l.discord_id: l for l in License.query.filter(
                License.script_hash == script.hash_id,
                License.discord_id.in_([str(x.id) for x in members])).all()
        }
        missing = [x for x in members if str(x.id) not in existing]
        ok, msg = plans.check(owner, "keys", len(missing))
        if not ok:
            await i.response.send_message(
                f"{msg}\nThis needs {len(missing)} new keys.", ephemeral=True)
            return
        for member in members:
            lic = existing.get(str(member.id))
            if not lic:
                lic = License(key=new_key(License), script_hash=script.hash_id, created_by=owner.id)
                m["db"].session.add(lic)
                plans.consume(owner, "keys")
            lic.discord_id = str(member.id)
            lic.active = True
            lic.expires_at = expiry(days)
            _reset_blacklist(lic)
        m["db"].session.commit()
        total = len(members)
    await i.response.send_message(f"✅ Mass whitelist complete. Total successful: {total}.", ephemeral=True)


@bot.tree.command(name="generatekey", description="Generate a 32-character script key")
@app_commands.describe(days="Days; 0 means indefinite", user="Optional bound user")
async def generatekey(i: discord.Interaction, days: int = 0, user: Optional[discord.Member] = None):
    m = M()
    with m["app"].app_context():
        if not await manager(i, m["RolePermission"]):
            return
        ctx = await require_project(i, m)
        if not ctx:
            return
        p, script, owner = ctx
        ok, msg = plans.check(owner, "keys")
        if not ok:
            await i.response.send_message(msg, ephemeral=True)
            return
        License = m["License"]
        lic = License(key=new_key(License), script_hash=script.hash_id,
                      discord_id=str(user.id) if user else None,
                      expires_at=expiry(days), created_by=owner.id)
        plans.consume(owner, "keys")
        m["db"].session.add(lic)
        m["db"].session.commit()
        value, name = lic.key, script.name
    await i.response.send_message(
        f"✅ Key generated for **{name}**\n`{value}`\nDays: `{days or 'indefinite'}`", ephemeral=True)
    await audit(i, p, f"🔑 {i.user.mention} generated a key ({days or 'indefinite'} days)")


@bot.tree.command(name="dropkey", description="Drop keys with countdown")
@app_commands.describe(amount="Number of keys", days="Days; 0 means indefinite")
async def dropkey(i: discord.Interaction, amount: app_commands.Range[int, 1, 100], days: int = 0):
    m = M()
    with m["app"].app_context():
        if not await manager(i, m["RolePermission"]):
            return
        ctx = await require_project(i, m)
        if not ctx:
            return
        p, script, owner = ctx
        ok, msg = plans.check(owner, "keys", amount)
        if not ok:
            await i.response.send_message(msg, ephemeral=True)
            return
        License = m["License"]
        values = []
        for _ in range(amount):
            lic = License(key=new_key(License), script_hash=script.hash_id,
                          expires_at=expiry(days), created_by=owner.id)
            m["db"].session.add(lic)
            m["db"].session.flush()
            values.append(lic.key)
        plans.consume(owner, "keys", amount)
        m["db"].session.commit()

    await i.response.send_message(
        "# Key drop!!\n@everyone", allowed_mentions=discord.AllowedMentions(everyone=True))
    for n in range(min(amount, 5), 0, -1):
        await i.channel.send(str(n))
    await i.channel.send("# GO!!")
    for value in values:
        await i.channel.send(f"`{value}`")


@bot.tree.command(name="deletekey", description="Revoke a key")
@app_commands.describe(key="Script key")
async def deletekey(i: discord.Interaction, key: str):
    m = M()
    with m["app"].app_context():
        if not await manager(i, m["RolePermission"]):
            return
        ctx = await require_project(i, m)
        if not ctx:
            return
        p, script, _ = ctx
        lic = m["License"].query.filter_by(key=key.strip(), script_hash=script.hash_id).first()
        if not lic:
            await i.response.send_message("Key not found in this project.", ephemeral=True)
            return
        lic.active = False
        m["db"].session.commit()
    await i.response.send_message("✅ Key revoked.", ephemeral=True)
    await audit(i, p, f"🗑️ {i.user.mention} revoked a key")


@bot.tree.command(name="resethwid", description="Reset HWID for a key")
@app_commands.describe(key="Script key")
async def resethwid(i: discord.Interaction, key: str):
    m = M()
    with m["app"].app_context():
        if not await manager(i, m["RolePermission"]):
            return
        ctx = await require_project(i, m)
        if not ctx:
            return
        _, script, _ = ctx
        lic = m["License"].query.filter_by(key=key.strip(), script_hash=script.hash_id).first()
        if not lic:
            await i.response.send_message("Key not found in this project.", ephemeral=True)
            return
        lic.hwid = None
        m["db"].session.commit()
    await i.response.send_message("✅ HWID reset.", ephemeral=True)


@bot.tree.command(name="force-resethwid", description="Force reset a user HWID (ignores cooldown)")
@app_commands.describe(user="User")
async def force_resethwid(i: discord.Interaction, user: discord.Member):
    m = M()
    with m["app"].app_context():
        if not await manager(i, m["RolePermission"]):
            return
        ctx = await require_project(i, m)
        if not ctx:
            return
        _, script, _ = ctx
        n = m["License"].query.filter_by(
            discord_id=str(user.id), script_hash=script.hash_id
        ).update({"hwid": None, "last_hwid_reset": None})
        m["db"].session.commit()
    await i.response.send_message(f"✅ Force-reset {n} HWID(s).", ephemeral=True)


@bot.tree.command(name="compensate", description="Add days to all licenses in this project")
@app_commands.describe(days="Days to add")
async def compensate(i: discord.Interaction, days: int):
    m = M()
    with m["app"].app_context():
        if not await manager(i, m["RolePermission"]):
            return
        ctx = await require_project(i, m)
        if not ctx:
            return
        _, script, _ = ctx
        licenses = m["License"].query.filter_by(script_hash=script.hash_id, active=True).all()
        touched = 0
        for lic in licenses:
            if lic.expires_at is None:  # las keys de por vida siguen siendo de por vida
                continue
            base = lic.expires_at if lic.expires_at > now() else now()
            lic.expires_at = base + dt.timedelta(days=days)
            touched += 1
        m["db"].session.commit()
    await i.response.send_message(f"✅ Compensated {touched} license(s) by {days} day(s).", ephemeral=True)


# ============================================================
# Blacklist / HWID ban / warn
# ============================================================
@bot.tree.command(name="blacklist", description="Blacklist a user from this project")
@app_commands.describe(user="User", reason="Reason", days="Days; 0 means indefinite")
async def blacklist(i: discord.Interaction, user: discord.Member,
                    reason: str = "Blocked by manager", days: int = 0):
    m = M()
    with m["app"].app_context():
        if not await manager(i, m["RolePermission"]):
            return
        ctx = await require_project(i, m)
        if not ctx:
            return
        p, script, _ = ctx
        n = m["License"].query.filter_by(
            discord_id=str(user.id), script_hash=script.hash_id
        ).update({
            "blacklisted": True,
            "blacklist_reason": reason[:255],
            "blacklist_until": expiry(days),
        })
        m["db"].session.commit()
        if n == 0:
            await i.response.send_message(
                f"{user.mention} has no keys in this project.", ephemeral=True)
            return

    # Mensaje público con el canal donde está el panel, no una URL de la web.
    await i.response.send_message(
        f"{user.mention} You have been blacklisted! :no_entry:\n\n"
        f"To find out why, go to <#{p.channel_id}> and click on **Stats** button\n\n"
        f"Reason: {reason}")
    await audit(i, p, f"⛔ {i.user.mention} blacklisted {user.mention}: {reason}")


@bot.tree.command(name="unblacklist", description="Remove a user from the blacklist")
@app_commands.describe(user="User")
async def unblacklist(i: discord.Interaction, user: discord.Member):
    m = M()
    with m["app"].app_context():
        if not await manager(i, m["RolePermission"]):
            return
        ctx = await require_project(i, m)
        if not ctx:
            return
        p, script, _ = ctx
        n = m["License"].query.filter_by(
            discord_id=str(user.id), script_hash=script.hash_id
        ).update({"blacklisted": False, "blacklist_reason": None, "blacklist_until": None})
        m["db"].session.commit()
    await i.response.send_message(f"✅ {user.mention} removed from the blacklist ({n} key(s)).")
    await audit(i, p, f"✅ {i.user.mention} unblacklisted {user.mention}")


@bot.tree.command(name="hwidban", description="Ban a HWID")
@app_commands.describe(hwid="HWID", reason="Reason")
async def hwidban(i: discord.Interaction, hwid: str, reason: str = "Blocked by manager"):
    m = M()
    with m["app"].app_context():
        if not await manager(i, m["RolePermission"]):
            return
        if not m["HWIDBan"].query.filter_by(hwid=hwid).first():
            m["db"].session.add(m["HWIDBan"](hwid=hwid, reason=reason, created_by=None))
            m["db"].session.commit()
    await i.response.send_message(f"⛔ HWID blacklisted.\nHWID: `{hwid}`\nReason: {reason}")


@bot.tree.command(name="unbanhwid", description="Unban a HWID")
@app_commands.describe(hwid="HWID")
async def unbanhwid(i: discord.Interaction, hwid: str):
    m = M()
    with m["app"].app_context():
        if not await manager(i, m["RolePermission"]):
            return
        ban = m["HWIDBan"].query.filter_by(hwid=hwid).first()
        if ban:
            m["db"].session.delete(ban)
            m["db"].session.commit()
    await i.response.send_message(f"✅ HWID removed from the blacklist.\nHWID: `{hwid}`")


@bot.tree.command(name="warn", description="Warn a user")
@app_commands.describe(user="User", reason="Reason")
async def warn(i: discord.Interaction, user: discord.Member, reason: str):
    m = M()
    with m["app"].app_context():
        if not await manager(i, m["RolePermission"]):
            return
        m["db"].session.add(m["Warning"](
            discord_id=str(user.id), reason=reason, created_by=str(i.user.id)))
        m["db"].session.commit()
    await i.response.send_message(f"⚠️ {user.mention} has been warned.\nReason: {reason}")


@bot.tree.command(name="prices", description="Publish configured prices")
async def prices(i: discord.Interaction):
    m = M()
    with m["app"].app_context():
        cfg = m["db"].session.get(m["PriceConfig"], 1)
        if not cfg:
            await i.response.send_message("No prices configured.", ephemeral=True)
            return
        title, description, body = cfg.title, cfg.description, cfg.body
        color = cfg.color or "#5865f2"
    embed = discord.Embed(title=title, description=description, color=discord.Color.from_str(color))
    embed.add_field(name="Pricing", value=body[:1024], inline=False)
    await i.response.send_message(embed=embed)


@bot.event
async def on_ready():
    if not getattr(bot, "_vp_ready", False):
        bot._vp_ready = True
        bot.add_view(Panel())
        synced = await bot.tree.sync()
        log.info("Connected as %s; synchronized %d commands", bot.user, len(synced))


if __name__ == "__main__":
    bot.run(TOKEN)
