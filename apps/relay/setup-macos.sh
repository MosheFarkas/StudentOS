#!/bin/bash
#
# Make the residential relay permanent on a Mac.
#
# Installs two launchd agents -- the relay itself and the Cloudflare tunnel
# that exposes it to the droplet -- so both come back after a reboot without
# anyone logging in to start them.
#
# Run AFTER `cloudflared tunnel login`, which is what authorises this machine
# to create a tunnel on your Cloudflare account.
#
#   bash setup-macos.sh
#
# Idempotent: safe to run again to update the relay or rotate the token.
set -euo pipefail

TUNNEL_NAME="${TUNNEL_NAME:-contexto-relay}"
HOSTNAME_="${RELAY_HOSTNAME:-relay.contextoagent.ai}"
RELAY_PORT="${RELAY_PORT:-8787}"
HOME_DIR="$HOME"
AGENTS="$HOME_DIR/Library/LaunchAgents"
RELAY_FILE="$HOME_DIR/.contexto/relay.mjs"
ENV_FILE="$HOME_DIR/.contexto/relay.env"

command -v cloudflared >/dev/null || { echo "cloudflared not found: brew install cloudflared" >&2; exit 1; }
command -v node >/dev/null || { echo "node not found" >&2; exit 1; }
[[ -f "$HOME_DIR/.cloudflared/cert.pem" ]] || {
  echo "Not logged in to Cloudflare. Run this first, then re-run this script:" >&2
  echo "  cloudflared tunnel login" >&2
  exit 1
}

mkdir -p "$HOME_DIR/.contexto" "$AGENTS"
chmod 700 "$HOME_DIR/.contexto"

echo "==> Fetching the relay"
curl -fsSL https://contextoagent.ai/relay.mjs -o "$RELAY_FILE"

# The token is generated once and reused, so re-running does not silently
# invalidate the droplet's copy.
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  echo "==> Reusing existing relay token"
else
  RELAY_TOKEN="$(openssl rand -hex 32)"
  printf 'RELAY_TOKEN=%s\n' "$RELAY_TOKEN" > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "==> Generated a new relay token"
fi

echo "==> Creating the tunnel (if it does not exist)"
if ! cloudflared tunnel list 2>/dev/null | awk '{print $2}' | grep -qx "$TUNNEL_NAME"; then
  cloudflared tunnel create "$TUNNEL_NAME"
fi
TUNNEL_ID="$(cloudflared tunnel list | awk -v n="$TUNNEL_NAME" '$2==n {print $1}' | head -1)"
[[ -n "$TUNNEL_ID" ]] || { echo "could not determine tunnel id" >&2; exit 1; }

echo "==> Pointing $HOSTNAME_ at the tunnel"
cloudflared tunnel route dns --overwrite-dns "$TUNNEL_NAME" "$HOSTNAME_" >/dev/null 2>&1 || true

cat > "$HOME_DIR/.cloudflared/config.yml" <<YAML
tunnel: $TUNNEL_ID
credentials-file: $HOME_DIR/.cloudflared/$TUNNEL_ID.json

ingress:
  - hostname: $HOSTNAME_
    service: http://127.0.0.1:$RELAY_PORT
  - service: http_status:404
YAML

echo "==> Installing launchd agents"

# The relay. KeepAlive restarts it if it exits; RunAtLoad starts it at login.
cat > "$AGENTS/ai.contexto.relay.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>ai.contexto.relay</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(command -v node)</string>
    <string>$RELAY_FILE</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>RELAY_TOKEN</key><string>$RELAY_TOKEN</string>
    <key>RELAY_PORT</key><string>$RELAY_PORT</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME_DIR/.contexto/relay.log</string>
  <key>StandardErrorPath</key><string>$HOME_DIR/.contexto/relay.log</string>
</dict>
</plist>
PLIST
# Contains the token, so it is readable only by this user.
chmod 600 "$AGENTS/ai.contexto.relay.plist"

cat > "$AGENTS/ai.contexto.cloudflared.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>ai.contexto.cloudflared</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(command -v cloudflared)</string>
    <string>tunnel</string>
    <string>run</string>
    <string>$TUNNEL_NAME</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME_DIR/.contexto/cloudflared.log</string>
  <key>StandardErrorPath</key><string>$HOME_DIR/.contexto/cloudflared.log</string>
</dict>
</plist>
PLIST

for label in ai.contexto.relay ai.contexto.cloudflared; do
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$AGENTS/$label.plist"
  launchctl enable "gui/$(id -u)/$label"
done

echo
echo "==> Done. Give the droplet these:"
echo "    RELAY_URL=https://$HOSTNAME_"
echo "    RELAY_TOKEN=$RELAY_TOKEN"
echo
echo "    logs: ~/.contexto/relay.log and ~/.contexto/cloudflared.log"
