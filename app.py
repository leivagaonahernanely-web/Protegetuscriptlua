from flask import Flask, render_template, request, jsonify, redirect, url_for, flash, Response, session, abort
from flask_sqlalchemy import SQLAlchemy
from flask_login import LoginManager, UserMixin, login_user, login_required, current_user, logout_user
from flask_cors import CORS
from authlib.integrations.flask_client import OAuth
import os
import re
import hashlib
import random
import string
import datetime
import zlib
import base64
import logging
import traceback
from typing import Optional, Tuple, Dict, Any
from functools import wraps

app = Flask(__name__)

CORS(app,
     supports_credentials=True,
     origins=["*"],
     allow_headers=["Content-Type", "Authorization", "X-Key", "X-HWID"],
     methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"])

app.config['SECRET_KEY'] = os.getenv("SECRET_KEY", "LUAPROTECT_2026_ULTRA_SECURE_v6_9872365410_abcdefghijklmnopqrstuvwxyz1234567890")
app.config['SECURITY_PASSWORD_SALT'] = os.getenv("SECURITY_SALT", "LUA_PROT_SALT_892736")
app.config['SQLALCHEMY_DATABASE_URI'] = os.getenv("DATABASE_URL", "sqlite:///luaprotect_database.db")
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
app.config['SQLALCHEMY_ENGINE_OPTIONS'] = {'pool_pre_ping': True, 'pool_recycle': 300}
app.config['PERMANENT_SESSION_LIFETIME'] = datetime.timedelta(days=30)
app.config['SESSION_COOKIE_SECURE'] = True
app.config['SESSION_COOKIE_HTTPONLY'] = True
app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'
app.config['SESSION_COOKIE_NAME'] = 'LuaProtectSession'
app.config['MAX_CONTENT_LENGTH'] = 32 * 1024 * 1024
app.config['MAX_FORM_MEMORY_SIZE'] = 16 * 1024 * 1024

app.config['DISCORD_CLIENT_ID'] = os.getenv("DISCORD_CLIENT_ID", "1519073151856803930")
app.config['DISCORD_CLIENT_SECRET'] = os.getenv("DISCORD_CLIENT_SECRET", "G-oqtu7gXsc0VmbjYpzBUHbvj55z7e0z")
app.config['DISCORD_REDIRECT_URI'] = os.getenv("DISCORD_REDIRECT_URI", "https://protegetuscriptlua-production.up.railway.app/callback")

ADMIN_DISCORD_ID = os.getenv("ADMIN_DISCORD_ID", "1501316920975036611")
DOMINIO = os.getenv("DOMAIN", "https://protegetuscriptlua-production.up.railway.app")
API_VERSION = "v2"

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s | %(levelname)s | %(module)s:%(lineno)d | %(message)s',
    handlers=[logging.FileHandler('luaprotect.log'), logging.StreamHandler()]
)
logger = logging.getLogger("LuaProtect")

db = SQLAlchemy(app)
login_manager = LoginManager(app)
login_manager.login_view = 'login'
login_manager.session_protection = "strong"
login_manager.login_message = "Inicia sesión con Discord para continuar"
login_manager.login_message_category = "info"

oauth = OAuth(app)
discord = oauth.register(
    name='discord',
    client_id=app.config['DISCORD_CLIENT_ID'],
    client_secret=app.config['DISCORD_CLIENT_SECRET'],
    access_token_url='https://discord.com/api/oauth2/token',
    authorize_url='https://discord.com/api/oauth2/authorize',
    api_base_url='https://discord.com/api/',
    client_kwargs={
        'scope': 'identify',
        'prompt': 'consent',
        'token_endpoint_auth_method': 'client_secret_post',
        'access_type': 'offline'
    }
)

def admin_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if not current_user.is_authenticated or not getattr(current_user, 'is_admin', False):
            flash("❌ No tienes permisos de administrador", "danger")
            return redirect(url_for('dashboard'))
        return f(*args, **kwargs)
    return decorated

def api_key_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        api_key = request.headers.get('X-API-Key')
        if not api_key:
            return jsonify({"success": False, "error": "Clave API requerida"}), 401
        return f(*args, **kwargs)
    return decorated

