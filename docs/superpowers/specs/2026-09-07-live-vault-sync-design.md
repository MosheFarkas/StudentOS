# Live vault sync

A teacher posts, a school email lands, a student saves a document: within
about a minute it is in the vault and the agent can find it. The six-hourly
pass stays, but it stops paying for work nothing asked for.

## Why

The vault is refreshed by one timer in the API process, every six hours,
not on boot. Three things are wrong with that:

- **Latency.** A post made at 9am is in the vault by 3pm at best, and a
  deploy within six hours of the last one means the timer never fires.
- **Cost that does not scale with change.** Every pass fetches a year of
  school mail bodies before checking which are already imported, then spends
  two model calls per student -- course classification and user.md -- even
  when nothing changed. On a real account the mail fetch alone is eight
  minutes, all of it thrown away on a quiet pass.
- **The student cap.** A pass takes the first five students in table order
  and never rotates. A sixth student is never refreshed by the timer.

The agent's search reads notes from disk at query time, so "in the vault" and
"reachable by the agent" are the same moment. Nothing else needs rebuilding.

## The shape

One engine syncs one student. Two things ring it: a push notification from
Google, or a poll timer where push is not configured. Every job for a student
runs on that student's own serial queue, so a manual build, a slow refresh
and a live sync never write to the same vault at once. The existing build
lock stays for progress reporting only.

Two tiers:

- **Live sync**, on a doorbell. Fetches only the delta, writes and links new
  items, spends a model call only where a person's words need summarising.
- **Slow refresh**, every six hours. Everything that needs a full look:
  course classification, sweeps, page consolidation, reconciliation of
  anything the live path could have missed.

## Live sync

### Gmail

The push notification is a doorbell, not a feed. It carries a history id and
we ignore it. On the bell: one `messages.list` with the existing school
query, window `newer_than:2d`, minus ids the vault already holds as episodes.
Only those bodies are fetched. New messages go through `importMail` as today.

Why not `history.list`: it needs a stored history id that can expire, a
fallback path when it does, and a metadata fetch per message to learn the
sender. The search returns exactly the school messages in one request and
the id de-duplication already exists.

School domains come from the row, found by the slow refresh; discovery
reads hundreds of sent messages and must not run per bell.

### Classroom, via Gmail

Classroom emails the student for every post, grade and material. When a new
message is a Classroom notification and names a course the vault knows, the
live sync pulls the Classroom snapshot again -- the tools cannot fetch one
course, and the whole snapshot is sixty requests and twenty seconds -- and
imports it through `importClassroom` using the cached course verdicts. Zero
model calls. A course with no cached verdict waits for the slow refresh.

Edits, deletions and roster changes do not email. The slow refresh catches
those. A student who has turned Classroom emails off falls back to the slow
refresh for everything Classroom; nothing else about their vault changes.

### Classroom notification episodes without the model

Today every Classroom email costs one model call to summarise, although the
same announcement or assignment arrives structurally for free. The subject
states the event (`New assignment: ...`, `New announcement: ...`, `New
material: ...`, `Graded: ...`), the body names the course, the sender names
the teacher, and the code already parses all three. These episodes are
written deterministically:

- `event` from the subject, as today.
- `what`: the subject with its event prefix removed, followed by the first
  paragraph of the body up to 300 characters.
- `actor`: the teacher's name from the sender line, when the subject is a
  teacher action.
- `inCourse`: the course from the body, created if missing, as today.
- `about`: the Assignment or Material note whose title equals the subject
  remainder, when one exists.
- `keep`: true for the four events above. Automated reminders (`Reminder`,
  `Due tomorrow`, `Due today`) are not kept, which is what the model decides
  for them today.

Everything else in a school inbox -- mail written by people -- keeps the
model call. Approved as a quality trade-off: the structured import carries
the substance, and the episode's job for a Classroom notification is the
teacher link and the event.

### Drive

