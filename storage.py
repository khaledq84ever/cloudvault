"""Storage backend abstraction: local disk or Cloudflare R2 (S3-compatible)."""
import os
import io
from pathlib import Path

try:
    import boto3
    from botocore.client import Config as BotoConfig
except ImportError:
    boto3 = None


class LocalStorage:
    def __init__(self, root: Path):
        self.root = Path(root)
        self.root.mkdir(exist_ok=True, parents=True)

    def _path(self, user_id, key):
        d = self.root / str(user_id)
        d.mkdir(exist_ok=True, parents=True)
        return d / key

    def put(self, user_id, key, data: bytes):
        with open(self._path(user_id, key), "wb") as f:
            f.write(data)

    def append(self, user_id, key, data: bytes):
        with open(self._path(user_id, key), "ab") as f:
            f.write(data)

    def get(self, user_id, key) -> bytes:
        with open(self._path(user_id, key), "rb") as f:
            return f.read()

    def stream_path(self, user_id, key):
        return str(self._path(user_id, key))

    def exists(self, user_id, key):
        return self._path(user_id, key).exists()

    def delete(self, user_id, key):
        p = self._path(user_id, key)
        if p.exists(): p.unlink()

    def presigned_url(self, user_id, key, ttl=60):
        return None  # local — no presigned URL, use direct send_file


class R2Storage:
    def __init__(self, endpoint, bucket, key_id, secret):
        if boto3 is None:
            raise RuntimeError("boto3 not installed")
        self.bucket = bucket
        self.client = boto3.client(
            "s3",
            endpoint_url=endpoint,
            aws_access_key_id=key_id,
            aws_secret_access_key=secret,
            config=BotoConfig(signature_version="s3v4"),
            region_name="auto",
        )

    def _key(self, user_id, key):
        return f"users/{user_id}/{key}"

    def put(self, user_id, key, data: bytes):
        self.client.put_object(Bucket=self.bucket, Key=self._key(user_id, key), Body=data)

    def append(self, user_id, key, data: bytes):
        # Object storage has no append; download + reupload
        existing = b""
        try:
            obj = self.client.get_object(Bucket=self.bucket, Key=self._key(user_id, key))
            existing = obj["Body"].read()
        except self.client.exceptions.NoSuchKey:
            pass
        self.put(user_id, key, existing + data)

    def get(self, user_id, key) -> bytes:
        obj = self.client.get_object(Bucket=self.bucket, Key=self._key(user_id, key))
        return obj["Body"].read()

    def stream_path(self, user_id, key):
        # Not directly streamable from FS; caller should use presigned_url instead
        return None

    def exists(self, user_id, key):
        try:
            self.client.head_object(Bucket=self.bucket, Key=self._key(user_id, key))
            return True
        except Exception:
            return False

    def delete(self, user_id, key):
        try:
            self.client.delete_object(Bucket=self.bucket, Key=self._key(user_id, key))
        except Exception:
            pass

    def presigned_url(self, user_id, key, ttl=60):
        return self.client.generate_presigned_url(
            "get_object",
            Params={"Bucket": self.bucket, "Key": self._key(user_id, key)},
            ExpiresIn=ttl,
        )


def get_storage(base_dir: Path):
    endpoint = os.environ.get("R2_ENDPOINT")
    bucket = os.environ.get("R2_BUCKET")
    key_id = os.environ.get("R2_KEY")
    secret = os.environ.get("R2_SECRET")
    if endpoint and bucket and key_id and secret and boto3:
        return R2Storage(endpoint, bucket, key_id, secret)
    # Honour DATA_DIR (e.g. mounted Railway volume at /app/data)
    data_dir = os.environ.get("DATA_DIR")
    root = Path(data_dir) / "uploads" if data_dir else base_dir / "uploads"
    return LocalStorage(root)
