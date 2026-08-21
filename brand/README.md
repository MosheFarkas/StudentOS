# Brand assets

`lockup.png` is the source, 8000x1795 with a real alpha channel. The white-
background version it replaced is gone: transparent works on any surface, and
keeping both invites someone picking the wrong one.

`mark.png` is the square mark on its own, also 8000px with alpha.

Regenerate the wordmark:

```bash
sips -Z 1400 -s format png brand/lockup.png --out apps/web/public/logo.png
```

Regenerate the icons. The source has 50% empty margin, which at 32px throws
away half the available pixels, so it is cropped to the artwork and padded
back to a square deliberately:

```bash
sips brand/mark.png --cropToHeightWidth 6450 4970 --cropOffset 780 1520 --out /tmp/c.png
sips /tmp/c.png --cropToHeightWidth 7000 7000 --out /tmp/sq.png        # transparent pad
for S in 16 32 48 192 512; do
  sips -Z $S -s format png /tmp/sq.png --out apps/web/public/icon-$S.png
done
```

Regenerate the desktop app icon:

```bash
python3 scripts/make-icon.py
```

That script owns the app icon rather than a line of `sips` here, because it
does three things a one-liner cannot. It cuts the mark out of the source and
recomposes it at a chosen fraction of the tile -- the source has so much empty
margin that a straight resize spends most of a 32px icon on white, which reads
as a smaller app than everything beside it in the dock. It resamples every
size once from the 8000px original with LANCZOS, where deriving the small
sizes from a generated 1024 resamples twice and softens the thin white outline
inside the mark first. And it draws the corner mask at 8x before shrinking it,
because a rounded rectangle rasterised straight to 16px has ragged corners.

The numbers worth knowing are at the top of the script: `MARK_HEIGHT` is the
share of the tile the mark fills (0.75), and `CORNER` is the corner radius as
a share of the tile (0.209, matching the tile this replaced). `MARK_BOX` is
where the artwork actually sits in the source, measured rather than guessed.

The web icons above are still generated with `sips` -- they are a favicon on
a page, not a tile in a dock, and nothing has been wrong with them.

Separate files per size, not one for the browser to downscale: a 512 squeezed
into a 16px tab loses the thin white outline inside the mark.

`apple-touch-icon.png` is the only opaque one. iOS composites transparency
onto BLACK, so an alpha icon shows as a dark tile on the home screen; it is
flattened onto white via a JPEG round trip.

The favicon is the mark alone, never the lockup: at 4.5:1 the wordmark is an
illegible smear by the time it is 32px wide.

Palette, sampled from this file rather than chosen next to it -- see
`apps/web/src/index.css`:

| Colour   | Hex       | Used for        |
| -------- | --------- | --------------- |
| Navy     | `#001040` | Ink, headings   |
| Violet   | `#5010d0` | Primary actions |
| Blue     | `#4070ff` | Focus rings     |
| Lavender | `#c090ff` | Accents         |
| Teal     | `#50b0d0` | Accents         |
