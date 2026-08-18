# ContextoAgent desktop companion

Reads school portals that have no API — Veracross, Mozaïk — using logins the
student completes themselves, and pushes what it finds to their account.

## Why it exists

Classroom has an API. Veracross does not, and it sits behind school SSO. The
only place a student's coursework is reachable is a browser they have already
logged into, so this drives one.

It does **not** embed a browser. Google refuses OAuth from embedded webviews,
so a student at a Workspace school could never complete SSO inside our own
window. This drives the real Chrome they already have.

## Running it

```sh
pnpm install
pnpm --filter @contexto/desktop start     # the app window
pnpm --filter @contexto/desktop dist      # build a DMG into release/
```

Point it at a local API with `CONTEXTO_API` and `CONTEXTO_WEB`.

## Command line

The same operations, without the window. Useful for writing portal support.

```sh
pnpm --filter @contexto/desktop link
pnpm --filter @contexto/desktop sync    veracross "https://portals.veracross.com/lcc/student"
pnpm --filter @contexto/desktop explore veracross "<url>" --budget 20
pnpm --filter @contexto/desktop record  veracross "<url>"
```

`record` and `explore` write **shapes** by default — field names and types, no
values — because their output is a spec a human reads. `sync` writes real
values, because it feeds the student's own agent, which cannot answer "what is
due Friday" from `string<date>`.

## Two things worth knowing before changing this

**Login and reading are separate browser launches.** Measured on Chrome 151,
`--remote-debugging-pipe` sets `navigator.webdriver = true` while
`--remote-debugging-port` leaves it false — but the port is an unauthenticated
TCP listener any local process can use to drive an authenticated school portal.
So login runs with *no* debugging transport at all, and only afterwards does
drive mode reopen the same profile over the pipe. See the header of
`src/browser.mjs`.

**The origin lock and page budget are enforced in code, not in a prompt.** A
model talked into wandering must still be unable to. See `src/explorer.mjs`.

Since Chrome 136 refuses debugging on the default profile, this physically
cannot reach the Chrome holding the student's Gmail and Drive.

## Known issues

**Not signed or notarized.** The DMG will be refused by macOS on another
machine until it is signed with an Apple Developer identity.

**Electron's own postinstall fails silently on Node 24.** `extract-zip` opens
the first archive entry and exits 0, leaving no binary; the download itself is
fine and its checksum validates. `scripts/ensure-electron.mjs` runs after
install and extracts from the archive Electron already downloaded. If you see
"Electron failed to install correctly", run `pnpm install` again.
