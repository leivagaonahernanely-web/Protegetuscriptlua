from flask import Flask, render_template, request, jsonify, redirect, url_for
from flask_sqlalchemy import SQLAlchemy
from flask_cors import CORS
from flask_login import LoginManager, UserMixin, login_user, login_required, current_user
import os, hashlib, random, datetime

app = Flask(__name__)
CORS(app)

app.config['SECRET_KEY'] = os.getenv('SECRET_KEY', 'protector_roblox_2026_89x7Qw2zR9pLm5sKj')
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///luau_protect.db'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

db = SQLAlchemy(app)
login_manager = LoginManager(app)
login_manager.login_view = 'login'

# Modelos
class User(UserMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    discord_id = db.Column(db.String(20), unique=True, nullable=False)
    username = db.Column(db.String(80))
    is_admin = db.Column(db.Boolean, default=False)

class Script(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), nullable=False)
    content = db.Column(db.Text, nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.datetime.utcnow)

class Key(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    key = db.Column(db.String(32), unique=True, nullable=False)
    script_id = db.Column(db.Integer, db.ForeignKey('script.id'))
    hwid = db.Column(db.String(64))
    expires_at = db.Column(db.DateTime)
    active = db.Column(db.Boolean, default=True)
    created_at = db.Column(db.DateTime, default=datetime.datetime.utcnow)

class BannedHWID(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    hwid = db.Column(db.String(64), unique=True, nullable=False)
    reason = db.Column(db.String(200))

@login_manager.user_loader
def load_user(user_id):
    return User.query.get(int(user_id))

with app.app_context():
    db.create_all()
    # Tu usuario admin
    if not User.query.filter_by(discord_id='1501316920975036611').first():
        admin = User(discord_id='1501316920975036611', username='hx_xitnotping', is_admin=True)
        db.session.add(admin)
        db.session.commit()

# Rutas del panel
@app.route('/')
@login_required
def index():
    scripts = Script.query.all()
    return render_template('index.html', scripts=scripts)

@app.route('/keys')
@login_required
def keys():
    keys = Key.query.all()
    return render_template('keys.html', keys=keys)

@app.route('/hwid-bans')
@login_required
def hwid_bans():
    bans = BannedHWID.query.all()
    return render_template('hwid_bans.html', bans=bans)

# API
@app.route('/api/upload-script', methods=['POST'])
@login_required
def upload_script():
    data = request.get_json()
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
    nueva = Key(key=clave, script_id=script_id, expires_at=expira, active=True)
    db.session.add(nueva)
    db.session.commit()
    return jsonify({"success": True, "key": clave})

@app.route('/api/redeem', methods=['POST'])
def redeem_key():
    data = request.get_json()
    clave = data.get('key')
    hwid = data.get('hwid')
    if not clave or not hwid:
        return jsonify({"ok": False, "msg": "Faltan datos"})
    reg = Key.query.filter_by(key=clave, active=True).first()
    if not reg:
        return jsonify({"ok": False, "msg": "Clave inválida"})
    if reg.expires_at and reg.expires_at < datetime.datetime.utcnow():
        return jsonify({"ok": False, "msg": "Clave expirada"})
    hwid_hash = hashlib.sha256(hwid.encode()).hexdigest()
    if not reg.hwid:
        reg.hwid = hwid_hash
        db.session.commit()
        return jsonify({"ok": True, "msg": "✅ Activada"})
    if reg.hwid == hwid_hash:
        return jsonify({"ok": True, "msg": "✅ Ya activada"})
    return jsonify({"ok": False, "msg": "❌ HWID no coincide"})

@app.route('/api/verify', methods=['POST'])
def verify():
    data = request.get_json()
    clave = data.get('key')
    hwid = data.get('hwid')
    if not clave or not hwid:
        return jsonify({"ok": False, "mensaje": "Sin datos"})
    reg = Key.query.filter_by(key=clave, active=True).first()
    if not reg:
        return jsonify({"ok": False, "mensaje": "Clave inválida"})
    if reg.expires_at and reg.expires_at < datetime.datetime.utcnow():
        return jsonify({"ok": False, "mensaje": "Clave expirada"})
    hwid_hash = hashlib.sha256(hwid.encode()).hexdigest()
    if reg.hwid and reg.hwid != hwid_hash:
        return jsonify({"ok": False, "mensaje": "❌ Equipo no autorizado"})
    return jsonify({"ok": True, "mensaje": "✅ Acceso permitido", "script": reg.script.content if reg.script else ""})

@app.route('/api/get-script', methods=['POST'])
def get_script():
    data = request.get_json()
    clave = data.get('key')
    hwid = data.get('hwid')
    if not clave or not hwid:
        return jsonify({"ok": False})
    reg = Key.query.filter_by(key=clave, active=True).first()
    if not reg or reg.hwid != hashlib.sha256(hwid.encode()).hexdigest():
        return jsonify({"ok": False})
    return jsonify({"ok": True, "script": reg.script.content if reg.script else ""})

@app.route('/api/reset-hwid', methods=['POST'])
def reset_hwid():
    data = request.get_json()
    clave = data.get('key')
    reg = Key.query.filter_by(key=clave).first()
    if reg:
        reg.hwid = None
        db.session.commit()
        return jsonify({"success": True})
    return jsonify({"success": False})

@app.route('/api/blacklist', methods=['POST'])
def blacklist():
    data = request.get_json()
    clave = data.get('key')
    reg = Key.query.filter_by(key=clave).first()
    if reg:
        reg.active = False
        db.session.commit()
        return jsonify({"success": True})
    return jsonify({"success": False})

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8080))
    app.run(host='0.0.0.0', port=port)
