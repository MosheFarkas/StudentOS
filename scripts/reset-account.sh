#!/bin/bash
#
# Return one account to the state of a student who has never used the product.
#
# Deletes the user row and everything hanging off it, and REVOKES the Google
# grant. The revoke is the part that matters for testing: without it, signing
# in again silently re-approves every scope, because Google remembers the
# earlier consent -- so you would never see the screen a new student sees.
#
#   ./scripts/reset-account.sh lyliu@wearelcc.ca
#
# Backs up first, always. Irreversible otherwise, and the one thing worse
# than losing a test account is losing the wrong one.
set -euo pipefail

EMAIL="${1:-}"
REMOTE="${CONTEXTO_HOST:-root@165.227.196.124}"

if [[ -z "$EMAIL" ]]; then
  echo "usage: $0 <email>" >&2
  echo "  no default on purpose: this deletes an account, and a default is how" >&2
  echo "  you delete the wrong one." >&2
  exit 1
fi

ssh -o ConnectTimeout=20 "$REMOTE" 'bash -s' <<REMOTE_SCRIPT
set -euo pipefail
EMAIL='$EMAIL'
DB=\$(grep '^DATABASE_URL=' /srv/contexto/.env | cut -d= -f2-)
CID=\$(grep '^GOOGLE_CLIENT_ID=' /srv/contexto/.env | cut -d= -f2-)
CS=\$(grep '^GOOGLE_CLIENT_SECRET=' /srv/contexto/.env | cut -d= -f2-)

UID_=\$(psql "\$DB" -tAc "select id from \"user\" where email='\$EMAIL'")
if [[ -z "\$UID_" ]]; then
  echo "No account for \$EMAIL -- already clean, or the address is wrong."
  exit 0
fi

UNLIMITED=\$(psql "\$DB" -tAc "select unlimited_usage from \"user\" where id='\$UID_'")
echo "==> Found \$EMAIL (\$UID_)"

echo "==> What is about to go"
psql "\$DB" -tAc "
select 'agents:'         || count(*) from agents where user_id='\$UID_'
union all select 'messages:'  || count(*) from agent_messages m join agents a on a.id=m.agent_id where a.user_id='\$UID_'
union all select 'memories:'  || count(*) from agent_memories x join agents a on a.id=x.agent_id where a.user_id='\$UID_'
union all select 'usage:'     || count(*) from llm_usage where user_id='\$UID_'
union all select 'sessions:'  || count(*) from session where user_id='\$UID_'
union all select 'oauth:'     || count(*) from account where user_id='\$UID_'
" | sed 's/^/    /'

STAMP=\$(date +%Y%m%d-%H%M%S)
OUT=/srv/contexto/backups
mkdir -p "\$OUT"
echo "==> Backing up"
pg_dump "\$DB" --data-only --no-owner \
  -t agents -t agent_messages -t agent_memories -t agent_memory_summaries -t agent_skills \
  -t account -t llm_credentials -t llm_usage -t channel_links -t disabled_integrations -t '"user"' \
  -f "\$OUT/reset-\$EMAIL-\$STAMP.sql"
chown contexto:contexto "\$OUT"/*.sql 2>/dev/null || true
chmod 600 "\$OUT"/*.sql 2>/dev/null || true
echo "    \$OUT/reset-\$EMAIL-\$STAMP.sql"

# Revoking is what makes the next sign-in show a real consent screen.
RT=\$(psql "\$DB" -tAc "select refresh_token from account where user_id='\$UID_' and provider_id='google' limit 1")
if [[ -n "\$RT" ]]; then
  CODE=\$(curl -s -o /dev/null -w '%{http_code}' -X POST https://oauth2.googleapis.com/revoke -d "token=\$RT")
  echo "==> Revoked the Google grant (HTTP \$CODE)"
else
  echo "==> No Google grant stored"
fi

echo "==> Deleting"
psql "\$DB" -q -v ON_ERROR_STOP=1 <<SQL
BEGIN;
DELETE FROM agent_memory_summaries s USING agents a WHERE s.agent_id=a.id AND a.user_id='\$UID_';
DELETE FROM agent_memories   m USING agents a WHERE m.agent_id=a.id AND a.user_id='\$UID_';
DELETE FROM agent_messages   g USING agents a WHERE g.agent_id=a.id AND a.user_id='\$UID_';
DELETE FROM agent_skills     k USING agents a WHERE k.agent_id=a.id AND a.user_id='\$UID_';
DELETE FROM agents            WHERE user_id='\$UID_';
DELETE FROM channel_links     WHERE user_id='\$UID_';
DELETE FROM disabled_integrations WHERE user_id='\$UID_';
DELETE FROM llm_credentials   WHERE user_id='\$UID_';
DELETE FROM llm_usage         WHERE user_id='\$UID_';
DELETE FROM session           WHERE user_id='\$UID_';
DELETE FROM account           WHERE user_id='\$UID_';
DELETE FROM "user"            WHERE id='\$UID_';
COMMIT;
SQL

REMAINING=\$(psql "\$DB" -tAc "select count(*) from \"user\" where email='\$EMAIL'")
echo "==> Done. user rows for \$EMAIL: \$REMAINING"
echo
echo "    Sign in at https://contextoagent.ai for a genuine first run:"
echo "    consent screen, no agents, nothing connected."
if [[ "\$UNLIMITED" == "t" ]]; then
  echo
  echo "    NOTE: this account had unlimited usage, which died with the row."
  echo "    After signing back in, restore it with:"
  echo "      psql \"\\\$DATABASE_URL\" -c \"update \\\"user\\\" set unlimited_usage=true where email='\$EMAIL'\""
fi
REMOTE_SCRIPT
