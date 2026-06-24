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
import logging
from typing import Optional

# ────────────────────────────────────────────────────────────────
# ⚙️ CONFIGURACIÓN GLOBAL
# ────────────────────────────────────────────────────────────────
app = Flask(__name__)
CORS(app, supports_credentials=True, origins="*")

# Seguridad y sesión
app.config['SECRET_KEY'] = 'LUAPROTECT_2026_ULTRA_SECURE_v5_7392847561'
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///luaprotect.db'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
app.config['PERMANENT_SESSION_LIFETIME'] = datetime.timedelta(days=30)
app.config['SESSION_COOKIE_SECURE'] = True
app.config['SESSION_COOKIE_HTTPONLY'] = True
app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'
app.config['MAX_CONTENT_LENGTH'] = 16 * 1024 * 1024  # 16MB máximo

# Discord OAuth
app.config['DISCORD_CLIENT_ID'] = "1519073151856803930"
app.config['DISCORD_CLIENT_SECRET'] = "G-oqtu7gXsc0VmbjYpzBUHbvj55z7e0z"
app.config['DISCORD_REDIRECT_URI'] = "https://protegetuscriptlua-production.up.railway.app/callback"

ADMIN_DISCORD_ID = "1501316920975036611"
DOMINIO = "https://protegetuscriptlua-production.up.railway.app"

# Configuración de logs
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Inicializar extensiones
db = SQLAlchemy(app)
login_manager = LoginManager(app)
login_manager.login_view = 'login'
login_manager.session_protection = "strong"

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
        'prompt': 'none',
        'token_endpoint_auth_method': 'client_secret_post'
    }
)

# ────────────────────────────────────────────────────────────────
# 📋 MODELOS DE BASE DE DATOS (ESTRUCTURA PERFECTA)
# ────────────────────────────────────────────────────────────────
class User(UserMixin, db.Model):
    __tablename__ = 'users'
    id = db.Column(db.Integer, primary_key=True)
    discord_id = db.Column(db.String(20), unique=True, nullable=False, index=True)
    username = db.Column(db.String(100), nullable=False)
    avatar = db.Column(db.String(255))
    is_admin = db.Column(db.Boolean, default=False)
    created_at = db.Column(db.DateTime, default=datetime.datetime.utcnow)
    last_login = db.Column(db.DateTime, default=datetime.datetime.utcnow, onupdate=datetime.datetime.utcnow)

class Script(db.Model):
    __tablename__ = 'scripts'
    id = db.Column(db.Integer, primary_key=True)
    owner_id = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=False)
    name = db.Column(db.String(150), nullable=False)
    code = db.Column(db.Text, nullable=False)
    hash = db.Column(db.String(16), unique=True, nullable=False, index=True)
    active = db.Column(db.Boolean, default=True)
    created_at = db.Column(db.DateTime, default=datetime.datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.datetime.utcnow, onupdate=datetime.datetime.utcnow)

class Panel(db.Model):
    __tablename__ = 'panels'
    id = db.Column(db.Integer, primary_key=True)
    owner_id = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=False)
    name = db.Column(db.String(100), nullable=False)
    description = db.Column(db.Text, default="")
    script_id = db.Column(db.Integer, db.ForeignKey('scripts.id'))
    discord_channel_id = db.Column(db.String(50))
    hwid_reset_cooldown = db.Column(db.Integer, default=3600)  # En segundos
    created_at = db.Column(db.DateTime, default=datetime.datetime.utcnow)

class Key(db.Model):
    __tablename__ = 'keys'
    id = db.Column(db.Integer, primary_key=True)
    owner_id = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=False)
    key = db.Column(db.String(16), unique=True, nullable=False, index=True)
    panel_id = db.Column(db.Integer, db.ForeignKey('panels.id'))
    hwid = db.Column(db.String(128), nullable=True)
    expires_at = db.Column(db.DateTime, nullable=True)
    active = db.Column(db.Boolean, default=True)
    created_at = db.Column(db.DateTime, default=datetime.datetime.utcnow)
    last_used = db.Column(db.DateTime, nullable=True)

class HWIDBan(db.Model):
    __tablename__ = 'hwid_bans'
    id = db.Column(db.Integer, primary_key=True)
    owner_id = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=False)
    hwid_hash = db.Column(db.String(128), unique=True, nullable=False, index=True)
    reason = db.Column(db.String(255), default="Sin motivo especificado")
    created_at = db.Column(db.DateTime, default=datetime.datetime.utcnow)

@login_manager.user_loader
def load_user(user_id: str) -> Optional[User]:
    return User.query.get(int(user_id))

# Crear tablas al iniciar
with app.app_context():
    db.create_all()
    logger.info("✅ Base de datos inicializada correctamente")

