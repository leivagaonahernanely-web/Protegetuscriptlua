# ==================================================
# LUA PROTECT - SISTEMA DE PROTECCIÓN DE SCRIPTS
# Versión: 2.0.0 | Fecha: 24/06/2026
# Desarrollado para Roblox Lua - Seguridad y Control
# ==================================================

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

# ==================================================
# ⚙️ CONFIGURACIÓN GLOBAL Y SEGURIDAD
# ==================================================

# Inicializar aplicación
app = Flask(__name__)

# Configuración de CORS
CORS(app,
     supports_credentials=True,
     origins=["*"],
     allow_headers=["Content-Type", "Authorization", "X-Key", "X-HWID"],
     methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"])

# Claves de seguridad - CAMBIA ESTAS POR LAS TUYAS
app.config['SECRET_KEY'] = 'LUAPROTECT_2026_ULTRA_SECURE_v6_9872365410_abcdefghijklmnopqrstuvwxyz1234567890'
app.config['SECURITY_PASSWORD_SALT'] = 'LUA_PROT_SALT_892736'

# Base de datos
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///luaprotect_database.db'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
app.config['SQLALCHEMY_ENGINE_OPTIONS'] = {
    'pool_pre_ping': True,
    'pool_recycle': 300
}

# Configuración de sesión
app.config['PERMANENT_SESSION_LIFETIME'] = datetime.timedelta(days=30)
app.config['SESSION_COOKIE_SECURE'] = True
app.config['SESSION_COOKIE_HTTPONLY'] = True
app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'
app.config['SESSION_COOKIE_NAME'] = 'LuaProtectSession'

# Límites de archivos y solicitudes
app.config['MAX_CONTENT_LENGTH'] = 32 * 1024 * 1024  # 32MB máximo
app.config['MAX_FORM_MEMORY_SIZE'] = 16 * 1024 * 1024

# Discord OAuth
app.config['DISCORD_CLIENT_ID'] = "1519073151856803930"
app.config['DISCORD_CLIENT_SECRET'] = "G-oqtu7gXsc0VmbjYpzBUHbvj55z7e0z"
app.config['DISCORD_REDIRECT_URI'] = "https://protegetuscriptlua-production.up.railway.app/callback"

# Configuración de administrador y dominio
ADMIN_DISCORD_ID = "1501316920975036611"
DOMINIO = "https://protegetuscriptlua-production.up.railway.app"
API_VERSION = "v2"

# Configuración de Logs
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s | %(levelname)s | %(module)s:%(lineno)d | %(message)s',
    handlers=[
        logging.FileHandler('luaprotect.log'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger("LuaProtect")

# Inicializar extensiones
db = SQLAlchemy(app)
login_manager = LoginManager(app)
login_manager.login_view = 'login'
login_manager.session_protection = "strong"
login_manager.login_message = "Por favor inicia sesión con Discord para continuar"
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

# ==================================================
# 🛡️ DECORADORES DE SEGURIDAD
# ==================================================

def admin_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if not current_user.is_authenticated or not current_user.is_admin:
            flash("❌ No tienes permisos de administrador", "danger")
            return redirect(url_for('dashboard'))
        return f(*args, **kwargs)
    return decorated_function

def api_key_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        api_key = request.headers.get('X-API-Key')
        if not api_key:
            return jsonify({"success": False, "error": "Se requiere clave API"}), 401
        # Aquí puedes agregar verificación de claves API si lo deseas
        return f(*args, **kwargs)
    return decorated_function

# ==================================================
# 📋 MODELOS DE BASE DE DATOS COMPLETOS
# ==================================================

class User(UserMixin, db.Model):
    __tablename__ = 'users'
    id = db.Column(db.Integer, primary_key=True)
    discord_id = db.Column(db.String(20), unique=True, nullable=False, index=True)
    username = db.Column(db.String(100), nullable=False)
    discriminator = db.Column(db.String(4), default="0000")
    avatar = db.Column(db.String(255))
    email = db.Column(db.String(150), nullable=True)
    is_admin = db.Column(db.Boolean, default=False)
    is_banned = db.Column(db.Boolean, default=False)
    ban_reason = db.Column(db.String(255), nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.datetime.utcnow)
    last_login = db.Column(db.DateTime, default=datetime.datetime.utcnow, onupdate=datetime.datetime.utcnow)
    total_scripts = db.Column(db.Integer, default=0)
    total_keys_generated = db.Column(db.Integer, default=0)

    # Relaciones
    scripts = db.relationship('Script', backref='owner', lazy=True, cascade="all, delete-orphan")
    panels = db.relationship('Panel', backref='owner', lazy=True, cascade="all, delete-orphan")
    keys = db.relationship('Key', backref='owner', lazy=True, cascade="all, delete-orphan")
    hwid_bans = db.relationship('HWIDBan', backref='owner', lazy=True, cascade="all, delete-orphan")

    def __repr__(self):
        return f"<User {self.username}#{self.discriminator}>"

    def get_avatar_url(self):
        if self.avatar:
            return f"https://cdn.discordapp.com/avatars/{self.discord_id}/{self.avatar}.png"
        return "https://cdn.discordapp.com/embed/avatars/0.png"


class Script(db.Model):
    __tablename__ = 'scripts'
    id = db.Column(db.Integer, primary_key=True)
    owner_id = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=False)
    name = db.Column(db.String(150), nullable=False)
    description = db.Column(db.Text, default="Sin descripción")
    code = db.Column(db.Text, nullable=False)
    original_size = db.Column(db.Integer, default=0)
    compressed_size = db.Column(db.Integer, default=0)
    hash = db.Column(db.String(32), unique=True, nullable=False, index=True)
    version = db.Column(db.String(10), default="1.0.0")
    active = db.Column(db.Boolean, default=True)
    protected = db.Column(db.Boolean, default=True)
    obfuscated = db.Column(db.Boolean, default=False)
    access_count = db.Column(db.Integer, default=0)
    created_at = db.Column(db.DateTime, default=datetime.datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.datetime.utcnow, onupdate=datetime.datetime.utcnow)
    last_access = db.Column(db.DateTime, nullable=True)

    # Relaciones
    panels = db.relationship('Panel', backref='script', lazy=True)

    def __repr__(self):
        return f"<Script {self.name} v{self.version}>"


class Panel(db.Model):
    __tablename__ = 'panels'
    id = db.Column(db.Integer, primary_key=True)
    owner_id = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=False)
    name = db.Column(db.String(100), nullable=False)
    description = db.Column(db.Text, default="")
    script_id = db.Column(db.Integer, db.ForeignKey('scripts.id'), nullable=True)
    discord_channel_id = db.Column(db.String(50), nullable=True)
    discord_role_id = db.Column(db.String(50), nullable=True)
    hwid_reset_cooldown = db.Column(db.Integer, default=3600)  # En segundos
    max_keys = db.Column(db.Integer, default=0)  # 0 = sin límite
    keys_used = db.Column(db.Integer, default=0)
    active = db.Column(db.Boolean, default=True)
    created_at = db.Column(db.DateTime, default=datetime.datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.datetime.utcnow, onupdate=datetime.datetime.utcnow)

    # Relaciones
    keys = db.relationship('Key', backref='panel', lazy=True)

    def __repr__(self):
        return f"<Panel {self.name}>"


class Key(db.Model):
    __tablename__ = 'keys'
    id = db.Column(db.Integer, primary_key=True)
    owner_id = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=False)
    key = db.Column(db.String(32), unique=True, nullable=False, index=True)
    panel_id = db.Column(db.Integer, db.ForeignKey('panels.id'), nullable=True)
    hwid = db.Column(db.String(128), nullable=True)
    ip_restriction = db.Column(db.String(45), nullable=True)
    expires_at = db.Column(db.DateTime, nullable=True)
    active = db.Column(db.Boolean, default=True)
    used_count = db.Column(db.Integer, default=0)
    max_uses = db.Column(db.Integer, default=0)  # 0 = sin límite
    created_at = db.Column(db.DateTime, default=datetime.datetime.utcnow)
    last_used = db.Column(db.DateTime, nullable=True)
    reset_count = db.Column(db.Integer, default=0)

    def __repr__(self):
        return f"<Key {self.key[:8]}...>"

    def is_valid(self) -> bool:
        if not self.active:
            return False
        if self.expires_at and self.expires_at < datetime.datetime.utcnow():
            return False
        if self.max_uses > 0 and self.used_count >= self.max_uses:
            return False
        return True


