import os
import io
import uuid
import secrets
import mimetypes
import zipfile
import queue
from datetime import datetime, timedelta
from pathlib import Path

from flask import (
    Flask, render_template, request, jsonify, send_file, redirect,
    url_for, flash, abort, session, Response, stream_with_context
)
from flask_sqlalchemy import SQLAlchemy
from flask_login import (
    LoginManager, UserMixin, login_user, logout_user, login_required, current_user
)
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from werkzeug.security import generate_password_hash, check_password_hash
from werkzeug.utils import secure_filename

from storage import get_storage
import events
import thumbs

BASE_DIR = Path(__file__).parent.resolve()
DATA_DIR = Path(os.environ.get("DATA_DIR", BASE_DIR))
INSTANCE_DIR = DATA_DIR / "instance"
INSTANCE_DIR.mkdir(exist_ok=True, parents=True)
TMP_UPLOAD_DIR = DATA_DIR / "tmp_uploads"
TMP_UPLOAD_DIR.mkdir(exist_ok=True, parents=True)

app = Flask(__name__)

# Trust the Railway/proxy X-Forwarded-* headers so url_for(_external=True)
# returns https:// URLs (otherwise auto-share links come out as insecure http://).
from werkzeug.middleware.proxy_fix import ProxyFix
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_prefix=1)
app.config["PREFERRED_URL_SCHEME"] = "https"

# Cache-bust static assets per process (changes on every deploy)
_CACHE_BUST = secrets.token_hex(4)


@app.context_processor
def inject_cache_bust():
    return {"cb": _CACHE_BUST}
secret_env = os.environ.get("SECRET_KEY")
if not secret_env and os.environ.get("FLASK_ENV") == "production":
    raise RuntimeError("SECRET_KEY must be set in production")
app.config["SECRET_KEY"] = secret_env or "dev-" + secrets.token_hex(16)

# Postgres via DATABASE_URL, SQLite fallback
db_url = os.environ.get("DATABASE_URL")
if db_url and db_url.startswith("postgres://"):
    db_url = db_url.replace("postgres://", "postgresql://", 1)
app.config["SQLALCHEMY_DATABASE_URI"] = db_url or "sqlite:///" + str(INSTANCE_DIR / "cloudvault.db")
app.config["MAX_CONTENT_LENGTH"] = 500 * 1024 * 1024
app.config["TRASH_RETENTION_DAYS"] = 30

PLANS = {
    "free":     {"name": "Free",     "price": 0,      "quota": 15 * 1024**3,   "max_file": 500 * 1024**2},
    "pro":      {"name": "Pro",      "price": 4.99,   "quota": 100 * 1024**3,  "max_file": 5  * 1024**3},
    "business": {"name": "Business", "price": 14.99,  "quota": 1024 * 1024**3, "max_file": 20 * 1024**3},
}
app.config["FREE_QUOTA_BYTES"] = PLANS["free"]["quota"]

db = SQLAlchemy(app)
login_manager = LoginManager(app)
login_manager.login_view = "login"

limiter = Limiter(get_remote_address, app=app, default_limits=[])

storage = get_storage(DATA_DIR)


# ---------------- Models ----------------
class User(UserMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    email = db.Column(db.String(120), unique=True, nullable=False)
    name = db.Column(db.String(80), nullable=False)
    password_hash = db.Column(db.String(255), nullable=False)
    plan = db.Column(db.String(20), default="free")
    plan_expires_at = db.Column(db.DateTime, nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    def plan_info(self):
        return PLANS.get(self.plan or "free", PLANS["free"])

    def quota_bytes(self):
        return self.plan_info()["quota"]


class Folder(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(255), nullable=False)
    owner_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False)
    parent_id = db.Column(db.Integer, db.ForeignKey("folder.id"), nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    trashed_at = db.Column(db.DateTime, nullable=True)


class File(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(255), nullable=False)
    storage_key = db.Column(db.String(80), unique=True, nullable=False)
    mime = db.Column(db.String(120))
    size = db.Column(db.BigInteger, default=0)
    owner_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False)
    folder_id = db.Column(db.Integer, db.ForeignKey("folder.id"), nullable=True)
    starred = db.Column(db.Boolean, default=False)
    has_thumb = db.Column(db.Boolean, default=False)
    trashed_at = db.Column(db.DateTime, nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    accessed_at = db.Column(db.DateTime, default=datetime.utcnow)


class Share(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    token = db.Column(db.String(40), unique=True, nullable=False)
    file_id = db.Column(db.Integer, db.ForeignKey("file.id"), nullable=False)
    expires_at = db.Column(db.DateTime, nullable=True)
    password_hash = db.Column(db.String(255), nullable=True)
    allow_download = db.Column(db.Boolean, default=True)
    downloads = db.Column(db.Integer, default=0)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)


class Tag(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(60), nullable=False)
    color = db.Column(db.String(20), default="#3b82f6")
    owner_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)


file_tags = db.Table(
    "file_tags",
    db.Column("file_id", db.Integer, db.ForeignKey("file.id"), primary_key=True),
    db.Column("tag_id", db.Integer, db.ForeignKey("tag.id"), primary_key=True),
)
File.tags = db.relationship("Tag", secondary=file_tags, backref="files")


class UploadSession(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    upload_id = db.Column(db.String(40), unique=True, nullable=False)
    owner_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False)
    filename = db.Column(db.String(255), nullable=False)
    folder_id = db.Column(db.Integer, db.ForeignKey("folder.id"), nullable=True)
    size = db.Column(db.BigInteger, default=0)
    mime = db.Column(db.String(120))
    received = db.Column(db.BigInteger, default=0)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)


