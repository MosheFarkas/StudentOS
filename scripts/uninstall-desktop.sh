#!/bin/bash
#
# Remove every copy of the desktop app from this machine.
#
#   ./scripts/uninstall-desktop.sh          apps, installers, caches
#   ./scripts/uninstall-desktop.sh --all    also the device link, sites and saved sign-ins
#
# Written after doing this by hand twice and missing a copy both times. The
# search below excludes NOTHING: a build in the repo is a real app bundle,
# Spotlight lists it as an Application, and filtering the repo out of a search
# meant to be exhaustive is how it got missed.
set -uo pipefail

ALL=false
[[ "${1:-}" == "--all" ]] && ALL=true

say() { printf '  %s\n' "$1"; }

# ---- find everything first, so the report is honest about what was there ----
# /System/Volumes/Data/X is the same file as /X through the firmlink macOS
# puts there, so counting both would report two copies where one exists -- and
# a report that overcounts is as untrustworthy as one that misses something.
# Built with a read loop rather than mapfile: macOS ships bash 3.2, where
# mapfile does not exist, and this script is for macOS.
BUNDLES=()
while IFS= read -r line; do
  [[ -n "$line" ]] && BUNDLES+=("$line")
done < <(find / /Volumes -maxdepth 10 -iname "*ontexto*.app" \
  -not -path "*/Trash/*" -not -path "*/Contents/Frameworks/*" 2>/dev/null \
  | sed 's|^/System/Volumes/Data||' | grep -v '^$' | sort -u)

echo "Found ${#BUNDLES[@]} app bundle(s)."
# ${arr[@]} on an empty array is an unbound-variable error under set -u in
# bash 3.2, so both loops are guarded rather than assuming there is one.
if [[ ${#BUNDLES[@]} -gt 0 ]]; then
  for b in "${BUNDLES[@]}"; do say "$b"; done
fi

# ---- stop it, unmount it, remove it ----
pkill -f "ContextoAgent" 2>/dev/null && say "stopped a running copy"
sleep 1

while read -r vol; do
  [[ -n "$vol" ]] && hdiutil detach "$vol" -quiet 2>/dev/null && say "ejected $vol"
done < <(mount | grep -i contexto | sed 's/.* on \(.*\) (.*/\1/')

if [[ ${#BUNDLES[@]} -gt 0 ]]; then
  for b in "${BUNDLES[@]}"; do
    rm -rf "$b" && say "removed $b"
  done
fi

# rm -rf succeeds on a path that was never there, so each of these checks
# first. A report that claims work it did not do is no more use than one that
# misses something.
drop() {
  local label="$1"; shift
  local found=false
  for path in "$@"; do
    [[ -e "$path" ]] && found=true
  done
  if $found; then
    rm -rf "$@" 2>/dev/null
    say "removed $label"
  fi
}

# The repo's build directory holds the DMG next to the app it was built from.
drop "the repo build output" "$(dirname "$0")/../apps/desktop/release"
drop "downloaded installers" "$HOME"/Downloads/*ontexto*.dmg
drop "caches, preferences and saved state" \
  "$HOME/Library/Caches/ContextoAgent" \
  "$HOME/Library/Caches/ai.contextoagent.desktop" \
  "$HOME/Library/Preferences/ai.contextoagent.desktop.plist" \
  "$HOME/Library/Saved Application State/ai.contextoagent.desktop.savedState" \
  "$HOME/Library/Logs/ContextoAgent" \
  "$HOME/Library/HTTPStorages/ai.contextoagent.desktop" \
  "$HOME/Library/WebKit/ai.contextoagent.desktop"

# ---- the student's own data, only when asked ----
CONFIG="$HOME/Library/Application Support/ContextoAgent/config.json"
if $ALL; then
  # Keychain entries are keyed by site id, which only the config knows -- so
  # read it before deleting it, or the sign-ins are orphaned in the keychain
  # with nothing left to name them.
  if [[ -f "$CONFIG" ]]; then
    while read -r site; do
      [[ -z "$site" ]] && continue
      security delete-generic-password -s "ContextoAgent: $site" >/dev/null 2>&1 \
        && say "forgot the saved sign-in for $site"
    done < <(python3 -c "
import json, sys
try:
    print('\n'.join(p['id'] for p in json.load(open('$CONFIG')).get('portals', [])))
except Exception:
    pass" 2>/dev/null)
  fi
  rm -rf "$HOME/Library/Application Support/ContextoAgent" && say "removed the device link, sites and browser profiles"
else
  if [[ -f "$CONFIG" ]]; then
    echo
    say "KEPT: the device link, sites and saved sign-ins."
    say "A fresh install will come back already linked. Use --all to clear them too."
  fi
fi

/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
  -u /Applications/ContextoAgent.app >/dev/null 2>&1
killall Dock 2>/dev/null && say "refreshed the Dock, which caches icons of apps that are gone"

# ---- prove it ----
echo
LEFT=$(find / /Volumes -maxdepth 10 -iname "*ontexto*.app" -not -path "*/Trash/*" 2>/dev/null \
  | sed 's|^/System/Volumes/Data||' | grep -v '^$' | sort -u | wc -l | tr -d ' ')
if [[ "$LEFT" == "0" ]]; then
  echo "Verified: no app bundles remain anywhere."
else
  echo "STILL PRESENT ($LEFT):" >&2
  find / /Volumes -maxdepth 10 -iname "*ontexto*.app" -not -path "*/Trash/*" 2>/dev/null \
    | sed 's|^/System/Volumes/Data||' | grep -v '^$' | sort -u >&2
  exit 1
fi
