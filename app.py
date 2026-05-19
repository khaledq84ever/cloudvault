import os
import uuid
import secrets
import mimetypes
from datetime import datetime, timedelta
from pathlib import Path
from flask import (
    Flask, render_template, request, jsonify, send_file, redirect,
    url_for, flash, abort, session, Response
)
from flask_sqlalchemy import SQLAlchemy
from flask_login import (
    LoginManager, UserMixin, login_user, logout_user, login_required, current_user
)
from werkzeug.security import generate_password_hash, check_password_hash
from werkzeug.utils import secure_filename

BASE_DIR = Path(__file__).parent.resolve()
UPLOAD_DIR = BASE_DIR / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)

app = Flask(__name__)
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "dev-key-change-me-" + secrets.token_hex(16))
app.config["SQLALCHEMY_DATABASE_URI"] = "sqlite:///" + str(BASE_DIR / "instance" / "cloudvault.db")
app.config["MAX_CONTENT_LENGTH"] = 500 * 1024 * 1024  # 500 MB per request
app.config["FREE_QUOTA_BYTES"] = 15 * 1024 * 1024 * 1024  # 15 GB

db = SQLAlchemy(app)
login_manager = LoginManager(app)
login_manager.login_view = "login"


# ---------------- Models ----------------
class User(UserMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    email = db.Column(db.String(120), unique=True, nullable=False)
    name = db.Column(db.String(80), nullable=False)
    password_hash = db.Column(db.String(255), nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    files = db.relationship("File", backref="owner", lazy=True)


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
    trashed_at = db.Column(db.DateTime, nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)


class Share(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    token = db.Column(db.String(40), unique=True, nullable=False)
    file_id = db.Column(db.Integer, db.ForeignKey("file.id"), nullable=False)
    expires_at = db.Column(db.DateTime, nullable=True)
    downloads = db.Column(db.Integer, default=0)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)


@login_manager.user_loader
def load_user(uid):
    return User.query.get(int(uid))


# ---------------- Helpers ----------------
def user_dir(user_id):
    d = UPLOAD_DIR / str(user_id)
    d.mkdir(exist_ok=True, parents=True)
    return d


def used_bytes(user_id):
    total = db.session.query(db.func.coalesce(db.func.sum(File.size), 0)).filter_by(
        owner_id=user_id, trashed_at=None
    ).scalar()
    return int(total or 0)


def file_to_dict(f):
    return {
        "id": f.id,
        "name": f.name,
        "size": f.size,
        "mime": f.mime,
        "starred": f.starred,
        "folder_id": f.folder_id,
        "created_at": f.created_at.isoformat() if f.created_at else None,
        "type": "file",
    }


def folder_to_dict(f):
    return {
        "id": f.id,
        "name": f.name,
        "parent_id": f.parent_id,
        "created_at": f.created_at.isoformat() if f.created_at else None,
        "type": "folder",
    }


# ---------------- Auth routes ----------------
@app.route("/")
def index():
    if current_user.is_authenticated:
        return redirect(url_for("drive"))
    return render_template("landing.html")


@app.route("/login", methods=["GET", "POST"])
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


# ---------------- API ----------------
@app.route("/api/me")
@login_required
def api_me():
    return jsonify({
        "id": current_user.id,
        "email": current_user.email,
        "name": current_user.name,
        "used": used_bytes(current_user.id),
        "quota": app.config["FREE_QUOTA_BYTES"],
    })


@app.route("/api/files")
@login_required
def api_list():
    view = request.args.get("view", "my")  # my | starred | trash | recent | shared
    folder_id = request.args.get("folder", type=int)
    q = request.args.get("q", "").strip()
    sort = request.args.get("sort", "name")  # name | size | date
    order = request.args.get("order", "asc")

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
            files_q = files_q.order_by(File.created_at.desc()).limit(30)
            folders_q = folders_q.filter(False)
        elif view == "shared":
            shared_ids = [s.file_id for s in Share.query.join(File).filter(File.owner_id == current_user.id).all()]
            files_q = files_q.filter(File.id.in_(shared_ids)) if shared_ids else files_q.filter(False)
            folders_q = folders_q.filter(False)
        else:  # my
            folders_q = folders_q.filter_by(parent_id=folder_id)
            files_q = files_q.filter_by(folder_id=folder_id)

    if q:
        like = f"%{q}%"
        files_q = files_q.filter(File.name.ilike(like))
        folders_q = folders_q.filter(Folder.name.ilike(like))

    if view not in ("recent",):
        if sort == "size":
            col = File.size
        elif sort == "date":
            col = File.created_at
        else:
            col = File.name
        files_q = files_q.order_by(col.desc() if order == "desc" else col.asc())
        folders_q = folders_q.order_by(Folder.name.desc() if order == "desc" else Folder.name.asc())

    folders = [folder_to_dict(f) for f in folders_q.all()]
    files = [file_to_dict(f) for f in files_q.all()]

    breadcrumb = []
    if folder_id:
        cur = Folder.query.filter_by(id=folder_id, owner_id=current_user.id).first()
        while cur:
            breadcrumb.insert(0, {"id": cur.id, "name": cur.name})
            cur = Folder.query.get(cur.parent_id) if cur.parent_id else None

    return jsonify({"folders": folders, "files": files, "breadcrumb": breadcrumb})


@app.route("/api/folders", methods=["POST"])
@login_required
def api_create_folder():
    data = request.get_json() or {}
    name = (data.get("name") or "Untitled folder").strip()[:255]
    parent_id = data.get("parent_id")
    folder = Folder(name=name, owner_id=current_user.id, parent_id=parent_id)
    db.session.add(folder)
    db.session.commit()
    return jsonify(folder_to_dict(folder))


@app.route("/api/upload", methods=["POST"])
@login_required
def api_upload():
    if "file" not in request.files:
        return jsonify({"error": "No file"}), 400
    f = request.files["file"]
    if not f.filename:
        return jsonify({"error": "Empty filename"}), 400

    folder_id = request.form.get("folder_id", type=int)
    data = f.read()
    size = len(data)

    if used_bytes(current_user.id) + size > app.config["FREE_QUOTA_BYTES"]:
        return jsonify({"error": "Quota exceeded"}), 413

    storage_key = uuid.uuid4().hex
    mime = f.mimetype or mimetypes.guess_type(f.filename)[0] or "application/octet-stream"
    path = user_dir(current_user.id) / storage_key
    with open(path, "wb") as out:
        out.write(data)

    record = File(
        name=secure_filename(f.filename) or f.filename,
        storage_key=storage_key,
        mime=mime,
        size=size,
        owner_id=current_user.id,
        folder_id=folder_id,
    )
    db.session.add(record)
    db.session.commit()
    return jsonify(file_to_dict(record))


@app.route("/api/files/<int:file_id>/download")
@login_required
def api_download(file_id):
    f = File.query.filter_by(id=file_id, owner_id=current_user.id).first_or_404()
    path = user_dir(current_user.id) / f.storage_key
    if not path.exists():
        abort(404)
    return send_file(path, as_attachment=True, download_name=f.name, mimetype=f.mime)


@app.route("/api/files/<int:file_id>/preview")
@login_required
def api_preview(file_id):
    f = File.query.filter_by(id=file_id, owner_id=current_user.id).first_or_404()
    path = user_dir(current_user.id) / f.storage_key
    if not path.exists():
        abort(404)
    return send_file(path, mimetype=f.mime, conditional=True)


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
    return jsonify(file_to_dict(f))


@app.route("/api/files/<int:file_id>", methods=["DELETE"])
@login_required
def api_trash(file_id):
    f = File.query.filter_by(id=file_id, owner_id=current_user.id).first_or_404()
    permanent = request.args.get("permanent") == "1"
    if permanent or f.trashed_at:
        path = user_dir(current_user.id) / f.storage_key
        if path.exists():
            path.unlink()
        db.session.delete(f)
    else:
        f.trashed_at = datetime.utcnow()
    db.session.commit()
    return jsonify({"ok": True})


@app.route("/api/files/<int:file_id>/restore", methods=["POST"])
@login_required
def api_restore(file_id):
    f = File.query.filter_by(id=file_id, owner_id=current_user.id).first_or_404()
    f.trashed_at = None
    db.session.commit()
    return jsonify(file_to_dict(f))


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
    return jsonify(folder_to_dict(folder))


@app.route("/api/folders/<int:folder_id>", methods=["DELETE"])
@login_required
def api_trash_folder(folder_id):
    folder = Folder.query.filter_by(id=folder_id, owner_id=current_user.id).first_or_404()
    permanent = request.args.get("permanent") == "1"
    if permanent or folder.trashed_at:
        for f in File.query.filter_by(folder_id=folder_id, owner_id=current_user.id).all():
            path = user_dir(current_user.id) / f.storage_key
            if path.exists():
                path.unlink()
            db.session.delete(f)
        db.session.delete(folder)
    else:
        folder.trashed_at = datetime.utcnow()
        for f in File.query.filter_by(folder_id=folder_id, owner_id=current_user.id, trashed_at=None).all():
            f.trashed_at = datetime.utcnow()
    db.session.commit()
    return jsonify({"ok": True})


@app.route("/api/folders/<int:folder_id>/restore", methods=["POST"])
@login_required
def api_restore_folder(folder_id):
    folder = Folder.query.filter_by(id=folder_id, owner_id=current_user.id).first_or_404()
    folder.trashed_at = None
    db.session.commit()
    return jsonify(folder_to_dict(folder))


@app.route("/api/bulk", methods=["POST"])
@login_required
def api_bulk():
    data = request.get_json() or {}
    action = data.get("action")  # trash | restore | delete | star | unstar | move
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
            path = user_dir(current_user.id) / f.storage_key
            if path.exists(): path.unlink()
            db.session.delete(f)
        for fo in folders:
            for f in File.query.filter_by(folder_id=fo.id, owner_id=current_user.id).all():
                path = user_dir(current_user.id) / f.storage_key
                if path.exists(): path.unlink()
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
    db.session.commit()
    return jsonify({"ok": True, "count": len(files) + len(folders)})


@app.route("/api/trash/empty", methods=["POST"])
@login_required
def api_empty_trash():
    files = File.query.filter(File.owner_id == current_user.id, File.trashed_at.isnot(None)).all()
    for f in files:
        path = user_dir(current_user.id) / f.storage_key
        if path.exists(): path.unlink()
        db.session.delete(f)
    folders = Folder.query.filter(Folder.owner_id == current_user.id, Folder.trashed_at.isnot(None)).all()
    for fo in folders:
        db.session.delete(fo)
    db.session.commit()
    return jsonify({"ok": True})


@app.route("/api/folders/tree")
@login_required
def api_folder_tree():
    """Return flat list of all live folders for move-to picker."""
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


@app.route("/api/shares")
@login_required
def api_my_shares():
    shares = Share.query.join(File).filter(File.owner_id == current_user.id).order_by(Share.created_at.desc()).all()
    out = []
    for s in shares:
        f = File.query.get(s.file_id)
        if not f or f.trashed_at: continue
        out.append({
            "token": s.token,
            "url": url_for("public_share", token=s.token, _external=True),
            "file": {"id": f.id, "name": f.name, "size": f.size, "mime": f.mime},
            "downloads": s.downloads,
            "expires_at": s.expires_at.isoformat() if s.expires_at else None,
            "created_at": s.created_at.isoformat(),
        })
    return jsonify(out)


@app.route("/api/shares/<token>", methods=["DELETE"])
@login_required
def api_revoke_share(token):
    s = Share.query.filter_by(token=token).first_or_404()
    f = File.query.get_or_404(s.file_id)
    if f.owner_id != current_user.id:
        abort(403)
    db.session.delete(s)
    db.session.commit()
    return jsonify({"ok": True})


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


# ---------------- Settings UI ----------------
@app.route("/settings")
@login_required
def settings():
    return render_template("settings.html", user=current_user)


@app.route("/shared")
@login_required
def shared_page():
    return render_template("shared.html", user=current_user)


@app.route("/api/share/<int:file_id>", methods=["POST"])
@login_required
def api_share(file_id):
    f = File.query.filter_by(id=file_id, owner_id=current_user.id).first_or_404()
    data = request.get_json() or {}
    expires_hours = data.get("expires_hours")
    token = secrets.token_urlsafe(16)
    expires_at = None
    if expires_hours:
        expires_at = datetime.utcnow() + timedelta(hours=int(expires_hours))
    share = Share(token=token, file_id=f.id, expires_at=expires_at)
    db.session.add(share)
    db.session.commit()
    return jsonify({
        "token": token,
        "url": url_for("public_share", token=token, _external=True),
        "expires_at": expires_at.isoformat() if expires_at else None,
    })


@app.route("/s/<token>")
def public_share(token):
    share = Share.query.filter_by(token=token).first_or_404()
    if share.expires_at and share.expires_at < datetime.utcnow():
        return render_template("share_expired.html"), 410
    f = File.query.get_or_404(share.file_id)
    if f.trashed_at:
        return render_template("share_expired.html"), 410
    return render_template("share.html", file=f, share=share)


@app.route("/s/<token>/download")
def public_download(token):
    share = Share.query.filter_by(token=token).first_or_404()
    if share.expires_at and share.expires_at < datetime.utcnow():
        abort(410)
    f = File.query.get_or_404(share.file_id)
    if f.trashed_at:
        abort(410)
    share.downloads += 1
    db.session.commit()
    path = user_dir(f.owner_id) / f.storage_key
    return send_file(path, as_attachment=True, download_name=f.name, mimetype=f.mime)


# ---------------- Init ----------------
with app.app_context():
    Path(BASE_DIR / "instance").mkdir(exist_ok=True)
    db.create_all()


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