@login_manager.user_loader
def load_user(uid):
    return User.query.get(int(uid))


# ---------------- Helpers ----------------
def used_bytes(user_id):
    total = db.session.query(db.func.coalesce(db.func.sum(File.size), 0)).filter_by(
        owner_id=user_id, trashed_at=None
    ).scalar()
    return int(total or 0)


AUTO_SHARE_DAYS = 7


def _auto_share_for(file_record):
    """Auto-create a public share link with no password, 7-day expiry."""
    token = secrets.token_urlsafe(16)
    expires_at = datetime.utcnow() + timedelta(days=AUTO_SHARE_DAYS)
    share = Share(
        token=token, file_id=file_record.id, expires_at=expires_at,
        password_hash=None, allow_download=True,
    )
    db.session.add(share)
    return share


def _latest_share_for(file_id):
    """Return the most recent non-expired Share for a file, or None."""
    share = Share.query.filter_by(file_id=file_id).order_by(Share.created_at.desc()).first()
    if not share:
        return None
    if share.expires_at and share.expires_at < datetime.utcnow():
        return None
    return share


def file_to_dict(f):
    share = _latest_share_for(f.id)
    share_url = url_for("public_share", token=share.token, _external=True) if share else None
    return {
        "id": f.id,
        "name": f.name,
        "size": f.size,
        "mime": f.mime,
        "starred": f.starred,
        "folder_id": f.folder_id,
        "has_thumb": f.has_thumb,
        "created_at": f.created_at.isoformat() if f.created_at else None,
        "trashed_at": f.trashed_at.isoformat() if f.trashed_at else None,
        "tags": [{"id": t.id, "name": t.name, "color": t.color} for t in f.tags],
        "share_url": share_url,
        "share_token": share.token if share else None,
        "share_expires_at": share.expires_at.isoformat() if share and share.expires_at else None,
        "type": "file",
    }


def folder_to_dict(f):
    return {
        "id": f.id,
        "name": f.name,
        "parent_id": f.parent_id,
        "created_at": f.created_at.isoformat() if f.created_at else None,
        "trashed_at": f.trashed_at.isoformat() if f.trashed_at else None,
        "type": "folder",
    }


def emit(user_id, event, payload=None):
    try:
        events.publish(user_id, event, payload)
    except Exception:
        pass


# ---------------- PWA routes (root-scope) ----------------
@app.route("/sw.js")
def service_worker():
    """Serve service worker from root so it controls full origin scope."""
    resp = app.send_static_file("sw.js")
    resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    resp.headers["Service-Worker-Allowed"] = "/"
    return resp


@app.route("/manifest.webmanifest")
def manifest():
    resp = app.send_static_file("manifest.webmanifest")
    resp.headers["Content-Type"] = "application/manifest+json"
    return resp


@app.route("/favicon.ico")
def favicon():
    return app.send_static_file("icons/favicon-32.png")


@app.route("/offline")
def offline():
    return render_template("offline.html")


# ---------------- Auth routes ----------------
@app.route("/")
def index():
    if current_user.is_authenticated:
        return redirect(url_for("drive"))
    return render_template("landing.html")


@app.route("/home")
def home():
    """Public landing page, accessible even when logged in.
    Logged-in users see the landing with a 'My Drive' button via the appnav."""
    return render_template("landing.html")


@app.route("/login", methods=["GET", "POST"])
@limiter.limit("10 per minute", methods=["POST"])
def login():
    if request.method == "POST":
        email = request.form.get("email", "").strip().lower()
        password = request.form.get("password", "")
        user = User.query.filter_by(email=email).first()
        if user and check_password_hash(user.password_hash, password):
            login_user(user, remember=True)
            return redirect(url_for("drive"))
        flash("Invalid email or password", "error")
    return render_template("login.html")


@app.route("/register", methods=["GET", "POST"])
@limiter.limit("5 per minute", methods=["POST"])
def register():
    if request.method == "POST":
        email = request.form.get("email", "").strip().lower()
        name = request.form.get("name", "").strip()
        password = request.form.get("password", "")
        if not email or not password or len(password) < 6:
            flash("Email and password (6+ chars) required", "error")
            return render_template("register.html")
        if User.query.filter_by(email=email).first():
            flash("Email already registered", "error")
            return render_template("register.html")
        user = User(email=email, name=name or email.split("@")[0],
                    password_hash=generate_password_hash(password))
        db.session.add(user)
        db.session.commit()
        login_user(user, remember=True)
        return redirect(url_for("drive"))
    return render_template("register.html")


@app.route("/logout")
@login_required
def logout():
    logout_user()
    return redirect(url_for("index"))