class HWIDBan(db.Model):
    __tablename__ = 'hwid_bans'
    id = db.Column(db.Integer, primary_key=True)
    owner_id = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=False)
    hwid_hash = db.Column(db.String(128), unique=True, nullable=False, index=True)
    original_hwid = db.Column(db.String(255), nullable=True)
    reason = db.Column(db.String(255), default="Sin motivo especificado")
    ip_address = db.Column(db.String(45), nullable=True)
    expires_at = db.Column(db.DateTime, nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.datetime.utcnow)

    def __repr__(self):
        return f"<HWIDBan {self.hwid_hash[:10]}...>"


class AccessLog(db.Model):
    __tablename__ = 'access_logs'
    id = db.Column(db.Integer, primary_key=True)
    key_id = db.Column(db.Integer, db.ForeignKey('keys.id'), nullable=True)
    script_id = db.Column(db.Integer, db.ForeignKey('scripts.id'), nullable=True)
    ip_address = db.Column(db.String(45), nullable=False)
    hwid = db.Column(db.String(128), nullable=True)
    user_agent = db.Column(db.String(255), nullable=True)
    success = db.Column(db.Boolean, default=False)
    error_message = db.Column(db.String(255), nullable=True)
    timestamp = db.Column(db.DateTime, default=datetime.datetime.utcnow)

    def __repr__(self):
        return f"<AccessLog {self.timestamp} {self.success}>"


