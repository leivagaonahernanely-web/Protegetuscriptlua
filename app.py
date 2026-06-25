from flask import Flask, render_template, request, jsonify, redirect, url_for, flash, session
from flask_sqlalchemy import SQLAlchemy
from flask_login import LoginManager, UserMixin, login_user, login_required, current_user, logout_user
from flask_cors import CORS
from authlib.integrations.flask_client import OAuth
from werkzeug.middleware.proxy_fix import ProxyFix
import os
import random
import string
import datetime
import zlib
import base64
import logging
from functools import wraps

# ========== CONFIGURACIÓN ==========
app = Flask(__name__)
app.wsgi_app = ProxyFix(app.wsgi_app, x_proto=1, x_host=1)

# Configuración desde variables de entorno
app.config['SECRET_KEY'] = os.getenv("SECRET_KEY", "clave-segura-por-defecto-cambiar-en-produccion")
app.config['SQLALCHEMY_DATABASE_URI'] = os.getenv("DATABASE_URL", "sqlite:///luaprotect.db")
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
app.config['SESSION_COOKIE_SECURE'] = True
app.config['SESSION_COOKIE_HTTPONLY'] = True
app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'
app.config['PERMANENT_SESSION_LIFETIME'] = datetime.timedelta(days=30)

# Variables de Discord (desde entorno)
DISCORD_CLIENT_ID = os.getenv("DISCORD_CLIENT_ID")
DISCORD_CLIENT_SECRET = os.getenv("DISCORD_CLIENT_SECRET")
DOMINIO = os.getenv("DOMINIO", "https://tu-app.railway.app")
ADMIN_DISCORD_ID = os.getenv("ADMIN_DISCORD_ID", "1501316920975036611")

# Verificar que las variables esenciales existen
if not DISCORD_CLIENT_ID or not DISCORD_CLIENT_SECRET:
    raise ValueError("❌ DISCORD_CLIENT_ID y DISCORD_CLIENT_SECRET son obligatorios")

# ========== INICIALIZACIÓN ==========
db = SQLAlchemy(app)
login_manager = LoginManager(app)
login_manager.login_view = 'login'
login_manager.login_message = "🔐 Inicia sesión con Discord"
CORS(app, supports_credentials=True)

# OAuth Discord
oauth = OAuth(app)
discord = oauth.register(
    name='discord',
    client_id=DISCORD_CLIENT_ID,
    client_secret=DISCORD_CLIENT_SECRET,
    access_token_url='https://discord.com/api/oauth2/token',
    authorize_url='https://discord.com/api/oauth2/authorize',
    api_base_url='https://discord.com/api/',
    redirect_uri=f'{DOMINIO}/callback',
    client_kwargs={'scope': 'identify'}
)

# ========== MODELOS ==========
class User(UserMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    discord_id = db.Column(db.String(32), unique=True, nullable=False)
    username = db.Column(db.String(100), nullable=False)
    avatar = db.Column(db.String(255))
    is_admin = db.Column(db.Boolean, default=False)
    created_at = db.Column(db.DateTime, default=datetime.datetime.utcnow)
    last_login = db.Column(db.DateTime)

class Script(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), nullable=False)
    hash_id = db.Column(db.String(32), unique=True, nullable=False)
    content = db.Column(db.Text, nullable=False)
    active = db.Column(db.Boolean, default=True)
    version = db.Column(db.Integer, default=1)
    owner_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.datetime.utcnow)
    downloads = db.Column(db.Integer, default=0)