# ---------------- Drive UI ----------------
@app.route("/drive")
@login_required
def drive():
    return render_template("drive.html", user=current_user)


@app.route("/settings")
@login_required
def settings_page():
    return render_template("settings.html", user=current_user)


@app.route("/shared")
@login_required
def shared_page():
    return render_template("shared.html", user=current_user)


# ---------------- API: me ----------------
@app.route("/api/me")
@login_required
def api_me():
    p = current_user.plan_info()
    return jsonify({
        "id": current_user.id,
        "email": current_user.email,
        "name": current_user.name,
        "plan": current_user.plan or "free",
        "plan_name": p["name"],
        "plan_price": p["price"],
        "used": used_bytes(current_user.id),
        "quota": current_user.quota_bytes(),
    })


@app.route("/api/me", methods=["PATCH"])
@login_required
def api_update_me():
    data = request.get_json() or {}
    if "name" in data:
        current_user.name = data["name"].strip()[:80]
    if "new_password" in data:
        if not check_password_hash(current_user.password_hash, data.get("current_password", "")):
            return jsonify({"error": "Current password incorrect"}), 403
        if len(data["new_password"]) < 6:
            return jsonify({"error": "Password too short"}), 400
        current_user.password_hash = generate_password_hash(data["new_password"])
    db.session.commit()
    return jsonify({"ok": True})


# ---------------- API: files list ----------------
@app.route("/api/files")
@login_required
def api_list():
    view = request.args.get("view", "my")
    folder_id = request.args.get("folder", type=int)
    q = request.args.get("q", "").strip()
    sort = request.args.get("sort", "name")
    order = request.args.get("order", "asc")
    tag_id = request.args.get("tag", type=int)

    folders_q = Folder.query.filter_by(owner_id=current_user.id)
    files_q = File.query.filter_by(owner_id=current_user.id)

    if view == "trash":
        folders_q = folders_q.filter(Folder.trashed_at.isnot(None))
        files_q = files_q.filter(File.trashed_at.isnot(None))
    else:
        folders_q = folders_q.filter(Folder.trashed_at.is_(None))
        files_q = files_q.filter(File.trashed_at.is_(None))
        if view == "starred":
            files_q = files_q.filter_by(starred=True)
            folders_q = folders_q.filter(False)
        elif view == "recent":
            files_q = files_q.order_by(File.accessed_at.desc()).limit(30)
            folders_q = folders_q.filter(False)
        elif view == "shared":
            shared_ids = [s.file_id for s in Share.query.join(File).filter(File.owner_id == current_user.id).all()]
            files_q = files_q.filter(File.id.in_(shared_ids)) if shared_ids else files_q.filter(False)
            folders_q = folders_q.filter(False)
        elif view == "tag" and tag_id:
            files_q = files_q.filter(File.tags.any(Tag.id == tag_id))
            folders_q = folders_q.filter(False)
        else:
            folders_q = folders_q.filter_by(parent_id=folder_id)
            files_q = files_q.filter_by(folder_id=folder_id)

    if q:
        like = f"%{q}%"
        files_q = files_q.filter(File.name.ilike(like))
        folders_q = folders_q.filter(Folder.name.ilike(like))

    if view != "recent":
        col = {"size": File.size, "date": File.created_at}.get(sort, File.name)
        files_q = files_q.order_by(col.desc() if order == "desc" else col.asc())
        folders_q = folders_q.order_by(Folder.name.desc() if order == "desc" else Folder.name.asc())

    return jsonify({
        "folders": [folder_to_dict(f) for f in folders_q.all()],
        "files": [file_to_dict(f) for f in files_q.all()],
        "breadcrumb": _breadcrumb(folder_id),
    })


def _breadcrumb(folder_id):
    out = []
    if folder_id:
        cur = Folder.query.filter_by(id=folder_id, owner_id=current_user.id).first()
        while cur:
            out.insert(0, {"id": cur.id, "name": cur.name})
            cur = Folder.query.get(cur.parent_id) if cur.parent_id else None
    return out


# ---------------- API: folders ----------------
@app.route("/api/folders", methods=["POST"])
@login_required
def api_create_folder():
    data = request.get_json() or {}
    name = (data.get("name") or "Untitled folder").strip()[:255]
    parent_id = data.get("parent_id")
    folder = Folder(name=name, owner_id=current_user.id, parent_id=parent_id)
    db.session.add(folder)
    db.session.commit()
    emit(current_user.id, "folder_created", folder_to_dict(folder))
    return jsonify(folder_to_dict(folder))


@app.route("/api/folders/<int:folder_id>", methods=["PATCH"])
@login_required
def api_rename_folder(folder_id):
    folder = Folder.query.filter_by(id=folder_id, owner_id=current_user.id).first_or_404()
    data = request.get_json() or {}
    if "name" in data:
        folder.name = data["name"].strip()[:255]
    if "parent_id" in data:
        folder.parent_id = data["parent_id"]
    db.session.commit()
    emit(current_user.id, "folder_updated", folder_to_dict(folder))
    return jsonify(folder_to_dict(folder))


