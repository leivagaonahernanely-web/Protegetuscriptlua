from flask import Flask, render_template, request, jsonify, redirect, url_for, flash, Response, session, abort
from flask_sqlalchemy import SQLAlchemy
from flask_login import LoginManager, UserMixin, login_user, login_required, current_user, logout_user
from flask_cors import CORS
from authlib.integrations.flask_client import OAuth
from werkzeug.middleware.proxy_fix import ProxyFix
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
from functools import wraps

# ---------------- CONFIGURACIÓN INICIAL CORREGIDA ----------------
app = Flask(__name__)

# 🔐 Fuerza HTTPS y sesiones seguras (arregla el bucle)
app.config['PREFERRED_URL_SCHEME'] = 'https'
app.config['SESSION_COOKIE_SECURE'] = True
app.config['SESSION_COOKIE_HTTPONLY'] = True
app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'
app.config['PERMANENT_SESSION_LIFETIME'] = datetime.timedelta(days=30)

# 🔧 Configuración de proxy para Railway
app.wsgi_app = ProxyFix(app.wsgi_app, x_proto=1, x_host=1, x_for=1)

# 🔑 Claves y conexión
app.config['SECRET_KEY'] = os.getenv("SECRET_KEY", "LUA_PROTECT_2026_ULTRA_SECURE_v7_9872365410_abcdefghijklmnopqrstuvwxyz1234567890")
app.config['SECURITY_PASSWORD_SALT'] = os.getenv("SECURITY_SALT", "LUA_PROT_SALT_892736_XYZ")
app.config['SQLALCHEMY_DATABASE_URI'] = os.getenv("DATABASE_URL", "sqlite:///luaprotect_database.db")
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
app.config['SQLALCHEMY_ENGINE_OPTIONS'] = {'pool_pre_ping': True, 'pool_recycle': 300}
app.config['MAX_CONTENT_LENGTH'] = 64 * 1024 * 1024

# 📋 Variables de entorno
app.config['DISCORD_CLIENT_ID'] = os.getenv("DISCORD_CLIENT_ID", "1519073151856803930")
app.config['DISCORD_CLIENT_SECRET'] = os.getenv("DISCORD_CLIENT_SECRET", "G-oqtu7gXsc0VmbjYpzBUHbvj55z7e0z")
app.config['DISCORD_REDIRECT_URI'] = "https://protegetuscriptlua-production.up.railway.app/callback"
ADMIN_DISCORD_ID = os.getenv("ADMIN_DISCORD_ID", "1501316920975036611")
DOMINIO = "https://protegetuscriptlua-production.up.railway.app"

# 📊 Logs y CORS
CORS(app, supports_credentials=True, origins=["*"], allow_headers=["*"], methods=["*"])
logging.basicConfig(level=logging.INFO, format='%(asctime)s | %(levelname)s | %(message)s')
logger = logging.getLogger("LuaProtect")

# 🧩 Inicializar extensiones
db = SQLAlchemy(app)
login_manager = LoginManager(app)
login_manager.login_view = 'login'
login_manager.login_message = "🔐 Inicia sesión con Discord para continuar"
login_manager.login_message_category = "info"

# 🔗 OAuth CORREGIDO (URL fija para evitar errores)
oauth = OAuth(app)
discord = oauth.register(
    name='discord',
    client_id=app.config['DISCORD_CLIENT_ID'],
    client_secret=app.config['DISCORD_CLIENT_SECRET'],
    access_token_url='https://discord.com/api/oauth2/token',
    authorize_url='https://discord.com/api/oauth2/authorize',
    api_base_url='https://discord.com/api/',
    redirect_uri=app.config['DISCORD_REDIRECT_URI'],
    client_kwargs={
        'scope': 'identify',
        'prompt': 'consent',
        'token_endpoint_auth_method': 'client_secret_post',
        'access_type': 'offline'
    }
)

# ---------------- DECORADORES ----------------
def admin_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if not current_user.is_authenticated or not current_user.is_admin:
            flash("❌ Acceso restringido a administradores", "danger")
            return redirect(url_for('dashboard'))
        return f(*args, **kwargs)
    return decorated

