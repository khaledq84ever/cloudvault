from __future__ import annotations

import io
import subprocess
import tempfile
from pathlib import Path
from typing import Optional


def make_image_thumb(data: bytes, size: int = 256) -> Optional[bytes]:
    try:
        from PIL import Image
    except ImportError:
        return None
    try:
        img = Image.open(io.BytesIO(data))
        img.thumbnail((size, size))
        if img.mode in ("RGBA", "LA", "P"):
            bg = Image.new("RGB", img.size, (10, 14, 39))
            if img.mode == "P":
                img = img.convert("RGBA")
            bg.paste(img, mask=img.split()[-1] if img.mode in ("RGBA", "LA") else None)
            img = bg
        elif img.mode != "RGB":
            img = img.convert("RGB")
        out = io.BytesIO()
        img.save(out, "JPEG", quality=80)
        return out.getvalue()
    except Exception:
        return None


def make_video_thumb(data: bytes, size: int = 256) -> Optional[bytes]:
    if not _has_ffmpeg():
        return None
    try:
        with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as src:
            src.write(data)
            src_path = src.name
        with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as dst:
            dst_path = dst.name
        r = subprocess.run([
            "ffmpeg", "-y", "-ss", "00:00:02", "-i", src_path,
            "-frames:v", "1", "-vf", f"scale={size}:-1", dst_path
        ], capture_output=True, timeout=30)
        if r.returncode != 0:
            subprocess.run([
                "ffmpeg", "-y", "-i", src_path, "-frames:v", "1",
                "-vf", f"scale={size}:-1", dst_path
            ], capture_output=True, timeout=30)
        with open(dst_path, "rb") as f:
            out = f.read()
        Path(src_path).unlink(missing_ok=True)
        Path(dst_path).unlink(missing_ok=True)
        return out if out else None
    except Exception:
        return None


def _has_ffmpeg() -> bool:
    try:
        subprocess.run(["ffmpeg", "-version"], capture_output=True, timeout=5)
        return True
    except Exception:
        return False


def generate(name: str, mime: str, data: bytes) -> Optional[bytes]:
    if mime and mime.startswith("image/"):
        return make_image_thumb(data)
    if mime and mime.startswith("video/"):
        return make_video_thumb(data)
    return None