On the bell: one `changes.list` against the student's stored change token,
with `includeRemoved`. Trashed and removed files have their File notes
removed. Folders and shortcuts are ignored. Changed files whose modified time
matches the ledger are ignored, which makes "opened but not edited" free.
The rest are judged by the existing triage in one batch, imported additively
(a new importer mode that never removes what it was not shown), and the new
ones are read and summarised, capped at 20 per sync. Anything past the cap
is picked up by the next slow refresh.

Folder paths for changed files are resolved with `files.get` on unknown
parents, cached for the sync, at most three levels deep. The slow refresh's
full listing corrects any misfiling.

A brand new document is empty. It is judged, read, found blank and set aside
in the ledger keyed to its modified time. When content appears, the modified
time moves, it is judged again, kept and read. Two model calls for one new
document, about the same as today.

### Debounce

Bells coalesce per student: 20 seconds of quiet for Gmail, 90 for Drive,
because a student typing in Docs produces a change every few seconds. A bell
during a running sync marks it dirty so it runs once more after.

### Poll fallback

Where push is not configured, a timer rings every student's bell on an
interval, default five minutes, so the same code serves local development
and any deployment before the Console steps are done. Push and poll can both
be on; the queue makes that harmless.

## Slow refresh

Today's full pass, with these changes:

- **Mail listing skips known ids** before any body is fetched.
- **Course classification is cached** in `courses-judged.json` beside the
  Drive ledger: a rule version, a fingerprint, and the verdicts. The
  fingerprint covers the described courses (the same data the model sees),
  the year end and the school page. Matching fingerprint, same rule: reuse
  the verdicts, no call. Held verdicts (`subject: null`) are never cached.
- **user.md is skipped** when the class pages, school page, chats page,
  student name and grade are unchanged, using the `sourceHash` field class
  pages already carry.
- **Ordering and budget.** Students are ordered by last refresh, oldest and
  never-refreshed first. The pass stops starting new students after a time
  budget (default 50 minutes) instead of after five students.
- **Boot.** A pass runs three minutes after start for students whose last
  refresh is older than six hours or missing. A deploy no longer resets the
  clock.
- **Concurrency.** The timer runs each student through the same queue as
  the button and the live sync, ending today's overlap.

## Push infrastructure

No new OAuth scopes. Gmail watch needs the Gmail read scope; Drive change
watch needs the Drive read scope. Both are already granted.

- **Gmail.** `users.watch` per ready student against one Pub/Sub topic.
  Pub/Sub pushes to `POST /api/hooks/gmail?token=<secret>`; the token is
  compared in constant time. The body names the mailbox; it is mapped to a
  student by email and their bell is rung. Unknown mailbox: 204 and ignore.
- **Drive.** `changes.getStartPageToken` on first arm, then `changes.watch`
  with a per-student random channel token pointing at
  `POST /api/hooks/drive`. The handler matches channel id and token against
  the student's row and rings the bell. `sync` messages are acknowledged
  and ignored.
- **Renewal.** Both watches expire within a week. A daily job, also run at
  boot, renews anything expiring within two days and stops replaced Drive
  channels. A student who is not ready (scope missing, token refused) is
  skipped and their watch fields cleared.
- **Threat model.** A forged bell can at most trigger one extra sync that
  reads the student's own data with the student's own token. The secrets
  stop the cheap version of that.

Console steps, done once and written into `deploy/README.md`: enable the
Pub/Sub API in the existing project, create the topic, grant
`roles/pubsub.publisher` on it to `gmail-api-push@system.gserviceaccount.com`,
create a push subscription to the Gmail hook URL, and add the domain on the
Domain verification page for Drive webhooks.

## Data

One table, `vault_sync`, one row per student, keyed by user id with cascade
delete:

| column                                                                                      | purpose                                                                                       |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `drive_page_token`                                                                          | where the next `changes.list` starts                                                          |
| `drive_channel_id`, `drive_resource_id`, `drive_channel_secret`, `drive_channel_expires_at` | the live Drive channel                                                                        |
| `gmail_watch_expires_at`                                                                    | when the Gmail watch lapses                                                                   |
| `school_domains`                                                                            | the school's mail domains, found by the slow refresh so the live sync need not read sent mail |
| `last_live_sync_at`                                                                         | last completed live sync                                                                      |
| `last_refresh_at`                                                                           | last completed slow refresh, used for ordering                                                |

