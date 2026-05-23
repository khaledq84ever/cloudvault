from __future__ import annotations

import io
import secrets
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import flask
from flask import url_for
from werkzeug.utils import secure_filename

from models import db, File, Folder, Share, Tag, utcnow, file_tags
from storage import get_storage


def used_bytes(user_id: int) -> int:
    total = db.session.query(db.func.coalesce(db.func.sum(File.size), 0)).filter_by(
        owner_id=user_id, trashed_at=None
    ).scalar()
    return int(total or 0)


def _auto_share_for(file_record: File) -> Share:
    token = secrets.token_urlsafe(16)
    share = Share(
        token=token, file_id=file_record.id, expires_at=None,
        password_hash=None, allow_download=True,
    )
    db.session.add(share)
    return share


def _latest_share_for(file_id: int) -> Optional[Share]:
    share = Share.query.filter_by(file_id=file_id).order_by(Share.created_at.desc()).first()
    if not share:
        return None
    if share.expires_at and share.expires_at < utcnow():
        return None
    return share


def file_to_dict(f: File) -> dict[str, Any]:
    share = _latest_share_for(f.id)
    handle = (share.alias or share.token) if share else None
    share_url = url_for("public_share", token=handle, _external=True) if share else None
    download_url = url_for("public_download", token=handle, _external=True) if share else None
    qr_url = url_for("public_share_qr", token=handle, _external=True) if share else None
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
        "download_url": download_url,
        "share_qr_url": qr_url,
        "share_token": share.token if share else None,
        "share_alias": share.alias if share else None,
        "share_expires_at": share.expires_at.isoformat() if share and share.expires_at else None,
        "type": "file",
    }


def folder_to_dict(f: Folder) -> dict[str, Any]:
    return {
        "id": f.id,
        "name": f.name,
        "parent_id": f.parent_id,
        "created_at": f.created_at.isoformat() if f.created_at else None,
        "trashed_at": f.trashed_at.isoformat() if f.trashed_at else None,
        "type": "folder",
    }


def _folder_is_descendant_of_id(maybe_child_id: Optional[int], ancestor_id: Optional[int]) -> bool:
    if maybe_child_id is None or ancestor_id is None:
        return False
    cur_id = maybe_child_id
    for _ in range(64):
        if cur_id == ancestor_id:
            return True
        f = Folder.query.get(cur_id)
        if not f or not f.parent_id:
            return False
        cur_id = f.parent_id
    return False


def _folder_is_descendant_of(folder: Folder, root: Folder) -> bool:
    cur = folder
    for _ in range(64):
        if cur is None:
            return False
        if cur.id == root.id:
            return True
        cur = Folder.query.get(cur.parent_id) if cur.parent_id else None
    return False


def _folder_breadcrumb(current: Folder, root: Folder) -> list[tuple[int, str]]:
    chain: list[tuple[int, str]] = []
    cur = current
    for _ in range(64):
        if cur is None:
            break
        chain.append((cur.id, cur.name))
        if cur.id == root.id:
            break
        cur = Folder.query.get(cur.parent_id) if cur.parent_id else None
    return list(reversed(chain))


def _breadcrumb(folder_id: Optional[int]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    if folder_id:
        cur = Folder.query.filter_by(id=folder_id).first()
        while cur:
            out.insert(0, {"id": cur.id, "name": cur.name})
            cur = Folder.query.get(cur.parent_id) if cur.parent_id else None
    return out


def _stream_zip_folder(folder: Folder):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as zf:
        _add_folder_to_zip(zf, folder, prefix=folder.name)
    buf.seek(0)
    yield from buf


def _add_folder_to_zip(zf: zipfile.ZipFile, folder: Folder, prefix: str = ""):
    storage = get_storage(Path(flask.current_app.instance_path).parent)
    for f in File.query.filter_by(folder_id=folder.id, owner_id=folder.owner_id, trashed_at=None).all():
        try:
            data = storage.get(folder.owner_id, f.storage_key)
            zf.writestr(f"{prefix}/{f.name}", data)
        except Exception:
            continue
    for sub in Folder.query.filter_by(parent_id=folder.id, owner_id=folder.owner_id, trashed_at=None).all():
        _add_folder_to_zip(zf, sub, prefix=f"{prefix}/{sub.name}")


def _folder_recursive_size(folder: Folder) -> int:
    total = db.session.query(db.func.coalesce(db.func.sum(File.size), 0)).filter_by(
        folder_id=folder.id, owner_id=folder.owner_id, trashed_at=None
    ).scalar() or 0
    for sub in Folder.query.filter_by(parent_id=folder.id, owner_id=folder.owner_id, trashed_at=None).all():
        total += _folder_recursive_size(sub)
    return int(total)


def _copy_file_to(file_obj: File, dest_folder_id: Optional[int]) -> File:
    import uuid
    storage = get_storage(Path(flask.current_app.instance_path).parent)
    new_key = uuid.uuid4().hex
    data = storage.get(file_obj.owner_id, file_obj.storage_key)
    storage.put(file_obj.owner_id, new_key, data)
    if file_obj.has_thumb:
        try:
            thumb_data = storage.get(file_obj.owner_id, f"_thumb/{file_obj.storage_key}.jpg")
            storage.put(file_obj.owner_id, f"_thumb/{new_key}.jpg", thumb_data)
        except Exception:
            pass
    new_file = File(
        name=file_obj.name,
        storage_key=new_key,
        mime=file_obj.mime,
        size=file_obj.size,
        owner_id=file_obj.owner_id,
        folder_id=dest_folder_id,
        has_thumb=file_obj.has_thumb,
    )
    db.session.add(new_file)
    db.session.flush()
    return new_file


def _copy_folder_to(folder: Folder, dest_parent_id: Optional[int]) -> Optional[Folder]:
    if _folder_is_descendant_of_id(dest_parent_id, folder.id) or folder.id == dest_parent_id:
        return None
    new_folder = Folder(
        name=folder.name, owner_id=folder.owner_id, parent_id=dest_parent_id,
    )
    db.session.add(new_folder)
    db.session.flush()
    for f in File.query.filter_by(folder_id=folder.id, owner_id=folder.owner_id, trashed_at=None).all():
        _copy_file_to(f, new_folder.id)
    for sub in Folder.query.filter_by(parent_id=folder.id, owner_id=folder.owner_id, trashed_at=None).all():
        _copy_folder_to(sub, new_folder.id)
    return new_folder


import re as _re
_ALIAS_RE = _re.compile(r"^[a-z0-9][a-z0-9-]{2,58}[a-z0-9]$")
