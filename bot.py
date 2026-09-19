"""VantaProtect Discord control plane: Luarmor-style panel and licensing."""
import datetime as dt
import logging
import os
import re
import secrets
import string
from typing import Optional
import discord
from discord import app_commands
from discord.ext import commands
from dotenv import load_dotenv
load_dotenv()
TOKEN=os.getenv('DISCORD_BOT_TOKEN') or os.getenv('DISCORD_TOKEN')
if not TOKEN: raise ValueError('DISCORD_BOT_TOKEN no estÃ¡ configurado')
OWNER_ID=int(os.getenv('ADMIN_DISCORD_ID','1501316920975036611'))
DOMAIN=os.getenv('DOMINIO','https://vantaprotect.up.railway.app').rstrip('/')
logging.basicConfig(level=logging.INFO); log=logging.getLogger('VantaProtectBot')
intents=discord.Intents.default(); intents.members=True
bot=commands.Bot(command_prefix='!', intents=intents, help_command=None)

def M():
    from app import app,db,User,License,Script,HWIDBan,AccessLog,RolePermission,Warning,PriceConfig,DiscordPanel
    return locals()
def key(License):
    a=string.ascii_letters+string.digits; v=''.join(secrets.choice(a) for _ in range(32))
    while License.query.filter_by(key=v).first(): v=''.join(secrets.choice(a) for _ in range(32))
    return v
def exp(days): return None if not days or days<1 else dt.datetime.utcnow()+dt.timedelta(days=days)
def is_owner(u): return int(u.id)==OWNER_ID
def guild_owner(i): return bool(i.guild and i.guild.owner_id==i.user.id)
def allowed(i,RP):
    if is_owner(i.user) or guild_owner(i): return True
    roles={str(x.id) for x in getattr(i.user,'roles',[])}
    return RP.query.filter(RP.guild_id==str(i.guild_id),RP.role_id.in_(roles),RP.enabled.is_(True)).first() is not None
async def manager(i,RP):
    if allowed(i,RP): return True
    await i.response.send_message("You don't have permission to manage any panels.\nYou must have the manager role to use this command. *(you specified what role it is while running /setpanel)*",ephemeral=True); return False
def panel(i,DP): return DP.query.filter_by(guild_id=str(i.guild_id)).first()
def hash_from_loader(s):
    m=re.search(r'/hosted/([A-Za-z0-9_-]{8,64})\.lua',s or ''); return m.group(1) if m else None
def loader(p,k):
    s=p.loader_script.strip()
    if '{{KEY}}' in s: return s.replace('{{KEY}}',k)
    if 'script_key' in s: return s
    return f'script_key = "{k}"\n\nloadstring(game:HttpGet("{s}"))()'

class Redeem(discord.ui.Modal,title='Redeem Key'):
    value=discord.ui.TextInput(label='Key',placeholder='32-character script key',min_length=32,max_length=64)
    async def on_submit(self,i):
        m=M()
        with m['app'].app_context():
            p=panel(i,m['DiscordPanel']); l=m['License'].query.filter_by(key=str(self.value).strip()).first(); expected=hash_from_loader(p.loader_script) if p else None
            if not l or not l.is_valid() or (expected and l.script_hash!=expected): await i.response.send_message('Invalid, expired or incorrect-project key.',ephemeral=True); return
            l.discord_id=str(i.user.id); l.hwid=None; m['db'].session.commit(); role_id=p.buyer_role_id if p else None
        if role_id:
            r=i.guild.get_role(int(role_id))
            if r:
                try: await i.user.add_roles(r,reason='VantaProtect key redemption')
                except discord.Forbidden: pass
        await i.response.send_message('âœ… Key redeemed. Press **Get Script** to receive your protected loader.',ephemeral=True)

