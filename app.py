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

# ---------------- CONFIGURACIÓN ----------------
app = Flask(__name__)
CORS(app)

app.config['SECRET_KEY'] = 'LUAUPROTECT_SECURE_2026'
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///luaprotect.db'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
app.config['PERMANENT_SESSION_LIFETIME'] = datetime.timedelta(days=30)
app.config['SESSION_COOKIE_SECURE'] = True
app.config['SESSION_COOKIE_HTTPONLY'] = True

# Discord OAuth
app.config['DISCORD_CLIENT_ID'] = "1519073151856803930"
app.config['DISCORD_CLIENT_SECRET'] = "G-oqtu7gXsc0VmbjYpzBUHbvj55z7e0z"
app.config['DISCORD_REDIRECT_URI'] = "https://protegetuscriptlua-production.up.railway.app/callback"

ADMIN_DISCORD_ID = "1501316920975036611"
DOMINIO = "https://protegetuscriptlua-production.up.railway.app"

# Inicializar extensiones
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

# ---------------- MODELOS DE BASE DE DATOS ----------------
class User(UserMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    discord_id = db.Column(db.String(20), unique=True, nullable=False)
    username = db.Column(db.String(100), nullable=False)
    avatar = db.Column(db.String(255))
    is_admin = db.Column(db.Boolean, default=False)

class Script(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    owner_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    name = db.Column(db.String(150), nullable=False)
    code = db.Column(db.Text, nullable=False)
    hash = db.Column(db.String(128), unique=True, nullable=False)
    active = db.Column(db.Boolean, default=True)
    created = db.Column(db.DateTime, default=datetime.datetime.utcnow)

class Panel(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    owner_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    name = db.Column(db.String(100), nullable=False)
    script_id = db.Column(db.Integer, db.ForeignKey('script.id'))

class Key(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    owner_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    key = db.Column(db.String(16), unique=True, nullable=False)
    panel_id = db.Column(db.Integer, db.ForeignKey('panel.id'))
    hwid = db.Column(db.String(128))
    expires = db.Column(db.DateTime)
    active = db.Column(db.Boolean, default=True)

class HWIDBan(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    owner_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    hwid_hash = db.Column(db.String(128), unique=True, nullable=False)
    reason = db.Column(db.String(200), default="Baneado")

@login_manager.user_loader
def load_user(user_id):
    return User.query.get(int(user_id))

# Crear tablas al iniciar
with app.app_context():
    db.create_all()

# ---------------- FUNCIÓN PARA LEER DURACIÓN ----------------
def parse_duration(duracion_str):
    duracion_str = duracion_str.strip().lower()
    if duracion_str == "0":
        return None  # Sin vencimiento
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
    except:
        return None

# ---------------- RUTAS DE INICIO DE SESIÓN ----------------
@app.route('/login')
def login():
    if current_user.is_authenticated:
        return redirect(url_for('dashboard'))
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
            username=user_data['username'],
            avatar=user_data.get('avatar'),
            is_admin=es_admin
        )
        db.session.add(user)
        db.session.commit()
    
    login_user(user, remember=True)
    return redirect(url_for('dashboard'))

@app.route('/logout')
@login_required
def logout():
    logout_user()
    session.clear()
    return redirect(url_for('login'))

# ---------------- RUTAS PRINCIPALES ----------------
@app.route('/')
@login_required
def dashboard():
    return render_template('dashboard.html', user=current_user)

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
    return render_template('panels.html', panels=lista, scripts=scripts, user=current_user)

@app.route('/keys')
@login_required
def keys():
    lista = Key.query.filter_by(owner_id=current_user.id).all() if not current_user.is_admin else Key.query.all()
    panels = Panel.query.all()
    return render_template('keys.html', keys=lista, panels=panels, user=current_user)

@app.route('/hwid-bans')
@login_required
def hwid_bans():
    lista = HWIDBan.query.filter_by(owner_id=current_user.id).all() if not current_user.is_admin else HWIDBan.query.all()
    return render_template('hwid_bans.html', bans=lista, user=current_user)

# ---------------- RUTA LOADER ----------------
@app.route('/loader/<script_id>')
def loader(script_id):
    key = request.args.get('key', '').strip()
    hwid = request.args.get('hwid', '').strip()

    script = Script.query.filter(
        (Script.id == script_id) | (Script.hash == script_id),
        Script.active == True
    ).first()

    if not script:
        return Response("return error('Script no encontrado o desactivado')", mimetype='text/plain', status=403)

    if key:
        key_obj = Key.query.filter_by(key=key, active=True).first()
        if not key_obj:
            return Response("return error('Clave inválida')", mimetype='text/plain', status=403)

        if key_obj.expires and key_obj.expires < datetime.datetime.utcnow():
            return Response("return error('Clave vencida')", mimetype='text/plain', status=403)

        if hwid:
            hwid_hash = hashlib.sha256(hwid.encode()).hexdigest()
            if HWIDBan.query.filter_by(hwid_hash=hwid_hash).first():
                return Response("return error('HWID baneado')", mimetype='text/plain', status=403)
            if key_obj.hwid and key_obj.hwid != hwid_hash:
                return Response("return error('HWID no coincide')", mimetype='text/plain', status=403)
            if not key_obj.hwid:
                key_obj.hwid = hwid_hash
                db.session.commit()

    comprimido = zlib.compress(script.code.encode('utf-8'), 9)
    codificado = base64.b64encode(comprimido).decode()

    return Response(f'''
local d="{codificado}"
local gs = game:GetService("HttpService")
local f = loadstring or load
if f then f(gs:Decompress(gs:Base64Decode(d)))() end
d=nil collectgarbage()
''', mimetype='text/plain')

# ---------------- API PARA SCRIPTS ----------------
@app.route('/api/upload-script', methods=['POST'])
@login_required
def upload_script():
    if 'file' not in request.files:
        return jsonify({"success": False, "error": "No se seleccionó ningún archivo"})
    
    archivo = request.files['file']
    if archivo.filename == '':
        return jsonify({"success": False, "error": "Archivo vacío"})
    
    if not archivo.filename.endswith(('.lua', '.txt')):
        return jsonify({"success": False, "error": "Solo se permiten archivos .lua o .txt"})
    
    contenido = archivo.read().decode('utf-8', errors='ignore')
    nombre = archivo.filename.rsplit('.', 1)[0]

    hash_code = hashlib.sha256(f"{current_user.id}{nombre}{datetime.datetime.utcnow()}".encode()).hexdigest()

    nuevo = Script(
        owner_id=current_user.id,
        name=nombre,
        code=contenido,
        hash=hash_code,
        active=True
    )
    db.session.add(nuevo)
    db.session.commit()

    loader = f'loadstring(game:HttpGet("{DOMINIO}/loader/{hash_code}?key=TU_CLAVE&hwid="..tostring({{}}):gsub("table: ","")))()'
    return jsonify({"success": True, "name": nombre, "hash": hash_code, "loader": loader})

@app.route('/api/protect', methods=['POST'])
@login_required
def protect():
    data = request.get_json()
    if not data or 'name' not in data or 'code' not in data:
        return jsonify({"success": False, "error": "Faltan datos"})
    
    hash_code = hashlib.sha256(f"{current_user.id}{data['name']}{datetime.datetime.utcnow()}".encode()).hexdigest()
    nuevo = Script(owner_id=current_user.id, name=data['name'], code=data['code'], hash=hash_code)
    db.session.add(nuevo)
    db.session.commit()

    loader = f'loadstring(game:HttpGet("{DOMINIO}/loader/{hash_code}?key=TU_CLAVE&hwid="..tostring({{}}):gsub("table: ","")))()'
    return jsonify({"success": True, "hash": hash_code, "loader": loader})

@app.route('/api/edit-script/<int:sid>', methods=['POST'])
@login_required
def edit_script(sid):
    data = request.get_json()
    script = Script.query.get_or_404(sid)
    if script.owner_id != current_user.id and not current_user.is_admin:
        return jsonify({"success": False, "error": "Sin permiso"})

    script.name = data.get('name', script.name)
    script.code = data.get('code', script.code)
    db.session.commit()
    return jsonify({"success": True, "message": "Script actualizado"})

@app.route('/api/delete-script/<int:sid>', methods=['POST'])
@login_required
def delete_script(sid):
    script = Script.query.get_or_404(sid)
    if script.owner_id != current_user.id and not current_user.is_admin:
        return jsonify({"success": False, "error": "Sin permiso"})
    db.session.delete(script)
    db.session.commit()
    return jsonify({"success": True, "message": "Script eliminado"})

@app.route('/api/toggle-script/<int:sid>', methods=['POST'])
@login_required
def toggle_script(sid):
    script = Script.query.get_or_404(sid)
    if script.owner_id != current_user.id and not current_user.is_admin:
        return jsonify({"success": False})
    script.active = not script.active
    db.session.commit()
    return jsonify({"success": True, "active": script.active})

# ---------------- API PARA PANELES ----------------
@app.route('/api/create-panel', methods=['POST'])
@login_required
def create_panel():
    data = request.get_json()
    if not data or 'name' not in data or 'script_id' not in data:
        return jsonify({"success": False, "error": "Faltan datos"})
    nuevo = Panel(owner_id=current_user.id, name=data['name'], script_id=data['script_id'])
    db.session.add(nuevo)
    db.session.commit()
    return jsonify({"success": True, "id": nuevo.id})

# ---------------- API PARA CLAVES ----------------
@app.route('/api/generate-key', methods=['POST'])
@login_required
def gen_key():
    data = request.get_json()
    duracion_str = data.get('duration', '24h')
    delta = parse_duration(duracion_str)
    expira = datetime.datetime.utcnow() + delta if delta else None

    clave = ''.join(random.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", k=16))
    nueva = Key(
        owner_id=current_user.id,
        key=clave,
        panel_id=data.get('panel_id'),
        expires=expira,
        active=True
    )
    db.session.add(nueva)
    db.session.commit()

    return jsonify({
        "success": True,
        "key": clave,
        "expires": expira.strftime('%d/%m/%Y %H:%M UTC') if expira else "Nunca"
    })

@app.route('/api/toggle-key/<int:key_id>', methods=['POST'])
@login_required
def toggle_key(key_id):
    key = Key.query.get_or_404(key_id)
    if key.owner_id != current_user.id and not current_user.is_admin:
        return jsonify({"success": False, "error": "Sin permiso"})
    key.active = not key.active
    db.session.commit()
    return jsonify({"success": True, "active": key.active})

@app.route('/api/delete-key', methods=['POST'])
@login_required
def delete_key():
    data = request.get_json()
    clave = data.get('key', '').strip()
    key_obj = Key.query.filter_by(key=clave).first()
    if not key_obj:
        return jsonify({"success": False, "error": "Clave no encontrada"})
    if key_obj.owner_id != current_user.id and not current_user.is_admin:
        return jsonify({"success": False, "error": "Sin permiso"})
    db.session.delete(key_obj)
    db.session.commit()
    return jsonify({"success": True, "message": "Clave eliminada"})

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

@app.route('/api/reset-hwid', methods=['POST'])
def reset_hwid():
    data = request.get_json()
    if not data or 'key' not in data:
        return jsonify({"success": False, "error": "Clave requerida"})
    key = Key.query.filter_by(key=data['key'].strip(), active=True).first()
    if not key:
        return jsonify({"success": False, "error": "Clave no válida"})
    key.hwid = None
    db.session.commit()
    return jsonify({"success": True, "message": "HWID restablecido"})

# ---------------- API PARA BANEO HWID ----------------
@app.route('/api/ban-hwid', methods=['POST'])
@login_required
def ban_hwid():
    data = request.get_json()
    if not data or 'hwid' not in data:
        return jsonify({"success": False, "error": "HWID requerido"})
    hwid_hash = hashlib.sha256(data['hwid'].strip().encode()).hexdigest()
    if HWIDBan.query.filter_by(hwid_hash=hwid_hash).first():
        return jsonify({"success": False, "error": "Ya está baneado"})
    nuevo = HWIDBan(owner_id=current_user.id, hwid_hash=hwid_hash, reason=data.get('reason', 'Sin motivo'))
    db.session.add(nuevo)
    db.session.commit()
    return jsonify({"success": True})

# ---------------- INICIAR SERVIDOR ----------------
if __name__ == '__main__':
    app.run(host='0.0.0.0', port=int(os.environ.get("PORT", 8080)), debug=False)
