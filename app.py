from flask import Flask, render_template, request, jsonify, redirect, url_for, flash, session, abort
from flask_sqlalchemy import SQLAlchemy
from flask_login import LoginManager, UserMixin, login_user, login_required, current_user, logout_user
from flask_cors import CORS
from werkzeug.middleware.proxy_fix import ProxyFix
from functools import wraps
from datetime import datetime, timedelta
import os
import random
import string
import zlib
import base64
import hashlib
import logging
import re
import json
import requests
from typing import Optional, Dict, Any, List, Tuple

# ============================================================
# 1. CONFIGURACIÓN ULTRA SEGURA
# ============================================================

app = Flask(__name__)
app.wsgi_app = ProxyFix(app.wsgi_app, x_proto=1, x_host=1)

# Claves desde variables de entorno
app.config['SECRET_KEY'] = os.getenv("SECRET_KEY")
if not app.config['SECRET_KEY']:
    raise ValueError("❌ SECRET_KEY no está configurada")

app.config['SQLALCHEMY_DATABASE_URI'] = os.getenv("DATABASE_URL", "sqlite:///luaprotect_ultimate.db")
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
app.config['SQLALCHEMY_ENGINE_OPTIONS'] = {
    'pool_size': 20,
    'pool_recycle': 3600,
    'pool_pre_ping': True,
}

# 🔥 SIN LÍMITE DE MB
app.config['MAX_CONTENT_LENGTH'] = None  # Sin límite

# Configuración de sesión ultra segura
app.config['SESSION_COOKIE_SECURE'] = True
app.config['SESSION_COOKIE_HTTPONLY'] = True
app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'
app.config['PERMANENT_SESSION_LIFETIME'] = timedelta(days=30)
app.config['SESSION_COOKIE_DOMAIN'] = None

# Variables de Discord
DISCORD_CLIENT_ID = os.getenv("DISCORD_CLIENT_ID")
DISCORD_CLIENT_SECRET = os.getenv("DISCORD_CLIENT_SECRET")
DOMINIO = os.getenv("DOMINIO", "https://protegetuscriptlua-production.up.railway.app")
ADMIN_DISCORD_ID = os.getenv("ADMIN_DISCORD_ID", "1501316920975036611")

if not DISCORD_CLIENT_ID or not DISCORD_CLIENT_SECRET:
    raise ValueError("❌ DISCORD_CLIENT_ID y DISCORD_CLIENT_SECRET son obligatorios")

# Configuración de la API
API_CONFIG = {
    'KEY_LENGTH': 32,
    'HASH_LENGTH': 16,
    'MAX_KEYS_PER_USER': 999999,  # Ilimitado para admin
    'MAX_SCRIPTS_PER_USER': 999999,  # Ilimitado
    'HWID_MIN_LENGTH': 5,
    'RATE_LIMIT': 100,
    'CACHE_TIMEOUT': 300,
}