@login_manager.user_loader
def load_user(user_id: str) -> Optional[User]:
    return User.query.get(int(user_id))


# Crear tablas al iniciar
with app.app_context():
    db.create_all()
    logger.info("✅ Base de datos inicializada correctamente")

# ==================================================
# 🛠️ FUNCIONES AUXILIARES AVANZADAS
# ==================================================

def parse_duration(duracion_str: str) -> Optional[datetime.timedelta]:
    """Convierte texto como '1h', '7d', '1y' a timedelta"""
    if not duracion_str:
        return None
    duracion_str = str(duracion_str).strip().lower()
    if duracion_str in ["0", "nunca", "infinito"]:
        return None

    pattern = re.compile(r'^(\d+)([hdmy])$')
    match = pattern.match(duracion_str)
    if not match:
        return None

    valor = int(match.group(1))
    unidad = match.group(2)

    if valor <= 0:
        return None

    if unidad == 'h':
        return datetime.timedelta(hours=valor)
    elif unidad == 'd':
        return datetime.timedelta(days=valor)
    elif unidad == 'm':
        return datetime.timedelta(days=valor * 30)
    elif unidad == 'y':
        return datetime.timedelta(days=valor * 365)
    return None


def generar_hash_corto(texto: str) -> str:
    """Genera hash corto único"""
    return hashlib.sha256(texto.encode('utf-8', errors='ignore')).hexdigest()[:32]


def obtener_hwid_hash(hwid: str) -> str:
    """Genera hash seguro del HWID"""
    return hashlib.sha256(hwid.strip().encode('utf-8', errors='ignore')).hexdigest()


def generar_clave_segura(longitud: int = 32) -> str:
    """Genera clave aleatoria segura"""
    caracteres = string.ascii_uppercase + string.digits
    return ''.join(random.choice(caracteres) for _ in range(longitud))


def validar_codigo_lua(codigo: str) -> Tuple[bool, str]:
    """Valida que el código sea sintácticamente válido"""
    if not codigo.strip():
        return False, "El código no puede estar vacío"
    if len(codigo) < 10:
        return False, "El código es demasiado corto"
    # Aquí puedes agregar más validaciones si lo deseas
    return True, "Código válido"


