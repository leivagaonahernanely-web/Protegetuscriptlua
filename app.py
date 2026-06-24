from flask import Flask, render_template, request, jsonify, redirect, url_for, flash, Response, session
from flask_sqlalchemy import SQLAlchemy
from flask_login import LoginManager, UserMixin, login_user, login_required, current_user, logout_user
from flask_cors import CORS
from authlib.integrations.flask_client import OAuth
import os
import hashlib
import random
import datetime
import zlib
import base64

# ---------------------- CONFIGURACIÓN ----------------------
app = Flask(__name__)
CORS(app)

app.config['SECRET_KEY'] = 'PROTECT_2026_SECURE_KEY_987XYZ'
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///protector.db'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
app.config['PERMANENT_SESSION_LIFETIME'] = datetime.timedelta(days=30)
app.config['SESSION_COOKIE_SECURE'] = False
app.config['SESSION_COOKIE_HTTPONLY'] = True

# ✅ DATOS DE TU APP
app.config['DISCORD_CLIENT_ID'] = "1519073151856803930"
app.config['DISCORD_CLIENT_SECRET'] = "G-oqtu7gXsc0VmbjYpzBUHbvj55z7e0z"
app.config['DISCORD_REDIRECT_URI'] = "http://localhost:8080/callback"

# ✅ TU ID DE DISCORD PARA ADMIN
ADMIN_DISCORD_ID = "1501316920975036611"

db = SQLAlchemy(app)
login_manager = LoginManager(app)
login_manager.login_view = 'login'

oauth = OAuth(app)
discord = oauth.register(
    name='discord',
    client_id=app.config['DISCORD_CLIENT_ID'],
    client_secret=app.config['DISCORD_CLIENT_SECRET'],
    access_token_url='https://discord.com/api/oauth2/token',
    authorize_url='https://discord.com/api/oauth2/authorize',
    api_base_url='https://discord.com/api/',
    client_kwargs={'scope': 'identify'}
)

