#!/usr/bin/env python3
"""
Build the macOS app icon from the brand mark.

The source is a white 8000px square with the mark sitting in the middle of a
lot of empty space -- at 32px that margin is most of the pixels, which is why
the app read as smaller than everything beside it in the dock. So the mark is
cut out of the source and re-composed at a chosen size on a tile drawn here.

Two things are deliberate:

- Every size is resampled once, from the 8000px original, with LANCZOS.
  Generating a 1024 and letting each smaller size fall out of it resamples
  twice and softens the thin white outline inside the mark, which is the first
  detail to go.

- The corner mask is drawn at 8x and shrunk, because a rounded rectangle
  rasterised straight to 16px has visibly ragged corners.
"""
from PIL import Image, ImageDraw
import os, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE = os.path.join(ROOT, 'brand', 'mark-white.png')

# Where the coloured artwork sits in the source, measured rather than guessed.
MARK_BOX = (1524, 775, 6485, 7234)

# Share of the tile's height the mark fills. The source sat at 0.617, which is
# a lot of white; macOS glyphs generally sit nearer three quarters.
MARK_HEIGHT = 0.75

# Matches the tile already shipping: full-bleed, corners at 20.9%.
CORNER = 0.209
SUPERSAMPLE = 8

SIZES = [16, 32, 128, 256, 512]


def tile(size: int, mark: Image.Image) -> Image.Image:
    canvas = Image.new('RGBA', (size, size), (255, 255, 255, 255))

    target_h = max(1, round(size * MARK_HEIGHT))
    target_w = max(1, round(mark.width * target_h / mark.height))
    scaled = mark.resize((target_w, target_h), Image.LANCZOS)
    canvas.paste(scaled, ((size - target_w) // 2, (size - target_h) // 2))

    big = size * SUPERSAMPLE
    mask = Image.new('L', (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, big - 1, big - 1), radius=round(big * CORNER), fill=255
    )
    canvas.putalpha(mask.resize((size, size), Image.LANCZOS))
    return canvas


def main() -> int:
    if not os.path.exists(SOURCE):
        print(f'missing source: {SOURCE}', file=sys.stderr)
        return 1

    mark = Image.open(SOURCE).convert('RGB').crop(MARK_BOX)
    out = os.path.join(ROOT, 'apps', 'desktop', 'build')
    iconset = os.path.join(out, 'icon.iconset')
    os.makedirs(iconset, exist_ok=True)

    for size in SIZES:
        tile(size, mark).save(os.path.join(iconset, f'icon_{size}x{size}.png'))
        tile(size * 2, mark).save(os.path.join(iconset, f'icon_{size}x{size}@2x.png'))

    icns = os.path.join(out, 'icon.icns')
    subprocess.run(['iconutil', '-c', 'icns', iconset, '-o', icns], check=True)
    print(f'wrote {icns} ({os.path.getsize(icns):,} bytes)')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