class Panel(discord.ui.View):
    def __init__(self): super().__init__(timeout=None)
    async def p(self,i):
        m=M()
        with m['app'].app_context(): p=panel(i,m['DiscordPanel'])
        if not p: await i.response.send_message('This server has no panel configured.',ephemeral=True); return None,m
        return p,m
    @discord.ui.button(label='ðŸ”‘ Redeem Key',style=discord.ButtonStyle.success,custom_id='vp:redeem')
    async def redeem(self,i,b):
        p,_=await self.p(i)
        if p: await i.response.send_modal(Redeem())
    @discord.ui.button(label='ðŸ“œ Get Script',style=discord.ButtonStyle.primary,custom_id='vp:script')
    async def script(self,i,b):
        p,m=await self.p(i)
        if not p:return
        h=hash_from_loader(p.loader_script)
        with m['app'].app_context():
            ls=m['License'].query.filter_by(discord_id=str(i.user.id),active=True).all(); ls=[x for x in ls if x.is_valid() and (not h or x.script_hash==h)]
            if not ls: await i.response.send_message('You do not have a valid key for this project.',ephemeral=True); return
            out=[]
            for l in ls:
                s=m['Script'].query.filter_by(hash_id=l.script_hash).first(); out.append(f"**{s.name if s else 'Script'}**\n```lua\n{loader(p,l.key)}\n```")
        await i.response.send_message('\n\n'.join(out)[:3900],ephemeral=True)
    @discord.ui.button(label='ðŸ‘¤ Get Role',style=discord.ButtonStyle.primary,custom_id='vp:role')
    async def role(self,i,b):
        p,_=await self.p(i)
        if not p:return
        if not p.buyer_role_id: await i.response.send_message('No buyer role is configured.',ephemeral=True); return
        r=i.guild.get_role(int(p.buyer_role_id))
        try: await i.user.add_roles(r,reason='VantaProtect buyer panel'); await i.response.send_message('âœ… Buyer role assigned.',ephemeral=True)
        except (discord.Forbidden,AttributeError): await i.response.send_message('The bot cannot assign that role. Move its role above the buyer role.',ephemeral=True)
    @discord.ui.button(label='âš™ Reset HWID',style=discord.ButtonStyle.secondary,custom_id='vp:reset')
    async def reset(self,i,b):
        p,m=await self.p(i)
        if not p:return
        with m['app'].app_context(): n=m['License'].query.filter_by(discord_id=str(i.user.id),active=True).update({'hwid':None}); m['db'].session.commit()
        await i.response.send_message(f'âœ… Reset HWID for {n} key(s).',ephemeral=True)
    @discord.ui.button(label='ðŸ“Š Get Stats',style=discord.ButtonStyle.secondary,custom_id='vp:stats')
    async def stats(self,i,b):
        p,m=await self.p(i)
        if not p:return
        with m['app'].app_context():
            ls=m['License'].query.filter_by(discord_id=str(i.user.id)).all(); out=[]
            for l in ls:
                s=m['Script'].query.filter_by(hash_id=l.script_hash).first(); e=l.expires_at.strftime('%Y-%m-%d') if l.expires_at else 'Never'; out.append(f"{s.name if s else l.script_hash}: {'Active' if l.is_valid() else 'Inactive'} | HWID {'linked' if l.hwid else 'not linked'} | expires {e} | executions {l.used_count}")
        await i.response.send_message('\n'.join(out) if out else 'No linked keys.',ephemeral=True)

async def script_autocomplete(interaction: discord.Interaction, current: str):
    m=M()
    with m['app'].app_context():
        user=m['User'].query.filter_by(discord_id=str(interaction.user.id)).first()
        if not user:
            return []
        query=current.lower().strip()
        scripts=m['Script'].query.filter_by(owner_id=user.id, active=True).order_by(m['Script'].updated_at.desc()).limit(25).all()
        return [app_commands.Choice(name=f'{x.name} Â· {x.hash_id[:8]}', value=x.hash_id) for x in scripts if not query or query in x.name.lower() or query in x.hash_id.lower()]

