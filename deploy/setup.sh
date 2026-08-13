#!/usr/bin/env bash
#
# One-time setup on the droplet. Run as root (or with sudo).
#
# Written for a droplet that already runs other things: it creates a dedicated
# unix user, a dedicated Postgres role and database, and touches nothing that
# is already there. It deliberately does NOT install or configure a web server
# -- see Caddyfile.snippet or nginx.conf.snippet for whichever you already run.
set -euo pipefail

APP_USER=contexto
APP_DIR=/srv/contexto
REPO="${REPO:-git@github.com:MosheFarkas/StudentOS.git}"
DB_NAME=contexto
DB_USER=contexto

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo ./setup.sh" >&2
  exit 1
fi

echo "==> Checking prerequisites"
command -v node >/dev/null || { echo "node not found -- install Node 22+ first" >&2; exit 1; }
node_major=$(node -p "process.versions.node.split('.')[0]")
[[ "$node_major" -ge 22 ]] || { echo "Node $node_major found, need 22+" >&2; exit 1; }
command -v psql >/dev/null || { echo "postgres client not found -- install postgresql" >&2; exit 1; }

if ! command -v pnpm >/dev/null; then
  echo "==> Installing pnpm"
  npm install -g pnpm
fi
# The systemd units hardcode this path. Symlink if pnpm landed elsewhere.
[[ -x /usr/local/bin/pnpm ]] || ln -sf "$(command -v pnpm)" /usr/local/bin/pnpm

echo "==> Creating service user"
# System account: no login shell, no home directory to compromise.
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --shell /usr/sbin/nologin --home-dir "$APP_DIR" "$APP_USER"

echo "==> Creating $APP_DIR"
mkdir -p "$APP_DIR"
if [[ ! -d "$APP_DIR/.git" ]]; then
  git clone "$REPO" "$APP_DIR"
fi
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

echo "==> Creating Postgres role and database"
# A dedicated role owning a dedicated database. On a shared box this matters:
# it means a compromise of another project's database credentials cannot read
# student data, and vice versa.
DB_PASS=$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)
sudo -u postgres psql <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '$DB_USER') THEN
    CREATE ROLE $DB_USER LOGIN PASSWORD '$DB_PASS';
  END IF;
END \$\$;
SQL
sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1 \
  || sudo -u postgres createdb -O "$DB_USER" "$DB_NAME"

echo
echo "==> Postgres connection string (put this in $APP_DIR/.env):"
echo "    DATABASE_URL=postgres://$DB_USER:$DB_PASS@localhost:5432/$DB_NAME"
echo "    (shown once -- if you lose it, re-run: ALTER ROLE $DB_USER PASSWORD '...';)"
echo

echo "==> Installing systemd units"
cp "$APP_DIR/deploy/contexto-api.service" /etc/systemd/system/
cp "$APP_DIR/deploy/contexto-worker.service" /etc/systemd/system/
systemctl daemon-reload

cat <<'NEXT'

==> Remaining manual steps

1. Create /srv/contexto/.env (see deploy/README.md for the production values),
   then lock it down -- this file holds MASTER_ENCRYPTION_KEY:

     sudo chown contexto:contexto /srv/contexto/.env
     sudo chmod 600 /srv/contexto/.env

   600 and owned by the service user is what stops other projects on this box
   reading it as their own user.

2. Add the web server config (deploy/Caddyfile.snippet OR nginx.conf.snippet).

3. Deploy:

     sudo -u contexto /srv/contexto/deploy/deploy.sh
     sudo systemctl enable --now contexto-api contexto-worker

4. Update the Google OAuth client with the production URLs, and register the
   Telegram webhook. Both are in deploy/README.md.
NEXT
