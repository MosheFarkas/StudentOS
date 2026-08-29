#!/bin/bash
#
# Bring this clone up to date and prove it can still be worked on.
#
# Written for the first hour on a new machine, but safe to run any morning:
# it pulls, reinstalls, migrates, and then runs the same checks CI runs, so
# "it works on my laptop" is something you have watched happen rather than
# something you are assuming.
#
#   ./scripts/sync.sh              update the branch you are on
#   ./scripts/sync.sh main         switch to main and update that
#   ./scripts/sync.sh --quick      skip the tests and the build
#
# It never decides what to do with your work. A dirty tree or a branch that
# has diverged from origin stops the script -- nothing is stashed, rebased,
# or merged behind your back.
set -uo pipefail

cd "$(dirname "$0")/.."

QUICK=0
BRANCH=""
for arg in "$@"; do
  case "$arg" in
    --quick) QUICK=1 ;;
    -h | --help)
      echo "usage: $0 [branch] [--quick]"
      exit 0
      ;;
    -*)
      echo "unknown option: $arg" >&2
      exit 1
      ;;
    *) BRANCH="$arg" ;;
  esac
done

LOG=$(mktemp)
trap 'rm -f "$LOG"' EXIT

# Collected as strings rather than arrays: macOS still ships bash 3.2, where
# an empty array under `set -u` is an unbound variable.
FAILED=""
NOTES=""

step() { printf '\n==> %s\n' "$1"; }
ok() { printf '    ok: %s\n' "$1"; }
note() {
  NOTES="${NOTES}  - $1"$'\n'
  printf '    note: %s\n' "$1"
}
fail() {
  FAILED="${FAILED}  - $1"$'\n'
  printf '    FAILED: %s\n' "$1"
}
die() {
  printf '\n%s\n' "$1" >&2
  exit 1
}

# --- toolchain ---------------------------------------------------------------

step "Checking the toolchain"
command -v node >/dev/null || die "No node on this machine. Install 22 or newer: brew install node, or nvm install 22."
NODE_MAJOR=$(node -v | sed 's/^v\([0-9]*\).*/\1/')
[ "$NODE_MAJOR" -ge 22 ] || die "node $(node -v) is too old -- package.json requires >=22."
ok "node $(node -v)"

if ! command -v pnpm >/dev/null; then
  corepack enable pnpm 2>/dev/null || die "pnpm is missing and corepack could not install it. Try: npm install -g pnpm@11"
fi
ok "pnpm $(pnpm --version)"

# --- git ---------------------------------------------------------------------

step "Fetching from origin"
git fetch --prune origin >/dev/null 2>&1 ||
  die "Could not reach origin. On a new machine this is almost always the SSH key -- check with: ssh -T git@github.com"
ok "origin reachable"

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  # Same filter as the test above: untracked files never block a fast-forward,
  # so listing them here would point at the wrong thing.
  git status --short --untracked-files=no | sed 's/^/    /'
  die "You have uncommitted changes. Commit or stash them first -- this script will not guess what to do with your work."
fi

CURRENT=$(git symbolic-ref --short HEAD 2>/dev/null) || die "Detached HEAD. Check out a branch first."
TARGET="${BRANCH:-$CURRENT}"

git rev-parse --verify --quiet "origin/$TARGET" >/dev/null ||
  die "origin has no branch called '$TARGET'. It has: $(git for-each-ref --format='%(refname:strip=3)' refs/remotes/origin | grep -v HEAD | tr '\n' ' ')"

if [ "$TARGET" != "$CURRENT" ]; then
  step "Switching to $TARGET"
  if git rev-parse --verify --quiet "refs/heads/$TARGET" >/dev/null; then
    git checkout "$TARGET" || die "Could not check out $TARGET."
  else
    git checkout -b "$TARGET" --track "origin/$TARGET" || die "Could not create $TARGET from origin/$TARGET."
  fi
fi

step "Updating $TARGET"
BEFORE=$(git rev-parse HEAD)
git merge --ff-only "origin/$TARGET" >/dev/null 2>&1 ||
  die "$TARGET has drifted from origin/$TARGET -- you have commits it doesn't, or the histories differ.
Look before you act: git log --oneline --left-right HEAD...origin/$TARGET
A script that chose between rebase and merge for you would choose wrong eventually."
AFTER=$(git rev-parse HEAD)

if [ "$BEFORE" = "$AFTER" ]; then
  ok "$TARGET was already current ($(git rev-parse --short HEAD))"
else
  ok "pulled $(git rev-list --count "$BEFORE..$AFTER") commits"
  git log --oneline "$BEFORE..$AFTER" | head -10 | sed 's/^/      /'
fi

git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1 || {
  git branch --set-upstream-to "origin/$TARGET" >/dev/null
  note "set the upstream for $TARGET, so plain 'git pull' works from now on"
}

# --- dependencies ------------------------------------------------------------

step "Installing dependencies"
# Unconditionally, and frozen like CI: pnpm is near-instant when nothing moved,
# and a lockfile that no longer matches package.json is worth finding out about
# here rather than in a red CI run.
if pnpm install --frozen-lockfile >"$LOG" 2>&1; then
  ok "node_modules in sync with the lockfile"
else
  tail -20 "$LOG" | sed 's/^/      /'
  fail "pnpm install -- if it says the lockfile is out of date, the branch is broken rather than your machine; 'pnpm install' without --frozen-lockfile gets you moving"
