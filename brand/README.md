# Brand assets

`lockup.png` is the source, 8000x1795 with a real alpha channel. The white-
background version it replaced is gone: transparent works on any surface, and
keeping both invites someone picking the wrong one.

Regenerate what the app serves:

```bash
sips -Z 1400 -s format png brand/lockup.png --out apps/web/public/logo.png
sips --cropToHeightWidth 1795 1795 --cropOffset 0 0 brand/lockup.png --out /tmp/mark.png
sips -Z 256 -s format png /tmp/mark.png --out apps/web/public/mark.png
```

The favicon is the mark alone, not the lockup: at 4.5:1 the full lockup is an
illegible smear by the time it is 32px wide.

Palette, sampled from this file rather than chosen next to it -- see
`apps/web/src/index.css`:

| Colour   | Hex       | Used for            |
| -------- | --------- | ------------------- |
| Navy     | `#001040` | Ink, headings       |
| Violet   | `#5010d0` | Primary actions     |
| Blue     | `#4070ff` | Focus rings         |
| Lavender | `#c090ff` | Accents             |
| Teal     | `#50b0d0` | Accents             |
