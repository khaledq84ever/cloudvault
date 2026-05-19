#!/usr/bin/env python3
"""Generate CloudVault PWA icons at multiple sizes from a cloud SVG."""
import os
from PIL import Image, ImageDraw, ImageFilter

ICON_DIR = os.path.join(os.path.dirname(__file__), "..", "static", "icons")
os.makedirs(ICON_DIR, exist_ok=True)


def draw_cloud(size: int, maskable: bool = False) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Gradient background (rounded square)
    bg = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    bgd = ImageDraw.Draw(bg)
    for y in range(size):
        t = y / size
        r = int(99 + (168 - 99) * t)
        g = int(102 + (85 - 102) * t)
        b = int(241 + (247 - 241) * t)
        bgd.line([(0, y), (size, y)], fill=(r, g, b, 255))

    # Rounded corner mask
    radius = int(size * (0.0 if maskable else 0.22))
    mask = Image.new("L", (size, size), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle((0, 0, size, size), radius=radius, fill=255)
    bg.putalpha(mask)
    img.alpha_composite(bg)

    # Cloud shape - inset for maskable safe area
    pad = int(size * (0.20 if maskable else 0.16))
    cw = size - pad * 2
    ch = int(cw * 0.62)
    cx = pad
    cy = (size - ch) // 2 + int(ch * 0.05)

    d2 = ImageDraw.Draw(img)
    # cloud puffs (white)
    white = (255, 255, 255, 255)
    r1 = int(ch * 0.42)
    r2 = int(ch * 0.50)
    r3 = int(ch * 0.36)
    # left puff
    d2.ellipse((cx, cy + ch - r1 * 2, cx + r1 * 2, cy + ch), fill=white)
    # big middle puff
    mx = cx + int(cw * 0.30)
    d2.ellipse((mx, cy + ch - r2 * 2 - int(ch * 0.1), mx + r2 * 2, cy + ch - int(ch * 0.1)), fill=white)
    # right puff
    rx = cx + cw - r3 * 2
    d2.ellipse((rx, cy + ch - r3 * 2 - int(ch * 0.02), rx + r3 * 2, cy + ch - int(ch * 0.02)), fill=white)
    # bottom bar to merge
    d2.rectangle((cx + r1, cy + ch - r1, cx + cw - r3, cy + ch), fill=white)

    return img


def main():
    sizes = [(192, "icon-192.png", False),
             (512, "icon-512.png", False),
             (512, "icon-maskable.png", True),
             (180, "apple-touch-icon.png", False),
             (32, "favicon-32.png", False)]
    for size, name, maskable in sizes:
        img = draw_cloud(size, maskable)
        path = os.path.join(ICON_DIR, name)
        img.save(path, "PNG", optimize=True)
        print(f"wrote {path} ({size}x{size}{' maskable' if maskable else ''})")


if __name__ == "__main__":
    main()