# ────────────────────────────────────────────────────────────────
# 🛠️ FUNCIONES AUXILIARES OPTIMIZADAS
# ────────────────────────────────────────────────────────────────
def parse_duration(duracion_str: str) -> Optional[datetime.timedelta]:
    duracion_str = str(duracion_str).strip().lower()
    if duracion_str == "0":
        return None
    try:
        valor = int(duracion_str[:-1])
        unidad = duracion_str[-1]
        if unidad == "h":
            return datetime.timedelta(hours=valor)
        elif unidad == "d":
            return datetime.timedelta(days=valor)
        elif unidad == "y":
            return datetime.timedelta(days=valor * 365)
        else:
            return None
    except Exception:
        return None

def generar_hash_corto(texto: str) -> str:
    return hashlib.sha256(texto.encode('utf-8')).hexdigest()[:16]

def obtener_hwid_hash(hwid: str) -> str:
    return hashlib.sha256(hwid.strip().encode('utf-8')).hexdigest()

# ────────────────────────────────────────────────────────────────
# 🔐 SISTEMA DE AUTENTICACIÓN SIN PEDIR PERMISOS REPETIDOS
# ────────────────────────────────────────────────────────────────
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
            flash("❌ No se pudo obtener acceso", "danger")
            return redirect(url_for('login'))

        resp = discord.get('users/@me')
        if resp.status_code != 200:
            flash("❌ Error al conectar con Discord", "danger")
            return redirect(url_for('login'))

        user_data = resp.json()
        user = User.query.filter_by(discord_id=user_data['id']).first()

        if not user:
            user = User(
                discord_id=user_data['id'],
                username=user_data['username'],
                avatar=user_data.get('avatar'),
                is_admin=(user_data['id'] == ADMIN_DISCORD_ID)
            )
            db.session.add(user)
            db.session.commit()
            logger.info(f"✅ Nuevo usuario registrado: {user.username}")

        login_user(user, remember=True)
        session.permanent = True
        user.last_login = datetime.datetime.utcnow()
        db.session.commit()
        return redirect(url_for('dashboard'))

    except Exception as e:
        logger.error(f"Error en inicio de sesión: {str(e)}")
        flash("❌ Ocurrió un error, intenta nuevamente", "danger")
        return redirect(url_for('login'))

@app.route('/logout')
@login_required
def logout():
    logout_user()
    session.clear()
    return redirect(url_for('login'))

# ────────────────────────────────────────────────────────────────
# 📄 RUTAS PRINCIPALES
# ────────────────────────────────────────────────────────────────
@app.route('/')
@login_required
def dashboard():
    total_scripts = Script.query.filter_by(owner_id=current_user.id).count()
    total_keys = Key.query.filter_by(owner_id=current_user.id, active=True).count()
    total_panels = Panel.query.filter_by(owner_id=current_user.id).count()
    total_bans = HWIDBan.query.filter_by(owner_id=current_user.id).count()

    return render_template(
        'dashboard.html',
        user=current_user,
        total_scripts=total_scripts,
        total_keys=total_keys,
        total_panels=total_panels,
        total_bans=total_bans,
        dominio=DOMINIO
    )

@app.route('/scripts')
@login_required
def scripts():
    lista = Script.query.filter_by(owner_id=current_user.id).all() if not current_user.is_admin else Script.query.all()
    return render_template('scripts.html', scripts=lista, user=current_user, dominio=DOMINIO)

@app.route('/panels')
@login_required
def panels():
    lista = Panel.query.filter_by(owner_id=current_user.id).all() if not current_user.is_admin else Panel.query.all()
    scripts = Script.query.filter_by(active=True).all()
    return render_template('panels.html', panels=lista, scripts=scripts, user=current_user, dominio=DOMINIO)

@app.route('/keys')
@login_required
def keys():
    lista = Key.query.filter_by(owner_id=current_user.id).all() if not current_user.is_admin else Key.query.all()
    return render_template('keys.html', keys=lista, user=current_user, dominio=DOMINIO)

@app.route('/hwid-bans')
@login_required
def hwid_bans():
    lista = HWIDBan.query.filter_by(owner_id=current_user.id).all() if not current_user.is_admin else HWIDBan.query.all()
    return render_template('hwid_bans.html', bans=lista, user=current_user)