# ============================================================
# 2. LOGGING PROFESIONAL
# ============================================================

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('luaprotect.log'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger("LuauProtect")

# ============================================================
# 3. INICIALIZACIÓN
# ============================================================

db = SQLAlchemy(app)
login_manager = LoginManager(app)
login_manager.login_view = 'login'
login_manager.login_message = "🔐 Inicia sesión con Discord"
CORS(app, origins=[DOMINIO, "https://*.roblox.com", "http://localhost:*"], supports_credentials=True)

# ============================================================
# 4. MODELOS ULTRA OPTIMIZADOS
# ============================================================

class User(UserMixin, db.Model):
    __tablename__ = 'users'
    
    id = db.Column(db.Integer, primary_key=True)
    discord_id = db.Column(db.String(32), unique=True, nullable=False, index=True)
    username = db.Column(db.String(100), nullable=False)
    email = db.Column(db.String(255))
    avatar = db.Column(db.String(255))
    is_admin = db.Column(db.Boolean, default=False, index=True)
    is_active = db.Column(db.Boolean, default=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    last_login = db.Column(db.DateTime)
    login_count = db.Column(db.Integer, default=0)
    
    scripts = db.relationship('Script', backref='owner', lazy='dynamic')
    licenses = db.relationship('License', backref='creator', lazy='dynamic')
    
    def to_dict(self):
        return {
            'id': self.discord_id,
            'username': self.username,
            'email': self.email,
            'avatar': self.avatar,
            'is_admin': self.is_admin,
            'created_at': self.created_at.isoformat()
        }

class Script(db.Model):
    __tablename__ = 'scripts'
    
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(255), nullable=False)
    hash_id = db.Column(db.String(32), unique=True, nullable=False, index=True)
    content = db.Column(db.Text, nullable=False)
    content_hash = db.Column(db.String(64))
    description = db.Column(db.Text)
    active = db.Column(db.Boolean, default=True, index=True)
    version = db.Column(db.Integer, default=1)
    owner_id = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=False, index=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    downloads = db.Column(db.Integer, default=0)
    size_mb = db.Column(db.Float, default=0.0)  # Tamaño en MB
    
    licenses = db.relationship('License', backref='script_ref', lazy='dynamic')
    
    def to_dict(self):
        return {
            'id': self.hash_id,
            'name': self.name,
            'description': self.description,
            'version': self.version,
            'active': self.active,
            'downloads': self.downloads,
            'size_mb': self.size_mb,
            'created_at': self.created_at.isoformat(),
            'updated_at': self.updated_at.isoformat()
        }

class License(db.Model):
    __tablename__ = 'licenses'
    
    id = db.Column(db.Integer, primary_key=True)
    key = db.Column(db.String(64), unique=True, nullable=False, index=True)
    hwid = db.Column(db.String(128))
    script_hash = db.Column(db.String(32), db.ForeignKey('scripts.hash_id'), nullable=False, index=True)
    active = db.Column(db.Boolean, default=True, index=True)
    max_uses = db.Column(db.Integer, default=999999)  # 🔥 ILIMITADO
    used_count = db.Column(db.Integer, default=0)
    expires_at = db.Column(db.DateTime)
    created_by = db.Column(db.Integer, db.ForeignKey('users.id'))
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    last_used = db.Column(db.DateTime)
    
    def is_valid(self) -> bool:
        if not self.active:
            return False
        if self.expires_at and self.expires_at < datetime.utcnow():
            return False
        # 🔥 SIN LÍMITE DE USOS
        return True
    
    def use(self, hwid: str) -> bool:
        if not self.is_valid():
            return False
        if not self.hwid:
            self.hwid = hwid
        elif self.hwid != hwid:
            return False
        self.used_count += 1
        self.last_used = datetime.utcnow()
        db.session.commit()
        return True
    
    def to_dict(self):
        return {
            'key': self.key,
            'hwid': self.hwid,
            'script_hash': self.script_hash,
            'active': self.active,
            'max_uses': 'Ilimitado' if self.max_uses >= 999999 else self.max_uses,
            'used_count': self.used_count,
            'expires_at': self.expires_at.isoformat() if self.expires_at else None,
            'created_at': self.created_at.isoformat()
        }

class AccessLog(db.Model):
    __tablename__ = 'access_logs'
    
    id = db.Column(db.Integer, primary_key=True)
    key_hash = db.Column(db.String(64), index=True)
    hwid = db.Column(db.String(128))
    ip = db.Column(db.String(45))
    user_agent = db.Column(db.String(255))
    script_hash = db.Column(db.String(32), index=True)
    success = db.Column(db.Boolean, default=False)
    error_message = db.Column(db.String(100))
    timestamp = db.Column(db.DateTime, default=datetime.utcnow, index=True)

class HWIDBan(db.Model):
    __tablename__ = 'hwid_bans'
    
    id = db.Column(db.Integer, primary_key=True)
    hwid = db.Column(db.String(128), unique=True, nullable=False, index=True)
    reason = db.Column(db.String(255))
    created_by = db.Column(db.Integer, db.ForeignKey('users.id'))
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

@login_manager.user_loader
def load_user(user_id):
    return User.query.get(int(user_id))

# ============================================================
# 5. DECORADORES
# ============================================================

def admin_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if not current_user.is_authenticated or not current_user.is_admin:
            abort(403)
        return f(*args, **kwargs)
    return decorated_function

# ============================================================
# 6. FUNCIONES AUXILIARES
# ============================================================

def generar_hash(longitud: int = 16) -> str:
    return ''.join(random.choices(string.ascii_letters + string.digits, k=longitud))

def generar_clave() -> str:
    return ''.join(random.choices(string.ascii_uppercase + string.digits, k=API_CONFIG['KEY_LENGTH']))

def comprimir_codigo(codigo: str) -> str:
    return base64.b64encode(zlib.compress(codigo.encode('utf-8'), level=9)).decode('utf-8')

def descomprimir_codigo(codigo_comprimido: str) -> Optional[str]:
    try:
        return zlib.decompress(base64.b64decode(codigo_comprimido)).decode('utf-8')
    except:
        return None

def validar_hwid(hwid: str) -> bool:
    if not hwid or len(hwid) < API_CONFIG['HWID_MIN_LENGTH']:
        return False
    return bool(re.match(r'^[A-Za-z0-9\-_]+$', hwid))

def obtener_ip_segura() -> str:
    if request.headers.get('X-Forwarded-For'):
        return request.headers.get('X-Forwarded-For').split(',')[0].strip()
    return request.remote_addr or '0.0.0.0'

def calcular_expiracion(duration: str) -> Optional[datetime]:
    if duration == '0':
        return None
    try:
        value = int(duration[:-1])
        unit = duration[-1]
        if unit == 'h':
            return datetime.utcnow() + timedelta(hours=value)
        elif unit == 'd':
            return datetime.utcnow() + timedelta(days=value)
        elif unit == 'y':
            return datetime.utcnow() + timedelta(days=value*365)
        elif unit == 'm':
            return datetime.utcnow() + timedelta(days=value*30)
    except:
        return datetime.utcnow() + timedelta(days=30)
    return datetime.utcnow() + timedelta(days=30)

# ============================================================
# 7. RUTAS PRINCIPALES (Login sin CSRF)
# ============================================================

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/login')
def login():
    try:
        session.permanent = True
        session.modified = True
        redirect_uri = f'{DOMINIO}/callback'
        discord_url = (
            f'https://discord.com/api/oauth2/authorize'
            f'?client_id={DISCORD_CLIENT_ID}'
            f'&redirect_uri={redirect_uri}'
            f'&response_type=code'
            f'&scope=identify'
        )
        return redirect(discord_url)
    except Exception as e:
        logger.error(f"Error en login: {str(e)}")
        return f"Error al iniciar sesión: {str(e)}"

@app.route('/callback')
def callback():
    try:
        code = request.args.get('code')
        if not code:
            return "Error: No se recibió código", 400
        
        data = {
            'client_id': DISCORD_CLIENT_ID,
            'client_secret': DISCORD_CLIENT_SECRET,
            'grant_type': 'authorization_code',
            'code': code,
            'redirect_uri': f'{DOMINIO}/callback'
        }
        
        headers = {'Content-Type': 'application/x-www-form-urlencoded'}
        response = requests.post('https://discord.com/api/oauth2/token', data=data, headers=headers)
        token_data = response.json()
        
        if 'access_token' not in token_data:
            return f"Error obteniendo token: {token_data}", 400
        
        user_headers = {'Authorization': f'Bearer {token_data["access_token"]}'}
        user_response = requests.get('https://discord.com/api/users/@me', headers=user_headers)
        user_data = user_response.json()
        
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
            db.session.commit()
            logger.info(f"Nuevo usuario: {username} ({discord_id})")
        
        user.last_login = datetime.utcnow()
        user.login_count += 1
        db.session.commit()
        
        login_user(user, remember=True)
        session.permanent = True
        
        return redirect(url_for('dashboard'))
    except Exception as e:
        logger.error(f"Error en callback: {str(e)}")
        return f"Error en callback: {str(e)}"

@app.route('/logout')
@login_required
def logout():
    logout_user()
    session.clear()
    return redirect(url_for('index'))

# ============================================================
# 8. DASHBOARD Y GESTIÓN DE SCRIPTS
# ============================================================

@app.route('/dashboard')
@login_required
def dashboard():
    if current_user.is_admin:
        scripts = Script.query.order_by(Script.created_at.desc()).all()
        licenses = License.query.order_by(License.created_at.desc()).all()
        users = User.query.all()
    else:
        scripts = Script.query.filter_by(owner_id=current_user.id).order_by(Script.created_at.desc()).all()
        licenses = License.query.filter_by(created_by=current_user.id).order_by(License.created_at.desc()).all()
        users = []
    
    stats = {
        'total_scripts': Script.query.count(),
        'active_scripts': Script.query.filter_by(active=True).count(),
        'total_licenses': License.query.count(),
        'active_licenses': License.query.filter_by(active=True).count(),
        'total_users': User.query.count(),
        'admin_users': User.query.filter_by(is_admin=True).count(),
        'total_access': AccessLog.query.count(),
        'success_access': AccessLog.query.filter_by(success=True).count(),
        'total_downloads': db.session.query(db.func.sum(Script.downloads)).scalar() or 0
    }
    
    return render_template('dashboard.html', 
                          user=current_user, 
                          scripts=scripts, 
                          licenses=licenses,
                          users=users,
                          stats=stats)

@app.route('/scripts')
@login_required
def scripts_page():
    if current_user.is_admin:
        scripts = Script.query.order_by(Script.created_at.desc()).all()
    else:
        scripts = Script.query.filter_by(owner_id=current_user.id).order_by(Script.created_at.desc()).all()
    
    return render_template('scripts.html', 
                          user=current_user, 
                          scripts=scripts, 
                          dominio=DOMINIO)

@app.route('/keys')
@login_required
def keys_page():
    if current_user.is_admin:
        scripts = Script.query.all()
        licenses = License.query.order_by(License.created_at.desc()).all()
    else:
        scripts = Script.query.filter_by(owner_id=current_user.id).all()
        licenses = License.query.filter_by(created_by=current_user.id).order_by(License.created_at.desc()).all()
    
    keys_data = []
    for lic in licenses:
        script = Script.query.filter_by(hash_id=lic.script_hash).first()
        keys_data.append({
            'key': lic.key,
            'script_name': script.name if script else 'Desconocido',
            'hwid': lic.hwid,
            'expires_at': lic.expires_at,
            'active': lic.active,
            'max_uses': 'Ilimitado' if lic.max_uses >= 999999 else lic.max_uses,
            'used_count': lic.used_count,
            'created_at': lic.created_at
        })
    
    return render_template('keys.html', 
                          user=current_user, 
                          keys=keys_data,
                          scripts=scripts)

@app.route('/protector')
@login_required
def protector_page():
    if current_user.is_admin:
        scripts = Script.query.order_by(Script.created_at.desc()).all()
    else:
        scripts = Script.query.filter_by(owner_id=current_user.id).order_by(Script.created_at.desc()).all()
    
    return render_template('protector.html', 
                          user=current_user, 
                          scripts=scripts)

@app.route('/hwid-bans')
@login_required
@admin_required
def hwid_bans_page():
    bans = HWIDBan.query.order_by(HWIDBan.created_at.desc()).all()
    return render_template('hwid_bans.html', user=current_user, bans=bans)

@app.route('/users')
@login_required
@admin_required
def users_page():
    usuarios = User.query.order_by(User.created_at.desc()).all()
    return render_template('users.html', user=current_user, usuarios=usuarios)

@app.route('/loader/<hash_id>')
@login_required
def view_loader(hash_id):
    script = Script.query.filter_by(hash_id=hash_id).first_or_404()
    loader = f'loadstring(game:HttpGet("{DOMINIO}/api/load/{hash_id}?key=TU_CLAVE&hwid="..tostring({{}}):gsub("table: ","")))()'
    return render_template('loader.html', script=script, loader=loader)

# ============================================================
# 9. API - PROTECCIÓN DE SCRIPTS (SIN LÍMITE DE MB)
# ============================================================

@app.route('/api/protect', methods=['POST'])
@login_required
def protect_script():
    try:
        data = request.get_json()
        nombre = data.get('name', '').strip()
        codigo = data.get('code', '').strip()
        killswitch = data.get('killswitch', True)
        compression = data.get('compression', True)
        description = data.get('description', '').strip()
        
        if not nombre or not codigo:
            return jsonify({'success': False, 'error': 'Nombre y código son requeridos'})
        
        if len(codigo) < 10:
            return jsonify({'success': False, 'error': 'El código debe tener al menos 10 caracteres'})
        
        # 🔥 SIN LÍMITE DE SCRIPTS PARA ADMIN
        if not current_user.is_admin:
            script_count = Script.query.filter_by(owner_id=current_user.id).count()
            if script_count >= API_CONFIG['MAX_SCRIPTS_PER_USER']:
                return jsonify({'success': False, 'error': f'Límite de {API_CONFIG["MAX_SCRIPTS_PER_USER"]} scripts alcanzado'})
        
        hash_id = generar_hash(API_CONFIG['HASH_LENGTH'])
        while Script.query.filter_by(hash_id=hash_id).first():
            hash_id = generar_hash(API_CONFIG['HASH_LENGTH'])
        
        # 🔥 CALCULAR TAMAÑO EN MB
        size_bytes = len(codigo.encode('utf-8'))
        size_mb = round(size_bytes / (1024 * 1024), 2)
        
        contenido = comprimir_codigo(codigo) if compression else base64.b64encode(codigo.encode()).decode()
        content_hash = hashlib.sha256(codigo.encode()).hexdigest()
        
        nuevo = Script(
            name=nombre,
            hash_id=hash_id,
            content=contenido,
            content_hash=content_hash,
            description=description,
            active=killswitch,
            owner_id=current_user.id,
            version=1,
            size_mb=size_mb
        )
        db.session.add(nuevo)
        db.session.commit()
        
        loader = f'loadstring(game:HttpGet("{DOMINIO}/api/load/{hash_id}?key=TU_CLAVE&hwid="..tostring({{}}):gsub("table: ","")))()'
        
        logger.info(f"Script protegido: {hash_id} por {current_user.username} ({size_mb}MB)")
        
        return jsonify({
            'success': True,
            'hash_id': hash_id,
            'loader': loader,
            'version': 1,
            'active': killswitch,
            'size_mb': size_mb
        })
    except Exception as e:
        logger.error(f"Error protegiendo script: {str(e)}")
        return jsonify({'success': False, 'error': str(e)})

@app.route('/api/load/<hash_id>')
def load_script(hash_id):
    try:
        key = request.args.get('key', '').strip()
        hwid = request.args.get('hwid', '').strip()
        
        if not key:
            return "error: clave requerida", 400
        
        if not validar_hwid(hwid):
            return "error: HWID inválido", 400
        
        if HWIDBan.query.filter_by(hwid=hwid).first():
            return "error: HWID baneado", 403
        
        script = Script.query.filter_by(hash_id=hash_id, active=True).first()
        if not script:
            return "error: script no encontrado", 404
        
        lic = License.query.filter_by(key=key, script_hash=hash_id, active=True).first()
        if not lic:
            AccessLog(key_hash=hashlib.md5(key.encode()).hexdigest()[:16], 
                     hwid=hwid, ip=obtener_ip_segura(), 
                     script_hash=hash_id, success=False, 
                     error_message="licencia_invalida")
            db.session.commit()
            return "error: licencia inválida", 401
        
        if not lic.is_valid():
            error_msg = "licencia_expirada" if lic.expires_at and lic.expires_at < datetime.utcnow() else "licencia_inactiva"
            AccessLog(key_hash=hashlib.md5(key.encode()).hexdigest()[:16], 
                     hwid=hwid, ip=obtener_ip_segura(), 
                     script_hash=hash_id, success=False, 
                     error_message=error_msg)
            db.session.commit()
            return f"error: {error_msg}", 401
        
        if lic.hwid and lic.hwid != hwid:
            AccessLog(key_hash=hashlib.md5(key.encode()).hexdigest()[:16], 
                     hwid=hwid, ip=obtener_ip_segura(), 
                     script_hash=hash_id, success=False, 
                     error_message="hwid_mismatch")
            db.session.commit()
            return "error: HWID no coincide", 401
        
        if not lic.use(hwid):
            return "error: error al usar licencia", 500
        
        script.downloads += 1
        db.session.commit()
        
        AccessLog(key_hash=hashlib.md5(key.encode()).hexdigest()[:16], 
                 hwid=hwid, ip=obtener_ip_segura(), 
                 script_hash=hash_id, success=True)
        db.session.commit()
        
        logger.info(f"Script cargado: {hash_id} por HWID {hwid[:8]}...")
        
        return script.content
    except Exception as e:
        logger.error(f"Error cargando script: {str(e)}")
        return f"error: {str(e)}", 500

@app.route('/api/upload-script', methods=['POST'])
@login_required
def upload_script():
    try:
        if 'file' not in request.files:
            return jsonify({'success': False, 'error': 'No se envió ningún archivo'})
        
        file = request.files['file']
        if file.filename == '':
            return jsonify({'success': False, 'error': 'Archivo vacío'})
        
        # 🔥 ACEPTAR CUALQUIER EXTENSIÓN
        contenido = file.read().decode('utf-8')
        nombre = file.filename.rsplit('.', 1)[0]
        
        # 🔥 SIN LÍMITE DE TAMAÑO
        size_bytes = len(contenido.encode('utf-8'))
        size_mb = round(size_bytes / (1024 * 1024), 2)
        
        hash_id = generar_hash(API_CONFIG['HASH_LENGTH'])
        while Script.query.filter_by(hash_id=hash_id).first():
            hash_id = generar_hash(API_CONFIG['HASH_LENGTH'])
        
        contenido_comprimido = comprimir_codigo(contenido)
        
        nuevo = Script(
            name=nombre,
            hash_id=hash_id,
            content=contenido_comprimido,
            owner_id=current_user.id,
            size_mb=size_mb
        )
        db.session.add(nuevo)
        db.session.commit()
        
        loader = f'loadstring(game:HttpGet("{DOMINIO}/api/load/{hash_id}?key=TU_CLAVE&hwid="..tostring({{}}):gsub("table: ","")))()'
        
        return jsonify({
            'success': True,
            'name': nombre,
            'hash_id': hash_id,
            'loader': loader,
            'size_mb': size_mb
        })
    except Exception as e:
        logger.error(f"Error subiendo script: {str(e)}")
        return jsonify({'success': False, 'error': str(e)})

# ============================================================
# 10. API - GENERACIÓN DE KEYS (ILIMITADAS)
# ============================================================

@app.route('/api/generate-key', methods=['POST'])
@login_required
def generate_key():
    try:
        data = request.get_json()
        script_hash = data.get('script_hash', '').strip()
        duration = data.get('duration', '30d')
        max_uses = int(data.get('max_uses', 999999))  # 🔥 ILIMITADO POR DEFECTO
        
        if not script_hash:
            return jsonify({'success': False, 'error': 'Script hash es requerido'})
        
        script = Script.query.filter_by(hash_id=script_hash).first()
        if not script:
            return jsonify({'success': False, 'error': 'Script no encontrado'})
        
        # 🔥 SIN LÍMITE DE KEYS PARA ADMIN
        if not current_user.is_admin:
            key_count = License.query.filter_by(created_by=current_user.id).count()
            if key_count >= API_CONFIG['MAX_KEYS_PER_USER']:
                return jsonify({'success': False, 'error': f'Límite de {API_CONFIG["MAX_KEYS_PER_USER"]} claves alcanzado'})
        
        expires_at = calcular_expiracion(duration)
        
        clave = generar_clave()
        while License.query.filter_by(key=clave).first():
            clave = generar_clave()
        
        nueva = License(
            key=clave,
            script_hash=script_hash,
            max_uses=max_uses if max_uses < 999999 else 999999,  # 🔥 ILIMITADO
            expires_at=expires_at,
            created_by=current_user.id
        )
        db.session.add(nueva)
        db.session.commit()
        
        logger.info(f"Clave generada: {clave} para {script_hash} por {current_user.username}")
        
        return jsonify({
            'success': True,
            'key': clave,
            'expires_at': expires_at.isoformat() if expires_at else None,
            'max_uses': 'Ilimitado' if max_uses >= 999999 else max_uses
        })
    except Exception as e:
        logger.error(f"Error generando clave: {str(e)}")
        return jsonify({'success': False, 'error': str(e)})

@app.route('/api/toggle-key', methods=['POST'])
@login_required
def toggle_key():
    try:
        data = request.get_json()
        key = data.get('key', '').strip()
        
        lic = License.query.filter_by(key=key).first()
        if not lic:
            return jsonify({'success': False, 'error': 'Licencia no encontrada'})
        
        if not current_user.is_admin:
            script = Script.query.filter_by(hash_id=lic.script_hash).first()
            if not script or script.owner_id != current_user.id:
                return jsonify({'success': False, 'error': 'No tienes permiso'})
        
        lic.active = not lic.active
        db.session.commit()
        
        return jsonify({
            'success': True,
            'active': lic.active
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

@app.route('/api/reset-key-hwid', methods=['POST'])
@login_required
def reset_key_hwid():
    try:
        data = request.get_json()
        key = data.get('key', '').strip()
        
        lic = License.query.filter_by(key=key).first()
        if not lic:
            return jsonify({'success': False, 'error': 'Licencia no encontrada'})
        
        if not current_user.is_admin:
            script = Script.query.filter_by(hash_id=lic.script_hash).first()
            if not script or script.owner_id != current_user.id:
                return jsonify({'success': False, 'error': 'No tienes permiso'})
        
        lic.hwid = None
        db.session.commit()
        
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

@app.route('/api/verify/<key>')
def verify_key(key):
    try:
        lic = License.query.filter_by(key=key).first()
        if not lic:
            return jsonify({'valid': False, 'error': 'Licencia no encontrada'}), 404
        
        if not lic.active:
            return jsonify({'valid': False, 'error': 'Licencia inactiva'}), 401
        
        if lic.expires_at and lic.expires_at < datetime.utcnow():
            lic.active = False
            db.session.commit()
            return jsonify({'valid': False, 'error': 'Licencia expirada'}), 401
        
        script = Script.query.filter_by(hash_id=lic.script_hash).first()
        
        return jsonify({
            'valid': True,
            'script': script.name if script else 'Unknown',
            'hash': lic.script_hash,
            'expires_at': lic.expires_at.isoformat() if lic.expires_at else None,
            'used_count': lic.used_count,
            'max_uses': 'Ilimitado' if lic.max_uses >= 999999 else lic.max_uses
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# ============================================================
# 11. API - GESTIÓN DE SCRIPTS (ADMIN VE TODO)
# ============================================================

@app.route('/api/toggle-script/<hash_id>', methods=['POST'])
@login_required
def toggle_script(hash_id):
    try:
        script = Script.query.filter_by(hash_id=hash_id).first()
        if not script:
            return jsonify({'success': False, 'error': 'Script no encontrado'})
        
        if not current_user.is_admin and script.owner_id != current_user.id:
            return jsonify({'success': False, 'error': 'No tienes permiso'})
        
        script.active = not script.active
        script.updated_at = datetime.utcnow()
        db.session.commit()
        
        return jsonify({
            'success': True,
            'active': script.active
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

@app.route('/api/delete-script/<hash_id>', methods=['POST'])
@login_required
def delete_script(hash_id):
    try:
        script = Script.query.filter_by(hash_id=hash_id).first()
        if not script:
            return jsonify({'success': False, 'error': 'Script no encontrado'})
        
        if not current_user.is_admin and script.owner_id != current_user.id:
            return jsonify({'success': False, 'error': 'No tienes permiso'})
        
        License.query.filter_by(script_hash=hash_id).delete()
        db.session.delete(script)
        db.session.commit()
        
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

# ============================================================
# 12. API - HWID BANS
# ============================================================

@app.route('/api/ban-hwid', methods=['POST'])
@login_required
@admin_required
def ban_hwid():
    try:
        data = request.get_json()
        hwid = data.get('hwid', '').strip()
        reason = data.get('reason', '').strip()
        
        if not hwid or len(hwid) < 5:
            return jsonify({'success': False, 'error': 'HWID inválido'})
        
        if HWIDBan.query.filter_by(hwid=hwid).first():
            return jsonify({'success': False, 'error': 'HWID ya está baneado'})
        
        ban = HWIDBan(
            hwid=hwid,
            reason=reason,
            created_by=current_user.id
        )
        db.session.add(ban)
        db.session.commit()
        
        logger.info(f"HWID baneado: {hwid} por {current_user.username}")
        
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

@app.route('/api/unban-hwid', methods=['POST'])
@login_required
@admin_required
def unban_hwid():
    try:
        data = request.get_json()
        hwid = data.get('hwid', '').strip()
        
        ban = HWIDBan.query.filter_by(hwid=hwid).first()
        if not ban:
            return jsonify({'success': False, 'error': 'HWID no encontrado'})
        
        db.session.delete(ban)
        db.session.commit()
        
        logger.info(f"HWID desbaneado: {hwid} por {current_user.username}")
        
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

# ============================================================
# 13. API - GESTIÓN DE USUARIOS
# ============================================================

@app.route('/api/toggle-admin', methods=['POST'])
@login_required
@admin_required
def toggle_admin():
    try:
        data = request.get_json()
        discord_id = data.get('discord_id', '').strip()
        
        if not discord_id:
            return jsonify({'success': False, 'error': 'ID de Discord requerido'})
        
        user = User.query.filter_by(discord_id=discord_id).first()
        if not user:
            return jsonify({'success': False, 'error': 'Usuario no encontrado'})
        
        if user.discord_id == ADMIN_DISCORD_ID:
            return jsonify({'success': False, 'error': 'No puedes cambiar el rol del admin principal'})
        
        user.is_admin = not user.is_admin
        db.session.commit()
        
        return jsonify({
            'success': True,
            'is_admin': user.is_admin
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

# ============================================================
# 14. ADMIN - PANEL COMPLETO
# ============================================================

@app.route('/admin')
@login_required
@admin_required
def admin_panel():
    scripts = Script.query.order_by(Script.created_at.desc()).all()
    licenses = License.query.order_by(License.created_at.desc()).all()
    users = User.query.order_by(User.created_at.desc()).all()
    logs = AccessLog.query.order_by(AccessLog.timestamp.desc()).limit(100).all()
    
    total_size = db.session.query(db.func.sum(Script.size_mb)).scalar() or 0
    
    stats = {
        'total_scripts': len(scripts),
        'total_licenses': len(licenses),
        'total_users': len(users),
        'total_logs': AccessLog.query.count(),
        'total_size_mb': round(total_size, 2),
        'active_scripts': len([s for s in scripts if s.active]),
        'active_licenses': len([l for l in licenses if l.active])
    }
    
    return render_template('admin.html', 
                          user=current_user,
                          scripts=scripts,
                          licenses=licenses,
                          users=users,
                          logs=logs,
                          stats=stats)

# ============================================================
# 15. MANEJO DE ERRORES
# ============================================================

@app.errorhandler(404)
def not_found(error):
    return jsonify({"error": "Recurso no encontrado"}), 404

@app.errorhandler(403)
def forbidden(error):
    return jsonify({"error": "No tienes permiso"}), 403

@app.errorhandler(500)
def internal_error(error):
    logger.error(f"Error 500: {str(error)}")
    return jsonify({"error": "Error interno del servidor"}), 500

# ============================================================
# 16. INICIALIZACIÓN
# ============================================================

with app.app_context():
    db.create_all()
    logger.info("📦 Base de datos inicializada")

if __name__ == '__main__':
    port = int(os.getenv("PORT", 5000))
    logger.info(f"🚀 LuauProtect Ultimate iniciado en puerto {port}")
    logger.info(f"🌐 Dominio: {DOMINIO}")
    app.run(host='0.0.0.0', port=port, debug=False)
