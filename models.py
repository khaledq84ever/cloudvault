from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from flask_login import UserMixin
from flask_sqlalchemy import SQLAlchemy
from werkzeug.security import generate_password_hash

db = SQLAlchemy()


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


# Single tier for everyone.
PLANS: dict[str, dict] = {
    "free": {"name": "Free", "price": 0, "quota": 500 * 1024**2, "max_file": 100 * 1024**2},
}


class User(UserMixin, db.Model):
    id: int = db.Column(db.Integer, primary_key=True)
    email: str = db.Column(db.String(120), unique=True, nullable=False)
    name: str = db.Column(db.String(80), nullable=False)
    password_hash: str = db.Column(db.String(255), nullable=False)
    plan: Optional[str] = db.Column(db.String(20), default="free")
    plan_expires_at: Optional[datetime] = db.Column(db.DateTime, nullable=True)
    created_at: datetime = db.Column(db.DateTime, default=utcnow)

    def plan_info(self) -> dict:
        return PLANS.get(self.plan or "free", PLANS["free"])

    def quota_bytes(self) -> int:
        return self.plan_info()["quota"]


class Folder(db.Model):
    id: int = db.Column(db.Integer, primary_key=True)
    name: str = db.Column(db.String(255), nullable=False)
    owner_id: int = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False)
    parent_id: Optional[int] = db.Column(db.Integer, db.ForeignKey("folder.id"), nullable=True)
    created_at: datetime = db.Column(db.DateTime, default=utcnow)
    trashed_at: Optional[datetime] = db.Column(db.DateTime, nullable=True)


class File(db.Model):
    id: int = db.Column(db.Integer, primary_key=True)
    name: str = db.Column(db.String(255), nullable=False)
    storage_key: str = db.Column(db.String(80), unique=True, nullable=False)
    mime: Optional[str] = db.Column(db.String(120))
    size: int = db.Column(db.BigInteger, default=0)
    owner_id: int = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False)
    folder_id: Optional[int] = db.Column(db.Integer, db.ForeignKey("folder.id"), nullable=True)
    starred: bool = db.Column(db.Boolean, default=False)
    has_thumb: bool = db.Column(db.Boolean, default=False)
    trashed_at: Optional[datetime] = db.Column(db.DateTime, nullable=True)
    created_at: datetime = db.Column(db.DateTime, default=utcnow)
    accessed_at: datetime = db.Column(db.DateTime, default=utcnow)


class Share(db.Model):
    id: int = db.Column(db.Integer, primary_key=True)
    token: str = db.Column(db.String(40), unique=True, nullable=False)
    alias: Optional[str] = db.Column(db.String(60), unique=True, nullable=True, index=True)
    file_id: Optional[int] = db.Column(db.Integer, db.ForeignKey("file.id"), nullable=True)
    folder_id: Optional[int] = db.Column(db.Integer, db.ForeignKey("folder.id"), nullable=True)
    expires_at: Optional[datetime] = db.Column(db.DateTime, nullable=True)
    password_hash: Optional[str] = db.Column(db.String(255), nullable=True)
    allow_download: bool = db.Column(db.Boolean, default=True)
    downloads: int = db.Column(db.Integer, default=0)
    created_at: datetime = db.Column(db.DateTime, default=utcnow)


class Tag(db.Model):
    id: int = db.Column(db.Integer, primary_key=True)
    name: str = db.Column(db.String(60), nullable=False)
    color: str = db.Column(db.String(20), default="#3b82f6")
    owner_id: int = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False)
    created_at: datetime = db.Column(db.DateTime, default=utcnow)


file_tags = db.Table(
    "file_tags",
    db.Column("file_id", db.Integer, db.ForeignKey("file.id"), primary_key=True),
    db.Column("tag_id", db.Integer, db.ForeignKey("tag.id"), primary_key=True),
)
File.tags = db.relationship("Tag", secondary=file_tags, backref="files")


class UploadSession(db.Model):
    id: int = db.Column(db.Integer, primary_key=True)
    upload_id: str = db.Column(db.String(40), unique=True, nullable=False)
    owner_id: int = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False)
    filename: str = db.Column(db.String(255), nullable=False)
    folder_id: Optional[int] = db.Column(db.Integer, db.ForeignKey("folder.id"), nullable=True)
    size: int = db.Column(db.BigInteger, default=0)
    mime: Optional[str] = db.Column(db.String(120))
    received: int = db.Column(db.BigInteger, default=0)
    created_at: datetime = db.Column(db.DateTime, default=utcnow)


class PasswordReset(db.Model):
    id: int = db.Column(db.Integer, primary_key=True)
    user_id: int = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False, index=True)
    token: str = db.Column(db.String(80), unique=True, nullable=False)
    created_at: datetime = db.Column(db.DateTime, default=utcnow)
    expires_at: datetime = db.Column(db.DateTime, nullable=False)
    used_at: Optional[datetime] = db.Column(db.DateTime, nullable=True)