# ────────────────────────────────────────────────────────────────
# 🚀 LOADER ESTILO POLSEC (SEGURO Y OPTIMIZADO)
# ────────────────────────────────────────────────────────────────
@app.route('/scripts/hosted/<hash>.lua')
def hosted_script(hash: str):
    script = Script.query.filter_by(hash=hash, active=True).first()
    if not script:
        return Response("return error('❌ Script no encontrado o desactivado')", mimetype='text/plain', status=403)

    key = request.args.get('key', '').strip() or request.headers.get('X-Key', '').strip()
    hwid = request.args.get('hwid', '').strip() or request.headers.get('X-HWID', '').strip()

    if key:
        key_obj = Key.query.filter_by(key=key, active=True).first()
        if not key_obj:
            return Response("return error('❌ Clave inválida')", mimetype='text/plain', status=403)

        if key_obj.expires_at and key_obj.expires_at < datetime.datetime.utcnow():
            return Response("return error('❌ Clave vencida')", mimetype='text/plain', status=403)

        if hwid:
            hwid_hash = obtener_hwid_hash(hwid)
            if HWIDBan.query.filter_by(hwid_hash=hwid_hash).first():
                return Response("return error('❌ Dispositivo baneado')", mimetype='text/plain', status=403)

            if key_obj.hwid and key_obj.hwid != hwid_hash:
                return Response("return error('❌ HWID no coincide')", mimetype='text/plain', status=403)

            if not key_obj.hwid:
                key_obj.hwid = hwid_hash
                db.session.commit()

        key_obj.last_used = datetime.datetime.utcnow()
        db.session.commit()

    # Comprimir y codificar para mayor seguridad
    comprimido = zlib.compress(script.code.encode('utf-8'), 9)
    codificado = base64.b64encode(comprimido).decode('utf-8')

    return Response(f'''
local encoded_data = "{codificado}"
local HttpService = game:GetService("HttpService")
local execute = loadstring or load
if execute then
    local code = HttpService:Decompress(HttpService:Base64Decode(encoded_data))
    execute(code)
    code = nil
end
encoded_data = nil
collectgarbage("collect")
''', mimetype='text/plain')

# ────────────────────────────────────────────────────────────────
# ⚙️ API COMPLETA Y SEGURA
# ────────────────────────────────────────────────────────────────
@app.route('/api/upload-script', methods=['POST'])
@login_required
def upload_script():
    if 'file' not in request.files:
        return jsonify({"success": False, "error": "No se envió ningún archivo"})

    archivo = request.files['file']
    if archivo.filename == '':
        return jsonify({"success": False, "error": "Archivo vacío"})

    if not archivo.filename.lower().endswith(('.lua', '.txt')):
        return jsonify({"success": False, "error": "Solo se permiten archivos .lua o .txt"})

    try:
        contenido = archivo.read().decode('utf-8', errors='ignore')
        nombre = os.path.splitext(archivo.filename)[0]
        hash_code = generar_hash_corto(f"{current_user.id}{nombre}{datetime.datetime.utcnow()}")

        nuevo = Script(
            owner_id=current_user.id,
            name=nombre,
            code=contenido,
            hash=hash_code
        )
        db.session.add(nuevo)
        db.session.commit()

        loader = f'''script_key = "TU_CLAVE_AQUI"

loadstring(game:HttpGet("{DOMINIO}/scripts/hosted/{hash_code}.lua?key="..script_key.."&hwid="..tostring({{}}):gsub("table: ","")))()'''

        return jsonify({
            "success": True,
            "name": nombre,
            "hash": hash_code,
            "loader": loader
        })

    except Exception as e:
        logger.error(f"Error al subir script: {str(e)}")
        return jsonify({"success": False, "error": "Error al procesar el archivo"})

@app.route('/api/protect', methods=['POST'])
@login_required
def protect():
    data = request.get_json()
    if not data or 'name' not in data or 'code' not in data:
        return jsonify({"success": False, "error": "Faltan datos obligatorios"})

    try:
        hash_code = generar_hash_corto(f"{current_user.id}{data['name']}{datetime.datetime.utcnow()}")
        nuevo = Script(
            owner_id=current_user.id,
            name=data['name'],
            code=data['code'],
            hash=hash_code
        )
        db.session.add(nuevo)
        db.session.commit()

        loader = f'''script_key = "TU_CLAVE_AQUI"

loadstring(game:HttpGet("{DOMINIO}/scripts/hosted/{hash_code}.lua?key="..script_key.."&hwid="..tostring({{}}):gsub("table: ","")))()'''

        return jsonify({"success": True, "hash": hash_code, "loader": loader})

    except Exception as e:
        logger.error(f"Error al proteger script: {str(e)}")
        return jsonify({"success": False, "error": "Error interno"})

@app.route('/api/edit-script/<int:sid>', methods=['POST'])
@login_required
def edit_script(sid: int):
    script = Script.query.get_or_404(sid)
    if script.owner_id != current_user.id and not current_user.is_admin:
        return jsonify({"success": False, "error": "Sin permisos"})

    data = request.get_json()
    script.name = data.get('name', script.name)
    script.code = data.get('code', script.code)
    script.updated_at = datetime.datetime.utcnow()
    db.session.commit()
    return jsonify({"success": True, "message": "Script actualizado correctamente"})