@app.route("/api/folders/<int:folder_id>", methods=["DELETE"])
@login_required
def api_trash_folder(folder_id):
    folder = Folder.query.filter_by(id=folder_id, owner_id=current_user.id).first_or_404()
    permanent = request.args.get("permanent") == "1"
    if permanent or folder.trashed_at:
        for f in File.query.filter_by(folder_id=folder_id, owner_id=current_user.id).all():
            storage.delete(current_user.id, f.storage_key)
            storage.delete(current_user.id, "_thumb/" + f.storage_key + ".jpg")
            db.session.delete(f)
        db.session.delete(folder)
    else:
        folder.trashed_at = datetime.utcnow()
        for f in File.query.filter_by(folder_id=folder_id, owner_id=current_user.id, trashed_at=None).all():
            f.trashed_at = datetime.utcnow()
    db.session.commit()
    emit(current_user.id, "folder_deleted", {"id": folder_id})
    return jsonify({"ok": True})


@app.route("/api/folders/<int:folder_id>/restore", methods=["POST"])
@login_required
def api_restore_folder(folder_id):
    folder = Folder.query.filter_by(id=folder_id, owner_id=current_user.id).first_or_404()
    folder.trashed_at = None
    db.session.commit()
    emit(current_user.id, "folder_updated", folder_to_dict(folder))
    return jsonify(folder_to_dict(folder))


@app.route("/api/folders/tree")
@login_required
def api_folder_tree():
    folders = Folder.query.filter_by(owner_id=current_user.id, trashed_at=None).order_by(Folder.name).all()
    out = []
    for f in folders:
        path = [f.name]
        cur = f
        while cur.parent_id:
            cur = Folder.query.get(cur.parent_id)
            if not cur: break
            path.insert(0, cur.name)
        out.append({"id": f.id, "name": f.name, "path": " / ".join(path)})
    return jsonify(out)


@app.route("/api/folders/<int:folder_id>/download")
@login_required
def api_folder_zip(folder_id):
    folder = Folder.query.filter_by(id=folder_id, owner_id=current_user.id).first_or_404()
    return Response(
        stream_with_context(_stream_zip_folder(folder)),
        mimetype="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{folder.name}.zip"'}
    )


def _stream_zip_folder(folder):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as zf:
        _add_folder_to_zip(zf, folder, prefix=folder.name)
    buf.seek(0)
    yield from buf


def _add_folder_to_zip(zf, folder, prefix=""):
    for f in File.query.filter_by(folder_id=folder.id, owner_id=folder.owner_id, trashed_at=None).all():
        try:
            data = storage.get(folder.owner_id, f.storage_key)
            zf.writestr(f"{prefix}/{f.name}", data)
        except Exception:
            continue
    for sub in Folder.query.filter_by(parent_id=folder.id, owner_id=folder.owner_id, trashed_at=None).all():
        _add_folder_to_zip(zf, sub, prefix=f"{prefix}/{sub.name}")


# ---------------- API: legacy single-shot upload ----------------
@app.route("/api/upload", methods=["POST"])
@login_required
@limiter.limit("120 per hour")
def api_upload():
    if "file" not in request.files:
        return jsonify({"error": "No file"}), 400
    f = request.files["file"]
    if not f.filename:
        return jsonify({"error": "Empty filename"}), 400

    folder_id = request.form.get("folder_id", type=int)
    data = f.read()
    size = len(data)

    if used_bytes(current_user.id) + size > current_user.quota_bytes():
        return jsonify({"error": "Quota exceeded"}), 413

    storage_key = uuid.uuid4().hex
    mime = f.mimetype or mimetypes.guess_type(f.filename)[0] or "application/octet-stream"
    storage.put(current_user.id, storage_key, data)

    has_thumb = False
    thumb_data = thumbs.generate(f.filename, mime, data)
    if thumb_data:
        storage.put(current_user.id, f"_thumb/{storage_key}.jpg", thumb_data)
        has_thumb = True

    record = File(
        name=secure_filename(f.filename) or f.filename,
        storage_key=storage_key,
        mime=mime, size=size,
        owner_id=current_user.id, folder_id=folder_id,
        has_thumb=has_thumb,
    )
    db.session.add(record)
    db.session.flush()
    _auto_share_for(record)
    db.session.commit()
    emit(current_user.id, "file_created", file_to_dict(record))
    return jsonify(file_to_dict(record))


# ---------------- API: resumable chunked upload ----------------
@app.route("/api/upload/init", methods=["POST"])
@login_required
def api_upload_init():
    data = request.get_json() or {}
    filename = data.get("filename")
    size = int(data.get("size", 0))
    mime = data.get("mime") or mimetypes.guess_type(filename or "")[0] or "application/octet-stream"
    folder_id = data.get("folder_id")
    if not filename or size <= 0:
        return jsonify({"error": "filename and size required"}), 400
    if used_bytes(current_user.id) + size > current_user.quota_bytes():
        return jsonify({"error": "Quota exceeded"}), 413
    upload_id = uuid.uuid4().hex
    sess = UploadSession(
        upload_id=upload_id, owner_id=current_user.id,
        filename=filename, folder_id=folder_id, size=size, mime=mime
    )
    db.session.add(sess)
    db.session.commit()
    # Create empty staging file
    staging = TMP_UPLOAD_DIR / f"{current_user.id}_{upload_id}"
    staging.touch()
    return jsonify({"upload_id": upload_id, "chunk_size": 5 * 1024 * 1024})