# ---------------------- BASE DE DATOS ----------------------
class User(UserMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    discord_id = db.Column(db.String(20), unique=True, nullable=False)
    discord_username = db.Column(db.String(100), nullable=False)
    discord_avatar = db.Column(db.String(255))
    is_admin = db.Column(db.Boolean, default=False)

class Script(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    owner_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    name = db.Column(db.String(150), nullable=False)
    content = db.Column(db.Text, nullable=False)
    file_hash = db.Column(db.String(128), unique=True, nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.datetime.utcnow)
    killswitch = db.Column(db.Boolean, default=False)
    anti_bypass = db.Column(db.Boolean, default=False)
    owner = db.relationship('User', backref=db.backref('scripts', lazy=True))

class Panel(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    owner_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    title = db.Column(db.String(150), nullable=False)
    script_id = db.Column(db.Integer, db.ForeignKey('script.id'))
    owner = db.relationship('User', backref=db.backref('panels', lazy=True))

class Key(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    owner_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    key = db.Column(db.String(16), unique=True, nullable=False)
    panel_id = db.Column(db.Integer, db.ForeignKey('panel.id'))
    hwid = db.Column(db.String(128))
    expires_at = db.Column(db.DateTime)
    active = db.Column(db.Boolean, default=True)
    created_at = db.Column(db.DateTime, default=datetime.datetime.utcnow)
    owner = db.relationship('User', backref=db.backref('keys', lazy=True))

class BannedHWID(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    owner_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    hwid_hash = db.Column(db.String(128), unique=True, nullable=False)
    reason = db.Column(db.String(255), default="Sin motivo")
    owner = db.relationship('User', backref=db.backref('bans', lazy=True))

@login_manager.user_loader
def load_user(user_id):
    return User.query.get(int(user_id))

with app.app_context():
    db.create_all()

# ---------------------- INICIO DE SESIÓN ----------------------
@app.route('/login')
def login():
    if current_user.is_authenticated:
        return redirect(url_for('scripts'))
    return discord.authorize_redirect(redirect_uri=app.config['DISCORD_REDIRECT_URI'])

@app.route('/callback')
def callback():
    token = discord.authorize_access_token()
    if not token:
        flash("Error al iniciar sesión")
        return redirect(url_for('login'))
    
    resp = discord.get('users/@me')
    user_data = resp.json()
    
    user = User.query.filter_by(discord_id=user_data['id']).first()
    if not user:
        es_admin = (user_data['id'] == ADMIN_DISCORD_ID)
        user = User(
            discord_id=user_data['id'],
            discord_username=user_data['username'],
            discord_avatar=user_data.get('avatar'),
            is_admin=es_admin
        )
        db.session.add(user)
        db.session.commit()
    
    login_user(user, remember=True)
    return redirect(url_for('scripts'))

@app.route('/logout')
@login_required
def logout():
    logout_user()
    session.clear()
    return redirect(url_for('login'))

# ---------------------- RUTAS ----------------------
@app.route('/')
@login_required
def index():
    return redirect(url_for('scripts'))

@app.route('/scripts')
@login_required
def scripts():
    scripts = Script.query.all() if current_user.is_admin else Script.query.filter_by(owner_id=current_user.id).all()
    return render_template('scripts.html', scripts=scripts, user=current_user)

@app.route('/panels')
@login_required
def panels():
    panels = Panel.query.all() if current_user.is_admin else Panel.query.filter_by(owner_id=current_user.id).all()
    scripts = Script.query.all() if current_user.is_admin else Script.query.filter_by(owner_id=current_user.id).all()
    return render_template('panels.html', panels=panels, scripts=scripts, user=current_user)

@app.route('/keys')
@login_required
def keys():
    keys = Key.query.all() if current_user.is_admin else Key.query.filter_by(owner_id=current_user.id).all()
    panels = Panel.query.all() if current_user.is_admin else Panel.query.filter_by(owner_id=current_user.id).all()
    return render_template('keys.html', keys=keys, panels=panels, user=current_user)

@app.route('/protector')
@login_required
def protector_page():
    scripts = Script.query.all() if current_user.is_admin else Script.query.filter_by(owner_id=current_user.id).all()
    return render_template('protector.html', scripts=scripts, user=current_user)

@app.route('/users')
@login_required
def users():
    if not current_user.is_admin:
        return redirect(url_for('scripts'))
    return render_template('users.html', users=User.query.all(), user=current_user)

# ---------------------- API Y PROTECCIÓN ----------------------
@app.route('/api/verify')
def verify():
    key = request.args.get('key', '').strip()
    hwid = request.args.get('hwid', '').strip()

    if not key:
        return Response("return error('Clave faltante')", mimetype='text/plain', status=403)

    key_obj = Key.query.filter_by(key=key, active=True).first()
    if not key_obj:
        return Response("return error('Clave inválida o desactivada')", mimetype='text/plain', status=403)

    if key_obj.expires_at and key_obj.expires_at < datetime.datetime.utcnow():
        return Response("return error('Clave vencida')", mimetype='text/plain', status=403)

    if hwid:
        hwid_hash = hashlib.sha256(hwid.encode()).hexdigest()
        if BannedHWID.query.filter_by(owner_id=key_obj.owner_id, hwid_hash=hwid_hash).first():
            return Response("return error('HWID baneado')", mimetype='text/plain', status=403)
        if key_obj.hwid and key_obj.hwid != hwid_hash:
            return Response("return error('HWID no coincide')", mimetype='text/plain', status=403)
        if not key_obj.hwid:
            key_obj.hwid = hwid_hash
            db.session.commit()

    panel = Panel.query.filter_by(id=key_obj.panel_id, owner_id=key_obj.owner_id).first()
    if not panel:
        return Response("return error('Panel no encontrado')", mimetype='text/plain', status=404)

    script = Script.query.filter_by(id=panel.script_id, owner_id=key_obj.owner_id).first()
    if not script or script.killswitch:
        return Response("return error('Script desactivado')", mimetype='text/plain', status=403)

    comprimido = zlib.compress(script.content.encode('utf-8'), 9)
    codificado = base64.b64encode(comprimido).decode('utf-8')

    return Response(f'''
local d="{codificado}"
local gs = game:GetService("HttpService")
local f = loadstring or load
if f then f(gs:Decompress(gs:Base64Decode(d)))() end
d=nil collectgarbage()
''', mimetype='text/plain')

@app.route('/api/protect', methods=['POST'])
@login_required
def protect_script():
    data = request.get_json()
    if not data or 'name' not in data or 'code' not in data:
        return jsonify({"success": False, "error": "Faltan datos"})

    hash_code = hashlib.sha256(f"{current_user.id}{data['name']}{datetime.datetime.utcnow()}".encode()).hexdigest()

    nuevo = Script(
        owner_id=current_user.id,
        name=data['name'],
        content=data['code'],
        file_hash=hash_code,
        killswitch=False,
        anti_bypass=True
    )
    db.session.add(nuevo)
    db.session.commit()

    loader = f'''-- 🔐 Protegido por ProtectorScripts
local KEY = "PONER_AQUI_TU_CLAVE"
local DOMINIO = "http://localhost:8080"

local hwid = game:GetService("HttpService"):UrlEncode(tostring({{}}):gsub("table: ", ""))
local res = game:GetService("HttpService"):GetAsync(DOMINIO.."/api/verify?key="..KEY.."&hwid="..hwid, true)
if res:sub(1,5) == "return" then error(res:match("error%('(.+)'%)") or "Error", 0) end
loadstring(res)()
'''

    return jsonify({
        "success": True,
        "hash": hash_code,
        "loader": loader,
        "url": f"http://localhost:8080/scripts/hosted/{hash_code}.lua"
    })

@app.route('/scripts/hosted/<file_hash>.lua')
def hosted_script(file_hash):
    script = Script.query.filter_by(file_hash=file_hash).first()
    if not script:
        return Response("-- Script no encontrado", mimetype='text/plain', status=404)
    return Response(f"loadstring(game:HttpGet('http://localhost:8080/api/verify?key=YOUR_KEY&hwid='..tostring({{}}):gsub('table: ','')))()", mimetype='text/plain')

@app.route('/api/toggle-kill/<int:script_id>', methods=['POST'])
@login_required
def toggle_kill(script_id):
    if current_user.is_admin:
        script = Script.query.get_or_404(script_id)
    else:
        script = Script.query.filter_by(id=script_id, owner_id=current_user.id).first()
        if not script:
            return jsonify({"success": False, "error": "Sin permiso"})
    
    script.killswitch = not script.killswitch
    db.session.commit()
    return jsonify({"success": True, "estado": script.killswitch})

@app.route('/api/generate-key', methods=['POST'])
@login_required
def gen_key():
    data = request.get_json()
    duracion = int(data.get('hours', 24))
    clave = ''.join(random.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", k=16))
    expira = datetime.datetime.utcnow() + datetime.timedelta(hours=duracion) if duracion > 0 else None
    nueva = Key(owner_id=current_user.id, key=clave, panel_id=data['panel_id'], expires_at=expira)
    db.session.add(nueva)
    db.session.commit()
    return jsonify({"success": True, "key": clave})

# ---------------------- INICIAR SERVIDOR ----------------------
if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8080, debug=False)
