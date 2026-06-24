from flask import Flask, render_template, request, jsonify
from flask_sqlalchemy import SQLAlchemy
from flask_cors import CORS
import os, hashlib, random, datetime

app = Flask(__name__)
CORS(app)

app.config['SECRET_KEY'] = os.getenv('SECRET_KEY', 'clave_segura_2026')
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///luau_protect.db'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

db = SQLAlchemy(app)

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

with app.app_context():
    db.create_all()

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/upload-script', methods=['POST'])
def upload_script():
    data = request.get_json()
    nuevo = Script(name=data['name'], content=data['content'])
    db.session.add(nuevo)
    db.session.commit()
    return jsonify({"success": True, "id": nuevo.id})

@app.route('/api/generate-key', methods=['POST'])
def generate_key():
    data = request.get_json() or {}
    duracion = int(data.get('duration', 0))
    clave = ''.join(random.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", k=16))
    expira = datetime.datetime.utcnow() + datetime.timedelta(hours=duracion) if duracion > 0 else None
    nueva = Key(key=clave, expires_at=expira, active=True)
    db.session.add(nueva)
    db.session.commit()
    return jsonify({"success": True, "key": clave})

@app.route('/api/redeem', methods=['POST'])
def redeem_key():
    data = request.get_json()
    clave = data.get('key')
    hwid = data.get('hwid')
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
    return jsonify({"ok": reg.hwid == hwid_hash, "msg": "✅ Ya activada" if reg.hwid == hwid_hash else "❌ HWID no coincide"})

@app.route('/api/verify', methods=['POST', 'GET'])
def verify():
    if request.method == 'POST':
        data = request.get_json()
        clave = data.get('key')
        hwid = data.get('hwid')
    else:
        clave = request.args.get('key')
        hwid = request.args.get('hwid')
    reg = Key.query.filter_by(key=clave, active=True).first()
    if not reg:
        return jsonify({"ok": False, "mensaje": "Clave inválida"})
    if reg.expires_at and reg.expires_at < datetime.datetime.utcnow():
        return jsonify({"ok": False, "mensaje": "Clave expirada"})
    hwid_hash = hashlib.sha256(hwid.encode()).hexdigest()
    if reg.hwid and reg.hwid != hwid_hash:
        return jsonify({"ok": False, "mensaje": "Equipo no autorizado"})
    return jsonify({"ok": True, "mensaje": "Acceso permitido", "script": reg.script.content if reg.script else ""})

@app.route('/api/get-script', methods=['POST'])
def get_script():
    data = request.get_json()
    clave = data.get('key')
    hwid = data.get('hwid')
    reg = Key.query.filter_by(key=clave, active=True).first()
    if not reg or reg.hwid != hashlib.sha256(hwid.encode()).hexdigest():
        return jsonify({"ok": False})
    return jsonify({"ok": True, "script": reg.script.content if reg.script else ""})

@app.route('/api/reset-hwid', methods=['POST'])
def reset_hwid():
    clave = request.get_json().get('key')
    reg = Key.query.filter_by(key=clave).first()
    if reg:
        reg.hwid = None
        db.session.commit()
        return jsonify({"success": True})
    return jsonify({"success": False})

@app.route('/api/blacklist', methods=['POST'])
def blacklist():
    clave = request.get_json().get('key')
    reg = Key.query.filter_by(key=clave).first()
    if reg:
        reg.active = False
        db.session.commit()
        return jsonify({"success": True})
    return jsonify({"success": False})

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8080))
    app.run(host='0.0.0.0', port=port)