@bot.tree.command(name='setpanel',description='Create the server user panel')
@app_commands.describe(loader_script='Select one of your hosted scripts',manager_role='Role allowed to manage the panel',buyer_role='Optional buyer role')
@app_commands.autocomplete(loader_script=script_autocomplete)
async def setpanel(i,loader_script:str,manager_role:discord.Role,buyer_role:Optional[discord.Role]=None):
    m=M()
    if not i.guild: await i.response.send_message('This command can only be used in a server.',ephemeral=True); return
    if not guild_owner(i) and not is_owner(i.user): await i.response.send_message('Only the server owner can configure the panel.',ephemeral=True); return
    with m['app'].app_context():
        user=m['User'].query.filter_by(discord_id=str(i.user.id)).first()
        script=m['Script'].query.filter_by(hash_id=loader_script.strip(), owner_id=user.id if user else -1, active=True).first()
        if not script:
            await i.response.send_message('Select one of your active hosted scripts from the loader_script field.',ephemeral=True); return
        protected_loader=f'{DOMAIN}/scripts/hosted/{script.hash_id}.lua'
        p=panel(i,m['DiscordPanel'])
        if not p: p=m['DiscordPanel'](guild_id=str(i.guild_id),channel_id=str(i.channel_id),created_by=str(i.user.id),loader_script=protected_loader,manager_role_id=str(manager_role.id));m['db'].session.add(p)
        p.channel_id=str(i.channel_id);p.loader_script=protected_loader;p.manager_role_id=str(manager_role.id);p.buyer_role_id=str(buyer_role.id) if buyer_role else None;p.project_name=script.name;p.description=script.description or 'Protected script control panel.'
        m['RolePermission'].query.filter_by(guild_id=str(i.guild_id)).delete();m['db'].session.add(m['RolePermission'](guild_id=str(i.guild_id),role_id=str(manager_role.id),role_name=manager_role.name,enabled=True));m['db'].session.commit()
        project_name=script.name; project_description=script.description or 'Protected script control panel.'
        author_name=user.username if user else i.user.display_name
        author_avatar=user.avatar if user and user.avatar else None
    e=discord.Embed(title=project_name,description=f'This control panel is for the project: **{project_name}**\n\nIf you\'re a buyer, click on the buttons below to redeem your key, get the script or get your role.',color=discord.Color.blurple())
    e.set_author(name=author_name, icon_url=author_avatar or i.user.display_avatar.url)
    e.set_footer(text=f'Sent by {author_name} â€¢ VantaProtect')
    await i.response.defer(ephemeral=True); msg=await i.channel.send(embed=e,view=Panel())
    with m['app'].app_context(): p=panel(i,m['DiscordPanel']);p.message_id=str(msg.id);m['db'].session.commit()
    await i.followup.send(f'âœ… Panel created: {msg.jump_url}',ephemeral=True)

@bot.tree.command(name='whitelist',description='Whitelist a user for the panel project')
@app_commands.describe(user='User to whitelist',days='Days; 0 means indefinite',note='Optional note')
async def whitelist(i,user:discord.Member,days:int=0,note:str=''):
    m=M()
    with m['app'].app_context():
        if not await manager(i,m['RolePermission']):return
        p=panel(i,m['DiscordPanel']);h=hash_from_loader(p.loader_script) if p else None;s=m['Script'].query.filter_by(hash_id=h,active=True).first() if h else None
        if not s: await i.response.send_message('Configure /setpanel with a hosted script loader first.',ephemeral=True);return
        l=m['License'].query.filter_by(discord_id=str(user.id),script_hash=s.hash_id).first() or m['License'](key=key(m['License']),script_hash=s.hash_id,created_by=None);l.discord_id=str(user.id);l.active=True;l.hwid=None;l.expires_at=exp(days);m['db'].session.add(l);m['db'].session.commit();url=f'https://discord.com/channels/{p.guild_id}/{p.channel_id}/{p.message_id}'
    await i.response.send_message(f'{user.mention} You have been whitelisted!\nYou can access the script via this message --> {url}')
    if p.buyer_role_id:
        r=i.guild.get_role(int(p.buyer_role_id))
        if r:
            try:await user.add_roles(r,reason='VantaProtect whitelist')
            except discord.Forbidden:pass