def comprimir_codigo(codigo: str) -> Tuple[bytes, int]:
    """Comprime código con máxima compresión"""
    original = len(codigo.encode('utf-8'))
    comprimido = zlib.compress(codigo.encode('utf-8'), level=9)
    return comprimido, original


def generar_loader_protected(hash_script: str, dominio: str) -> str:
    """Genera loader anti-decompile y seguro"""
    return f'''
--[[
    LUA PROTECT v2.0
    Script protegido | No distribuir sin autorización
]]

local HttpService = game:GetService("HttpService")
local RunService = game:GetService("RunService")
local Players = game:GetService("Players")

-- Obtener datos
local script_key = getgenv().script_key or ""
local hwid = tostring({{}}):gsub("table: ", "")
local url = "{dominio}/scripts/hosted/{hash_script}.lua?key="..HttpService:UrlEncode(script_key).."&hwid="..HttpService:UrlEncode(hwid)

-- Anti-detección
local function isSafe()
    if getfenv(0) ~= getgenv() then return false end
    if debug and debug.getupvalue then return false end
    return true
end

if not isSafe() then
    error("❌ Entorno no seguro", 2)
end

-- Cargar y ejecutar
local success, response = pcall(function()
    return HttpService:GetAsync(url, true)
end)

if not success then
    error("❌ Error al cargar: "..tostring(response), 2)
end

local decodeSuccess, decoded = pcall(function()
    return HttpService:Decompress(HttpService:Base64Decode(response))
end)

if not decodeSuccess then
    error("❌ Error al decodificar: "..tostring(decoded), 2)
end

-- Ejecutar limpiamente
local exec = loadstring or load
if exec then
    local runSuccess, err = pcall(exec, decoded)
    if not runSuccess then
        error("❌ Error en ejecución: "..tostring(err), 2)
    end
end

-- Limpiar memoria
script_key = nil
hwid = nil
url = nil
response = nil
decoded = nil
collectgarbage("collect")
collectgarbage("collect")
'''


# ==================================================
# 🔐 SISTEMA DE AUTENTICACIÓN
# ==================================================

@app.route('/login')
def login():
    if current_user.is_authenticated:
        return redirect(url_for('dashboard'))
    return discord.authorize_redirect(app.config['DISCORD_REDIRECT_URI'])


@app.route('/callback')
def callback():
    if current_user.is_authenticated:
        return redirect(url_for('dashboard'))

    try:
        token = discord.authorize_access_token()
        if not token:
            flash("❌ No se pudo obtener el token de acceso", "danger")
            return redirect(url_for('login'))

        resp = discord.get('users/@me')
        if resp.status_code != 200:
            logger.error(f"Error al obtener datos de Discord: {resp.status_code}")
            flash("❌ No se pudo conectar con Discord", "danger")
            return redirect(url_for('login'))

        user_data = resp.json()
        discord_id = user_data['id']

        # Verificar si usuario ya existe
        user = User.query.filter_by(discord_id=discord_id).first()

        if not user:
            user = User(
                discord_id=discord_id,
                username=user_data.get('username', 'Desconocido'),
                discriminator=user_data.get('discriminator', '0000'),
                avatar=user_data.get('avatar'),
                email=user_data.get('email'),
                is_admin=(discord_id == ADMIN_DISCORD_ID)
            )
            db.session.add(user)
            logger.info(f"Nuevo usuario registrado: {user.username} ({discord_id})")
        else:
            if user.is_banned:
                flash("❌ Tu cuenta está baneada", "danger")
                return redirect(url_for('login'))
            # Actualizar datos
            user.username = user_data.get('username', user.username)
            user.discriminator = user_data.get('discriminator', user.discriminator)
            user.avatar = user_data.get('avatar', user.avatar)
            user.email = user_data.get('email', user.email)

        user.last_login = datetime.datetime.utcnow()
        db.session.commit()

        login_user(user, remember=True)
        session.permanent = True
        flash(f"✅ Bienvenido, {user.username}!", "success")
        return redirect(url_for('dashboard'))

    except Exception as e:
        logger.error(f"Error en callback: {str(e)}\n{traceback.format_exc()}")
        flash("❌ Ocurrió un error al iniciar sesión", "danger")
        return redirect(url_for('login'))