@app.route("/api/upload/<upload_id>", methods=["PATCH"])
@login_required
def api_upload_patch(upload_id):
    sess = UploadSession.query.filter_by(upload_id=upload_id, owner_id=current_user.id).first_or_404()
    offset = int(request.args.get("offset", 0))
    chunk = request.get_data()
    staging = TMP_UPLOAD_DIR / f"{current_user.id}_{upload_id}"
    # Tolerate retries: open in r+b, seek, write
    with open(staging, "r+b") as f:
        f.seek(offset)
        f.write(chunk)
    sess.received = max(sess.received, offset + len(chunk))
    db.session.commit()
    return jsonify({"received": sess.received, "size": sess.size})


@app.route("/api/upload/<upload_id>/complete", methods=["POST"])
@login_required
def api_upload_complete(upload_id):
    sess = UploadSession.query.filter_by(upload_id=upload_id, owner_id=current_user.id).first_or_404()
    staging = TMP_UPLOAD_DIR / f"{current_user.id}_{upload_id}"
    if not staging.exists():
        return jsonify({"error": "missing chunks"}), 400
    with open(staging, "rb") as f:
        data = f.read()
    if len(data) != sess.size:
        return jsonify({"error": f"size mismatch: got {len(data)} want {sess.size}"}), 400

    storage_key = uuid.uuid4().hex
    storage.put(current_user.id, storage_key, data)
    has_thumb = False
    t = thumbs.generate(sess.filename, sess.mime, data)
    if t:
        storage.put(current_user.id, f"_thumb/{storage_key}.jpg", t)
        has_thumb = True

    record = File(
        name=secure_filename(sess.filename) or sess.filename,
        storage_key=storage_key, mime=sess.mime, size=sess.size,
        owner_id=current_user.id, folder_id=sess.folder_id,
        has_thumb=has_thumb,
    )
    db.session.add(record)
    db.session.flush()
    _auto_share_for(record)
    db.session.delete(sess)
    db.session.commit()
    staging.unlink(missing_ok=True)
    emit(current_user.id, "file_created", file_to_dict(record))
    return jsonify(file_to_dict(record))


# ---------------- API: file download / preview / thumb ----------------
def _serve_file_data(f: File, attachment=False):
    f.accessed_at = datetime.utcnow()
    db.session.commit()
    presigned = storage.presigned_url(f.owner_id, f.storage_key)
    if presigned:
        return redirect(presigned)
    p = storage.stream_path(f.owner_id, f.storage_key)
    if p and Path(p).exists():
        return send_file(p, as_attachment=attachment, download_name=f.name, mimetype=f.mime, conditional=True)
    data = storage.get(f.owner_id, f.storage_key)
    return send_file(io.BytesIO(data), as_attachment=attachment, download_name=f.name, mimetype=f.mime)


@app.route("/api/files/<int:file_id>/download")
@login_required
def api_download(file_id):
    f = File.query.filter_by(id=file_id, owner_id=current_user.id).first_or_404()
    return _serve_file_data(f, attachment=True)


@app.route("/api/files/<int:file_id>/preview")
@login_required
def api_preview(file_id):
    f = File.query.filter_by(id=file_id, owner_id=current_user.id).first_or_404()
    return _serve_file_data(f, attachment=False)


@app.route("/api/files/<int:file_id>/thumb")
@login_required
def api_thumb(file_id):
    f = File.query.filter_by(id=file_id, owner_id=current_user.id).first_or_404()
    if not f.has_thumb:
        abort(404)
    key = f"_thumb/{f.storage_key}.jpg"
    p = storage.stream_path(f.owner_id, key)
    if p and Path(p).exists():
        return send_file(p, mimetype="image/jpeg", conditional=True)
    try:
        data = storage.get(f.owner_id, key)
        return send_file(io.BytesIO(data), mimetype="image/jpeg")
    except Exception:
        abort(404)


# ---------------- API: file PATCH/DELETE ----------------
@app.route("/api/files/<int:file_id>", methods=["PATCH"])
@login_required
def api_update(file_id):
    f = File.query.filter_by(id=file_id, owner_id=current_user.id).first_or_404()
    data = request.get_json() or {}
    if "name" in data:
        f.name = data["name"][:255]
    if "starred" in data:
        f.starred = bool(data["starred"])
    if "folder_id" in data:
        f.folder_id = data["folder_id"]
    db.session.commit()
    emit(current_user.id, "file_updated", file_to_dict(f))
    return jsonify(file_to_dict(f))


@app.route("/api/files/<int:file_id>", methods=["DELETE"])
@login_required
def api_trash(file_id):
    f = File.query.filter_by(id=file_id, owner_id=current_user.id).first_or_404()
    permanent = request.args.get("permanent") == "1"
    if permanent or f.trashed_at:
        storage.delete(current_user.id, f.storage_key)
        storage.delete(current_user.id, f"_thumb/{f.storage_key}.jpg")
        db.session.delete(f)
    else:
        f.trashed_at = datetime.utcnow()
    db.session.commit()
    emit(current_user.id, "file_deleted", {"id": file_id})
    return jsonify({"ok": True})