@app.route('/api/delete-script/<int:sid>', methods=['POST'])
@login_required
def delete_script(sid: int):
    script = Script.query.get_or_404(sid)
    if script.owner_id != current_user.id and not current_user.is_admin:
        return jsonify({"success": False, "error": "Sin permisos"})
    db.session.delete(script)
    db.session.commit()
    return jsonify({"success": True, "message": "Script eliminado"})

@app.route('/api/toggle-script/<int:sid>', methods=['POST'])
@login_required
def toggle_script(sid: int):
    script = Script.query.get_or_404(sid)
    if script.owner_id != current_user.id and not current_user.is_admin:
        return jsonify({"success": False})
    script.active = not script.active
    db.session.commit()
    return jsonify({"success": True, "active": script.active})

@app.route('/api/create-panel', methods=['POST'])
@login_required
def create_panel():
    data = request.get_json()
    nombre = data.get('name', '').strip()
    descripcion = data.get('description', '').strip()
    script_id = data.get('script_id')
    discord_channel_id = data.get('discord_channel_id', '').strip()
    cooldown = int(data.get('hwid_reset_cooldown', 3600))

    if not nombre:
        return jsonify({"success": False, "error": "El nombre es obligatorio"})

    nuevo = Panel(
        owner_id=current_user.id,
        name=nombre,
        description=descripcion,
        script_id=script_id,
        discord_channel_id=discord_channel_id,
        hwid_reset_cooldown=cooldown
    )
    db.session.add(nuevo)
    db.session.commit()
    return jsonify({"success": True, "id": nuevo.id, "message": "Panel creado correctamente"})

@app.route('/api/generate-key', methods=['POST'])
@login_required
def generate_key():
    data = request.get_json()
    duracion_str = data.get('duration', '24h')
    panel_id = data.get('panel_id')

    delta = parse_duration(duracion_str)
    expira = datetime.datetime.utcnow() + delta if delta else None

    clave = ''.join(random.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", k=16))
    nueva = Key(
        owner_id=current_user.id,
        key=clave,
        panel_id=panel_id,
        expires_at=expira
    )
    db.session.add(nueva)
    db.session.commit()

    return jsonify({
        "success": True,
        "key": clave,
        "expires": expira.strftime('%d/%m/%Y %H:%M UTC') if expira else "Sin vencimiento"
    })

@app.route('/api/delete-key', methods=['POST'])
@login_required
def delete_key():
    data = request.get_json()
    clave = data.get('key', '').strip()
    key_obj = Key.query.filter_by(key=clave).first()

    if not key_obj:
        return jsonify({"success": False, "error": "Clave no encontrada"})
    if key_obj.owner_id != current_user.id and not current_user.is_admin:
        return jsonify({"success": False, "error": "Sin permisos"})

    db.session.delete(key_obj)
    db.session.commit()
    return jsonify({"success": True, "message": "Clave eliminada correctamente"})

@app.route('/api/reset-key-hwid', methods=['POST'])
@login_required
def reset_key_hwid():
    data = request.get_json()
    clave = data.get('key', '').strip()
    key_obj = Key.query.filter_by(key=clave, active=True).first()

    if not key_obj:
        return jsonify({"success": False, "error": "Clave inválida"})

    key_obj.hwid = None
    db.session.commit()
    return jsonify({"success": True, "message": "HWID restablecido"})

@app.route('/api/ban-hwid', methods=['POST'])
@login_required
def ban_hwid():
    data = request.get_json()
    hwid = data.get('hwid', '').strip()
    motivo = data.get('reason', 'Sin motivo especificado')

    if not hwid:
        return jsonify({"success": False, "error": "HWID requerido"})

    hwid_hash = obtener_hwid_hash(hwid)
    if HWIDBan.query.filter_by(hwid_hash=hwid_hash).first():
        return jsonify({"success": False, "error": "Este HWID ya está baneado"})

    nuevo = HWIDBan(
        owner_id=current_user.id,
        hwid_hash=hwid_hash,
        reason=motivo
    )
    db.session.add(nuevo)
    db.session.commit()
    return jsonify({"success": True, "message": "HWID baneado correctamente"})

@app.route('/api/unban-hwid/<int:ban_id>', methods=['POST'])
@login_required
def unban_hwid(ban_id: int):
    ban = HWIDBan.query.get_or_404(ban_id)
    if ban.owner_id != current_user.id and not current_user.is_admin:
        return jsonify({"success": False, "error": "Sin permisos"})
    db.session.delete(ban)
    db.session.commit()
    return jsonify({"success": True, "message": "HWID desbaneado"})

# ────────────────────────────────────────────────────────────────
# 🚀 INICIAR SERVIDOR
# ────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    port = int(os.environ.get("PORT", 8080))
    app.run(host='0.0.0.0', port=port, debug=False, use_reloader=False)
 