Index on `drive_channel_id`.

## Environment

| variable                       | meaning                                                        |
| ------------------------------ | -------------------------------------------------------------- |
| `GMAIL_PUBSUB_TOPIC`           | optional; `projects/<id>/topics/<name>`. Unset: no Gmail push. |
| `VAULT_HOOK_SECRET`            | required when the topic is set; the Gmail hook token.          |
| `VAULT_LIVE_POLL_MINUTES`      | optional; default 5; 0 disables the poll trigger.              |
| `VAULT_REFRESH_BUDGET_MINUTES` | optional; default 50.                                          |

Drive push is armed whenever `API_BASE_URL` is https and `VAULT_ROOT` is
set, since it needs nothing else.

## Cost

Model calls per event, today versus proposed:

| event                                       | today        | proposed           |
| ------------------------------------------- | ------------ | ------------------ |
| teacher posts an announcement or assignment | 1, within 6h | 0, within a minute |
| human school email                          | 1, within 6h | 1, within a minute |
| student creates a document                  | 2, within 6h | 2, within minutes  |
| nothing happens, per student per day        | 8            | 0                  |
| class page after activity                   | 1 per pass   | 1 per pass         |

Google requests on a quiet day, per student: one list per Gmail bell, one
change list per Drive bell, and the slow pass's Classroom snapshot four
times. Well inside per-user quotas.

## Failure handling

- Drive change token rejected (404 or 410): take a fresh start token, mark
  the row for reconciliation; the next slow refresh does the full listing.
- Google refuses the token: the readiness check already stops the build; the
  live sync stops the same way, and the renewal job clears the watch fields.
- Pub/Sub retries on non-2xx, so the Gmail hook answers 204 as soon as the
  bell is queued. A bad secret answers 401.
- Duplicate deliveries are harmless: ids and modified times make every
  import idempotent.
- One student's failure is logged and never stops another's.

## Not in scope

- Re-summarising a file that changed after it was first read. A file is
  read once, as today; the blank-then-filled path is the exception and
  already works through the ledger.
- Classroom push registrations, which need a new OAuth scope and cover no
  announcements.
- A "last synced" indicator in the UI.
- Moving the refresh into the worker process.

## Plumbing

`packages/agent/src/vault/`:

- `mail-query.ts`: `schoolMailQuery(domains, newerThan)` takes the window as
  a Gmail duration string.
- `collect-mail.ts`: `collectSchoolMail` gains `skip` (message ids not to
  fetch) and `newerThan`.
- `mail.ts`: a deterministic path for Classroom notifications before the
  model pool; exported for tests.
- `collect-drive.ts`: `collectDriveChanges(ctx, pageToken)` returns changed
  files with paths, removed ids and the new token.
- `drive.ts`: `importDrive` gains an additive mode; `removeDriveFiles`.
- `courses.ts`: `recallCourseVerdicts` and `rememberCourseVerdicts` with
  the fingerprint and rule version.
- `user-doc.ts`: `sourceHash` fingerprint and skip.
- `tools/google/gmail.ts`: `watchMailbox`. `tools/google/drive.ts`:
  `startPageToken`, `listChanges`, `watchChanges`, `stopChannel`.

`apps/api/src/`:

- `vault-queue.ts` (new): per-student serial queue with dirty flag.
- `vault-live.ts` (new): debounce, `liveSync(ctx, userId)`, the poll
  trigger, watch arming and renewal.
- `vault-refresh.ts`: known-id skip, cached verdicts, user.md skip,
  ordering, budget, boot pass, queue.
- `routes/hooks.ts` (new): the two webhook routes, mounted without session
  auth.
- `env.ts`: the four variables.

`packages/db/src/schema/vault-sync.ts` and its migration.
`deploy/README.md`: the Console steps and the new variables.
