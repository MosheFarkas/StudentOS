#!/usr/bin/env python3
"""
Build the two web brand assets the folding header mark needs.

The header used to be one flat lockup image. It is now the mark and the
wordmark side by side, because only the mark animates -- so the two have to
ship separately, framed exactly as they sat in the lockup or the header
visibly shifts.

`mark.png` is the square mark with its original framing preserved. That last
part is load-bearing: the fold animation's axes were measured against this
exact framing, in a 900-unit space mapped onto the whole square. Crop it, pad
it, or re-centre it and every fold lands somewhere slightly wrong.

Two things are deliberate, both borrowed from the app-icon script:

- Resampling happens in linear light, for the reason set out in
  scripts/make-icon.py: sRGB values are not proportional to light, and the
  energy lost in averaging them shows up wherever a saturated colour meets its
  background, which is most of this mark's edges.

- Alpha is premultiplied before the resize and divided back out after. The
  source stores black in its fully transparent pixels, so resampling colour
  without regard to coverage drags that black into every edge -- a dark fringe
  around the mark, worst at the small sizes this asset exists for.

Alpha itself is resized in coverage space, not linear light: coverage is
already proportional to area, so putting it through the transfer function
would be the mistake, not the fix.
"""
from PIL import Image
import numpy as np
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MARK_SOURCE = os.path.join(ROOT, 'brand', 'mark.png')
LOCKUP_SOURCE = os.path.join(ROOT, 'brand', 'lockup.png')
OUT_DIR = os.path.join(ROOT, 'apps', 'web', 'public')

# Enough for the mark at any size the app shows it -- 26px in the header, 20px
# in the conversation, times the densest display anyone is running. Larger
# would be weight the page pays for on every load and never draws.
MARK_SIZE = 512

# Where the wordmark sits in the lockup, measured rather than guessed. The
# mark occupies everything left of the gap at x=1309..1476.
WORDMARK_BOX = (1477, 541, 7870, 1508)
# Three times the ~16px the header draws it at, on the densest display going.
WORDMARK_HEIGHT = 160


def to_linear(c: np.ndarray) -> np.ndarray:
    """sRGB to linear light. The transfer function, not an approximation."""
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def to_srgb(c: np.ndarray) -> np.ndarray:
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.clip(c, 0, None) ** (1 / 2.4) - 0.055)


def resize_rgba(source: Image.Image, size: tuple[int, int]) -> Image.Image:
    """Downscale with alpha intact: premultiplied, in linear light."""
    rgba = np.asarray(source.convert('RGBA'), dtype=np.float32) / 255.0
    alpha = rgba[:, :, 3]
    premultiplied = to_linear(rgba[:, :, :3]) * alpha[:, :, None]

    channels = [
        np.asarray(
            Image.fromarray(premultiplied[:, :, i]).resize(size, Image.LANCZOS), dtype=np.float32
        )
        for i in range(3)
    ]
    out_alpha = np.asarray(Image.fromarray(alpha).resize(size, Image.LANCZOS), dtype=np.float32)

    # Divide coverage back out. Where nothing landed there is no colour to
    # recover, and leaving it at zero keeps the transparent pixels black --
    # which is what the source does and what nothing ever draws.
    safe = np.where(out_alpha > 1e-6, out_alpha, 1.0)
    colour = to_srgb(np.clip(np.dstack(channels) / safe[:, :, None], 0.0, 1.0))

    stacked = np.dstack([colour, np.clip(out_alpha, 0.0, 1.0)])
    return Image.fromarray((stacked * 255).round().astype(np.uint8))


def main() -> int:
    for path in (MARK_SOURCE, LOCKUP_SOURCE):
        if not os.path.exists(path):
            print(f'missing source: {path}', file=sys.stderr)
            return 1

    mark = Image.open(MARK_SOURCE)
    if mark.width != mark.height:
        print(f'the mark source must be square, got {mark.size}', file=sys.stderr)
        return 1
    out = os.path.join(OUT_DIR, 'mark.png')
    resize_rgba(mark, (MARK_SIZE, MARK_SIZE)).save(out)
    print(f'{out}  {MARK_SIZE}x{MARK_SIZE}')

    lockup = Image.open(LOCKUP_SOURCE).crop(WORDMARK_BOX)
    width = max(1, round(lockup.width * WORDMARK_HEIGHT / lockup.height))
    out = os.path.join(OUT_DIR, 'wordmark.png')
    resize_rgba(lockup, (width, WORDMARK_HEIGHT)).save(out)
    print(f'{out}  {width}x{WORDMARK_HEIGHT}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