@app.route("/api/files/<int:file_id>/restore", methods=["POST"])
@login_required
def api_restore(file_id):
    f = File.query.filter_by(id=file_id, owner_id=current_user.id).first_or_404()
    f.trashed_at = None
    db.session.commit()
    emit(current_user.id, "file_updated", file_to_dict(f))
    return jsonify(file_to_dict(f))


# ---------------- API: bulk + trash empty ----------------
@app.route("/api/bulk", methods=["POST"])
@login_required
def api_bulk():
    data = request.get_json() or {}
    action = data.get("action")
    file_ids = data.get("file_ids") or []
    folder_ids = data.get("folder_ids") or []
    target_folder = data.get("target_folder")

    files = File.query.filter(File.id.in_(file_ids), File.owner_id == current_user.id).all()
    folders = Folder.query.filter(Folder.id.in_(folder_ids), Folder.owner_id == current_user.id).all()
    now = datetime.utcnow()

    if action == "trash":
        for f in files: f.trashed_at = now
        for fo in folders:
            fo.trashed_at = now
            for f in File.query.filter_by(folder_id=fo.id, owner_id=current_user.id, trashed_at=None).all():
                f.trashed_at = now
    elif action == "restore":
        for f in files: f.trashed_at = None
        for fo in folders: fo.trashed_at = None
    elif action == "delete":
        for f in files:
            storage.delete(current_user.id, f.storage_key)
            storage.delete(current_user.id, f"_thumb/{f.storage_key}.jpg")
            db.session.delete(f)
        for fo in folders:
            for f in File.query.filter_by(folder_id=fo.id, owner_id=current_user.id).all():
                storage.delete(current_user.id, f.storage_key)
                storage.delete(current_user.id, f"_thumb/{f.storage_key}.jpg")
                db.session.delete(f)
            db.session.delete(fo)
    elif action == "star":
        for f in files: f.starred = True
    elif action == "unstar":
        for f in files: f.starred = False
    elif action == "move":
        tid = int(target_folder) if target_folder else None
        for f in files: f.folder_id = tid
        for fo in folders:
            if fo.id != tid: fo.parent_id = tid
    elif action == "zip":
        return _bulk_zip(files, folders)

    db.session.commit()
    emit(current_user.id, "bulk_updated", {"action": action})
    return jsonify({"ok": True, "count": len(files) + len(folders)})


def _bulk_zip(files, folders):
    def gen():
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as zf:
            for f in files:
                try:
                    zf.writestr(f.name, storage.get(f.owner_id, f.storage_key))
                except Exception:
                    pass
            for fo in folders:
                _add_folder_to_zip(zf, fo, prefix=fo.name)
        buf.seek(0)
        yield from buf
    return Response(stream_with_context(gen()), mimetype="application/zip",
                    headers={"Content-Disposition": 'attachment; filename="cloudvault.zip"'})


@app.route("/api/trash/empty", methods=["POST"])
@login_required
def api_empty_trash():
    files = File.query.filter(File.owner_id == current_user.id, File.trashed_at.isnot(None)).all()
    for f in files:
        storage.delete(current_user.id, f.storage_key)
        storage.delete(current_user.id, f"_thumb/{f.storage_key}.jpg")
        db.session.delete(f)
    folders = Folder.query.filter(Folder.owner_id == current_user.id, Folder.trashed_at.isnot(None)).all()
    for fo in folders:
        db.session.delete(fo)
    db.session.commit()
    emit(current_user.id, "trash_emptied", {})
    return jsonify({"ok": True})


# ---------------- API: shares ----------------
@app.route("/api/share/<int:file_id>", methods=["POST"])
@login_required
def api_share(file_id):
    f = File.query.filter_by(id=file_id, owner_id=current_user.id).first_or_404()
    data = request.get_json() or {}
    expires_hours = data.get("expires_hours")
    password = data.get("password")
    allow_download = data.get("allow_download", True)
    token = secrets.token_urlsafe(16)
    expires_at = datetime.utcnow() + timedelta(hours=int(expires_hours)) if expires_hours else None
    pw_hash = generate_password_hash(password) if password else None
    share = Share(
        token=token, file_id=f.id, expires_at=expires_at,
        password_hash=pw_hash, allow_download=bool(allow_download)
    )
    db.session.add(share)
    db.session.commit()
    return jsonify({
        "token": token,
        "url": url_for("public_share", token=token, _external=True),
        "expires_at": expires_at.isoformat() if expires_at else None,
        "has_password": bool(pw_hash),
        "allow_download": share.allow_download,
    })


@app.route("/api/shares")
@login_required
def api_my_shares():
    shares = Share.query.join(File).filter(File.owner_id == current_user.id).order_by(Share.created_at.desc()).all()
    out = []
    for s in shares:
        f = File.query.get(s.file_id)
        if not f or f.trashed_at: continue
        out.append({
            "token": s.token, "url": url_for("public_share", token=s.token, _external=True),
            "file": {"id": f.id, "name": f.name, "size": f.size, "mime": f.mime},
            "downloads": s.downloads,
            "has_password": bool(s.password_hash),
            "allow_download": s.allow_download,
            "expires_at": s.expires_at.isoformat() if s.expires_at else None,
            "created_at": s.created_at.isoformat(),
        })
    return jsonify(out)


