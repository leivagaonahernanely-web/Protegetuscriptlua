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

# Variables de Discord (desde entorno)
DISCORD_CLIENT_ID = os.getenv("DISCORD_CLIENT_ID")
DISCORD_CLIENT_SECRET = os.getenv("DISCORD_CLIENT_SECRET")
DISCORD_REDIRECT_URI = os.getenv("DOMINIO", "https://tu-app.railway.app") + "/callback"
ADMIN_DISCORD_ID = os.getenv("ADMIN_DISCORD_ID", "1501316920975036611")
DOMINIO = os.getenv("DOMINIO", "https://tu-app.railway.app")

# ========== INICIALIZACIÓN ==========
db = SQLAlchemy(app)
login_manager = LoginManager(app)
login_manager.login_view = 'login'
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
    redirect_uri=DISCORD_REDIRECT_URI,
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

# ========== RUTAS ==========
@app.route('/')
def index():
    return render_template('index.html')

@app.route('/login')
def login():
    return discord.authorize_redirect(DISCORD_REDIRECT_URI)

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
        return f"Error: {str(e)}"

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
    else:
        scripts = Script.query.filter_by(owner_id=current_user.id).all()
    return render_template('dashboard.html', user=current_user, scripts=scripts)

@app.route('/api/protect', methods=['POST'])
@login_required
def protect_script():
    data = request.get_json()
    nombre = data.get('name', '').strip()
    codigo = data.get('code', '').strip()
    
    if not nombre or not codigo:
        return jsonify({'success': False, 'error': 'Nombre y código son requeridos'})
    
    hash_id = generar_hash()
    contenido = comprimir_codigo(codigo)
    
    nuevo = Script(
        name=nombre,
        hash_id=hash_id,
        content=contenido,
        owner_id=current_user.id
    )
    db.session.add(nuevo)
    db.session.commit()
    
    loader = f'loadstring(game:HttpGet("{DOMINIO}/api/load/{hash_id}?key=TU_CLAVE&hwid="..tostring({{}}):gsub("table: ","")))()'
    
    return jsonify({
        'success': True,
        'hash_id': hash_id,
        'loader': loader,
        'version': 1
    })

@app.route('/api/load/<hash_id>')
def load_script(hash_id):
    key = request.args.get('key', '')
    hwid = request.args.get('hwid', '')
    
    script = Script.query.filter_by(hash_id=hash_id, active=True).first()
    if not script:
        return "error: script no encontrado", 404
    
    lic = License.query.filter_by(key=key, script_hash=hash_id, active=True).first()
    if not lic:
        return "error: licencia inválida", 401
    
    if lic.hwid and lic.hwid != hwid:
        return "error: HWID no coincide", 401
    
    if not lic.hwid:
        lic.hwid = hwid
        db.session.commit()
    
    script.downloads += 1
    db.session.commit()
    
    return script.content

# ========== INICIALIZACIÓN ==========
with app.app_context():
    db.create_all()

if __name__ == '__main__':
    port = int(os.getenv("PORT", 5000))
    app.run(host='0.0.0.0', port=port, debug=False)
