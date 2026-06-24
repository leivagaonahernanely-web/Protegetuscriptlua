from flask import Flask, render_template, request, jsonify, redirect, url_for, flash, Response, session, abort
from flask_sqlalchemy import SQLAlchemy
from flask_login import LoginManager, UserMixin, login_user, login_required, current_user, logout_user
from flask_cors import CORS
from authlib.integrations.flask_client import OAuth
from werkzeug.middleware.proxy_fix import ProxyFix
from functools import wraps
from datetime import datetime, timedelta
import os
import random
import string
import hashlib
import zlib
import base64
import logging
import re
from typing import Optional, Tuple, Dict, Any
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
import json

# ============================================================
# 1. CONFIGURACIÓN SEGURA Y ROBUSTA
# ============================================================

app = Flask(__name__)

# 🔒 Configuración de Proxy para Railway/HTTPS
app.wsgi_app = ProxyFix(app.wsgi_app, x_proto=1, x_host=1, x_for=1, x_port=1)
app.config['PREFERRED_URL_SCHEME'] = 'https'
app.config['FORCE_HTTPS'] = True

# 🍪 Sesiones ultra-seguras
app.config['SESSION_COOKIE_SECURE'] = True
app.config['SESSION_COOKIE_HTTPONLY'] = True
app.config['SESSION_COOKIE_SAMESITE'] = 'Strict'  # Más seguro que 'Lax'
app.config['PERMANENT_SESSION_LIFETIME'] = timedelta(days=30)
app.config['SESSION_COOKIE_NAME'] = 'LuaProtect_Secure_v2'

# 🔑 Claves desde variables de entorno (NUNCA hardcodeadas)
app.config['SECRET_KEY'] = os.getenv("SECRET_KEY")
if not app.config['SECRET_KEY']:
    raise ValueError("❌ SECRET_KEY no está configurada en variables de entorno")

# 📦 Base de datos
app.config['SQLALCHEMY_DATABASE_URI'] = os.getenv("DATABASE_URL", "sqlite:///luaprotect_pro.db")
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
app.config['SQLALCHEMY_ENGINE_OPTIONS'] = {
    'pool_size': 10,
    'pool_recycle': 3600,
    'pool_pre_ping': True,
}

# 📏 Límites de tamaño
app.config['MAX_CONTENT_LENGTH'] = 64 * 1024 * 1024  # 64MB

# 🔐 Variables de entorno OBLIGATORIAS
DISCORD_CLIENT_ID = os.getenv("DISCORD_CLIENT_ID")
DISCORD_CLIENT_SECRET = os.getenv("DISCORD_CLIENT_SECRET")
ADMIN_DISCORD_ID = os.getenv("ADMIN_DISCORD_ID", "1501316920975036611")
DOMINIO = os.getenv("DOMINIO", "https://protegetuscriptlua-production.up.railway.app")

if not DISCORD_CLIENT_ID or not DISCORD_CLIENT_SECRET:
    raise ValueError("❌ DISCORD_CLIENT_ID y DISCORD_CLIENT_SECRET son obligatorios")

# ⚙️ Configuración de la API
API_CONFIG = {
    'MAX_KEYS_PER_USER': 100,
    'KEY_LENGTH': 32,
    'SCRIPT_HASH_LENGTH': 16,
    'HWID_MIN_LENGTH': 10,
    'CACHE_TIMEOUT': 300,  # 5 minutos
    'RATE_LIMIT_PER_MINUTE': 10,
}

# ============================================================
# 2. INICIALIZACIÓN DE EXTENSIONES
# ============================================================