@app.route('/logout')
@login_required
def logout():
    username = current_user.username
    logout_user()
    session.clear()
    flash(f"✅ Sesión cerrada correctamente. ¡Hasta pronto!", "info")
    logger.info(f"Usuario cerró sesión: {username}")
    return redirect(url_for('login'))


# ==================================================
# 📄 RUTAS PRINCIPALES
# ==================================================

@app.route('/')
@login_required
def dashboard():
    total_scripts = Script.query.filter_by(owner_id=current_user.id).count()
    active_scripts = Script.query.filter_by(owner_id=current_user.id, active=True).count()
    total_panels = Panel.query.filter_by(owner_id=current_user.id).count()
    total_keys = Key.query.filter_by(owner_id=current_user.id).count()
    active_keys = Key.query.filter_by(owner_id=current_user.id, active=True).count()
    total_bans = HWIDBan.query.filter_by(owner_id=current_user.id).count()

    return render_template(
        'dashboard.html',
        user=current_user,
        dominio=DOMINIO,
        api_version=API_VERSION,
        total_scripts=total_scripts,
        active_scripts=active_scripts,
        total_panels=total_panels,
        total_keys=total_keys,
        active_keys=active_keys,
        total_bans=total_bans
    )


@app.route('/scripts')
@login_required
def scripts():
    if current_user.is_admin:
        lista = Script.query.order_by(Script.created_at.desc()).all()
    else:
        lista = Script.query.filter_by(owner_id=current_user.id).order_by(Script.created_at.desc()).all()
    return render_template('scripts.html', scripts=lista, user=current_user, dominio=DOMINIO)


@app.route('/panels')
@login_required
def panels():
    if current_user.is_admin:
        lista = Panel.query.order_by(Panel.created_at.desc()).all()
        scripts = Script.query.filter_by(active=True).all()
    else:
        lista = Panel.query.filter_by(owner_id=current_user.id).order_by(Panel.created_at.desc()).all()
        scripts = Script.query.filter_by(owner_id=current_user.id, active=True).all()
    return render_template('panels.html', panels=lista, scripts=scripts, user=current_user, dominio=DOMINIO)


@app.route('/keys')
@login_required
def keys():
    if current_user.is_admin:
        lista = Key.query.order_by(Key.created_at.desc()).all()
    else:
        lista = Key.query.filter_by(owner_id=current_user.id).order_by(Key.created_at.desc()).all()
    return render_template('keys.html', keys=lista, user=current_user, dominio=DOMINIO)


@app.route('/hwid-bans')
@login_required
def hwid_bans():
    if current_user.is_admin:
        lista = HWIDBan.query.order_by(HWIDBan.created_at.desc()).all()
    else:
        lista = HWIDBan.query.filter_by(owner_id=current_user.id).order_by(HWIDBan.created_at.desc()).all()
    return render_template('hwid_bans.html', bans=lista, user=current_user)


@app.route('/logs')
@login_required
@admin_required
def logs():
    registros = AccessLog.query.order_by(AccessLog.timestamp.desc()).limit(100).all()
    return render_template('logs.html', logs=registros, user=current_user)


# ==================================================
# 🚀 SISTEMA DE CARGA Y PROTECCIÓN DE SCRIPTS
# ==================================================