@bot.tree.command(name='unwhitelist',description='Remove a user license')
@app_commands.describe(user='User')
async def unwhitelist(i,user:discord.Member):
    m=M()
    with m['app'].app_context():
        if not await manager(i,m['RolePermission']):return
        n=m['License'].query.filter_by(discord_id=str(user.id)).update({'active':False,'discord_id':None,'hwid':None});m['db'].session.commit()
    await i.response.send_message(f'{user.mention} has been unwhitelisted.\nâœ… Removed {n} license(s).')

@bot.tree.command(name='force-resethwid',description='Force reset a user HWID')
@app_commands.describe(user='User')
async def force_resethwid(i,user:discord.Member):
    m=M()
    with m['app'].app_context():
        if not await manager(i,m['RolePermission']):return
        n=m['License'].query.filter_by(discord_id=str(user.id)).update({'hwid':None});m['db'].session.commit()
    await i.response.send_message(f'âœ… Force-reset {n} HWID(s).',ephemeral=True)

@bot.tree.command(name='generatekey',description='Generate a 32-character script key')
@app_commands.describe(days='Days; 0 means indefinite',user='Optional bound user')
async def generatekey(i,days:int=0,user:Optional[discord.Member]=None):
    m=M()
    with m['app'].app_context():
        if not await manager(i,m['RolePermission']):return
        p=panel(i,m['DiscordPanel']);h=hash_from_loader(p.loader_script) if p else None;s=m['Script'].query.filter_by(hash_id=h,active=True).first() if h else None
        if not s: await i.response.send_message('Configure /setpanel first.',ephemeral=True);return
        l=m['License'](key=key(m['License']),script_hash=s.hash_id,discord_id=str(user.id) if user else None,expires_at=exp(days),created_by=None);m['db'].session.add(l);m['db'].session.commit();v=l.key
    await i.response.send_message(f'âœ… Key generated for **{s.name}**\n`{v}`\nDays: `{days or "indefinite"}`',ephemeral=True)

@bot.tree.command(name='dropkey',description='Drop keys with countdown')
@app_commands.describe(amount='Number of keys',script='Script for these keys',days='Days; 0 means indefinite')
@app_commands.autocomplete(script=script_autocomplete)
async def dropkey(i,amount:app_commands.Range[int,1,100],script:str,days:int=0):
    m=M()
    with m['app'].app_context():
        if not await manager(i,m['RolePermission']):return
        creator=m['User'].query.filter_by(discord_id=str(i.user.id)).first();s=m['Script'].query.filter_by(hash_id=script.strip(),owner_id=creator.id if creator else -1,active=True).first()
        if not s: await i.response.send_message('Select one of your active hosted scripts.',ephemeral=True);return
        vs=[]
        for _ in range(amount):l=m['License'](key=key(m['License']),script_hash=s.hash_id,expires_at=exp(days),created_by=None);m['db'].session.add(l);vs.append(l.key)
        m['db'].session.commit()
    await i.response.send_message('# Key drop!!\n@everyone',allowed_mentions=discord.AllowedMentions(everyone=True))
    for n in range(amount,0,-1):await i.channel.send(str(n))
    await i.channel.send('# GO!!')
    for v in vs:await i.channel.send(f'`{v}`')