class User(UserMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    discord_id = db.Column(db.String(20), unique=True, nullable=False)
    username = db.Column(db.String(100), nullable=False)
    discriminator = db.Column(db.String(10), default="0000")
    avatar = db.Column(db.String(255))
    is_admin = db.Column(db.Boolean, default=False)
    created_at = db.Column(db.DateTime, default=datetime.datetime.utcnow)
    last_login = db.Column(db.DateTime)
    scripts = db.relationship('Script', backref='owner', lazy=True)
    licenses = db.relationship('License', backref='creator', lazy=True)

class Script(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), nullable=False)
    description = db.Column(db.Text, default="Sin descripción")
    hash_id = db.Column(db.String(64), unique=True, nullable=False)
    content = db.Column(db.Text, nullable=False)
    original_size = db.Column(db.Integer, default=0)
    protected = db.Column(db.Boolean, default=True)
    active = db.Column(db.Boolean, default=True)
    created_at = db.Column(db.DateTime, default=datetime.datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.datetime.utcnow, onupdate=datetime.datetime.utcnow)
    owner_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    licenses = db.relationship('License', backref='script', lazy=True)

class License(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    key = db.Column(db.String(64), unique=True, nullable=False)
    hwid = db.Column(db.String(128), default=None)
    ip_register = db.Column(db.String(45), default=None)
    script_hash = db.Column(db.String(64), db.ForeignKey('script.hash_id'), nullable=False)
    active = db.Column(db.Boolean, default=True)
    max_uses = db.Column(db.Integer, default=1)
    uses = db.Column(db.Integer, default=0)
    expires_at = db.Column(db.DateTime)
    created_at = db.Column(db.DateTime, default=datetime.datetime.utcnow)
    last_used = db.Column(db.DateTime)
    created_by = db.Column(db.Integer, db.ForeignKey('user.id'))

class AccessLog(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    key = db.Column(db.String(64))
    hwid = db.Column(db.String(128))
    ip = db.Column(db.String(45))
    script_hash = db.Column(db.String(64))
    success = db.Column(db.Boolean)
    message = db.Column(db.String(255))
    timestamp = db.Column(db.DateTime, default=datetime.datetime.utcnow)

@login_manager.user_loader
def load_user(user_id):
    return User.query.get(int(user_id))

def generar_hash(longitud=32):
    return ''.join(random.choices(string.ascii_letters + string.digits, k=longitud))

def generar_clave_licencia(longitud=40):
    return ''.join(random.choices(string.ascii_letters + string.digits + "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", k=longitud))

def proteger_codigo(codigo: str) -> str:
    codigo = codigo.strip()
    comprimido = zlib.compress(codigo.encode('utf-8'), level=9)
    return base64.b64encode(comprimido).decode('utf-8')

def desproteger_codigo(datos: str) -> str:
    try:
        decodificado = base64.b64decode(datos)
        descomprimido = zlib.decompress(decodificado)
        return descomprimido.decode('utf-8')
    except Exception as e:
        logger.error(f"Error al desproteger: {e}")
        return "-- Error al leer código"

def generar_loader(hash_script: str, dominio: str) -> str:
    return f'''
--[[
    LUA PROTECT v2.1
    Sistema de protección de scripts
    Dominio: {dominio}
    Script ID: {hash_script}
]]

local HttpService = game:GetService("HttpService")
local RunService = game:GetService("RunService")
local StarterGui = game:GetService("StarterGui")

local function notify(title, text)
    pcall(function()
        StarterGui:SetCore("SendNotification", {{
            Title = title,
            Text = text,
            Duration = 3
        }})
    end)
end

local script_key = getgenv().script_key or ""
if script_key == "" then
    notify("Error", "Clave no proporcionada")
    error("Clave requerida", 2)
end

local hwid = tostring({{}}):gsub("table: ", "")
local url = "{dominio}/api/load/{hash_script}?key=" .. HttpService:UrlEncode(script_key) .. "&hwid=" .. HttpService:UrlEncode(hwid)

local success, result = pcall(function()
    return HttpService:GetAsync(url, true)
end)

if not success then
    notify("Error", "No se pudo conectar al servidor")
    error("Error de conexión: " .. tostring(result), 2)
end

local decode_success, codigo = pcall(function()
    return HttpService:Decompress(HttpService:Base64Decode(result))
end)

if not decode_success then
    notify("Error", "Clave inválida o expirada")
    error("Acceso denegado: " .. tostring(codigo), 2)
end

local exec = loadstring or load
if not exec then
    notify("Error", "Ejecutor no compatible")
    error("No se puede ejecutar", 2)
end

local run_success, err = pcall(exec, codigo)
if not run_success then
    notify("Error", "Error en el script")
    error("Ejecución fallida: " .. tostring(err), 2)
end

notify("Éxito", "Script cargado correctamente")
collectgarbage("collect")
'''

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/login')
def login():
    return discord.authorize_redirect(url_for('callback', _external=True))

@app.route('/callback')
def callback():
    try:
        token = discord.authorize_access_token()
        resp = discord.get('users/@me')
        user_data = resp.json()

        discord_id = user_data['id']
        username = user_data['username']
        discriminator = user_data.get('discriminator', '0000')
        avatar = f"https://cdn.discordapp.com/avatars/{discord_id}/{user_data['avatar']}.png" if user_data.get('avatar') else ""

        user = User.query.filter_by(discord_id=discord_id).first()
        if not user:
            user = User(
                discord_id=discord_id,
                username=username,
                discriminator=discriminator,
                avatar=avatar,
                is_admin=(discord_id == ADMIN_DISCORD_ID)
            )
            db.session.add(user)
        user.last_login = datetime.datetime.utcnow()
        db.session.commit()

        login_user(user, remember=True)
        return redirect(url_for('dashboard'))
    except Exception as e:
        logger.error(f"Error en callback: {str(e)}")
        flash("❌ Error al iniciar sesión", "danger")
        return redirect(url_for('index'))

@app.route('/logout')
@login_required
def logout():
    logout_user()
    return redirect(url_for('index'))

@app.route('/dashboard')
@login_required
def dashboard():
    if current_user.is_admin:
        scripts = Script.query.all()
        licenses = License.query.all()
        logs = AccessLog.query.order_by(AccessLog.timestamp.desc()).limit(50).all()
    else:
        scripts = Script.query.filter_by(owner_id=current_user.id).all()
        licenses = License.query.filter_by(created_by=current_user.id).all()
        logs = []
    return render_template('dashboard.html', user=current_user, scripts=scripts, licenses=licenses, logs=logs, dominio=DOMINIO)

@app.route('/scripts/new', methods=['POST'])
@login_required
def new_script():
    nombre = request.form.get('name', 'Sin nombre').strip()
    descripcion = request.form.get('description', 'Sin descripción').strip()
    codigo = request.form.get('code', '')

    if not nombre or not codigo.strip():
        flash("❌ Nombre y código son obligatorios", "danger")
        return redirect(url_for('dashboard'))

    hash_id = generar_hash()
    codigo_protegido = proteger_codigo(codigo)
    tamano_original = len(codigo.encode('utf-8'))

    nuevo = Script(
        name=nombre,
        description=descripcion,
        hash_id=hash_id,
        content=codigo_protegido,
        original_size=tamano_original,
        owner_id=current_user.id
    )
    db.session.add(nuevo)
    db.session.commit()

    flash(f"✅ Script creado | Hash: {hash_id}", "success")
    return redirect(url_for('dashboard'))

@app.route('/scripts/delete/<hash_id>', methods=['POST'])
@login_required
def delete_script(hash_id):
    script = Script.query.filter_by(hash_id=hash_id).first_or_404()
    if script.owner_id != current_user.id and not current_user.is_admin:
        abort(403)

    License.query.filter_by(script_hash=hash_id).delete()
    AccessLog.query.filter_by(script_hash=hash_id).delete()
    db.session.delete(script)
    db.session.commit()

    flash("✅ Script eliminado correctamente", "success")
    return redirect(url_for('dashboard'))

@app.route('/loader/<hash_id>')
@login_required
def ver_loader(hash_id):
    script = Script.query.filter_by(hash_id=hash_id).first_or_404()
    if script.owner_id != current_user.id and not current_user.is_admin:
        abort(403)
    loader = generar_loader(hash_id, DOMINIO)
    return render_template('loader.html', script=script, loader=loader)

@app.route('/licenses/new', methods=['POST'])
@login_required
@admin_required
def new_license():
    script_hash = request.form.get('script_hash')
    dias = int(request.form.get('days', 30))
    usos = int(request.form.get('uses', 1))

    script = Script.query.filter_by(hash_id=script_hash).first()
    if not script:
        flash("❌ El script no existe", "danger")
        return redirect(url_for('dashboard'))

    key = generar_clave_licencia()
    expira = datetime.datetime.utcnow() + datetime.timedelta(days=dias)

    nueva = License(
        key=key,
        script_hash=script_hash,
        max_uses=usos,
        expires_at=expira,
        created_by=current_user.id
    )
    db.session.add(nueva)
    db.session.commit()

    flash(f"✅ Licencia generada: {key}", "success")
    return redirect(url_for('dashboard'))

@app.route('/licenses/reset-hwid/<key>', methods=['POST'])
@login_required
@admin_required
def reset_hwid(key):
    licencia = License.query.filter_by(key=key).first_or_404()
    licencia.hwid = None
    licencia.ip_register = None
    db.session.commit()
    flash("✅ HWID restablecido", "success")
    return redirect(url_for('dashboard'))

@app.route('/licenses/deactivate/<key>', methods=['POST'])
@login_required
@admin_required
def deactivate_license(key):
    licencia = License.query.filter_by(key=key).first_or_404()
    licencia.active = False
    db.session.commit()
    flash("✅ Licencia desactivada", "success")
    return redirect(url_for('dashboard'))

@app.route('/api/load/<hash_id>')
def cargar_script(hash_id):
    key = request.args.get('key', '')
    hwid = request.args.get('hwid', '')
    ip = request.remote_addr

    script = Script.query.filter_by(hash_id=hash_id, active=True).first()
    if not script:
        AccessLog(key=key, hwid=hwid, ip=ip, script_hash=hash_id, success=False, message="Script no existe o desactivado")
        db.session.commit()
        return Response(base64.b64encode(zlib.compress("error = 'Script no disponible'".encode())), mimetype='text/plain')

    licencia = License.query.filter_by(key=key, script_hash=hash_id, active=True).first()
    if not licencia:
        AccessLog(key=key, hwid=hwid, ip=ip, script_hash=hash_id, success=False, message="Licencia inválida")
        db.session.commit()
        return Response(base64.b64encode(zlib.compress("error = 'Licencia inválida'".encode())), mimetype='text/plain')

    if licencia.expires_at and licencia.expires_at < datetime.datetime.utcnow():
        licencia.active = False
        db.session.commit()
        AccessLog(key=key, hwid=hwid, ip=ip, script_hash=hash_id, success=False, message="Licencia expirada")
        db.session.commit()
        return Response(base64.b64encode(zlib.compress("error = 'Licencia expirada'".encode())), mimetype='text/plain')

    if licencia.hwid and licencia.hwid != hwid:
        AccessLog(key=key, hwid=hwid, ip=ip, script_hash=hash_id, success=False, message="HWID no coincide")
        db.session.commit()
        return Response(base64.b64encode(zlib.compress("error = 'HWID no coincide'".encode())), mimetype='text/plain')

    if licencia.uses >= licencia.max_uses:
        licencia.active = False
        db.session.commit()
        AccessLog(key=key, hwid=hwid, ip=ip, script_hash=hash_id, success=False, message="Límite de usos alcanzado")
        db.session.commit()
        return Response(base64.b64encode(zlib.compress("error = 'Límite de usos alcanzado'".encode())), mimetype='text/plain')

    if not licencia.hwid:
        licencia.hwid = hwid
        licencia.ip_register = ip

    licencia.uses += 1
    licencia.last_used = datetime.datetime.utcnow()
    db.session.commit()

    AccessLog(key=key, hwid=hwid, ip=ip, script_hash=hash_id, success=True, message="Acceso permitido")
    db.session.commit()

    return Response(script.content, mimetype='text/plain')

with app.app_context():
    db.create_all()

if __name__ == '__main__':
    port = int(os.getenv("PORT", 5000))
    app.run(host='0.0.0.0', port=port, debug=False)
