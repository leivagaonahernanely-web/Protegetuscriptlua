from flask import Flask, render_template, request, jsonify, redirect, url_for, flash, Response
from flask_sqlalchemy import SQLAlchemy
from flask_login import LoginManager, UserMixin, login_user, login_required, current_user, logout_user
from flask_cors import CORS
import os
import hashlib
import random
import datetime
import zlib
import base64

# ---------------------- CONFIGURACIÓN BÁSICA ----------------------
app = Flask(__name__)
CORS(app)

app.config['SECRET_KEY'] = os.getenv('SECRET_KEY', 'PROTECT_2026_SECURE_KEY_987XYZ')
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///luau_protect.db'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
app.config['PERMANENT_SESSION_LIFETIME'] = datetime.timedelta(days=30)

db = SQLAlchemy(app)
login_manager = LoginManager(app)
login_manager.login_view = 'login'

# ---------------------- MODELOS DE BASE DE DATOS ----------------------
class User(UserMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    discord_id = db.Column(db.String(20), unique=True, nullable=False)
    username = db.Column(db.String(100), nullable=False)
    is_admin = db.Column(db.Boolean, default=False)

class Script(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(150), nullable=False)
    content = db.Column(db.Text, nullable=False)
    file_hash = db.Column(db.String(128), unique=True, nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.datetime.utcnow)
    killswitch = db.Column(db.Boolean, default=False)
    trial_mode = db.Column(db.Boolean, default=False)
    anti_bypass = db.Column(db.Boolean, default=False)
    key_duration = db.Column(db.Integer, default=86400)

class Panel(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    title = db.Column(db.String(150), nullable=False)
    description = db.Column(db.Text)
    script_id = db.Column(db.Integer, db.ForeignKey('script.id'))
    reset_cooldown = db.Column(db.Integer, default=86400)

class Key(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    key = db.Column(db.String(16), unique=True, nullable=False)
    panel_id = db.Column(db.Integer, db.ForeignKey('panel.id'))
    hwid = db.Column(db.String(128))
    expires_at = db.Column(db.DateTime)
    note = db.Column(db.String(255))
    active = db.Column(db.Boolean, default=True)
    created_at = db.Column(db.DateTime, default=datetime.datetime.utcnow)

class BannedHWID(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    hwid_hash = db.Column(db.String(128), unique=True, nullable=False)
    reason = db.Column(db.String(255), default="Sin motivo")
    banned_at = db.Column(db.DateTime, default=datetime.datetime.utcnow)

@login_manager.user_loader
def load_user(user_id):
    return User.query.get(int(user_id))

# Crear tablas y usuario admin inicial
with app.app_context():
    db.create_all()
    if not User.query.filter_by(discord_id='1501316920975036611').first():
        admin = User(
            discord_id='1501316920975036611',
            username='hx_xitnotping',
            is_admin=True
        )
        db.session.add(admin)
        db.session.commit()

# ---------------------- RUTA PÚBLICA: SOLO MUESTRA EL LOADER ----------------------
@app.route('/scripts/hosted/<file_hash>.lua', methods=['GET'])
def hosted_script(file_hash):
    script = Script.query.filter_by(file_hash=file_hash).first()
    if not script:
        return Response("-- Script no encontrado", mimetype='text/plain', status=404)

    # Exactamente igual a la imagen, nada más
    codigo = f'''script_key = "KEY"  -- Paste your key here or if the script is free put trial

loadstring(game:HttpGet("https://{request.host}/api/verify?key="..script_key.."&hwid="..getgenv().HWID))()'''

    return Response(codigo, mimetype='text/plain; charset=utf-8')

# ---------------------- VERIFICACIÓN: NUNCA DEVUELVE CÓDIGO LEGIBLE ----------------------
@app.route('/api/verify', methods=['GET'])
def verify():
    clave = request.args.get('key', '').strip()
    hwid = request.args.get('hwid', '').strip()

    if not clave:
        return Response("return error('Missing key')", mimetype='text/plain', status=403)

    key = Key.query.filter_by(key=clave, active=True).first()
    if not key:
        return Response("return error('Invalid or inactive key')", mimetype='text/plain', status=403)

    if key.expires_at and key.expires_at < datetime.datetime.utcnow():
        return Response("return error('Key expired')", mimetype='text/plain', status=403)

    # Verificar HWID
    if hwid:
        hwid_hash = hashlib.sha256(hwid.encode()).hexdigest()
        if BannedHWID.query.filter_by(hwid_hash=hwid_hash).first():
            return Response("return error('HWID is banned')", mimetype='text/plain', status=403)
        if key.hwid and key.hwid != hwid_hash:
            return Response("return error('HWID mismatch')", mimetype='text/plain', status=403)
        if not key.hwid:
            key.hwid = hwid_hash
            db.session.commit()

    # Obtener script
    panel = Panel.query.get(key.panel_id)
    if not panel or not panel.script_id:
        return Response("return error('No script assigned')", mimetype='text/plain', status=404)

    script = Script.query.get(panel.script_id)
    if not script:
        return Response("return error('Script not found')", mimetype='text/plain', status=404)

    # Killswitch
    if script.killswitch:
        return Response("return error('Script disabled by admin')", mimetype='text/plain', status=403)

    # 🔐 Solo enviamos datos comprimidos + codificados, NADA LEGIBLE
    comprimido = zlib.compress(script.content.encode('utf-8'), 9)
    codificado = base64.b64encode(comprimido).decode('utf-8')

    ejecutable = f'''
local d="{codificado}"
local gs = game:GetService("HttpService")
local f = loadstring or load
if f then
    f(gs:Decompress(gs:Base64Decode(d)))()
end
d=nil collectgarbage()
'''

    return Response(ejecutable, mimetype='text/plain; charset=utf-8')

# ---------------------- RUTAS DE AUTENTICACIÓN ----------------------
@app.route('/login', methods=['GET', 'POST'])
def login():
    if current_user.is_authenticated:
        return redirect(url_for('scripts_page'))
    if request.method == 'POST':
        discord_id = request.form.get('discord_id', '').strip()
        user = User.query.filter_by(discord_id=discord_id).first()
        if user:
            login_user(user, remember=True)
            return redirect(url_for('scripts_page'))
        flash('ID no autorizado o incorrecto', 'danger')
    return render_template('login.html')

@app.route('/logout')
@login_required
def logout():
    logout_user()
    return redirect(url_for('login'))

# ---------------------- RUTAS DEL PANEL ----------------------
@app.route('/')
@login_required
def index():
    return redirect(url_for('scripts_page'))

@app.route('/scripts')
@login_required
def scripts_page():
    return render_template('scripts.html', scripts=Script.query.all(), user=current_user)

@app.route('/panels')
@login_required
def panels_page():
    return render_template('panels.html', panels=Panel.query.all(), scripts=Script.query.all(), user=current_user)

@app.route('/keys')
@login_required
def keys_page():
    return render_template('keys.html', keys=Key.query.all(), panels=Panel.query.all(), user=current_user)

@app.route('/hwid-bans')
@login_required
def hwid_bans_page():
    return render_template('hwid_bans.html', bans=BannedHWID.query.all(), user=current_user)

@app.route('/vault')
@login_required
def vault_page():
    return render_template('vault.html', user=current_user)

@app.route('/ads')
@login_required
def ads_page():
    return render_template('ads.html', user=current_user)

# ---------------------- API PARA ACCIONES ----------------------
@app.route('/api/upload-script', methods=['POST'])
@login_required
def upload_script():
    data = request.get_json()
    if not data or 'name' not in data or 'content' not in data:
        return jsonify({"success": False, "error": "Datos incompletos"})

    file_hash = hashlib.sha256(f"{data['name']}{datetime.datetime.utcnow()}".encode()).hexdigest()

    nuevo = Script(
        name=data['name'],
        content=data['content'],
        file_hash=file_hash
    )
    db.session.add(nuevo)
    db.session.commit()

    url_final = f"https://{request.host}/scripts/hosted/{file_hash}.lua"
    return jsonify({"success": True, "id": nuevo.id, "url": url_final})

@app.route('/api/update-script/<int:script_id>', methods=['POST'])
@login_required
def update_script(script_id):
    script = Script.query.get_or_404(script_id)
    data = request.get_json()

    script.killswitch = data.get('killswitch', False)
    script.trial_mode = data.get('trial_mode', False)
    script.anti_bypass = data.get('anti_bypass', False)
    script.key_duration = int(data.get('key_duration', 86400))

    if data.get('content'):
        script.content = data['content']

    db.session.commit()
    return jsonify({"success": True})

@app.route('/api/create-panel', methods=['POST'])
@login_required
def create_panel():
    data = request.get_json()
    nuevo = Panel(
        title=data['title'],
        description=data.get('description', ''),
        script_id=data['script_id']
    )
    db.session.add(nuevo)
    db.session.commit()
    return jsonify({"success": True, "id": nuevo.id})

@app.route('/api/generate-key', methods=['POST'])
@login_required
def generate_key():
    data = request.get_json()
    duracion = int(data.get('duration', 0))
    clave = ''.join(random.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", k=16))
    expira = datetime.datetime.utcnow() + datetime.timedelta(hours=duracion) if duracion > 0 else None

    nueva = Key(
        key=clave,
        panel_id=data['panel_id'],
        note=data.get('note', ''),
        expires_at=expira
    )
    db.session.add(nueva)
    db.session.commit()
    return jsonify({"success": True, "key": clave})

@app.route('/api/reset-hwid', methods=['POST'])
@login_required
def reset_hwid():
    clave = request.get_json().get('key')
    key = Key.query.filter_by(key=clave).first()
    if key:
        key.hwid = None
        db.session.commit()
        return jsonify({"success": True})
    return jsonify({"success": False})

@app.route('/api/ban-key', methods=['POST'])
@login_required
def ban_key():
    clave = request.get_json().get('key')
    key = Key.query.filter_by(key=clave).first()
    if key:
        key.active = False
        db.session.commit()
        return jsonify({"success": True})
    return jsonify({"success": False})

@app.route('/api/ban-hwid', methods=['POST'])
@login_required
def ban_hwid():
    hwid = request.get_json().get('hwid', '').strip()
    motivo = request.get_json().get('reason', 'Sin motivo')
    if not hwid:
        return jsonify({"success": False})
    hwid_hash = hashlib.sha256(hwid.encode()).hexdigest()
    if not BannedHWID.query.filter_by(hwid_hash=hwid_hash).first():
        db.session.add(BannedHWID(hwid_hash=hwid_hash, reason=motivo))
        db.session.commit()
    return jsonify({"success": True})

# ---------------------- INICIO DEL SERVIDOR ----------------------
if __name__ == '__main__':
    app.run(host='0.0.0.0', port=int(os.getenv('PORT', 8080)))
