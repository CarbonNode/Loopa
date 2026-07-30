#!/usr/bin/env python3
"""Build the Loopa icon set from a single hand-authored vector source.

The mark: a loop arrow (gifs loop) closing around a play triangle (video).
Concept direction generated with Forge/Gemini, then redrawn as clean geometry.

Two optical sizes, because one geometry cannot serve 512px and 16px:
  * regular — used at >=32px. Generous ring, full arrowhead flourish.
  * small   — used at 16px. Larger ring, heavier stroke, trimmed arrowhead and
              a tighter play triangle, so ~2px of clear space survives between
              the triangle and the ring instead of antialiasing into a blob.

Run:  PYTHONPATH=/tmp/pylibs python3 assets/icon/build_icon.py
"""
import io
import os
import struct
import cairosvg
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ICON_DIR = os.path.join(ROOT, "assets", "icon")
PUBLIC_DIR = os.path.join(ROOT, "public")
# Vite serves web/public at the site root, so the generated set is mirrored there
# for the app to actually pick up.
MIRROR_DIR = os.path.join(ROOT, "web", "public")

CORAL = "#ED7659"
SHELL = "#0c0d12"  # app shell background — tiles match it so the icon looks native

C = 256.0  # canvas centre, 512 viewBox

# Play triangle at scale 1.0: apex right, corners left, nudged +8px so the
# triangle's visual mass — not its bounding box — sits centred.
PLAY_BASE = ((352.0, 256.0), (204.0, 172.0), (204.0, 340.0))
PLAY_STROKE = 26.0


def glyph(r, w, play_scale, arrow_ratio, color=CORAL):
    """Build the mark's paths. r = ring radius, w = ring stroke weight."""
    d = r * 0.70710678  # 45 degrees, for the arc's 10:30 start point

    # 315-degree arc: clockwise from 10:30 all the way round to 9 o'clock,
    # where it terminates in the arrowhead — reads as a loop still running.
    ring = f"M{C - d:.1f} {C - d:.1f}A{r:g} {r:g} 0 1 1 {C - r:g} {C:g}"

    # Arrowhead sits on the arc terminus, pointing up along the direction of travel.
    ax, half = C - r, arrow_ratio * w
    arrow = (
        f"M{ax:g} {C - 1.95 * w:.1f} {ax + half:.1f} {C - 0.09 * w:.1f} "
        f"{ax - half:.1f} {C - 0.09 * w:.1f}Z"
    )

    play = "M" + " ".join(
        f"{C + (x - C) * play_scale:.1f} {C + (y - C) * play_scale:.1f}" for x, y in PLAY_BASE
    ) + "Z"

    return (
        f'  <path d="{ring}" fill="none" stroke="{color}" stroke-width="{w:g}" '
        'stroke-linecap="round"/>\n'
        f'  <path d="{arrow}" fill="{color}" stroke="{color}" '
        f'stroke-width="{0.45 * w:.1f}" stroke-linejoin="round"/>\n'
        f'  <path d="{play}" fill="{color}" stroke="{color}" '
        f'stroke-width="{PLAY_STROKE * play_scale:.1f}" stroke-linejoin="round"/>'
    )


REGULAR = dict(r=168, w=44, play_scale=1.0, arrow_ratio=1.23)
SMALL = dict(r=196, w=58, play_scale=0.916, arrow_ratio=0.80)


def svg_doc(body, bg=None, radius=112):
    tile = (
        f'  <rect width="512" height="512" rx="{radius}" ry="{radius}" fill="{bg}"/>\n'
        if bg
        else ""
    )
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" '
        'width="512" height="512" role="img" aria-label="Loopa">\n'
        f"{tile}{body}\n</svg>\n"
    )


def mark_svg(variant=REGULAR, color=CORAL):
    return svg_doc(glyph(color=color, **variant))


def tile_svg(variant=REGULAR, bg=SHELL, color=CORAL, scale=0.74):
    """Glyph on an opaque rounded tile — apple-touch, PWA, store listings."""
    off = C * (1 - scale)
    inner = glyph(color=color, **variant)
    body = f'  <g transform="translate({off:.1f} {off:.1f}) scale({scale})">\n{inner}\n  </g>'
    return svg_doc(body, bg=bg)