fi

# pnpm install already runs the `prepare` script that does this. Repeated
# because a fresh clone with a half-finished install is exactly the state that
# leaves commits unchecked until CI catches them.
if [ "$(git config core.hooksPath)" != ".githooks" ]; then
  git config core.hooksPath .githooks
  note "pointed core.hooksPath at .githooks -- commits are format/lint/typechecked again"
fi

# --- .env --------------------------------------------------------------------

step "Checking .env"
if [ ! -f .env ]; then
  cp .env.example .env
  note "created .env from .env.example"

  # Both are just random bytes, so there is nothing to look up -- but a blank
  # AUTH_SECRET stops the API booting, and the encryption key is the one value
  # in this file that cannot be regenerated once anything has been stored with
  # it. Local dev has nothing stored yet, so a fresh one is correct here.
  for KEY in AUTH_SECRET MASTER_ENCRYPTION_KEY; do
    if grep -q "^$KEY=$" .env; then
      VALUE=$(openssl rand -base64 32)
      awk -v k="$KEY" -v v="$VALUE" -F= '$1 == k { print k "=" v; next } { print }' .env >.env.tmp &&
        mv .env.tmp .env
      note "generated $KEY"
    fi
  done
  note "if your other machine has a working .env, copy that one over instead -- these secrets are new, and the Google credentials are still blank"
fi

BLANK=$(grep -E '^[A-Za-z_][A-Za-z0-9_]*=$' .env | tr -d '=' | tr '\n' ' ' | sed 's/ $//')
[ -n "$BLANK" ] && note "still empty in .env: $BLANK"

MISSING=""
for KEY in $(grep -oE '^[A-Za-z_][A-Za-z0-9_]*=' .env.example | tr -d '='); do
  grep -q "^$KEY=" .env || MISSING="$MISSING $KEY"
done
[ -n "$MISSING" ] && note ".env.example has keys your .env does not:$MISSING"

grep -q '^DATABASE_URL=.' .env || fail "DATABASE_URL is empty in .env -- migrations and the API both need it (see .env.example)"

# --- postgres ----------------------------------------------------------------

DB_UP=0
step "Starting Postgres"
if ! command -v docker >/dev/null 2>&1; then
  fail "Docker isn't installed, and it is how Postgres runs locally. OrbStack is the shortest way in: 'brew install --cask orbstack', then open it once. Docker Desktop works too, but its installer wants your password for a symlink into /usr/local/bin and rolls itself back without one. The integration tests are skipped until then."
elif ! docker info >/dev/null 2>&1; then
  fail "Docker is installed but its engine isn't running. Start it -- OrbStack or Docker Desktop, whichever this machine has -- and run this again. The integration tests are skipped without it."
else
  if pnpm -w run db:up >"$LOG" 2>&1; then
    for _ in $(seq 1 30); do
      if docker exec contexto-postgres pg_isready -U studentos >/dev/null 2>&1; then
        DB_UP=1
        break
      fi
      sleep 1
    done
    [ "$DB_UP" = 1 ] && ok "postgres accepting connections on :5432" ||
      fail "Postgres started but never became ready -- try: docker compose logs postgres"
  else
    tail -20 "$LOG" | sed 's/^/      /'
    fail "docker compose up"
  fi
fi

if [ "$DB_UP" = 1 ]; then
  step "Applying migrations"
  if pnpm -w run db:migrate >"$LOG" 2>&1; then
    ok "schema up to date"
  else
    tail -20 "$LOG" | sed 's/^/      /'
    fail "pnpm db:migrate"
  fi

  # The suite migrates this database itself, but it will not create it.
  if ! docker exec contexto-postgres psql -U studentos -tAc \
    "select 1 from pg_database where datname='contexto_test'" 2>/dev/null | grep -q 1; then
    if docker exec contexto-postgres createdb -U studentos contexto_test >"$LOG" 2>&1; then
      note "created the contexto_test database the integration tests run against"
    else
      tail -5 "$LOG" | sed 's/^/      /'
      fail "could not create contexto_test -- the integration tests will fail to connect until it exists"
    fi
  fi
fi

# --- the checks CI runs ------------------------------------------------------

check() {
  LABEL=$1
  shift
  step "$LABEL"
  if "$@" >"$LOG" 2>&1; then
    ok "$LABEL"
  else
    tail -20 "$LOG" | sed 's/^/      /'
    fail "$LABEL"
  fi
}

check "format" pnpm -w run format:check
check "lint" pnpm -w run lint
check "typecheck" pnpm -w run typecheck

if [ "$QUICK" = 1 ]; then
  note "skipped the tests and the build (--quick)"
else
  if [ "$DB_UP" = 1 ]; then
    check "test" pnpm -w run test
  else
    note "skipped the tests -- they run against a real Postgres, and there isn't one"
  fi
  check "build" pnpm -w run build
fi

# --- verdict -----------------------------------------------------------------

echo
if [ -n "$NOTES" ]; then
  echo "Worth knowing:"
  printf '%s' "$NOTES"
  echo
fi

if [ -z "$FAILED" ]; then
  echo "Good to work on. $TARGET at $(git rev-parse --short HEAD), everything checked passes."
  echo "  pnpm dev    api on :3000, web on :5173"
else
  echo "Not ready yet:"
  printf '%s' "$FAILED"
  exit 1
fi