@app.route("/api/shares/<token>", methods=["DELETE"])
@login_required
def api_revoke_share(token):
    s = Share.query.filter_by(token=token).first_or_404()
    f = File.query.get_or_404(s.file_id)
    if f.owner_id != current_user.id: abort(403)
    db.session.delete(s)
    db.session.commit()
    return jsonify({"ok": True})


def _share_valid(share):
    if share.expires_at and share.expires_at < datetime.utcnow(): return False
    return True


@app.route("/s/<token>", methods=["GET", "POST"])
def public_share(token):
    share = Share.query.filter_by(token=token).first_or_404()
    if not _share_valid(share):
        return render_template("share_expired.html"), 410
    f = File.query.get_or_404(share.file_id)
    if f.trashed_at:
        return render_template("share_expired.html"), 410

    # Password gate (session-scoped)
    if share.password_hash:
        unlocked_key = f"share_ok_{token}"
        if request.method == "POST":
            pw = request.form.get("password", "")
            if check_password_hash(share.password_hash, pw):
                session[unlocked_key] = True
            else:
                return render_template("share_password.html", token=token, error="Wrong password"), 401
        if not session.get(unlocked_key):
            return render_template("share_password.html", token=token, error=None)

    return render_template("share.html", file=f, share=share)


@app.route("/s/<token>/download")
@limiter.limit("200 per hour")
def public_download(token):
    share = Share.query.filter_by(token=token).first_or_404()
    if not _share_valid(share): abort(410)
    if not share.allow_download: abort(403)
    f = File.query.get_or_404(share.file_id)
    if f.trashed_at: abort(410)
    if share.password_hash and not session.get(f"share_ok_{token}"):
        return redirect(url_for("public_share", token=token))
    share.downloads += 1
    db.session.commit()
    return _serve_file_data(f, attachment=True)


@app.route("/s/<token>/preview")
def public_preview(token):
    share = Share.query.filter_by(token=token).first_or_404()
    if not _share_valid(share): abort(410)
    f = File.query.get_or_404(share.file_id)
    if f.trashed_at: abort(410)
    if share.password_hash and not session.get(f"share_ok_{token}"):
        abort(401)
    return _serve_file_data(f, attachment=False)


# ---------------- API: tags ----------------
@app.route("/api/tags")
@login_required
def api_tags_list():
    tags = Tag.query.filter_by(owner_id=current_user.id).order_by(Tag.name).all()
    return jsonify([{"id": t.id, "name": t.name, "color": t.color} for t in tags])


@app.route("/api/tags", methods=["POST"])
@login_required
def api_tags_create():
    data = request.get_json() or {}
    name = (data.get("name") or "").strip()[:60]
    color = data.get("color") or "#3b82f6"
    if not name: return jsonify({"error": "name required"}), 400
    existing = Tag.query.filter_by(owner_id=current_user.id, name=name).first()
    if existing:
        return jsonify({"id": existing.id, "name": existing.name, "color": existing.color})
    t = Tag(name=name, color=color, owner_id=current_user.id)
    db.session.add(t)
    db.session.commit()
    return jsonify({"id": t.id, "name": t.name, "color": t.color})


@app.route("/api/tags/<int:tag_id>", methods=["DELETE"])
@login_required
def api_tags_delete(tag_id):
    t = Tag.query.filter_by(id=tag_id, owner_id=current_user.id).first_or_404()
    db.session.delete(t)
    db.session.commit()
    return jsonify({"ok": True})


@app.route("/api/files/<int:file_id>/tags", methods=["POST"])
@login_required
def api_file_tag_add(file_id):
    f = File.query.filter_by(id=file_id, owner_id=current_user.id).first_or_404()
    data = request.get_json() or {}
    tag_id = data.get("tag_id")
    t = Tag.query.filter_by(id=tag_id, owner_id=current_user.id).first_or_404()
    if t not in f.tags:
        f.tags.append(t)
        db.session.commit()
        emit(current_user.id, "file_updated", file_to_dict(f))
    return jsonify({"ok": True})


@app.route("/api/files/<int:file_id>/tags/<int:tag_id>", methods=["DELETE"])
@login_required
def api_file_tag_remove(file_id, tag_id):
    f = File.query.filter_by(id=file_id, owner_id=current_user.id).first_or_404()
    t = Tag.query.filter_by(id=tag_id, owner_id=current_user.id).first_or_404()
    if t in f.tags:
        f.tags.remove(t)
        db.session.commit()
        emit(current_user.id, "file_updated", file_to_dict(f))
    return jsonify({"ok": True})


# ---------------- SSE ----------------
@app.route("/api/events")
@login_required
def api_events():
    user_id = current_user.id
    def stream():
        q = events.subscribe(user_id)
        try:
            yield "data: {\"type\":\"ready\"}\n\n"
            while True:
                try:
                    msg = q.get(timeout=20)
                    yield msg
                except queue.Empty:
                    yield ": keepalive\n\n"
        finally:
            events.unsubscribe(user_id, q)
    return Response(stream(), mimetype="text/event-stream", headers={
        "Cache-Control": "no-cache", "X-Accel-Buffering": "no",
    })