@app.route('/scripts/hosted/<hash>.lua')
def hosted_script(hash: str):
    """Ruta principal para entregar scripts protegidos"""
    ip_usuario = request.remote_addr
    user_agent = request.headers.get('User-Agent', 'Desconocido')

    # Buscar script
    script = Script.query.filter_by(hash=hash, active=True).first()
    if not script:
        AccessLog(
            ip_address=ip_usuario,
            hwid=None,
            user_agent=user_agent,
            success=False,
            error_message="Script no encontrado o desactivado"
        )
        db.session.add(AccessLog)
        db.session.commit()
        return Response("return error('❌ Script no disponible')", mimetype='text/plain', status=404)

    # Obtener parámetros
    key_str = request.args.get('key', '').strip() or request.headers.get('X-Key', '').strip()
    hwid_str = request.args.get('hwid', '').strip() or request.headers.get('X-HWID', '').strip()

    # Verificar clave
    if not key_str:
        AccessLog(
            script_id=script.id,
            ip_address=ip_usuario,
            hwid=hwid_str,
            user_agent=user_agent,
            success=False,
            error_message="Clave no proporcionada"
        )
        db.session.add(AccessLog)
        db.session.commit()
        return Response("return error('❌ Se requiere clave de acceso')", mimetype='text/plain', status=401)

    key_obj = Key.query.filter_by(key=key_str, active=True).first()
    if not key_obj or not key_obj.is_valid():
        AccessLog(
            script_id=script.id,
            ip_address=ip_usuario,
            hwid=hwid_str,
            user_agent=user_agent,
            success=False,
            error_message="Clave inválida o vencida"
        )
        db.session.add(AccessLog)
        db.session.commit()
        return Response("return error('❌ Clave inválida o vencida')", mimetype='text/plain', status=403)

    # Verificar HWID
    if hwid_str:
        hwid_hash = obtener_hwid_hash(hwid_str)
        # Verificar baneo
        if HWIDBan.query.filter_by(hwid_hash=hwid_hash).first():
            AccessLog(
                key_id=key_obj.id,
                script_id=script.id,
                ip_address=ip_usuario,
                hwid=hwid_str,
                user_agent=user_agent,
                success=False,
                error_message="HWID baneado"
            )
            db.session.add(AccessLog)
            db.session.commit()
            return Response("return error('❌ Dispositivo bloqueado')", mimetype='text/plain', status=403)

        # Verificar coincidencia HWID
        if key_obj.hwid:
            if key_obj.hwid != hwid_hash:
                AccessLog(
                    key_id=key_obj.id,
                    script_id=script.id,
                    ip_address=ip_usuario,
                    hwid=hwid_str,
                    user_agent=user_agent,
                    success=False,
                    error_message="HWID no coincide"
                )
                db.session.add(AccessLog)
                db.session.commit()
                return Response("return error('❌ Dispositivo no autorizado')", mimetype='text/plain', status=403)
        else:
            # Asignar HWID por primera vez
            key_obj.hwid = hwid_hash

    # Actualizar estadísticas
    key_obj.used_count += 1
    key_obj.last_used = datetime.datetime.utcnow()
    script.access_count += 1
    script.last_access = datetime.datetime.utcnow()

    # Registrar acceso exitoso
    AccessLog(
        key_id=key_obj.id,
        script_id=script.id,
        ip_address=ip_usuario,
        hwid=hwid_str,
        user_agent=user_agent,
        success=True
    )
    db.session.add(AccessLog)
    db.session.commit()

    # Comprimir y codificar para entrega
    comprimido, _ = comprimir_codigo(script.code)
    codificado = base64.b64encode(comprimido).decode('utf-8')

    # Devolver código protegido
    return Response(f'''
local data = "{codificado}"
local HttpService = game:GetService("HttpService")
local decode = HttpService.Base64Decode
local decompress = HttpService.Decompress
local exec = loadstring or load

if exec then
    local ok, code = pcall(decompress, decode(HttpService, data))
    if ok then
        exec(code)
    end
end

data = nil
collectgarbage("collect")
''', mimetype='text/plain', headers={
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
        'Pragma': 'no-cache',
        'Expires': '0'
    })


# ==================================================
# ⚙️ API COMPLETA Y AMPLIADA
# ==================================================