@bot.tree.command(name='deletekey',description='Revoke a key')
@app_commands.describe(key='Script key')
async def deletekey(i,key:str):
    m=M()
    with m['app'].app_context():
        if not await manager(i,m['RolePermission']):return
        l=m['License'].query.filter_by(key=key.strip()).first()
        if not l:await i.response.send_message('Key not found.',ephemeral=True);return
        l.active=False;m['db'].session.commit()
    await i.response.send_message('âœ… Key revoked.',ephemeral=True)

@bot.tree.command(name='resethdwi',description='Reset HWID for a key')
@app_commands.describe(key='Script key')
async def resethdwi(i,key:str):
    m=M()
    with m['app'].app_context():
        if not await manager(i,m['RolePermission']):return
        l=m['License'].query.filter_by(key=key.strip()).first()
        if not l:await i.response.send_message('Key not found.',ephemeral=True);return
        l.hwid=None;m['db'].session.commit()
    await i.response.send_message('âœ… HWID reset.',ephemeral=True)

@bot.tree.command(name='hdwiban',description='Ban a HWID')
@app_commands.describe(hwid='HWID',reason='Reason')
async def hdwiban(i,hwid:str,reason:str='Blocked by manager'):
    m=M()
    with m['app'].app_context():
        if not await manager(i,m['RolePermission']):return
        if not m['HWIDBan'].query.filter_by(hwid=hwid).first():m['db'].session.add(m['HWIDBan'](hwid=hwid,reason=reason,created_by=OWNER_ID));m['db'].session.commit()
    await i.response.send_message(f'â›” HWID blacklisted.\nHWID: `{hwid}`\nReason: {reason}')

@bot.tree.command(name='unbanhdwi',description='Unban a HWID')
@app_commands.describe(hwid='HWID')
async def unbanhdwi(i,hwid:str):
    m=M()
    with m['app'].app_context():
        if not await manager(i,m['RolePermission']):return
        b=m['HWIDBan'].query.filter_by(hwid=hwid).first()
        if b:m['db'].session.delete(b);m['db'].session.commit()
    await i.response.send_message(f'âœ… HWID removed from the blacklist.\nHWID: `{hwid}`')

@bot.tree.command(name='warn',description='Warn a user')
@app_commands.describe(user='User',reason='Reason')
async def warn(i,user:discord.Member,reason:str):
    m=M()
    with m['app'].app_context():
        if not await manager(i,m['RolePermission']):return
        m['db'].session.add(m['Warning'](discord_id=str(user.id),reason=reason,created_by=str(i.user.id)));m['db'].session.commit()
    await i.response.send_message(f'âš ï¸ {user.mention} has been warned.\nReason: {reason}')

@bot.tree.command(name='prices',description='Publish configured prices')
async def prices(i):
    m=M()
    with m['app'].app_context():c=m['PriceConfig'].query.get(1)
    if not c:await i.response.send_message('No prices configured.',ephemeral=True);return
    e=discord.Embed(title=c.title,description=c.description,color=discord.Color.from_str(c.color or '#5865f2'));e.add_field(name='Pricing',value=c.body[:1024],inline=False);await i.response.send_message(embed=e)


@bot.tree.command(name='generatekeyrol',description='Set the manager role for this server panel')
@app_commands.describe(role='Manager role')
async def generatekeyrol(i, role: discord.Role):
    m=M()
    if not (is_owner(i.user) or guild_owner(i)):
        await i.response.send_message('Only the server owner can configure the manager role.',ephemeral=True); return
    with m['app'].app_context():
        old=m['RolePermission'].query.filter_by(guild_id=str(i.guild_id)).first()
        if old: old.role_id=str(role.id); old.role_name=role.name; old.enabled=True
        else: m['db'].session.add(m['RolePermission'](guild_id=str(i.guild_id),role_id=str(role.id),role_name=role.name,enabled=True))
        m['db'].session.commit()
    await i.response.send_message(f'âœ… Manager role set to {role.mention}. Use `/setpanel` to bind it to a panel.',ephemeral=True)

