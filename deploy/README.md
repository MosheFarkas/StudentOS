# Deploying Contexto

Runs at **contextoagent.ai**, on the existing droplet alongside your other
projects.

## What sharing a droplet means

This is a deliberate choice, so the tradeoff is worth stating plainly.

`MASTER_ENCRYPTION_KEY` decrypts every student's API key, and the database next
to it holds minors' calendars and coursework. On a dedicated box, only this
project can reach them. Here, that depends on everything else on the host
staying uncompromised.

What the setup does about it:

| Mitigation                                          | What it stops                                               |
| --------------------------------------------------- | ----------------------------------------------------------- |
| Dedicated `contexto` system user, no shell          | Another project's process reading app files as its own user |
| `.env` at `600`, owned by `contexto`                | The same, for the encryption key specifically               |
| Dedicated Postgres role + database                  | Another project's DB credentials reaching student data      |
| `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp` | A compromise of _this_ service reaching the rest of the box |
| `MemoryMax` on both units                           | A runaway agent loop OOMing your other sites                |

What it does not stop: **root compromise anywhere on the host.** If any project
here is exploited to root, the key is readable. Nothing configured on-box
changes that — only a separate machine does. Moving later is `pg_dump`, copy
`.env`, re-point DNS, roughly an hour.

## Prerequisites

- Node 22+, Postgres, git
- A web server already running — Caddy or nginx. Do not install a second one;
  they will fight over ports 80 and 443.
- DNS: `A` records for `contextoagent.ai` and `www` pointing at the droplet

## Port choice

The API listens on **3210**, not 3000, because 3000 is the most likely thing to
already be taken on a box running other projects. It is never exposed publicly
— the web server proxies to it on localhost.

## Steps

**1. Run setup as root**

```bash
sudo REPO=git@github.com:MosheFarkas/StudentOS.git ./deploy/setup.sh
```

Creates the user, clones to `/srv/contexto`, creates the Postgres role and
database, installs the systemd units. It prints a `DATABASE_URL` once — copy it.

**2. Write `/srv/contexto/.env`**

```bash
NODE_ENV=production
PORT=3210

DATABASE_URL=            # printed by setup.sh

API_BASE_URL=https://contextoagent.ai
WEB_BASE_URL=https://contextoagent.ai
VITE_API_BASE_URL=https://contextoagent.ai

AUTH_SECRET=             # openssl rand -base64 32
MASTER_ENCRYPTION_KEY=   # openssl rand -base64 32

GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
PLATFORM_OPENAI_API_KEY=
PLATFORM_MONTHLY_TOKEN_QUOTA=

TELEGRAM_BOT_TOKEN=
TELEGRAM_WEBHOOK_SECRET= # openssl rand -hex 32
```

All three URLs are the **same origin**. That is what removes CORS entirely and
lets session cookies work without `SameSite` workarounds.

> **Generate a fresh `MASTER_ENCRYPTION_KEY` for production — do not reuse the
> local one.** And back it up somewhere off this droplet. If it is lost, every
> stored student API key is permanently undecryptable; there is no recovery.

Then lock it down:

```bash
sudo chown contexto:contexto /srv/contexto/.env
sudo chmod 600 /srv/contexto/.env
```

**3. Web server**

Append `Caddyfile.snippet` to your Caddyfile, or install `nginx.conf.snippet`
and run certbot. Whichever you already have — not both.

**4. Allow the service user to restart its own units**

```bash
echo 'contexto ALL=(root) NOPASSWD: /bin/systemctl restart contexto-api, /bin/systemctl restart contexto-worker' \
  | sudo tee /etc/sudoers.d/contexto
sudo chmod 440 /etc/sudoers.d/contexto
```

Scoped to exactly two commands. A blanket `NOPASSWD: ALL` would hand root to
anything that compromises the app.

**5. Deploy**

```bash
sudo -u contexto /srv/contexto/deploy/deploy.sh
sudo systemctl enable --now contexto-api contexto-worker
```

**6. Google OAuth — update the existing client**

APIs & Services → Credentials → your OAuth client:

- Authorised JavaScript origins: `https://contextoagent.ai`
- Authorised redirect URIs: `https://contextoagent.ai/api/auth/callback/google`

Keep the localhost entries so local development keeps working.

**6b. Drive file reading (Google Picker)**

Needed for the agent to read file _contents_. Everything else works without
it; the Files panel in Settings just says it is not configured.

In the same Cloud project:

1. **APIs & Services → Library** — enable **Google Drive API** _and_ **Google
   Picker API**. Both. Missing either produces `accessNotConfigured`, which
   Google also uses for "your school blocked this app" — client.ts tells the
   two apart by message text so a student is not sent to their IT department
   over an unticked box here.
2. **OAuth consent screen → Data access** — add the scope
   `https://www.googleapis.com/auth/drive.file`. It is **non-sensitive**, so
   it needs no security assessment. Do not add `drive.readonly`; see
   `packages/agent/src/tools/google/scopes.ts` for why.