def render(svg, size):
    png = cairosvg.svg2png(bytestring=svg.encode(), output_width=size, output_height=size)
    return Image.open(io.BytesIO(png)).convert("RGBA")


def write_ico(path, images):
    """ICO with genuinely different artwork per size (PIL's sizes= only rescales one)."""
    blobs = []
    for img in images:
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        blobs.append(buf.getvalue())

    offset = 6 + 16 * len(blobs)
    header = struct.pack("<HHH", 0, 1, len(blobs))
    entries, payload = b"", b""
    for img, blob in zip(images, blobs):
        w, h = img.size
        entries += struct.pack(
            "<BBBBHHII", w if w < 256 else 0, h if h < 256 else 0, 0, 0, 1, 32, len(blob), offset
        )
        payload += blob
        offset += len(blob)

    with open(path, "wb") as fh:
        fh.write(header + entries + payload)


def main():
    os.makedirs(ICON_DIR, exist_ok=True)
    os.makedirs(PUBLIC_DIR, exist_ok=True)

    regular, small = mark_svg(REGULAR), mark_svg(SMALL)
    tile = tile_svg(REGULAR)
    written = []

    def write_text(path, body):
        with open(path, "w") as fh:
            fh.write(body)
        written.append(path)

    def save(img, path):
        img.save(path)
        written.append(path)

    write_text(os.path.join(ICON_DIR, "loopa-mark.svg"), regular)
    write_text(os.path.join(ICON_DIR, "loopa-mark-small.svg"), small)
    write_text(os.path.join(ICON_DIR, "loopa-tile.svg"), tile)
    write_text(os.path.join(PUBLIC_DIR, "favicon.svg"), regular)

    for size in (32, 192, 512):
        save(render(regular, size), os.path.join(PUBLIC_DIR, f"icon-{size}.png"))
    save(render(small, 16), os.path.join(PUBLIC_DIR, "icon-16.png"))

    # iOS ignores alpha, so apple-touch gets the opaque tile flattened to RGB.
    apple = os.path.join(PUBLIC_DIR, "apple-touch-icon.png")
    render(tile, 180).convert("RGB").save(apple)
    written.append(apple)
    save(render(tile_svg(REGULAR, scale=0.60), 512),
         os.path.join(PUBLIC_DIR, "icon-512-maskable.png"))

    ico = os.path.join(PUBLIC_DIR, "favicon.ico")
    write_ico(ico, [render(small, 16), render(regular, 32), render(regular, 48)])
    written.append(ico)

    # --- contact sheet, so the result gets eyeballed rather than assumed ------
    pad, cell = 24, 160
    cols = [("regular", regular, 512), ("regular", regular, 48), ("regular", regular, 32),
            ("small", small, 16), ("tile", tile, 180), ("tile", tile, 512)]
    sheet = Image.new("RGBA", (pad * 7 + cell * 6, pad * 4 + cell * 2), (247, 247, 250, 255))
    sheet.paste(Image.new("RGBA", (sheet.width, cell + pad * 2), (12, 13, 18, 255)),
                (0, pad * 2 + cell))

    for row in range(2):
        y = pad + row * (cell + pad * 2)
        for col, (_, svg, size) in enumerate(cols):
            src = render(svg, size)
            resample = Image.NEAREST if size <= 48 else Image.LANCZOS
            sheet.alpha_composite(src.resize((cell, cell), resample), (pad + col * (cell + pad), y))

    sheet.convert("RGB").save(os.path.join(ICON_DIR, "preview.png"))
    written.append(os.path.join(ICON_DIR, "preview.png"))

    for p in written:
        print(f"  {os.path.relpath(p, ROOT):40s} {os.path.getsize(p):>8,} B")

    # mirror the served set into the Vite public dir
    os.makedirs(MIRROR_DIR, exist_ok=True)
    mirrored = 0
    for name in sorted(os.listdir(PUBLIC_DIR)):
        src = os.path.join(PUBLIC_DIR, name)
        if os.path.isfile(src):
            with open(src, "rb") as fh:
                data = fh.read()
            with open(os.path.join(MIRROR_DIR, name), "wb") as fh:
                fh.write(data)
            mirrored += 1
    print(f"\n  mirrored {mirrored} files -> {os.path.relpath(MIRROR_DIR, ROOT)}/")


if __name__ == "__main__":
    main()
