---
description: Remove every copy of the ContextoAgent desktop app from this machine
argument-hint: [--all]
allowed-tools: Bash(./scripts/uninstall-desktop.sh:*)
---

Run `./scripts/uninstall-desktop.sh $1` and report what it removed.

Without `--all` it removes the apps, installers and caches but keeps the
device link, the configured sites and any saved sign-ins — so a fresh install
comes back already linked. Say so plainly, because "removed the app" and
"back to a new user" are different states and the difference only shows up
later.

With `--all` it also forgets the saved sign-ins from the keychain and deletes
the browser profiles holding the site sessions. Those cannot be recovered:
the sign-ins are gone from the keychain and the device token exists nowhere
else, since the server keeps only its hash.

The script searches without excluding anything, including the repo's own
`release/` build output — that is a real app bundle, Spotlight lists it as an
Application, and it is the copy that gets missed. It verifies at the end and
exits non-zero if anything survived; if that happens, say what is still there
rather than reporting success.

One thing the script cannot do: the linked device still exists on the server.
Mention that it will show in Settings as a device that can never sync again,
and offer to revoke it.