3. **Credentials → Create credentials → API key.** Restrict it:
   - Application restrictions → Websites → `https://contextoagent.ai/*`
   - API restrictions → Google Picker API only

Then on the droplet:

```bash
printf 'VITE_GOOGLE_PICKER_API_KEY=%s\n' "<key>" >> /srv/contexto/.env
sudo -u contexto /srv/contexto/deploy/deploy.sh   # Vite inlines it at build
```

`VITE_GOOGLE_CLIENT_ID` is set automatically from `GOOGLE_CLIENT_ID`. Both
values are public — the client id appears in every OAuth redirect, and the API
key is referrer-restricted — which is why they can be inlined into the bundle.

**6c. YouTube (optional)**

Two independent keys, both optional, both in `/srv/contexto/.env`:

```bash
YOUTUBE_API_KEY=              # Data API v3: adds description + duration
YOUTUBE_TRANSCRIPT_API_KEY=   # transcriptapi.com: adds the transcript
```

Without either, the agent still identifies a video by title and channel
through oEmbed, which needs no key.

`YOUTUBE_TRANSCRIPT_API_KEY` exists because YouTube blocks caption access from
datacenter IPs. Measured from this droplet: the watch page returns bot-walled
HTML, `timedtext` returns zero bytes, innertube `get_transcript` returns 400,
and yt-dlp fails on every player client including with curl_cffi TLS
impersonation. The block is the IP, not the client, so the only routes are a
residential proxy or a service that runs one. 100 free credits, then $5/month;
failed requests are not billed.

**6d. Residential relay on a machine at home (optional, preferred)**

Some sites -- YouTube first among them -- serve a bot wall to datacenter IPs
and the real page to a home connection. Measured from this droplet: real
Chromium with a warmed cookie session still gets "Sign in to confirm you're
not a bot" for videos a home machine fetches without trouble. The variable is
the IP, so the fix has to be an IP.

Rather than renting one, run this on a machine you already have at home. It is
a single dependency-free file. Nothing else moves: no database, no state, no
student data -- so there is nothing to lose when that machine reboots.

On the home machine, from a checkout of this repo:

```bash
export RELAY_TOKEN=$(openssl rand -hex 32)   # keep this, the droplet needs it
node apps/relay/relay.mjs
```

It binds to **127.0.0.1 only**. Expose it to the droplet with a tunnel rather
than a forwarded port -- no inbound firewall rule, and no dependence on a home
IP that changes:

```bash
brew install cloudflared
cloudflared tunnel --url http://127.0.0.1:8787
```

Then on the droplet:

```bash
RELAY_URL=https://<your-tunnel-hostname>
RELAY_TOKEN=<the same token>
```

Keep it running across reboots with a launchd agent (`~/Library/LaunchAgents`).

The relay refuses private, loopback and link-local addresses **after resolving
them**, so a hostname pointing at `192.168.1.1` is refused just as a literal
is. That check is what stops a relay on a home network becoming a window onto
the house; `apps/relay/relay.test.mjs` covers it.

**6e. Residential proxy (optional, alternative)**

```bash
RESIDENTIAL_PROXY_URL=http://user:pass@gate.provider.com:7777
```

A second way out of the network, for hosts that serve a bot wall to cloud IPs
and the real page to a home connection. Not YouTube-specific -- `web_read_link`
retries 403 and 429 through it too.

Only reached when a direct request was refused, so the bill tracks the
blocking rather than the traffic. At a few dozen videos a month that is cents:
residential providers charge roughly $1.75-4 per GB and a watch page is about
1MB. Any provider works; it takes a standard proxy URL.

Why it is needed at all, measured from this droplet: real Chromium executing
JavaScript, with a warmed cookie session and consent accepted, still gets
"Sign in to confirm you're not a bot" for videos that a residential machine
fetches without trouble. The variable is the IP, so the fix has to be an IP.

**7. Telegram webhook**

```bash
curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://contextoagent.ai/api/channels/telegram/webhook",
       "secret_token":"<TELEGRAM_WEBHOOK_SECRET>",
       "allowed_updates":["message"]}'
```

Verify: `curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"` — check
`pending_update_count` is 0 and `last_error_message` is absent.

## Subsequent deploys

```bash
sudo -u contexto /srv/contexto/deploy/deploy.sh
```

Pull, install, **migrate, then build, then restart** — in that order. Migrating
after the restart leaves a window where new code queries columns that do not
exist yet.

## Debugging

```bash
journalctl -u contexto-api -f
journalctl -u contexto-worker -f
sudo -u contexto psql "$DATABASE_URL" -c '\dt'
curl -s localhost:3210/api/health
```

## Not set up here

No automated backups. `pg_dump` on a cron to somewhere off this droplet is the
minimum before real students use it — a database of student data with no backup
is one bad migration from gone.
