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

Regenerate the desktop app icon. Same cropped square as above -- using
`mark.png` directly spends half the icon on empty margin, which reads as a
smaller app icon than every other app in the dock:

```bash
mkdir -p /tmp/icon.iconset
for S in 16 32 128 256 512; do
  sips -Z $S      -s format png /tmp/sq.png --out /tmp/icon.iconset/icon_${S}x${S}.png
  sips -Z $((S*2)) -s format png /tmp/sq.png --out /tmp/icon.iconset/icon_${S}x${S}@2x.png
done
iconutil -c icns /tmp/icon.iconset -o apps/desktop/build/icon.icns
```

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
