from __future__ import annotations

import os
from pathlib import Path
from typing import Optional


class LocalStorage:
    def __init__(self, root: Path) -> None:
        self.root = Path(root)
        self.root.mkdir(exist_ok=True, parents=True)

    def _path(self, user_id: int, key: str) -> Path:
        final = self.root / str(user_id) / key
        final.parent.mkdir(exist_ok=True, parents=True)
        return final

    def put(self, user_id: int, key: str, data: bytes) -> None:
        with open(self._path(user_id, key), "wb") as f:
            f.write(data)

    def append(self, user_id: int, key: str, data: bytes) -> None:
        with open(self._path(user_id, key), "ab") as f:
            f.write(data)

    def get(self, user_id: int, key: str) -> bytes:
        with open(self._path(user_id, key), "rb") as f:
            return f.read()

    def stream_path(self, user_id: int, key: str) -> str | None:
        return str(self._path(user_id, key))

    def exists(self, user_id: int, key: str) -> bool:
        return self._path(user_id, key).exists()

    def delete(self, user_id: int, key: str) -> None:
        p = self._path(user_id, key)
        if p.exists():
            p.unlink()

    def presigned_url(self, user_id: int, key: str, ttl: int = 60) -> None:
        return None


class R2Storage:
    def __init__(self, endpoint: str, bucket: str, key_id: str, secret: str) -> None:
        import boto3
        from botocore.client import Config as BotoConfig
        self.bucket = bucket
        self.client = boto3.client(
            "s3",
            endpoint_url=endpoint,
            aws_access_key_id=key_id,
            aws_secret_access_key=secret,
            config=BotoConfig(signature_version="s3v4"),
            region_name="auto",
        )

    def _key(self, user_id: int, key: str) -> str:
        return f"users/{user_id}/{key}"

    def put(self, user_id: int, key: str, data: bytes) -> None:
        self.client.put_object(Bucket=self.bucket, Key=self._key(user_id, key), Body=data)

    def append(self, user_id: int, key: str, data: bytes) -> None:
        existing = b""
        try:
            obj = self.client.get_object(Bucket=self.bucket, Key=self._key(user_id, key))
            existing = obj["Body"].read()
        except self.client.exceptions.NoSuchKey:
            pass
        self.put(user_id, key, existing + data)

    def get(self, user_id: int, key: str) -> bytes:
        obj = self.client.get_object(Bucket=self.bucket, Key=self._key(user_id, key))
        return obj["Body"].read()

    def stream_path(self, user_id: int, key: str) -> None:
        return None

    def exists(self, user_id: int, key: str) -> bool:
        try:
            self.client.head_object(Bucket=self.bucket, Key=self._key(user_id, key))
            return True
        except Exception:
            return False

    def delete(self, user_id: int, key: str) -> None:
        try:
            self.client.delete_object(Bucket=self.bucket, Key=self._key(user_id, key))
        except Exception:
            pass

    def presigned_url(self, user_id: int, key: str, ttl: int = 60) -> str:
        return self.client.generate_presigned_url(
            "get_object",
            Params={"Bucket": self.bucket, "Key": self._key(user_id, key)},
            ExpiresIn=ttl,
        )


def get_storage(base_dir: Path) -> LocalStorage | R2Storage:
    endpoint = os.environ.get("R2_ENDPOINT")
    bucket = os.environ.get("R2_BUCKET")
    key_id = os.environ.get("R2_KEY")
    secret = os.environ.get("R2_SECRET")
    if endpoint and bucket and key_id and secret:
        try:
            return R2Storage(endpoint, bucket, key_id, secret)
        except Exception:
            pass
    data_dir = os.environ.get("DATA_DIR")
    root = Path(data_dir) / "uploads" if data_dir else base_dir / "uploads"
    return LocalStorage(root)
