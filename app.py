from flask import Flask, render_template, request, jsonify, redirect, url_for, flash, Response, session, abort
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

# ---------------- CONFIGURACIÓN FUERTE ----------------
app = Flask(__name__)

# 🔒 OBLIGATORIO para Railway / HTTPS
app.wsgi_app = ProxyFix(app.wsgi_app, x_proto=1, x_host=1, x_for=1, x_port=1)
app.config['PREFERRED_URL_SCHEME'] = 'https'
app.config['FORCE_HTTPS'] = True

# 🍪 Sesiones seguras
app.config['SESSION_COOKIE_SECURE'] = True
app.config['SESSION_COOKIE_HTTPONLY'] = True
app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'
app.config['PERMANENT_SESSION_LIFETIME'] = datetime.timedelta(days=30)
app.config['SESSION_COOKIE_NAME'] = 'LuaProtect_Secure'

# 🔑 Claves
app.config['SECRET_KEY'] = os.getenv("SECRET_KEY", "LUA_PROTECT_2026_ULTRA_SECURE_v7_9872365410_abcdefghijklmnopqrstuvwxyz1234567890")
app.config['SQLALCHEMY_DATABASE_URI'] = os.getenv("DATABASE_URL", "sqlite:///luaprotect_database.db")
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
app.config['MAX_CONTENT_LENGTH'] = 64 * 1024 * 1024

# 📌 Variables FIJAS (no dependen de generación automática)
DISCORD_CLIENT_ID = os.getenv("DISCORD_CLIENT_ID", "1519073151856803930")
DISCORD_CLIENT_SECRET = os.getenv("DISCORD_CLIENT_SECRET", "G-oqtu7gXsc0VmbjYpzBUHbvj55z7e0z")
DISCORD_REDIRECT_URI = "https://protegetuscriptlua-production.up.railway.app/callback"
ADMIN_DISCORD_ID = os.getenv("ADMIN_DISCORD_ID", "1501316920975036611")
DOMINIO = "https://protegetuscriptlua-production.up.railway.app"

# 🛠️ Inicializar
CORS(app, supports_credentials=True)
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("LuaProtect")

db = SQLAlchemy(app)
login_manager = LoginManager(app)
login_manager.login_view = 'login'
login_manager.login_message = "🔐 Inicia sesión con Discord"

# 🔗 OAuth CONFIGURADO A MANO (no falla)
oauth = OAuth(app)
discord = oauth.register(
    name='discord',
    client_id=DISCORD_CLIENT_ID,
    client_secret=DISCORD_CLIENT_SECRET,
    access_token_url='https://discord.com/api/oauth2/token',
    authorize_url='https://discord.com/api/oauth2/authorize',
    api_base_url='https://discord.com/api/',
    redirect_uri=DISCORD_REDIRECT_URI,
    client_kwargs={
        'scope': 'identify',
        'prompt': 'consent',
        'token_endpoint_auth_method': 'client_secret_post'
    }
)

# ---------------- MODELOS ----------------
class User(UserMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    discord_id = db.Column(db.String(20), unique=True, nullable=False)
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
    owner_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)

class License(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    key = db.Column(db.String(64), unique=True, nullable=False)
    hwid = db.Column(db.String(128))
    script_hash = db.Column(db.String(32), db.ForeignKey('script.hash_id'), nullable=False)
    active = db.Column(db.Boolean, default=True)
    expires_at = db.Column(db.DateTime)
    created_by = db.Column(db.Integer, db.ForeignKey('user.id'))

class AccessLog(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    key = db.Column(db.String(64))
    hwid = db.Column(db.String(128))
    ip = db.Column(db.String(45))
    success = db.Column(db.Boolean)
    timestamp = db.Column(db.DateTime, default=datetime.datetime.utcnow)

@login_manager.user_loader
def load_user(user_id):
    return User.query.get(int(user_id))

# ---------------- RUTAS ----------------
@app.route('/')
def index():
    return render_template('index.html')

@app.route('/login')
def login():
    # ⚠️ Forzamos siempre HTTPS en la redirección
    return discord.authorize_redirect(DISCORD_REDIRECT_URI.replace('http://', 'https://'))

@app.route('/callback')
def callback():
    try:
        # Obtener token
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

        user.last_login = datetime.datetime.utcnow()
        db.session.commit()

        # Iniciar sesión
        login_user(user, remember=True)
        session.permanent = True

        # Redirigir seguro
        return redirect(url_for('dashboard', _external=True, _scheme='https'))

    except Exception as e:
        logger.error(f"Error callback: {str(e)}")
        flash("❌ No se pudo iniciar sesión", "danger")
        return redirect(url_for('index', _external=True, _scheme='https'))

@app.route('/logout')
@login_required
def logout():
    logout_user()
    session.clear()
    return redirect(url_for('index', _external=True, _scheme='https'))

@app.route('/dashboard')
@login_required
def dashboard():
    scripts = Script.query.filter_by(owner_id=current_user.id).all() if not current_user.is_admin else Script.query.all()
    licenses = License.query.all() if current_user.is_admin else []
    return render_template('dashboard.html', user=current_user, scripts=scripts, licenses=licenses, dominio=DOMINIO)

# ---------------- FUNCIONES AUXILIARES Y RESTO DE RUTAS ----------------
def generar_hash(longitud=32):
    return ''.join(random.choices(string.ascii_letters + string.digits, k=longitud))

def generar_clave_licencia(longitud=40):
    return ''.join(random.choices(string.ascii_letters + string.digits, k=longitud))

def proteger_codigo(codigo: str) -> str:
    return base64.b64encode(zlib.compress(codigo.encode('utf-8'), level=9)).decode('utf-8')

@app.route('/scripts/new', methods=['POST'])
@login_required
def new_script():
    nombre = request.form.get('name', '').strip()
    codigo = request.form.get('code', '').strip()
    if not nombre or not codigo:
        flash("❌ Campos obligatorios", "danger")
        return redirect(url_for('dashboard'))
    hash_id = generar_hash()
    contenido = proteger_codigo(codigo)
    nuevo = Script(name=nombre, hash_id=hash_id, content=contenido, owner_id=current_user.id)
    db.session.add(nuevo)
    db.session.commit()
    flash(f"✅ Script creado: {hash_id}", "success")
    return redirect(url_for('dashboard'))

@app.route('/loader/<hash_id>')
@login_required
def ver_loader(hash_id):
    script = Script.query.filter_by(hash_id=hash_id).first_or_404()
    return render_template('loader.html', script=script, loader=f"-- Loader para {hash_id}\n-- Dominio: {DOMINIO}")

@app.route('/api/load/<hash_id>')
def cargar_script(hash_id):
    key = request.args.get('key', '')
    hwid = request.args.get('hwid', '')
    script = Script.query.filter_by(hash_id=hash_id, active=True).first()
    lic = License.query.filter_by(key=key, script_hash=hash_id, active=True).first()
    if not script or not lic or (lic.hwid and lic.hwid != hwid):
        return Response(base64.b64encode(zlib.compress("error = 'Acceso denegado'".encode())), mimetype='text/plain')
    if not lic.hwid:
        lic.hwid = hwid
    db.session.commit()
    return Response(script.content, mimetype='text/plain')

# ---------------- INICIO ----------------
with app.app_context():
    db.create_all()

if __name__ == '__main__':
    port = int(os.getenv("PORT", 5000))
    app.run(host='0.0.0.0', port=port, debug=False)