# ---------------- MODELOS DE BASE DE DATOS ----------------
class User(UserMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    discord_id = db.Column(db.String(20), unique=True, nullable=False)
    username = db.Column(db.String(100), nullable=False)
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
    hash_id = db.Column(db.String(32), unique=True, nullable=False)
    content = db.Column(db.Text, nullable=False)
    original_size = db.Column(db.Integer, default=0)
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
    script_hash = db.Column(db.String(32), db.ForeignKey('script.hash_id'), nullable=False)
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
    script_hash = db.Column(db.String(32))
    success = db.Column(db.Boolean)
    message = db.Column(db.String(255))
    timestamp = db.Column(db.DateTime, default=datetime.datetime.utcnow)

@login_manager.user_loader
def load_user(user_id):
    return User.query.get(int(user_id))

# ---------------- FUNCIONES AUXILIARES ----------------
def generar_hash(longitud=32):
    return ''.join(random.choices(string.ascii_letters + string.digits, k=longitud))

def generar_clave_licencia(longitud=40):
    return ''.join(random.choices(string.ascii_letters + string.digits + "ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=longitud))

def proteger_codigo(codigo: str) -> str:
    comprimido = zlib.compress(codigo.encode('utf-8'), level=9)
    return base64.b64encode(comprimido).decode('utf-8')

def desproteger_codigo(datos: str) -> str:
    try:
        return zlib.decompress(base64.b64decode(datos)).decode('utf-8')
    except:
        return "-- Error al cargar código"

def generar_loader(hash_script: str, dominio: str) -> str:
    return f'''
--[[
    LUA PROTECT v2.2
    Sistema Profesional de Protección
    Dominio: {dominio}
    Script ID: {hash_script}
]]

local HttpService = game:GetService("HttpService")
local StarterGui = game:GetService("StarterGui")

local function notify(title, text, dur=3)
    pcall(function()
        StarterGui:SetCore("SendNotification", {{Title=title, Text=text, Duration=dur}})
    end)
end

local script_key = getgenv().script_key or ""
if script_key == "" then notify("Error", "Clave no ingresada") error("Clave requerida", 2) end

local hwid = tostring({{}}):gsub("table: ", "")
local url = "{dominio}/api/load/{hash_script}?key="..HttpService:UrlEncode(script_key).."&hwid="..HttpService:UrlEncode(hwid)

local ok, res = pcall(HttpService.GetAsync, HttpService, url, true)
if not ok then notify("Error", "Sin conexión") error("Error: "..tostring(res), 2) end

local dec_ok, code = pcall(function() return zlib.decompress(base64.b64decode(res)) end)
if not dec_ok then notify("Acceso Denegado", "Clave inválida/expirada") error("Error: "..tostring(code), 2) end

local exec = loadstring or load
if not exec then notify("Error", "Ejecutor no compatible") error("No se puede ejecutar", 2) end

local run_ok, err = pcall(exec, code)
if not run_ok then notify("Error", "Fallo en el script") error("Ejecución: "..tostring(err), 2) end

notify("Éxito", "Script cargado correctamente")
collectgarbage("collect")
'''

# ---------------- RUTAS WEB ----------------
@app.route('/')
def index():
    return render_template('index.html')

@app.route('/login')
def login():
    return discord.authorize_redirect(url_for('callback', _external=True, _scheme='https'))

@app.route('/callback')
def callback():
    try:
        token = discord.authorize_access_token()
        resp = discord.get('users/@me')
        user_data = resp.json()

        discord_id = user_data['id']
        username = user_data['username']
        avatar = f"https://cdn.discordapp.com/avatars/{discord_id}/{user_data['avatar']}.png" if user_data.get('avatar') else ""

        user = User.query.filter_by(discord_id=discord_id).first()
        if not user:
            user = User(
                discord_id=discord_id,
                username=username,
                avatar=avatar,
                is_admin=(discord_id == ADMIN_DISCORD_ID)
            )
            db.session.add(user)

        user.last_login = datetime.datetime.utcnow()
        db.session.commit()
        login_user(user, remember=True)

        return redirect(url_for('dashboard'))

    except Exception as e:
        logger.error(f"Error en inicio de sesión: {str(e)}")
        flash("❌ No se pudo iniciar sesión. Intenta nuevamente.", "danger")
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
        logs = AccessLog.query.order_by(AccessLog.timestamp.desc()).limit(100).all()
    else:
        scripts = Script.query.filter_by(owner_id=current_user.id).all()
        licenses = License.query.filter_by(created_by=current_user.id).all()
        logs = []

    return render_template('dashboard.html', user=current_user, scripts=scripts, licenses=licenses, logs=logs, dominio=DOMINIO)

@app.route('/scripts/new', methods=['POST'])
@login_required
def new_script():
    nombre = request.form.get('name', '').strip()
    descripcion = request.form.get('description', 'Sin descripción').strip()
    codigo = request.form.get('code', '').strip()

    if not nombre or not codigo:
        flash("❌ Nombre y código son obligatorios", "danger")
        return redirect(url_for('dashboard'))

    hash_id = generar_hash()
    contenido = proteger_codigo(codigo)

    nuevo = Script(
        name=nombre,
        description=descripcion,
        hash_id=hash_id,
        content=contenido,
        original_size=len(codigo),
        owner_id=current_user.id
    )

    db.session.add(nuevo)
    db.session.commit()
    flash(f"✅ Script creado | ID: {hash_id}", "success")
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

    return render_template('loader.html', script=script, loader=generar_loader(hash_id, DOMINIO))

@app.route('/licenses/new', methods=['POST'])
@login_required
@admin_required
def new_license():
    script_hash = request.form.get('script_hash', '').strip()
    dias = int(request.form.get('days', 30))
    usos = int(request.form.get('uses', 1))

    if not Script.query.filter_by(hash_id=script_hash).first():
        flash("❌ Script no encontrado", "danger")
        return redirect(url_for('dashboard'))

    clave = generar_clave_licencia()
    expira = datetime.datetime.utcnow() + datetime.timedelta(days=dias)

    nueva = License(
        key=clave,
        script_hash=script_hash,
        max_uses=usos,
        expires_at=expira,
        created_by=current_user.id
    )

    db.session.add(nueva)
    db.session.commit()
    flash(f"✅ Licencia generada: {clave}", "success")
    return redirect(url_for('dashboard'))

@app.route('/licenses/reset/<key>', methods=['POST'])
@login_required
@admin_required
def reset_hwid(key):
    lic = License.query.filter_by(key=key).first_or_404()
    lic.hwid = None
    lic.ip_register = None
    db.session.commit()
    flash("✅ HWID restablecido", "success")
    return redirect(url_for('dashboard'))

@app.route('/licenses/toggle/<key>', methods=['POST'])
@login_required
@admin_required
def toggle_license(key):
    lic = License.query.filter_by(key=key).first_or_404()
    lic.active = not lic.active
    db.session.commit()
    estado = "activada" if lic.active else "desactivada"
    flash(f"✅ Licencia {estado}", "success")
    return redirect(url_for('dashboard'))

# ---------------- API DE CARGA DE SCRIPTS ----------------
@app.route('/api/load/<hash_id>')
def cargar_script(hash_id):
    key = request.args.get('key', '')
    hwid = request.args.get('hwid', '')
    ip = request.remote_addr

    script = Script.query.filter_by(hash_id=hash_id, active=True).first()
    if not script:
        AccessLog(key=key, hwid=hwid, ip=ip, script_hash=hash_id, success=False, message="Script no disponible")
        db.session.commit()
        return Response(base64.b64encode(zlib.compress("error = 'Script no encontrado'".encode())), mimetype='text/plain')

    lic = License.query.filter_by(key=key, script_hash=hash_id, active=True).first()
    if not lic:
        AccessLog(key=key, hwid=hwid, ip=ip, script_hash=hash_id, success=False, message="Clave inválida")
        db.session.commit()
        return Response(base64.b64encode(zlib.compress("error = 'Clave incorrecta'".encode())), mimetype='text/plain')

    if lic.expires_at and lic.expires_at < datetime.datetime.utcnow():
        lic.active = False
        db.session.commit()
        AccessLog(key=key, hwid=hwid, ip=ip, script_hash=hash_id, success=False, message="Licencia expirada")
        db.session.commit()
        return Response(base64.b64encode(zlib.compress("error = 'Licencia vencida'".encode())), mimetype='text/plain')

    if lic.hwid and lic.hwid != hwid:
        AccessLog(key=key, hwid=hwid, ip=ip, script_hash=hash_id, success=False, message="HWID no coincide")
        db.session.commit()
        return Response(base64.b64encode(zlib.compress("error = 'Dispositivo no autorizado'".encode())), mimetype='text/plain')

    if lic.uses >= lic.max_uses:
        lic.active = False
        db.session.commit()
        AccessLog(key=key, hwid=hwid, ip=ip, script_hash=hash_id, success=False, message="Límite de usos alcanzado")
        db.session.commit()
        return Response(base64.b64encode(zlib.compress("error = 'Límite de usos agotado'".encode())), mimetype='text/plain')

    if not lic.hwid:
        lic.hwid = hwid
        lic.ip_register = ip

    lic.uses += 1
    lic.last_used = datetime.datetime.utcnow()
    db.session.commit()

    AccessLog(key=key, hwid=hwid, ip=ip, script_hash=hash_id, success=True, message="Acceso permitido")
    db.session.commit()

    return Response(script.content, mimetype='text/plain')

# ---------------- INICIO DE LA APLICACIÓN ----------------
with app.app_context():
    db.create_all()

if __name__ == '__main__':
    port = int(os.getenv("PORT", 5000))
    app.run(host='0.0.0.0', port=port, debug=False)