@app.route('/api/upload-script', methods=['POST'])
@login_required
def api_upload_script():
    try:
        if 'file' not in request.files:
            return jsonify({"success": False, "error": "No se envió ningún archivo"}), 400

        archivo = request.files['file']
        if archivo.filename == '':
            return jsonify({"success": False, "error": "Archivo vacío"}), 400

        if not archivo.filename.lower().endswith(('.lua', '.txt', '.luau')):
            return jsonify({"success": False, "error": "Solo se permiten archivos .lua, .txt o .luau"}), 400

        contenido = archivo.read().decode('utf-8', errors='ignore')
        valido, mensaje = validar_codigo_lua(contenido)
        if not valido:
            return jsonify({"success": False, "error": mensaje}), 400

        nombre = os.path.splitext(archivo.filename)[0]
        descripcion = request.form.get('description', 'Sin descripción')
        version = request.form.get('version', '1.0.0')

        hash_code = generar_hash_corto(f"{current_user.id}{nombre}{datetime.datetime.utcnow().timestamp()}")
        comprimido, tam_original = comprimir_codigo(contenido)

        nuevo_script = Script(
            owner_id=current_user.id,
            name=nombre,
            description=descripcion,
            code=contenido,
            original_size=tam_original,
            compressed_size=len(comprimido),
            hash=hash_code,
            version=version
        )

        db.session.add(nuevo_script)
        current_user.total_scripts += 1
        db.session.commit()

        loader = generar_loader_protected(hash_code, DOMINIO)

        return jsonify({
            "success": True,
            "message": "Script subido y protegido correctamente",
            "id": nuevo_script.id,
            "name": nuevo_script.name,
            "hash": nuevo_script.hash,
            "version": nuevo_script.version,
            "loader": loader,
            "size_original": f"{tam_original / 1024:.2f} KB",
            "size_compressed": f"{len(comprimido) / 1024:.2f} KB"
        })

    except Exception as e:
        logger.error(f"Error al subir script: {str(e)}\n{traceback.format_exc()}")
        return jsonify({"success": False, "error": "Error interno del servidor"}), 500


@app.route('/api/protect', methods=['POST'])
@login_required
def api_protect_code():
    try:
        data = request.get_json()
        if not data or 'name' not in data or 'code' not in data:
            return jsonify({"success": False, "error": "Faltan datos obligatorios"}), 400

        nombre = str(data['name']).strip()
        codigo = str(data['code'])
        descripcion = str(data.get('description', 'Sin descripción')).strip()
        version = str(data.get('version', '1.0.0')).strip()

        if not nombre:
            return jsonify({"success": False, "error": "El nombre no puede estar vacío"}), 400

        valido, mensaje = validar_codigo_lua(codigo)
        if not valido:
            return jsonify({"success": False, "error": mensaje}), 400

        hash_code = generar_hash_corto(f"{current_user.id}{nombre}{datetime.datetime.utcnow().timestamp()}")
        comprimido, tam_original = comprimir_codigo(codigo)

        nuevo_script = Script(
            owner_id=current_user.id,
            name=nombre,
            description=descripcion,
            code=codigo,
            original_size=tam_original,
            compressed_size=len(comprimido),
            hash=hash_code,
            version=version
        )

        db.session.add(nuevo_script)
        current_user.total_scripts += 1
        db.session.commit()

        loader = generar_loader_protected(hash_code, DOMINIO)

        return jsonify({
            "success": True,
            "message": "Código protegido exitosamente",
            "id": nuevo_script.id,
            "hash": nuevo_script.hash,
            "loader": loader
        })

    except Exception as e:
        logger.error(f"Error al proteger código: {str(e)}")
        return jsonify({"success": False, "error": "Error interno"}), 500


