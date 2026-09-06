# Dark mode

Approved 2026-09-05. Navy-tinted dark theme across the web app; the desktop companion follows the OS.

## Rules (from Material, Apple HIG, web.dev, NN/g, WCAG 2.2)

- Base surfaces are dark grey tinted toward the brand navy, never pure black. Raised layers step lighter; borders replace shadows.
- Text is off-white (~87%), secondary ~60%. Every text colour clears 4.5:1 on every surface it sits on.
- Accents are lighter and less saturated on dark; fills (buttons) and text need separate values.
- `color-scheme` on the root; `data-theme` stamped only for a pinned choice; system follows the OS live; an inline script applies the stored choice before first paint.
- Logos get a made dark variant (wordmark off-white, Agent lighter violet, mark unchanged). Focus rings get their own token.

## Tokens (light → dark)

page #faf9fd → #0c0f2a · surface #fff → #151a3e · wash #f4f4f9 → #1c2148 · line #e3e4ee → #262b55 · line-strong #cdcfe0 → #383e70
ink #0a1045 → #e8eaff · ink-soft #3d4470 → #b4b9dc · ink-faint #6b7194 → #8a90bb
violet (fill) #5010d0 → #6c3ef5 · violet-ink (text) #5010d0 → #b39aff · violet-dark #3f0ba6 → #7d55ff
blue (fill) #4070ff → #3d6fe6 · blue-ink #4070ff → #8fb0ff · blue-dark #2f5ce6 → #5583f0
lavender #c090ff → #c4b5fd · teal #2f9bbc → #5cc8e0 · ok #12805c → #58c99a · warn #8a5a00 → #f0b35a · danger #b3261e → #ff7b72
focus #4070ff → #8fb0ff · shadow → none (borders + lighter surface)

## Plumbing

- `apps/web/src/lib/theme.ts`: applyAppearance('light'|'dark'|'system'), resolvedTheme(), useResolvedTheme(); persists to localStorage `appearance`; updates `<meta name="theme-color">`; listens to `prefers-color-scheme` while on system.
- `index.html`: `<meta name="color-scheme" content="light dark">`, theme-color per scheme, inline pre-paint script.
- App applies the account preference from `/me` on load; Settings offers System / Light / Dark and applies immediately.
- Images: `/wordmark-dark.png`, `/logo-dark.png` swapped by `useResolvedTheme()`.
- Tests: theme resolver; Settings three-state; contrast test parsing both palettes from index.css (text-on-surface ≥ 4.5:1).
- Desktop renderer (`apps/desktop/src/renderer/app.css`): `prefers-color-scheme: dark` block with the same tokens.