# 📊 Logging profesional
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('luaprotect.log'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger("LuaProtect")

# 🛡️ Rate Limiting
limiter = Limiter(
    app=app,
    key_func=get_remote_address,
    default_limits=["200 per day", "50 per hour"],
    storage_uri="memory://",
)

# 🗄️ Base de datos
db = SQLAlchemy(app)

# 🔐 Login Manager
login_manager = LoginManager(app)
login_manager.login_view = 'login'
login_manager.login_message = "🔐 Inicia sesión con Discord para continuar"
login_manager.login_message_category = "info"

# 🌐 CORS (restringido para seguridad)
CORS(app, origins=[
    "https://protegetuscriptlua-production.up.railway.app",
    "https://*.roblox.com",
    "http://localhost:5000"
], supports_credentials=True)

# 🔗 OAuth de Discord
oauth = OAuth(app)
discord = oauth.register(
    name='discord',
    client_id=DISCORD_CLIENT_ID,
    client_secret=DISCORD_CLIENT_SECRET,
    access_token_url='https://discord.com/api/oauth2/token',
    authorize_url='https://discord.com/api/oauth2/authorize',
    api_base_url='https://discord.com/api/',
    redirect_uri=f"{DOMINIO}/callback",
    client_kwargs={
        'scope': 'identify email',
        'prompt': 'consent',
        'token_endpoint_auth_method': 'client_secret_post'
    }
)

# ============================================================
# 3. MODELOS DE BASE DE DATOS (OPTIMIZADOS)
# ============================================================

class User(UserMixin, db.Model):
    __tablename__ = 'users'
    
    id = db.Column(db.Integer, primary_key=True)
    discord_id = db.Column(db.String(32), unique=True, nullable=False, index=True)
    username = db.Column(db.String(100), nullable=False)
    email = db.Column(db.String(255))
    avatar = db.Column(db.String(255))
    is_admin = db.Column(db.Boolean, default=False)
    is_active = db.Column(db.Boolean, default=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    last_login = db.Column(db.DateTime)
    login_count = db.Column(db.Integer, default=0)
    
    # Relaciones
    scripts = db.relationship('Script', backref='owner', lazy='dynamic')
    licenses = db.relationship('License', backref='creator', lazy='dynamic')
    
    def to_dict(self):
        return {
            'id': self.discord_id,
            'username': self.username,
            'avatar': self.avatar,
            'is_admin': self.is_admin,
            'created_at': self.created_at.isoformat()
        }

class Script(db.Model):
    __tablename__ = 'scripts'
    
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), nullable=False)
    hash_id = db.Column(db.String(32), unique=True, nullable=False, index=True)
    content = db.Column(db.Text, nullable=False)  # Ya comprimido
    content_hash = db.Column(db.String(64))  # SHA-256 para integridad
    version = db.Column(db.Integer, default=1)
    active = db.Column(db.Boolean, default=True, index=True)
    owner_id = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=False, index=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    downloads = db.Column(db.Integer, default=0)
    
    # Relaciones
    licenses = db.relationship('License', backref='script', lazy='dynamic')
    
    def to_dict(self):
        return {
            'id': self.hash_id,
            'name': self.name,
            'version': self.version,
            'active': self.active,
            'downloads': self.downloads,
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
    expires_at = db.Column(db.DateTime)
    max_uses = db.Column(db.Integer, default=1)
    used_count = db.Column(db.Integer, default=0)
    created_by = db.Column(db.Integer, db.ForeignKey('users.id'))
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    last_used = db.Column(db.DateTime)
    
    def is_valid(self) -> bool:
        """Verifica si la licencia es válida"""
        if not self.active:
            return False
        if self.expires_at and self.expires_at < datetime.utcnow():
            return False
        if self.used_count >= self.max_uses:
            return False
        return True
    
    def use(self, hwid: str) -> bool:
        """Registra un uso de la licencia"""
        if not self.is_valid():
            return False
        
        # Si no tiene HWID asignado, lo asigna (primera activación)
        if not self.hwid:
            self.hwid = hwid
        # Si ya tiene HWID, verifica que coincida
        elif self.hwid != hwid:
            return False
        
        self.used_count += 1
        self.last_used = datetime.utcnow()
        db.session.commit()
        return True

class AccessLog(db.Model):
    __tablename__ = 'access_logs'
    
    id = db.Column(db.Integer, primary_key=True)
    key_hash = db.Column(db.String(64))  # Hash de la clave (no la clave en texto)
    hwid = db.Column(db.String(128))
    ip = db.Column(db.String(45))
    user_agent = db.Column(db.String(255))
    script_hash = db.Column(db.String(32), index=True)
    success = db.Column(db.Boolean, default=False)
    error_message = db.Column(db.String(100))
    timestamp = db.Column(db.DateTime, default=datetime.utcnow, index=True)
    
    @classmethod
    def log(cls, key: str = None, hwid: str = None, script_hash: str = None, 
            success: bool = True, error: str = None, request_obj: Any = None):
        """Registra un acceso de forma segura"""
        log_entry = cls(
            key_hash=hashlib.sha256(key.encode()).hexdigest()[:16] if key else None,
            hwid=hwid[:128] if hwid else None,
            script_hash=script_hash,
            success=success,
            error_message=error[:100] if error else None
        )
        if request_obj:
            log_entry.ip = request_obj.remote_addr or '0.0.0.0'
            log_entry.user_agent = request_obj.headers.get('User-Agent', '')[:255]
        db.session.add(log_entry)
        db.session.commit()
        return log_entry

@login_manager.user_loader
def load_user(user_id):
    return User.query.get(int(user_id))

# ============================================================
# 4. DECORADORES DE SEGURIDAD
# ============================================================

def admin_required(f):
    """Decorador para rutas que solo admins pueden acceder"""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if not current_user.is_authenticated or not current_user.is_admin:
            abort(403)
        return f(*args, **kwargs)
    return decorated_function

def rate_limit_per_endpoint(limit: str):
    """Decorador para límites específicos por endpoint"""
    def decorator(f):
        @wraps(f)
        @limiter.limit(limit)
        def wrapped(*args, **kwargs):
            return f(*args, **kwargs)
        return wrapped
    return decorator

# ============================================================
# 5. FUNCIONES AUXILIARES
# ============================================================

def generar_hash(longitud: int = 16) -> str:
    """Genera un hash aleatorio seguro"""
    return ''.join(random.choices(string.ascii_letters + string.digits, k=longitud))

def generar_clave() -> str:
    """Genera una clave de licencia segura"""
    return ''.join(random.choices(string.ascii_uppercase + string.digits, k=API_CONFIG['KEY_LENGTH']))

def comprimir_codigo(codigo: str) -> str:
    """Comprime y codifica el código para almacenamiento"""
    compressed = zlib.compress(codigo.encode('utf-8'), level=9)
    return base64.b64encode(compressed).decode('utf-8')

def descomprimir_codigo(codigo_comprimido: str) -> str:
    """Descomprime y decodifica el código"""
    try:
        compressed = base64.b64decode(codigo_comprimido.encode('utf-8'))
        return zlib.decompress(compressed).decode('utf-8')
    except Exception as e:
        logger.error(f"Error descomprimiendo código: {e}")
        return ""

def validar_hwid(hwid: str) -> bool:
    """Valida el formato del HWID"""
    if not hwid or len(hwid) < API_CONFIG['HWID_MIN_LENGTH']:
        return False
    # Solo caracteres alfanuméricos, guiones y guiones bajos
    return bool(re.match(r'^[A-Za-z0-9\-_]+$', hwid))

def obtener_ip_segura():
    """Obtiene la IP real incluso detrás de proxies"""
    if request.headers.get('X-Forwarded-For'):
        return request.headers.get('X-Forwarded-For').split(',')[0].strip()
    return request.remote_addr or '0.0.0.0'

# ============================================================
# 6. RUTAS PRINCIPALES
# ============================================================

@app.route('/')
def index():
    """Página principal"""
    return render_template('index.html')

@app.route('/login')
def login():
    """Inicio de sesión con Discord"""
    try:
        # Redirige a Discord con configuración segura
        redirect_uri = f"{DOMINIO}/callback"
        return discord.authorize_redirect(redirect_uri)
    except Exception as e:
        logger.error(f"Error en login: {str(e)}")
        flash("❌ Error al iniciar sesión con Discord", "danger")
        return redirect(url_for('index'))

@app.route('/callback')
def callback():
    """Callback de Discord después de autenticación"""
    try:
        # Obtener token de acceso
        token = discord.authorize_access_token()
        logger.info("Token obtenido exitosamente")
        
        # Obtener datos del usuario
        resp = discord.get('users/@me')
        user_data = resp.json()
        
        # Obtener email si está disponible
        email_data = discord.get('users/@me', params={'with_email': 'true'}).json()
        
        discord_id = user_data['id']
        username = user_data['username']
        email = email_data.get('email', '')
        avatar = f"https://cdn.discordapp.com/avatars/{discord_id}/{user_data['avatar']}.png" if user_data.get('avatar') else ""
        
        # Buscar o crear usuario
        user = User.query.filter_by(discord_id=discord_id).first()
        if not user:
            user = User(
                discord_id=discord_id,
                username=username,
                email=email,
                avatar=avatar,
                is_admin=(discord_id == ADMIN_DISCORD_ID)
            )
            db.session.add(user)
            logger.info(f"Nuevo usuario creado: {username} (ID: {discord_id})")
        
        # Actualizar datos del usuario
        user.username = username
        user.email = email if email else user.email
        user.avatar = avatar if avatar else user.avatar
        user.last_login = datetime.utcnow()
        user.login_count += 1
        db.session.commit()
        
        # Iniciar sesión
        login_user(user, remember=True)
        session.permanent = True
        
        logger.info(f"Usuario logueado: {username} (Admin: {user.is_admin})")
        return redirect(url_for('dashboard'))
        
    except Exception as e:
        logger.error(f"Error en callback: {str(e)}")
        flash("❌ Error al procesar la autenticación", "danger")
        return redirect(url_for('index'))

@app.route('/logout')
@login_required
def logout():
    """Cerrar sesión"""
    logout_user()
    session.clear()
    flash("✅ Sesión cerrada correctamente", "success")
    return redirect(url_for('index'))

# ============================================================
# 7. DASHBOARD Y GESTIÓN
# ============================================================

@app.route('/dashboard')
@login_required
def dashboard():
    """Panel de control principal"""
    try:
        # Scripts del usuario (o todos si es admin)
        if current_user.is_admin:
            scripts = Script.query.order_by(Script.created_at.desc()).all()
            licenses = License.query.order_by(License.created_at.desc()).all()
        else:
            scripts = Script.query.filter_by(owner_id=current_user.id).order_by(Script.created_at.desc()).all()
            licenses = License.query.filter_by(created_by=current_user.id).order_by(License.created_at.desc()).all()
        
        stats = {
            'total_scripts': Script.query.count(),
            'total_licenses': License.query.count(),
            'total_users': User.query.count(),
            'total_access': AccessLog.query.count(),
        }
        
        return render_template(
            'dashboard.html', 
            user=current_user, 
            scripts=scripts, 
            licenses=licenses,
            stats=stats,
            dominio=DOMINIO
        )
    except Exception as e:
        logger.error(f"Error en dashboard: {str(e)}")
        flash("❌ Error al cargar el dashboard", "danger")
        return redirect(url_for('index'))

@app.route('/dashboard/scripts')
@login_required
def dashboard_scripts():
    """API para obtener scripts en JSON"""
    if current_user.is_admin:
        scripts = Script.query.all()
    else:
        scripts = Script.query.filter_by(owner_id=current_user.id).all()
    return jsonify([s.to_dict() for s in scripts])

# ============================================================
# 8. GESTIÓN DE SCRIPTS (CRUD)
# ============================================================

@app.route('/scripts/new', methods=['POST'])
@login_required
@limiter.limit("5 per minute")
def new_script():
    """Crear un nuevo script"""
    try:
        nombre = request.form.get('name', '').strip()
        codigo = request.form.get('code', '').strip()
        
        if not nombre or not codigo:
            flash("❌ Nombre y código son obligatorios", "danger")
            return redirect(url_for('dashboard'))
        
        if len(codigo) < 10:
            flash("❌ El código debe tener al menos 10 caracteres", "danger")
            return redirect(url_for('dashboard'))
        
        # Generar hash único
        hash_id = generar_hash(API_CONFIG['SCRIPT_HASH_LENGTH'])
        while Script.query.filter_by(hash_id=hash_id).first():
            hash_id = generar_hash(API_CONFIG['SCRIPT_HASH_LENGTH'])
        
        # Comprimir y almacenar
        contenido_comprimido = comprimir_codigo(codigo)
        contenido_hash = hashlib.sha256(codigo.encode()).hexdigest()
        
        nuevo_script = Script(
            name=nombre,
            hash_id=hash_id,
            content=contenido_comprimido,
            content_hash=contenido_hash,
            owner_id=current_user.id
        )
        db.session.add(nuevo_script)
        db.session.commit()
        
        logger.info(f"Script creado: {hash_id} por {current_user.username}")
        flash(f"✅ Script '{nombre}' creado con ID: {hash_id}", "success")
        return redirect(url_for('dashboard'))
        
    except Exception as e:
        logger.error(f"Error creando script: {str(e)}")
        flash("❌ Error al crear el script", "danger")
        return redirect(url_for('dashboard'))

@app.route('/scripts/<hash_id>/edit', methods=['POST'])
@login_required
def edit_script(hash_id):
    """Editar un script existente"""
    try:
        script = Script.query.filter_by(hash_id=hash_id).first_or_404()
        
        # Verificar permisos
        if not current_user.is_admin and script.owner_id != current_user.id:
            abort(403)
        
        nombre = request.form.get('name', '').strip()
        codigo = request.form.get('code', '').strip()
        
        if not nombre or not codigo:
            flash("❌ Nombre y código son obligatorios", "danger")
            return redirect(url_for('dashboard'))
        
        # Actualizar
        script.name = nombre
        script.content = comprimir_codigo(codigo)
        script.content_hash = hashlib.sha256(codigo.encode()).hexdigest()
        script.version += 1
        script.updated_at = datetime.utcnow()
        db.session.commit()
        
        logger.info(f"Script actualizado: {hash_id} por {current_user.username}")
        flash(f"✅ Script '{nombre}' actualizado (v{script.version})", "success")
        return redirect(url_for('dashboard'))
        
    except Exception as e:
        logger.error(f"Error editando script: {str(e)}")
        flash("❌ Error al editar el script", "danger")
        return redirect(url_for('dashboard'))

@app.route('/scripts/<hash_id>/delete', methods=['POST'])
@login_required
def delete_script(hash_id):
    """Eliminar un script (soft delete)"""
    try:
        script = Script.query.filter_by(hash_id=hash_id).first_or_404()
        
        if not current_user.is_admin and script.owner_id != current_user.id:
            abort(403)
        
        # En lugar de eliminar, desactivamos
        script.active = False
        db.session.commit()
        
        logger.info(f"Script desactivado: {hash_id} por {current_user.username}")
        flash(f"✅ Script '{script.name}' desactivado", "success")
        return redirect(url_for('dashboard'))
        
    except Exception as e:
        logger.error(f"Error eliminando script: {str(e)}")
        flash("❌ Error al desactivar el script", "danger")
        return redirect(url_for('dashboard'))

# ============================================================
# 9. GESTIÓN DE LICENCIAS
# ============================================================

@app.route('/licenses/generate', methods=['POST'])
@login_required
@limiter.limit("10 per minute")
def generate_license():
    """Generar una nueva licencia"""
    try:
        script_hash = request.form.get('script_hash', '').strip()
        
        if not script_hash:
            flash("❌ Debes seleccionar un script", "danger")
            return redirect(url_for('dashboard'))
        
        script = Script.query.filter_by(hash_id=script_hash, active=True).first()
        if not script:
            flash("❌ Script no encontrado o inactivo", "danger")
            return redirect(url_for('dashboard'))
        
        # Verificar permisos
        if not current_user.is_admin and script.owner_id != current_user.id:
            abort(403)
        
        # Generar clave única
        clave = generar_clave()
        while License.query.filter_by(key=clave).first():
            clave = generar_clave()
        
        # Configurar expiración (30 días por defecto)
        days_valid = int(request.form.get('days_valid', 30))
        expires_at = datetime.utcnow() + timedelta(days=days_valid)
        
        nueva_licencia = License(
            key=clave,
            script_hash=script_hash,
            expires_at=expires_at,
            max_uses=1,
            created_by=current_user.id
        )
        db.session.add(nueva_licencia)
        db.session.commit()
        
        logger.info(f"Licencia generada: {clave} para script {script_hash} por {current_user.username}")
        
        # Respuesta JSON para mejor UX
        if request.headers.get('Accept') == 'application/json':
            return jsonify({
                'success': True,
                'key': clave,
                'script': script.name,
                'expires_at': expires_at.isoformat()
            })
        
        flash(f"✅ Licencia generada: <code>{clave}</code> para '{script.name}' (expira: {expires_at.strftime('%d/%m/%Y')})", "success")
        return redirect(url_for('dashboard'))
        
    except Exception as e:
        logger.error(f"Error generando licencia: {str(e)}")
        flash("❌ Error al generar la licencia", "danger")
        return redirect(url_for('dashboard'))

@app.route('/licenses/<key>/revoke', methods=['POST'])
@login_required
def revoke_license(key):
    """Revocar una licencia"""
    try:
        license = License.query.filter_by(key=key).first_or_404()
        
        if not current_user.is_admin:
            script = Script.query.filter_by(hash_id=license.script_hash).first()
            if not script or script.owner_id != current_user.id:
                abort(403)
        
        license.active = False
        db.session.commit()
        
        logger.info(f"Licencia revocada: {key} por {current_user.username}")
        flash("✅ Licencia revocada exitosamente", "success")
        return redirect(url_for('dashboard'))
        
    except Exception as e:
        logger.error(f"Error revocando licencia: {str(e)}")
        flash("❌ Error al revocar la licencia", "danger")
        return redirect(url_for('dashboard'))

# ============================================================
# 10. ENDPOINTS PARA EL LOADER (PROTEGIDOS)
# ============================================================

@app.route('/api/load/<hash_id>')
@limiter.limit(f"{API_CONFIG['RATE_LIMIT_PER_MINUTE']} per minute")
def cargar_script(hash_id):
    """Endpoint principal para cargar scripts protegidos"""
    try:
        # Obtener parámetros
        key = request.args.get('key', '').strip()
        hwid = request.args.get('hwid', '').strip()
        
        # --- Validación de entrada ---
        if not key:
            AccessLog.log(key=key, hwid=hwid, script_hash=hash_id, success=False, error="missing_key")
            return jsonify({"error": "Clave requerida"}), 400
        
        if len(key) < 10:
            AccessLog.log(key=key, hwid=hwid, script_hash=hash_id, success=False, error="invalid_key_format")
            return jsonify({"error": "Formato de clave inválido"}), 400
        
        if not validar_hwid(hwid):
            AccessLog.log(key=key, hwid=hwid, script_hash=hash_id, success=False, error="invalid_hwid_format")
            return jsonify({"error": "HWID inválido"}), 400
        
        # --- Buscar script ---
        script = Script.query.filter_by(hash_id=hash_id, active=True).first()
        if not script:
            AccessLog.log(key=key, hwid=hwid, script_hash=hash_id, success=False, error="script_not_found")
            return jsonify({"error": "Script no encontrado o inactivo"}), 404
        
        # --- Buscar y validar licencia ---
        lic = License.query.filter_by(key=key, script_hash=hash_id).first()
        if not lic:
            AccessLog.log(key=key, hwid=hwid, script_hash=hash_id, success=False, error="license_not_found")
            return jsonify({"error": "Licencia inválida"}), 401
        
        if not lic.is_valid():
            error_msg = "license_expired" if lic.expires_at and lic.expires_at < datetime.utcnow() else "license_inactive"
            AccessLog.log(key=key, hwid=hwid, script_hash=hash_id, success=False, error=error_msg)
            return jsonify({"error": "Licencia expirada o inactiva"}), 401
        
        # --- Verificar HWID ---
        if lic.hwid and lic.hwid != hwid:
            AccessLog.log(key=key, hwid=hwid, script_hash=hash_id, success=False, error="hwid_mismatch")
            return jsonify({"error": "HWID no coincide con la licencia"}), 401
        
        # --- Usar la licencia (asignar HWID si no tiene) ---
        if not lic.use(hwid):
            AccessLog.log(key=key, hwid=hwid, script_hash=hash_id, success=False, error="license_use_failed")
            return jsonify({"error": "Error al usar la licencia"}), 500
        
        # --- Registrar acceso exitoso ---
        AccessLog.log(key=key, hwid=hwid, script_hash=hash_id, success=True, request_obj=request)
        
        # --- Incrementar contador de descargas ---
        script.downloads += 1
        db.session.commit()
        
        # --- Devolver el script (ya comprimido) ---
        logger.info(f"Script cargado: {hash_id} por HWID {hwid[:8]}... con clave {key[:8]}...")
        
        # Retornar como JSON para mejor manejo
        return jsonify({
            "success": True,
            "script": script.content,  # Ya está comprimido
            "script_name": script.name,
            "version": script.version,
            "hash": script.content_hash[:8]
        })
        
    except Exception as e:
        logger.error(f"Error en carga de script {hash_id}: {str(e)}")
        return jsonify({"error": "Error interno del servidor"}), 500

@app.route('/api/verify/<key>')
@limiter.limit("30 per minute")
def verify_license(key):
    """Endpoint para verificar validez de una licencia"""
    try:
        lic = License.query.filter_by(key=key).first()
        if not lic:
            return jsonify({"valid": False, "error": "Licencia no encontrada"}), 404
        
        if not lic.is_valid():
            return jsonify({"valid": False, "error": "Licencia inválida"}), 401
        
        # Obtener información del script
        script = Script.query.filter_by(hash_id=lic.script_hash).first()
        
        return jsonify({
            "valid": True,
            "script": script.name if script else "Unknown",
            "expires_at": lic.expires_at.isoformat() if lic.expires_at else None,
            "used_count": lic.used_count,
            "max_uses": lic.max_uses
        })
        
    except Exception as e:
        logger.error(f"Error verificando licencia {key}: {str(e)}")
        return jsonify({"error": "Error interno"}), 500

# ============================================================
# 11. ADMINISTRACIÓN (SOLO PARA ADMINS)
# ============================================================

@app.route('/admin/stats')
@login_required
@admin_required
def admin_stats():
    """Estadísticas del sistema para admins"""
    stats = {
        'total_scripts': Script.query.count(),
        'active_scripts': Script.query.filter_by(active=True).count(),
        'total_licenses': License.query.count(),
        'active_licenses': License.query.filter_by(active=True).count(),
        'total_users': User.query.count(),
        'admin_users': User.query.filter_by(is_admin=True).count(),
        'total_access': AccessLog.query.count(),
        'successful_access': AccessLog.query.filter_by(success=True).count(),
        'failed_access': AccessLog.query.filter_by(success=False).count(),
        'recent_access': [log.to_dict() for log in AccessLog.query.order_by(AccessLog.timestamp.desc()).limit(50).all()]
    }
    return jsonify(stats)

# ============================================================
# 12. MANEJO DE ERRORES
# ============================================================

@app.errorhandler(404)
def not_found(error):
    """Manejo de errores 404"""
    return jsonify({"error": "Recurso no encontrado"}), 404

@app.errorhandler(403)
def forbidden(error):
    """Manejo de errores 403"""
    return jsonify({"error": "No tienes permiso para acceder"}), 403

@app.errorhandler(429)
def ratelimit_handler(error):
    """Manejo de rate limiting"""
    return jsonify({
        "error": "Demasiadas peticiones. Espera un momento e intenta de nuevo."
    }), 429

@app.errorhandler(500)
def internal_error(error):
    """Manejo de errores 500"""
    logger.error(f"Error 500: {str(error)}")
    return jsonify({"error": "Error interno del servidor"}), 500

# ============================================================
# 13. INICIALIZACIÓN DE LA APLICACIÓN
# ============================================================

@app.before_first_request
def create_tables():
    """Crea las tablas si no existen"""
    db.create_all()
    logger.info("📦 Base de datos inicializada")

# ============================================================
# 14. EJECUCIÓN
# ============================================================

if __name__ == '__main__':
    port = int(os.getenv("PORT", 5000))
    
    # Configuración según entorno
    debug_mode = os.getenv("FLASK_DEBUG", "False").lower() == "true"
    
    logger.info(f"🚀 LuauProtect PRO iniciado en puerto {port}")
    logger.info(f"🔒 Modo debug: {debug_mode}")
    logger.info(f"🌐 Dominio: {DOMINIO}")
    
    app.run(
        host='0.0.0.0',
        port=port,
        debug=debug_mode,
        threaded=True
) 
