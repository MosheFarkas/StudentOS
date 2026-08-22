#!/usr/bin/env python3
"""
Build the macOS app icon from the brand mark.

The source is a white 8000px square with the mark sitting in the middle of a
lot of empty space -- at 32px that margin is most of the pixels, which is why
the app read as smaller than everything beside it in the dock. So the mark is
cut out of the source and re-composed at a chosen size on a tile drawn here.

Three things are deliberate:

- Resampling happens in linear light. Averaging pixels in sRGB is averaging
  numbers that are not proportional to light, which loses energy wherever a
  saturated colour meets white -- most of this mark's edges. Measured on this
  artwork: downscaling to 32px in sRGB loses 2.75% of the image's luminance,
  and in linear light 0.54%. The error grows as the target gets smaller, so it
  is worst exactly where the icon is hardest to read.

- Every size is resampled once, from the 8000px original. Generating a 1024
  and letting each smaller size fall out of it resamples twice and softens the
  thin white outline inside the mark, which is the first detail to go.

- The corner mask is drawn at 8x and shrunk, because a rounded rectangle
  rasterised straight to 16px has visibly ragged corners.
"""
from PIL import Image, ImageDraw
import numpy as np
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE = os.path.join(ROOT, 'brand', 'mark-white.png')

# Where the coloured artwork sits in the source, measured rather than guessed.
MARK_BOX = (1524, 775, 6485, 7234)

# Share of the tile's height the mark fills.
#
# The mark is portrait -- 0.768 as wide as it is tall -- so height is the
# binding dimension and the width that falls out of it is narrower again.
# 0.82 of the height is 63% of the width.
#
# The usable range is roughly 0.75 to 0.90: below that it reads as a small
# mark in a large white square, and by 0.94 it grazes the top and bottom
# edges, with its corners lost to the tile's own rounding at 1.0.
MARK_HEIGHT = 0.82

# Matches the tile already shipping: full-bleed, corners at 20.9%.
CORNER = 0.209
SUPERSAMPLE = 8

SIZES = [16, 32, 128, 256, 512]


def to_linear(c: np.ndarray) -> np.ndarray:
    """sRGB to linear light. The transfer function, not an approximation."""
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def to_srgb(c: np.ndarray) -> np.ndarray:
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.clip(c, 0, None) ** (1 / 2.4) - 0.055)


def resize_linear(mark: np.ndarray, size: tuple[int, int]) -> Image.Image:
    """Downscale in linear light, then come back to sRGB for storage."""
    linear = to_linear(mark)
    channels = [
        np.asarray(Image.fromarray(linear[:, :, i]).resize(size, Image.LANCZOS), dtype=np.float32)
        for i in range(3)
    ]
    out = to_srgb(np.clip(np.dstack(channels), 0.0, 1.0))
    return Image.fromarray((np.clip(out, 0, 1) * 255).round().astype(np.uint8))


def tile(size: int, mark: np.ndarray, aspect: float) -> Image.Image:
    canvas = Image.new('RGBA', (size, size), (255, 255, 255, 255))

    target_h = max(1, round(size * MARK_HEIGHT))
    target_w = max(1, round(target_h * aspect))
    canvas.paste(
        resize_linear(mark, (target_w, target_h)),
        ((size - target_w) // 2, (size - target_h) // 2),
    )

    big = size * SUPERSAMPLE
    mask = Image.new('L', (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, big - 1, big - 1), radius=round(big * CORNER), fill=255
    )
    # Coverage is already proportional to area, so this one is linear as it
    # stands and must not be run through the transfer function.
    canvas.putalpha(mask.resize((size, size), Image.LANCZOS))
    return canvas


def main() -> int:
    if not os.path.exists(SOURCE):
        print(f'missing source: {SOURCE}', file=sys.stderr)
        return 1

    cropped = Image.open(SOURCE).convert('RGB').crop(MARK_BOX)
    mark = np.asarray(cropped, dtype=np.float32) / 255.0
    aspect = cropped.width / cropped.height

    out = os.path.join(ROOT, 'apps', 'desktop', 'build')
    iconset = os.path.join(out, 'icon.iconset')
    os.makedirs(iconset, exist_ok=True)

    for size in SIZES:
        tile(size, mark, aspect).save(os.path.join(iconset, f'icon_{size}x{size}.png'))
        tile(size * 2, mark, aspect).save(os.path.join(iconset, f'icon_{size}x{size}@2x.png'))

    icns = os.path.join(out, 'icon.icns')
    subprocess.run(['iconutil', '-c', 'icns', iconset, '-o', icns], check=True)
    print(f'wrote {icns} ({os.path.getsize(icns):,} bytes)')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
