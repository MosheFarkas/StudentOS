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

## Signing and notarizing

Without this the DMG runs only on the machine that built it — macOS refuses an
unsigned app everywhere else, and "right-click → Open" does not get a student
past it reliably.

You need a paid Apple Developer account, a **Developer ID Application**
certificate (not "Apple Distribution" — that one is for the App Store and will
not work here), and an App Store Connect API key.

```sh
# The certificate must be in the login keychain. Confirm it is:
security find-identity -v -p codesigning | grep "Developer ID Application"

export APPLE_API_KEY=~/private_keys/AuthKey_XXXXXXXXXX.p8
export APPLE_API_KEY_ID=XXXXXXXXXX      # the key id
export APPLE_API_ISSUER=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee

pnpm --filter @contexto/desktop dist
```

The config turns notarization on only when those are present, so a build
without them still works and says so rather than failing.

Notarization uploads the app to Apple and waits — usually a few minutes, and
occasionally much longer. Check the result:

```sh
spctl -a -vvv -t install release/mac-arm64/ContextoAgent.app   # expect "accepted"
codesign -dv --entitlements - release/mac-arm64/ContextoAgent.app
```

The entitlements in `build/entitlements.mac.plist` are what V8 needs under the
hardened runtime — it compiles JavaScript to machine code at runtime, which is
the exact behaviour the hardened runtime exists to block. None of them grant
access to a student's files or devices.

## Known issues

**Electron's own postinstall fails silently on Node 24.** `extract-zip` opens
the first archive entry and exits 0, leaving no binary; the download itself is
fine and its checksum validates. `scripts/ensure-electron.mjs` runs after
install and extracts from the archive Electron already downloaded. If you see
"Electron failed to install correctly", run `pnpm install` again.
