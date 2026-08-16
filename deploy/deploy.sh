#!/usr/bin/env bash
#
# Deploy. Run as the contexto user:
#   sudo -u contexto /srv/contexto/deploy/deploy.sh
set -euo pipefail

APP_DIR=/srv/contexto
cd "$APP_DIR"

echo "==> Pulling"
# --ff-only so a dirty or diverged working tree fails loudly here rather than
# producing a merge commit nobody meant to make, on a production box.
git pull --ff-only

echo "==> Installing dependencies"
pnpm install --frozen-lockfile

echo "==> Running migrations"
# Before the restart: the new code may depend on a column that does not exist
# yet. Migrating after restart means a window where the API 500s on every
# request touching it.
pnpm --filter @contexto/db migrate

echo "==> Building the web bundle"
pnpm --filter @contexto/web build

# Publish the relay so a home machine can fetch the current version with
# curl, rather than needing a checkout of this repo.
cp apps/relay/relay.mjs apps/web/dist/relay.mjs
cp apps/relay/setup-macos.sh apps/web/dist/relay-setup.sh

echo "==> Restarting services"
# The contexto user needs a sudoers entry for exactly these two commands:
#   contexto ALL=(root) NOPASSWD: /bin/systemctl restart contexto-api, /bin/systemctl restart contexto-worker
sudo systemctl restart contexto-api
sudo systemctl restart contexto-worker

echo "==> Waiting for health"
for i in $(seq 1 30); do
  if curl -fsS http://localhost:3210/api/health >/dev/null 2>&1; then
    echo "healthy"
    exit 0
  fi
  sleep 1
done

echo "API did not become healthy in 30s. Check: journalctl -u contexto-api -n 50" >&2
exit 1