class License(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    key = db.Column(db.String(64), unique=True, nullable=False)
    hwid = db.Column(db.String(128))
    script_hash = db.Column(db.String(32), db.ForeignKey('script.hash_id'), nullable=False)
    active = db.Column(db.Boolean, default=True)
    max_uses = db.Column(db.Integer, default=1)
    used_count = db.Column(db.Integer, default=0)
    expires_at = db.Column(db.DateTime)
    created_by = db.Column(db.Integer, db.ForeignKey('user.id'))
    created_at = db.Column(db.DateTime, default=datetime.datetime.utcnow)

class AccessLog(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    key_hash = db.Column(db.String(64))
    hwid = db.Column(db.String(128))
    ip = db.Column(db.String(45))
    script_hash = db.Column(db.String(32))
    success = db.Column(db.Boolean, default=False)
    timestamp = db.Column(db.DateTime, default=datetime.datetime.utcnow)

@login_manager.user_loader
def load_user(user_id):
    return User.query.get(int(user_id))

# ========== FUNCIONES AUXILIARES ==========
def generar_hash(longitud=16):
    return ''.join(random.choices(string.ascii_letters + string.digits, k=longitud))

def generar_clave():
    return ''.join(random.choices(string.ascii_uppercase + string.digits, k=32))

def comprimir_codigo(codigo):
    compressed = zlib.compress(codigo.encode('utf-8'), level=9)
    return base64.b64encode(compressed).decode('utf-8')

def descomprimir_codigo(codigo_comprimido):
    try:
        compressed = base64.b64decode(codigo_comprimido.encode('utf-8'))
        return zlib.decompress(compressed).decode('utf-8')
    except:
        return None

# ========== RUTAS ==========
@app.route('/')
def index():
    return render_template('index.html')

@app.route('/login')
def login():
    """Inicia sesión con Discord"""
    try:
        # Redirige a Discord sin parámetros (usará redirect_uri de oauth.register)
        return discord.authorize_redirect()
    except Exception as e:
        return f"Error al iniciar sesión: {str(e)}"

@app.route('/callback')
def callback():
    """Callback de Discord después de autenticación"""
    try:
        # Obtener token de acceso
        token = discord.authorize_access_token()
        resp = discord.get('users/@me')
        user_data = resp.json()
        
        discord_id = user_data['id']
        username = user_data['username']
        avatar = f"https://cdn.discordapp.com/avatars/{discord_id}/{user_data['avatar']}.png" if user_data.get('avatar') else ""
        
        # Buscar o crear usuario
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
        
        user.last_login = datetime.datetime.utcnow()
        db.session.commit()
        
        # Iniciar sesión
        login_user(user, remember=True)
        session.permanent = True
        
        return redirect(url_for('dashboard'))
    except Exception as e:
        return f"Error en callback: {str(e)}"

@app.route('/logout')
@login_required
def logout():
    logout_user()
    session.clear()
    return redirect(url_for('index'))

@app.route('/dashboard')
@login_required
def dashboard():
    if current_user.is_admin:
        scripts = Script.query.all()
    else:
        scripts = Script.query.filter_by(owner_id=current_user.id).all()
    return render_template('dashboard.html', user=current_user, scripts=scripts)

@app.route('/scripts')
@login_required
def scripts_page():
    if current_user.is_admin:
        scripts = Script.query.all()
    else:
        scripts = Script.query.filter_by(owner_id=current_user.id).all()
    return render_template('scripts.html', user=current_user, scripts=scripts, dominio=DOMINIO)

@app.route('/keys')
@login_required
def keys_page():
    if current_user.is_admin:
        licenses = License.query.all()
    else:
        licenses = License.query.filter_by(created_by=current_user.id).all()
    return render_template('keys.html', user=current_user, keys=licenses)

@app.route('/api/protect', methods=['POST'])
@login_required
def protect_script():
    """Protege un script y genera su loader"""
    try:
        data = request.get_json()
        nombre = data.get('name', '').strip()
        codigo = data.get('code', '').strip()
        killswitch = data.get('killswitch', True)
        compression = data.get('compression', True)
        
        if not nombre or not codigo:
            return jsonify({'success': False, 'error': 'Nombre y código son requeridos'})
        
        if len(codigo) < 10:
            return jsonify({'success': False, 'error': 'El código debe tener al menos 10 caracteres'})
        
        # Generar hash único
        hash_id = generar_hash()
        while Script.query.filter_by(hash_id=hash_id).first():
            hash_id = generar_hash()
        
        # Comprimir si está habilitado
        if compression:
            contenido = comprimir_codigo(codigo)
        else:
            contenido = base64.b64encode(codigo.encode('utf-8')).decode('utf-8')
        
        nuevo = Script(
            name=nombre,
            hash_id=hash_id,
            content=contenido,
            active=killswitch,
            owner_id=current_user.id,
            version=1
        )
        db.session.add(nuevo)
        db.session.commit()
        
        # Generar loader
        loader = f'loadstring(game:HttpGet("{DOMINIO}/api/load/{hash_id}?key=TU_CLAVE&hwid="..tostring({{}}):gsub("table: ","")))()'
        
        return jsonify({
            'success': True,
            'hash_id': hash_id,
            'loader': loader,
            'version': 1,
            'active': killswitch
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

@app.route('/api/load/<hash_id>')
def load_script(hash_id):
    """Endpoint para cargar el script protegido"""
    try:
        key = request.args.get('key', '').strip()
        hwid = request.args.get('hwid', '').strip()
        
        if not key:
            return "error: clave requerida", 400
        
        # Buscar script
        script = Script.query.filter_by(hash_id=hash_id, active=True).first()
        if not script:
            return "error: script no encontrado", 404
        
        # Buscar licencia
        lic = License.query.filter_by(key=key, script_hash=hash_id, active=True).first()
        if not lic:
            return "error: licencia inválida", 401
        
        # Verificar expiración
        if lic.expires_at and lic.expires_at < datetime.datetime.utcnow():
            lic.active = False
            db.session.commit()
            return "error: licencia expirada", 401
        
        # Verificar HWID
        if lic.hwid and lic.hwid != hwid:
            return "error: HWID no coincide", 401
        
        # Asignar HWID si no tiene
        if not lic.hwid and hwid:
            lic.hwid = hwid
            db.session.commit()
        
        # Registrar uso
        lic.used_count += 1
        script.downloads += 1
        db.session.commit()
        
        # Registrar log
        log = AccessLog(
            key_hash=hashlib.md5(key.encode()).hexdigest()[:16],
            hwid=hwid,
            ip=request.remote_addr,
            script_hash=hash_id,
            success=True
        )
        db.session.add(log)
        db.session.commit()
        
        # Devolver script
        return script.content
    except Exception as e:
        return f"error: {str(e)}", 500

@app.route('/api/verify/<key>')
def verify_key(key):
    """Verifica si una clave es válida"""
    try:
        lic = License.query.filter_by(key=key).first()
        if not lic:
            return jsonify({'valid': False, 'error': 'Licencia no encontrada'}), 404
        
        if not lic.active:
            return jsonify({'valid': False, 'error': 'Licencia inactiva'}), 401
        
        if lic.expires_at and lic.expires_at < datetime.datetime.utcnow():
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
            'max_uses': lic.max_uses
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/generate-key', methods=['POST'])
@login_required
def generate_key():
    """Genera una nueva licencia"""
    try:
        data = request.get_json()
        script_hash = data.get('script_hash', '').strip()
        duration = data.get('duration', '30d')
        max_uses = int(data.get('max_uses', 1))
        
        if not script_hash:
            return jsonify({'success': False, 'error': 'Script hash es requerido'})
        
        script = Script.query.filter_by(hash_id=script_hash).first()
        if not script:
            return jsonify({'success': False, 'error': 'Script no encontrado'})
        
        # Calcular expiración
        expires_at = None
        if duration != '0':
            value = int(duration[:-1])
            unit = duration[-1]
            if unit == 'h':
                expires_at = datetime.datetime.utcnow() + datetime.timedelta(hours=value)
            elif unit == 'd':
                expires_at = datetime.datetime.utcnow() + datetime.timedelta(days=value)
            elif unit == 'y':
                expires_at = datetime.datetime.utcnow() + datetime.timedelta(days=value*365)
        
        # Generar clave única
        clave = generar_clave()
        while License.query.filter_by(key=clave).first():
            clave = generar_clave()
        
        nueva = License(
            key=clave,
            script_hash=script_hash,
            max_uses=max_uses,
            expires_at=expires_at,
            created_by=current_user.id
        )
        db.session.add(nueva)
        db.session.commit()
        
        return jsonify({
            'success': True,
            'key': clave,
            'expires_at': expires_at.isoformat() if expires_at else None
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

@app.route('/api/toggle-script/<hash_id>', methods=['POST'])
@login_required
def toggle_script(hash_id):
    """Activa o desactiva un script"""
    try:
        script = Script.query.filter_by(hash_id=hash_id).first()
        if not script:
            return jsonify({'success': False, 'error': 'Script no encontrado'})
        
        if not current_user.is_admin and script.owner_id != current_user.id:
            return jsonify({'success': False, 'error': 'No tienes permiso'})
        
        script.active = not script.active
        db.session.commit()
        
        return jsonify({
            'success': True,
            'active': script.active
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

@app.route('/api/toggle-key', methods=['POST'])
@login_required
def toggle_key():
    """Activa o desactiva una licencia"""
    try:
        data = request.get_json()
        key = data.get('key', '').strip()
        
        lic = License.query.filter_by(key=key).first()
        if not lic:
            return jsonify({'success': False, 'error': 'Licencia no encontrada'})
        
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
    """Resetea el HWID de una licencia"""
    try:
        data = request.get_json()
        key = data.get('key', '').strip()
        
        lic = License.query.filter_by(key=key).first()
        if not lic:
            return jsonify({'success': False, 'error': 'Licencia no encontrada'})
        
        lic.hwid = None
        db.session.commit()
        
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

@app.route('/api/upload-script', methods=['POST'])
@login_required
def upload_script():
    """Sube un script desde un archivo"""
    try:
        if 'file' not in request.files:
            return jsonify({'success': False, 'error': 'No se envió ningún archivo'})
        
        file = request.files['file']
        if file.filename == '':
            return jsonify({'success': False, 'error': 'Archivo vacío'})
        
        # Leer contenido
        contenido = file.read().decode('utf-8')
        nombre = file.filename.rsplit('.', 1)[0]
        
        # Proteger el script
        hash_id = generar_hash()
        while Script.query.filter_by(hash_id=hash_id).first():
            hash_id = generar_hash()
        
        contenido_comprimido = comprimir_codigo(contenido)
        
        nuevo = Script(
            name=nombre,
            hash_id=hash_id,
            content=contenido_comprimido,
            owner_id=current_user.id
        )
        db.session.add(nuevo)
        db.session.commit()
        
        loader = f'loadstring(game:HttpGet("{DOMINIO}/api/load/{hash_id}?key=TU_CLAVE&hwid="..tostring({{}}):gsub("table: ","")))()'
        
        return jsonify({
            'success': True,
            'name': nombre,
            'hash_id': hash_id,
            'loader': loader
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

@app.route('/loader/<hash_id>')
@login_required
def view_loader(hash_id):
    """Muestra el loader de un script"""
    script = Script.query.filter_by(hash_id=hash_id).first_or_404()
    loader = f'loadstring(game:HttpGet("{DOMINIO}/api/load/{hash_id}?key=TU_CLAVE&hwid="..tostring({{}}):gsub("table: ","")))()'
    return render_template('loader.html', script=script, loader=loader)

# ========== INICIALIZACIÓN ==========
with app.app_context():
    db.create_all()

if __name__ == '__main__':
    port = int(os.getenv("PORT", 5000))
    app.run(host='0.0.0.0', port=port, debug=False) 
