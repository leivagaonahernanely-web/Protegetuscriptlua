from flask import Flask, render_template, request, jsonify, redirect, url_for, flash
from flask_sqlalchemy import SQLAlchemy
from flask_login import LoginManager, UserMixin, login_user, login_required, current_user, logout_user
from flask_cors import CORS
import os, hashlib, random, datetime

app = Flask(__name__)
CORS(app)

# Configuración
app.config['SECRET_KEY'] = os.getenv('SECRET_KEY', 'LUAU_PROTECT_2026_SECRET_789xyz')
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///luau_protect.db'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

db = SQLAlchemy(app)
login_manager = LoginManager(app)
login_manager.login_view = 'login'
login_manager.login_message_category = 'info'

# Modelos
class User(UserMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    discord_id = db.Column(db.String(20), unique=True, nullable=False)
    username = db.Column(db.String(100), nullable=False)
    is_admin = db.Column(db.Boolean, default=False)
    created_at = db.Column(db.DateTime, default=datetime.datetime.utcnow)

class Script(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(150), nullable=False)
    content = db.Column(db.Text, nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.datetime.utcnow, onupdate=datetime.datetime.utcnow)

class Key(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    key = db.Column(db.String(32), unique=True, nullable=False)
    script_id = db.Column(db.Integer, db.ForeignKey('script.id'))
    hwid = db.Column(db.String(128))
    expires_at = db.Column(db.DateTime)
    active = db.Column(db.Boolean, default=True)
    created_by = db.Column(db.String(20))
    created_at = db.Column(db.DateTime, default=datetime.datetime.utcnow)

class BannedHWID(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    hwid_hash = db.Column(db.String(128), unique=True, nullable=False)
    reason = db.Column(db.String(255))
    banned_at = db.Column(db.DateTime, default=datetime.datetime.utcnow)

@login_manager.user_loader
def load_user(user_id):
    return User.query.get(int(user_id))

with app.app_context():
    db.create_all()
    # Agrega tu usuario admin automáticamente
    if not User.query.filter_by(discord_id='1501316920975036611').first():
        admin = User(
            discord_id='1501316920975036611',
            username='hx_xitnotping',
            is_admin=True
        )
        db.session.add(admin)
        db.session.commit()

# Rutas públicas
@app.route('/login', methods=['GET', 'POST'])
def login():
    if current_user.is_authenticated:
        return redirect(url_for('index'))
    if request.method == 'POST':
        discord_id = request.form.get('discord_id')
        if not discord_id:
            flash('Ingresa tu ID de Discord', 'danger')
            return render_template('login.html')
        user = User.query.filter_by(discord_id=discord_id).first()
        if user:
            login_user(user, remember=True)
            return redirect(url_for('index'))
        flash('ID no autorizado', 'danger')
    return render_template('login.html')

@app.route('/logout')
@login_required
def logout():
    logout_user()
    return redirect(url_for('login'))

# Rutas del panel
@app.route('/')
@login_required
def index():
    scripts = Script.query.order_by(Script.created_at.desc()).all()
    return render_template('index.html', scripts=scripts, user=current_user)

@app.route('/keys')
@login_required
def keys():
    all_keys = Key.query.order_by(Key.created_at.desc()).all()
    return render_template('keys.html', keys=all_keys, user=current_user)

@app.route('/hwid-bans')
@login_required
def hwid_bans():
    bans = BannedHWID.query.order_by(BannedHWID.banned_at.desc()).all()
    return render_template('hwid_bans.html', bans=bans, user=current_user)

# API
@app.route('/api/upload-script', methods=['POST'])
@login_required
def upload_script():
    data = request.get_json()
    if not data or 'name' not in data or 'content' not in data:
        return jsonify({"success": False, "error": "Datos incompletos"})
    nuevo = Script(name=data['name'], content=data['content'])
    db.session.add(nuevo)
    db.session.commit()
    return jsonify({"success": True, "id": nuevo.id})

@app.route('/api/generate-key', methods=['POST'])
@login_required
def generate_key():
    data = request.get_json() or {}
    duracion = int(data.get('duration', 0))
    script_id = data.get('script_id')
    clave = ''.join(random.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", k=16))
    expira = None
    if duracion > 0:
        expira = datetime.datetime.utcnow() + datetime.timedelta(hours=duracion)
    nueva = Key(
        key=clave,
        script_id=script_id,
        expires_at=expira,
        active=True,
        created_by=current_user.discord_id
    )
    db.session.add(nueva)
    db.session.commit()
    return jsonify({"success": True, "key": clave, "expires": expira.isoformat() if expira else "Permanente"})

@app.route('/api/redeem', methods=['POST'])
def redeem_key():
    data = request.get_json()
    clave = data.get('key')
    hwid = data.get('hwid')
    if not clave or not hwid:
        return jsonify({"ok": False, "msg": "Faltan datos"})
    reg = Key.query.filter_by(key=clave, active=True).first()
    if not reg:
        return jsonify({"ok": False, "msg": "Clave inválida o desactivada"})
    if reg.expires_at and reg.expires_at < datetime.datetime.utcnow():
        return jsonify({"ok": False, "msg": "Clave expirada"})
    hwid_hash = hashlib.sha256(hwid.encode()).hexdigest()
    if BannedHWID.query.filter_by(hwid_hash=hwid_hash).first():
        return jsonify({"ok": False, "msg": "Este HWID está baneado"})
    if not reg.hwid:
        reg.hwid = hwid_hash
        db.session.commit()
        return jsonify({"ok": True, "msg": "✅ Clave activada correctamente"})
    if reg.hwid == hwid_hash:
        return jsonify({"ok": True, "msg": "✅ Ya tienes acceso"})
    return jsonify({"ok": False, "msg": "❌ HWID no coincide con el registrado"})

@app.route('/api/verify', methods=['POST', 'GET'])
def verify():
    if request.method == 'POST':
        data = request.get_json()
        clave = data.get('key')
        hwid = data.get('hwid')
    else:
        clave = request.args.get('key')
        hwid = request.args.get('hwid')
    if not clave or not hwid:
        return jsonify({"ok": False, "mensaje": "Sin datos de acceso"})
    reg = Key.query.filter_by(key=clave, active=True).first()
    if not reg:
        return jsonify({"ok": False, "mensaje": "Clave inválida"})
    if reg.expires_at and reg.expires_at < datetime.datetime.utcnow():
        return jsonify({"ok": False, "mensaje": "Clave expirada"})
    hwid_hash = hashlib.sha256(hwid.encode()).hexdigest()
    if BannedHWID.query.filter_by(hwid_hash=hwid_hash).first():
        return jsonify({"ok": False, "mensaje": "Dispositivo baneado"})
    if reg.hwid and reg.hwid != hwid_hash:
        return jsonify({"ok": False, "mensaje": "❌ Dispositivo no autorizado"})
    return jsonify({
        "ok": True,
        "mensaje": "✅ Acceso permitido",
        "script": reg.script.content if reg.script else ""
    })

@app.route('/api/get-script', methods=['POST'])
def get_script():
    data = request.get_json()
    clave = data.get('key')
    hwid = data.get('hwid')
    if not clave or not hwid:
        return jsonify({"ok": False})
    reg = Key.query.filter_by(key=clave, active=True).first()
    hwid_hash = hashlib.sha256(hwid.encode()).hexdigest()
    if not reg or reg.hwid != hwid_hash or BannedHWID.query.filter_by(hwid_hash=hwid_hash).first():
        return jsonify({"ok": False})
    return jsonify({"ok": True, "script": reg.script.content if reg.script else ""})

@app.route('/api/reset-hwid', methods=['POST'])
@login_required
def reset_hwid():
    clave = request.get_json().get('key')
    reg = Key.query.filter_by(key=clave).first()
    if reg:
        reg.hwid = None
        db.session.commit()
        return jsonify({"success": True})
    return jsonify({"success": False})

@app.route('/api/ban-key', methods=['POST'])
@login_required
def ban_key():
    clave = request.get_json().get('key')
    reg = Key.query.filter_by(key=clave).first()
    if reg:
        reg.active = False
        db.session.commit()
        return jsonify({"success": True})
    return jsonify({"success": False})

@app.route('/api/ban-hwid', methods=['POST'])
@login_required
def ban_hwid():
    hwid = request.get_json().get('hwid')
    motivo = request.get_json().get('reason', 'Sin motivo')
    if not hwid:
        return jsonify({"success": False})
    hwid_hash = hashlib.sha256(hwid.encode()).hexdigest()
    if not BannedHWID.query.filter_by(hwid_hash=hwid_hash).first():
        nuevo_ban = BannedHWID(hwid_hash=hwid_hash, reason=motivo)
        db.session.add(nuevo_ban)
        db.session.commit()
    return jsonify({"success": True})

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8080))
    app.run(host='0.0.0.0', port=port)
 