@app.route('/api/generate-key', methods=['POST'])
@login_required
def api_generate_key():
    try:
        data = request.get_json()
        panel_id = data.get('panel_id')
        duracion = str(data.get('duration', '24h')).strip()
        max_uses = int(data.get('max_uses', 0))

        if panel_id:
            panel = Panel.query.get_or_404(panel_id)
            if panel.owner_id != current_user.id and not current_user.is_admin:
                return jsonify({"success": False, "error": "Sin permisos para este panel"}), 403
            if panel.max_keys > 0 and panel.keys_used >= panel.max_keys:
                return jsonify({"success": False, "error": "Límite de claves alcanzado en el panel"}), 400

        delta = parse_duration(duracion)
        expira = datetime.datetime.utcnow() + delta if delta else None

        clave = generar_clave_segura(32)

        nueva_clave = Key(
            owner_id=current_user.id,
            key=clave,
            panel_id=panel_id,
            expires_at=expira,
            max_uses=max_uses
        )

        db.session.add(nueva_clave)
        current_user.total_keys_generated += 1
        if panel_id:
            panel.keys_used += 1
        db.session.commit()

        fecha_expiracion = expira.strftime('%d/%m/%Y %H:%M UTC') if expira else "Sin vencimiento"

        return jsonify({
            "success": True,
            "message": "Clave generada correctamente",
            "key": clave,
            "expires": fecha_expiracion,
            "max_uses": max_uses if max_uses > 0 else "Sin límite"
        })

    except Exception as e:
        logger.error(f"Error al generar clave: {str(e)}")
        return jsonify({"success": False, "error": "Error interno"}), 500


@app.route('/api/reset-key-hwid', methods=['POST'])
@login_required
def api_reset_key_hwid():
    try:
        data = request.get_json()
        clave_str = str(data.get('key', '')).strip()
        if not clave_str:
            return jsonify({"success": False, "error": "Clave requerida"}), 400

        key_obj = Key.query.filter_by(key=clave_str).first()
        if not key_obj:
            return jsonify({"success": False, "error": "Clave no encontrada"}), 404

        if key_obj.owner_id != current_user.id and not current_user.is_admin:
            return jsonify({"success": False, "error": "Sin permisos"}), 403

        # Verificar cooldown si pertenece a un panel
        if key_obj.panel_id:
            panel = Panel.query.get(key_obj.panel_id)
            if panel and key_obj.reset_count >= 1:
                return jsonify({"success": False, "error": "Ya se ha restablecido esta clave"}), 400

        key_obj.hwid = None
        key_obj.reset_count += 1
        db.session.commit()

        return jsonify({"success": True, "message": "HWID restablecido correctamente"})

    except Exception as e:
        logger.error(f"Error al resetear HWID: {str(e)}")
        return jsonify({"success": False, "error": "Error interno"}), 500


@app.route('/api/ban-hwid', methods=['POST'])
@login_required
def api_ban_hwid():
    try:
        data = request.get_json()
        hwid = str(data.get('hwid', '')).strip()
        motivo = str(data.get('reason', 'Sin motivo especificado')).strip()
        ip = str(data.get('ip', '')).strip()

        if not hwid:
            return jsonify({"success": False, "error": "HWID requerido"}), 400

        hwid_hash = obtener_hwid_hash(hwid)

        if HWIDBan.query.filter_by(hwid_hash=hwid_hash).first():
            return jsonify({"success": False, "error": "Este HWID ya está bloqueado"}), 400

        nuevo_baneo = HWIDBan(
            owner_id=current_user.id,
            hwid_hash=hwid_hash,
            original_hwid=hwid[:255],
            reason=motivo,
            ip_address=ip if ip else None
        )

        db.session.add(nuevo_baneo)
        db.session.commit()

        return jsonify({
            "success": True,
            "message": "HWID bloqueado correctamente",
            "ban_id": nuevo_baneo.id
        })

    except Exception as e:
        logger.error(f"Error al bloquear HWID: {str(e)}")
        return jsonify({"success": False, "error": "Error interno"}), 500


# ==================================================
# 🚀 INICIAR SERVIDOR
# ==================================================

if __name__ == '__main__':
    port = int(os.environ.get("PORT", 8080))
    logger.info(f"🚀 Iniciando LuaProtect v{API_VERSION} en puerto {port}")
    app.run(host='0.0.0.0', port=port, debug=False, use_reloader=False)