@bot.tree.command(name='ungeneratekeyrol',description='Remove the manager role')
async def ungeneratekeyrol(i):
    m=M()
    if not (is_owner(i.user) or guild_owner(i)):
        await i.response.send_message('Only the server owner can remove the manager role.',ephemeral=True); return
    with m['app'].app_context(): m['RolePermission'].query.filter_by(guild_id=str(i.guild_id)).update({'enabled':False});m['db'].session.commit()
    await i.response.send_message('âœ… Manager role disabled.',ephemeral=True)

@bot.tree.command(name='mass-whitelist',description='Whitelist every member of a role')
@app_commands.describe(role='Buyer role',days='Days; 0 means indefinite')
async def mass_whitelist(i,role:discord.Role,days:int=0):
    m=M()
    with m['app'].app_context():
        if not await manager(i,m['RolePermission']):return
        p=panel(i,m['DiscordPanel']);h=hash_from_loader(p.loader_script) if p else None;sc=m['Script'].query.filter_by(hash_id=h,active=True).first() if h else None
        if not sc: await i.response.send_message('Configure /setpanel first.',ephemeral=True);return
        ok=0
        for member in role.members:
            l=m['License'].query.filter_by(discord_id=str(member.id),script_hash=sc.hash_id).first() or m['License'](key=key(m['License']),script_hash=sc.hash_id,created_by=None)
            l.discord_id=str(member.id);l.active=True;l.expires_at=exp(days);m['db'].session.add(l);ok+=1
        m['db'].session.commit()
    await i.response.send_message(f'âœ… Mass whitelist complete. Total successful: {ok}.',ephemeral=True)

@bot.tree.command(name='blacklist',description='Blacklist a user from this project')
@app_commands.describe(user='User',days='Days; 0 means indefinite',reason='Reason')
async def blacklist(i,user:discord.Member,days:int=0,reason:str='Blocked by manager'):
    m=M()
    with m['app'].app_context():
        if not await manager(i,m['RolePermission']):return
        n=m['License'].query.filter_by(discord_id=str(user.id)).update({'active':False});m['db'].session.commit()
    await i.response.send_message(f'âœ… {user.mention} blacklisted. {n} license(s) disabled. Reason: {reason}',ephemeral=True)

@bot.tree.command(name='compensate',description='Add days to all licenses in this project')
@app_commands.describe(days='Days to add')
async def compensate(i,days:int):
    m=M()
    with m['app'].app_context():
        if not await manager(i,m['RolePermission']):return
        p=panel(i,m['DiscordPanel']);h=hash_from_loader(p.loader_script) if p else None;ls=m['License'].query.filter_by(script_hash=h,active=True).all() if h else []
        now=dt.datetime.utcnow()
        for l in ls:l.expires_at=(l.expires_at if l.expires_at and l.expires_at>now else now)+dt.timedelta(days=days) if l.expires_at or days else None
        m['db'].session.commit()
    await i.response.send_message(f'âœ… Compensated {len(ls)} license(s) by {days} day(s).',ephemeral=True)

@bot.tree.command(name='setlogs',description='Select a channel for bot audit messages')
@app_commands.describe(channel='Log channel')
async def setlogs(i,channel:discord.TextChannel):
    m=M()
    with m['app'].app_context():
        if not await manager(i,m['RolePermission']):return
        p=panel(i,m['DiscordPanel'])
        if not p: await i.response.send_message('Configure /setpanel first.',ephemeral=True); return
        p.logs_channel_id=str(channel.id); m['db'].session.commit()
    await i.response.send_message(f'âœ… Audit log channel saved: {channel.mention}.',ephemeral=True)

@bot.event
async def on_ready():
    bot.add_view(Panel());synced=await bot.tree.sync();log.info('Connected as %s; synchronized %d commands',bot.user,len(synced))
if __name__=='__main__':bot.run(TOKEN)