# ---------------- Pricing + Billing ----------------
@app.route("/pricing")
def pricing():
    return render_template("pricing.html", plans=PLANS, user=current_user if current_user.is_authenticated else None)


@app.route("/billing")
@login_required
def billing():
    return render_template("billing.html", user=current_user, plans=PLANS, used=used_bytes(current_user.id))


@app.route("/api/plan/upgrade", methods=["POST"])
@login_required
def api_plan_upgrade():
    data = request.get_json() or {}
    target = data.get("plan", "").lower()
    if target not in PLANS:
        return jsonify({"error": "Invalid plan"}), 400
    # Mock checkout — in real impl this is the Stripe webhook handler
    current_user.plan = target
    current_user.plan_expires_at = datetime.utcnow() + timedelta(days=30) if target != "free" else None
    db.session.commit()
    return jsonify({"ok": True, "plan": target})


# ---------------- Healthz ----------------
@app.route("/healthz")
def healthz():
    return jsonify({"ok": True})


# ---------------- Trash auto-purge ----------------
def purge_trash():
    cutoff = datetime.utcnow() - timedelta(days=app.config["TRASH_RETENTION_DAYS"])
    with app.app_context():
        files = File.query.filter(File.trashed_at.isnot(None), File.trashed_at < cutoff).all()
        for f in files:
            storage.delete(f.owner_id, f.storage_key)
            storage.delete(f.owner_id, f"_thumb/{f.storage_key}.jpg")
            db.session.delete(f)
        folders = Folder.query.filter(Folder.trashed_at.isnot(None), Folder.trashed_at < cutoff).all()
        for fo in folders:
            db.session.delete(fo)
        db.session.commit()
        return len(files) + len(folders)


@app.cli.command("purge")
def cli_purge():
    n = purge_trash()
    print(f"Purged {n} expired items")


# ---------------- Security headers ----------------
@app.after_request
def secure_headers(resp):
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
    resp.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    return resp


# ---------------- Bootstrap ----------------
with app.app_context():
    db.create_all()
    # Lightweight migration: add missing columns on SQLite
    try:
        cols = [c["name"] for c in db.session.execute(db.text("PRAGMA table_info(file)")).mappings()]
        if "has_thumb" not in cols:
            db.session.execute(db.text("ALTER TABLE file ADD COLUMN has_thumb BOOLEAN DEFAULT 0"))
        if "accessed_at" not in cols:
            db.session.execute(db.text("ALTER TABLE file ADD COLUMN accessed_at DATETIME"))
        share_cols = [c["name"] for c in db.session.execute(db.text("PRAGMA table_info(share)")).mappings()]
        if "password_hash" not in share_cols:
            db.session.execute(db.text("ALTER TABLE share ADD COLUMN password_hash VARCHAR(255)"))
        if "allow_download" not in share_cols:
            db.session.execute(db.text("ALTER TABLE share ADD COLUMN allow_download BOOLEAN DEFAULT 1"))
        user_cols = [c["name"] for c in db.session.execute(db.text("PRAGMA table_info(user)")).mappings()]
        if "plan" not in user_cols:
            db.session.execute(db.text("ALTER TABLE user ADD COLUMN plan VARCHAR(20) DEFAULT 'free'"))
        if "plan_expires_at" not in user_cols:
            db.session.execute(db.text("ALTER TABLE user ADD COLUMN plan_expires_at DATETIME"))
        db.session.commit()
    except Exception:
        db.session.rollback()

    # Backfill auto-shares: every non-trashed file with no active share gets one
    try:
        now = datetime.utcnow()
        files_without_active_share = db.session.execute(db.text("""
            SELECT f.id FROM file f
            WHERE f.trashed_at IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM share s
                WHERE s.file_id = f.id
                  AND (s.expires_at IS NULL OR s.expires_at > :now)
              )
        """), {"now": now}).fetchall()
        for row in files_without_active_share:
            fid = row[0]
            share = Share(
                token=secrets.token_urlsafe(16),
                file_id=fid,
                expires_at=now + timedelta(days=AUTO_SHARE_DAYS),
                password_hash=None,
                allow_download=True,
            )
            db.session.add(share)
        if files_without_active_share:
            db.session.commit()
            app.logger.info("auto-share backfill: created %d shares", len(files_without_active_share))
    except Exception as e:
        db.session.rollback()
        app.logger.warning("auto-share backfill failed: %s", e)


# Start APScheduler for trash purge (skip in debug auto-reload child)
if not os.environ.get("WERKZEUG_RUN_MAIN") and os.environ.get("ENABLE_SCHEDULER", "1") == "1":
    try:
        from apscheduler.schedulers.background import BackgroundScheduler
        sched = BackgroundScheduler(daemon=True)
        sched.add_job(purge_trash, "cron", hour=3, minute=0)
        sched.start()
    except Exception:
        pass


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)), debug=True)
