# Live Vault Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** New school mail, Classroom posts and Drive files reach the vault within about a minute, and the six-hourly pass stops paying for work nothing asked for.

**Architecture:** One engine (`liveSync`) syncs one student from a delta: a two-day Gmail search minus known ids, a Drive change list against a stored token, and a Classroom re-pull when a notification arrives. Two triggers ring it: Google push (Pub/Sub for Gmail, a webhook channel for Drive) or a poll timer. Every job for a student runs on that student's serial queue. The slow refresh keeps its shape but skips known mail, caches course verdicts, skips an unchanged user.md, orders students by staleness under a time budget, and runs shortly after boot.

**Tech Stack:** TypeScript (ESM), pnpm workspace, Hono, Drizzle + Postgres, Vitest, Google Gmail/Drive/Classroom REST APIs via the existing `googleFetch`.

**Spec:** `docs/superpowers/specs/2026-09-07-live-vault-sync-design.md`

## Global Constraints

- No new OAuth scopes. Gmail watch uses the Gmail read scope; Drive change watch uses `drive.readonly`.
- Model calls only where a person's words need summarising. Classroom notification emails never reach the model.
- Debounce: Gmail 20 s, Drive 90 s. Live file-read cap: 20 per sync. Slow refresh cap stays 40.
- Defaults: `VAULT_LIVE_POLL_MINUTES` 5 (0 disables), `VAULT_REFRESH_BUDGET_MINUTES` 50, boot pass after 3 minutes, slow interval 6 hours unchanged.
- Every commit passes `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test` (the pre-commit hook enforces formatting).
- Commit messages follow the repo's style: one sentence saying what changed and why, no conventional-commit prefix. End with the Co-Authored-By and Claude-Session trailers used on this branch.
- Deviations from the spec, already decided: the Classroom re-pull fetches the full snapshot (the Classroom tools cannot fetch one course); school domains are cached in `vault_sync` by the slow refresh because discovery reads hundreds of sent messages.

## File structure

New:

- `packages/db/src/schema/vault-sync.ts` — the `vault_sync` table.
- `packages/db/migrations/0015_*.sql` — generated.
- `apps/api/src/vault-sync-state.ts` — read/upsert helpers for `vault_sync`.
- `apps/api/src/vault-queue.ts` — `StudentQueue`, serial per student.
- `apps/api/src/vault-live.ts` — `Bells` (debounce), `liveSync`, `armWatches`, `startVaultLive`.
- `apps/api/src/routes/hooks.ts` — `/hooks/gmail`, `/hooks/drive`.
- Tests beside each: `*.test.ts` (unit) and `*.integration.test.ts` (Postgres via `test-support/harness.ts`).

Modified:

- `packages/agent/src/vault/mail-query.ts` — window as a Gmail duration string.
- `packages/agent/src/vault/collect-mail.ts` — `newerThan`, `skip`.
- `packages/agent/src/vault/mail.ts` — `classroomEpisode`, used before the model pool.
- `packages/agent/src/vault/collect-drive.ts` — `collectDriveChanges`, shared `toDriveFile`.
- `packages/agent/src/vault/drive.ts` — `removeDriveFiles`.
- `packages/agent/src/vault/files.ts` — `only` option on `readFileContents`.
- `packages/agent/src/vault/courses.ts` — verdict ledger.
- `packages/agent/src/vault/user-doc.ts` — fingerprint skip.
- `packages/agent/src/tools/google/drive.ts` — `startPageToken`, `listChanges`, `watchChanges`, `stopChannel`, `fileMeta`, `trashed` on `DriveFileMeta`.
- `packages/agent/src/tools/google/gmail.ts` — `watchMailbox`.
- `packages/agent/src/index.ts` — exports.
- `apps/api/src/env.ts`, `apps/api/src/index.ts`, `apps/api/src/routes/index.ts`, `apps/api/src/vault-build.ts`, `apps/api/src/vault-refresh.ts`, `apps/api/src/vault-refresh.test.ts`.
- `deploy/README.md`, `.env.example`.

---

### Task 1: Mail window as a duration, and ids the collector must not fetch

**Files:**

- Modify: `packages/agent/src/vault/mail-query.ts:32-40`
- Modify: `packages/agent/src/vault/collect-mail.ts` (options, `collectSchoolMail`)
- Modify: `packages/agent/src/vault/mail-query.test.ts` (existing calls)
- Create: `packages/agent/src/vault/collect-mail.test.ts`

**Interfaces:**

- Produces: `schoolMailQuery(domains: string[], newerThan: string): string` where `newerThan` is a Gmail duration such as `'12m'` or `'2d'`.
- Produces: `MailCollectionOptions` gains `newerThan?: string` (precedence over `months`) and `skip?: ReadonlySet<string>`; `CollectedMail` gains `known: number` (ids skipped because the vault has them).

- [ ] **Step 1: Change `schoolMailQuery` to take a duration string**

In `mail-query.ts` replace the function:

```ts
export function schoolMailQuery(domains: string[], newerThan: string): string {
  const from = [
    ...domains.map((domain) => `from:${domain}`),
    `from:${CLASSROOM_NOTIFICATIONS}`,
  ].join(' OR ');
  // Parenthesised because Gmail binds OR tighter than the implicit AND, and
  // without them `newer_than` would apply to the last domain alone.
  return `(${from}) newer_than:${newerThan} -in:spam -in:trash`;
}
```

Then `grep -n "schoolMailQuery(" packages/agent/src -r` and change every numeric second argument `12` to `'12m'` (tests included). Run `pnpm test packages/agent/src/vault/mail-query.test.ts` — expected PASS.

- [ ] **Step 2: Write the failing collector test**

Create `packages/agent/src/vault/collect-mail.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../tools/types.js';
import { collectSchoolMail } from './collect-mail.js';

/**
 * The collector fetches only what the vault lacks.
 *
 * Every pass used to fetch a year of bodies and then throw most of them away
 * once the importer saw the ids were already episodes. Eight minutes a pass
 * on a real inbox, all of it for nothing on a quiet day.
 */

const ctx = {
  userId: 'u',
  agentId: 'u',
  google: { getAccessToken: async () => 'token', hasScope: () => true },
} as unknown as ToolContext;

function gmail(listed: string[]) {
  return vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url.includes('/messages?')) {
      return new Response(JSON.stringify({ messages: listed.map((id) => ({ id })) }));
    }
    const id = url.match(/\/messages\/([^?]+)/)?.[1] ?? '';
    return new Response(
      JSON.stringify({
        id,
        payload: {
          headers: [
            { name: 'From', value: 'Teacher <t@school.org>' },
            { name: 'Subject', value: `about ${id}` },
            { name: 'Date', value: 'Mon, 1 Sep 2026 09:00:00 +0000' },
          ],
          body: { data: Buffer.from('hello').toString('base64url') },
        },
      }),
    );
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('collecting school mail', () => {
  it('does not fetch a body the vault already holds', async () => {
    const fetch = gmail(['a', 'b', 'c']);
    vi.stubGlobal('fetch', fetch);

    const found = await collectSchoolMail(ctx, {
      domains: ['school.org'],
      newerThan: '2d',
      skip: new Set(['a', 'c']),
    });

    const fetched = fetch.mock.calls.map(([url]) => String(url));
    expect(fetched.some((url) => url.includes('/messages/b?'))).toBe(true);
    expect(fetched.some((url) => url.includes('/messages/a?'))).toBe(false);
    expect(fetched.some((url) => url.includes('/messages/c?'))).toBe(false);
    expect(found.found).toBe(3);
    expect(found.known).toBe(2);
    expect(found.messages.map((m) => m.messageId)).toEqual(['b']);
  });

  it('asks for the window it was given', async () => {
    const fetch = gmail([]);
    vi.stubGlobal('fetch', fetch);
    await collectSchoolMail(ctx, { domains: ['school.org'], newerThan: '2d' });
    expect(decodeURIComponent(String(fetch.mock.calls[0]?.[0]))).toContain('newer_than:2d');
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `pnpm test packages/agent/src/vault/collect-mail.test.ts`
Expected: FAIL — `newerThan`/`skip` unknown, `known` undefined.

- [ ] **Step 4: Implement the options**

In `collect-mail.ts`:

```ts
export interface MailCollectionOptions {
  /** Every domain the school uses. See discoverSchoolDomains. */
  domains: string[];
  /** How far back to look, in months. */
  months?: number;
  /** How far back to look, as a Gmail duration such as `2d`. Wins over months. */
  newerThan?: string;
  /** Ceiling on ids listed, for an inbox far outside the ordinary. */
  maxIds?: number;
  /**
   * Message ids not to fetch, because the vault already holds them.
   *
   * The listing is two requests; the bodies were six hundred. Skipping here
   * rather than in the importer is the whole difference.
   */
  skip?: ReadonlySet<string>;
}

export interface CollectedMail {
  messages: SchoolMessage[];
  /** How many ids were listed, so a truncated fetch is visible. */
  found: number;
  /** How many of those the vault already had, and so were not fetched. */
  known: number;
  /** True when listing stopped at the ceiling, so the result is incomplete. */
  hitCeiling: boolean;
  skipped: string[];
}
```

In `collectSchoolMail`: build the query with `schoolMailQuery(options.domains, options.newerThan ?? `${options.months ?? 12}m`)`; add `known: 0` to both early returns; in the fetch loop, before `let full`, add:

```ts
if (options.skip?.has(messageId)) {
  known += 1;
  continue;
}
```

with `let known = 0;` declared beside `messages`, and return `{ messages, found: ids.length, known, hitCeiling, skipped }`.

- [ ] **Step 5: Run tests**

Run: `pnpm test packages/agent/src/vault` — expected PASS. Run `pnpm typecheck` — expected clean (fix any `known` omissions the compiler names).

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/vault/mail-query.ts packages/agent/src/vault/mail-query.test.ts packages/agent/src/vault/collect-mail.ts packages/agent/src/vault/collect-mail.test.ts
git commit -m "Fetch only the mail the vault does not already hold"
```

---

### Task 2: Classroom notifications become episodes without the model

**Files:**

- Modify: `packages/agent/src/vault/mail.ts` (new export `classroomEpisode`; use it in `extractAndWrite`)
- Modify: `packages/agent/src/vault/mail.test.ts`
- Modify: `packages/agent/src/index.ts` (export `classroomEpisode`)

**Interfaces:**

- Produces: `classroomEpisode(message: SchoolMessage): Extraction | null` where `Extraction` is the existing zod `extraction` inferred type. Null for mail that is not from `no-reply@classroom.google.com`. For Classroom mail whose subject names no known event, returns `{ keep: false, ... }`.

- [ ] **Step 1: Write the failing tests**

Append to `mail.test.ts` (reuse its existing temp-vault helpers if present; otherwise create a vault with `new Vault(await mkdtemp(join(tmpdir(), 'v-')), 'u')`):

```ts
describe('Classroom notifications without a model', () => {
  const notification = {
    messageId: 'm1',
    from: 'Stacey Ottley (Classroom) <no-reply@classroom.google.com>',
    subject: 'New assignment: Titration lab writeup',
    date: 'Tue, 2 Sep 2026 10:00:00 +0000',
    body: [
      'Hi Lucas,',
      '',
      'Stacey Ottley posted a new assignment in 10 Chemistry',
      '',
      '10 Chemistry',
      'https://classroom.google.com/c/abc',
      '',
      'Titration lab writeup',
      'Due Friday. Include your raw data table.',
    ].join('\n'),
  };

  it('reads the event, the teacher and the course from the notification itself', () => {
    const said = classroomEpisode(notification);
    expect(said).not.toBeNull();
    expect(said?.keep).toBe(true);
    expect(said?.event).toBe('assignment-posted');
    expect(said?.actor).toBe('Stacey Ottley');
    expect(said?.inCourse).toEqual(['10-chemistry']);
    expect(said?.about).toEqual(['titration-lab-writeup']);
    expect(said?.what).toContain('Titration lab writeup');
  });

  it('keeps nothing for a reminder', () => {
    const said = classroomEpisode({
      ...notification,
      subject: 'Reminder: Titration lab writeup is due tomorrow',
    });
    expect(said?.keep).toBe(false);
  });

  it("leaves a teacher's own email to the model", () => {
    expect(
      classroomEpisode({ ...notification, from: 'Stacey Ottley <ottley@school.org>' }),
    ).toBeNull();
  });

  it('writes the episode without asking the model', async () => {
    const vault = await freshVault();
    const llm = {
      chat: vi.fn(async () => {
        throw new Error('the model must not be asked');
      }),
    };
    const result = await importMail(
      { llm },
      { vault, messages: [notification], entities: [], userId: 'u', domains: ['school.org'] },
    );
    expect(llm.chat).not.toHaveBeenCalled();
    expect(result.written).toBe(1);
    const [episode] = await vault.list('episode');
    expect(episode?.event).toBe('assignment-posted');
    expect(episode?.actor).toBe('Stacey Ottley');
    expect(episode?.body).toContain('In [[10-chemistry]]');
  });
});
```

Import `classroomEpisode` and `importMail` from `./mail.js`, `vi` from vitest.

- [ ] **Step 2: Run to see failure**

Run: `pnpm test packages/agent/src/vault/mail.test.ts` — expected FAIL, `classroomEpisode` is not exported.

- [ ] **Step 3: Implement**

In `mail.ts`, after `classroomCourse`, add:

```ts
/** The event prefix Classroom puts on a subject, so the rest is the thing itself. */
const EVENT_PREFIX =
  /^(?:re:\s*)?(?:new (?:assignment|announcement|material|question)|graded)\s*[:\-–—]?\s*/i;

/**
 * What a Classroom notification says, read off the notification.
 *
 * Every one of these used to cost a model call, although the announcement or
 * assignment it announces arrives structurally through the Classroom import
 * for nothing. The subject states the event, the body names the course, the
 * sender names the teacher, and all three parsers already exist. So these
 * episodes are written from those, and the model is kept for mail a person
 * wrote. Reminders and comments keep nothing, which is what the model decided
 * for them anyway.
 *
 * Null for anything not from Classroom's own address.
 */
export function classroomEpisode(message: SchoolMessage): z.infer<typeof extraction> | null {
  const { address } = parseSender(message.from);
  if (address !== CLASSROOM_NOTIFICATIONS) return null;

  const event = classroomEvent(message.subject);
  if (!event) return { keep: false, what: '', actor: '', event: 'other', about: [], inCourse: [] };

  const remainder = message.subject.trim().replace(EVENT_PREFIX, '').trim();
  const course = classroomCourse(message.body);
  const paragraph =
    message.body
      .split(/\n\s*\n/)
      .map((part) => part.trim())
      .find(
        (part) =>
          part !== '' &&
          !/https?:\/\//.test(part) &&
          part !== course &&
          part.toLowerCase() !== remainder.toLowerCase() &&
          !/^hi\b|^hello\b/i.test(part) &&
          !/posted a new|graded your/i.test(part),
      ) ?? '';
  const what = [remainder, paragraph].filter(Boolean).join('. ').slice(0, 300) || message.subject;

  return {
    keep: true,
    what,
    actor: classroomSender(message.from, message.subject) ?? '',
    event,
    about: remainder ? [slugForNote(remainder)] : [],
    inCourse: course ? [slugForNote(course)] : [],
  };
}
```

`classroomEvent` returns an `EpisodeEvent`; the extraction schema's `event` is the `EVENTS` enum. Both contain the four values `classroomEvent` produces, so assign with `event as (typeof EVENTS)[number]` if the compiler objects.

In `extractAndWrite`, change the pooled callback so a known notification never reaches the model:

```ts
    const extracted = await pooled(batch, EXTRACT_CONCURRENCY, async (message) => {
      const known = classroomEpisode(message);
      if (known) {
        seen += 1;
        onProgress?.(seen, pending.length);
        return { message, parsed: known };
      }
      try {
        // ... existing llm.chat block unchanged ...
```

The write loop already filters `about` and `inCourse` against `allowed` and already adds the course from `classroomCourse` for Classroom senders, so a course the vault has not seen still gets its note.

- [ ] **Step 4: Export and run**

Add to `packages/agent/src/index.ts`: `export { importMail, classroomEpisode, type SchoolMessage, type MailImportResult } from './vault/mail.js';` (replacing the existing `importMail` line).

Run: `pnpm test packages/agent/src/vault/mail.test.ts` — expected PASS. Run `pnpm typecheck`.

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/vault/mail.ts packages/agent/src/vault/mail.test.ts packages/agent/src/index.ts
git commit -m "Classroom's own notifications are written from what they say, not from a model"
```

---

### Task 3: Drive change listing, and the tool calls it needs

**Files:**

- Modify: `packages/agent/src/tools/google/drive.ts` (add `trashed` to `DriveFileMeta`; add `fileMeta`, `startPageToken`, `listChanges`, `watchChanges`, `stopChannel`)
- Modify: `packages/agent/src/vault/collect-drive.ts` (extract `toDriveFile`; add `collectDriveChanges`)
- Create: `packages/agent/src/vault/collect-drive.test.ts`
- Modify: `packages/agent/src/index.ts`

**Interfaces:**

- Produces (tools): `startPageToken(token): Promise<string | ToolUnavailable>`; `listChanges(token, pageToken): Promise<{ changes: DriveChange[]; newStartPageToken: string } | ToolUnavailable>`; `watchChanges(token, pageToken, channel: { id: string; address: string; token: string; expiresAt: number }): Promise<{ resourceId: string; expiration: string } | ToolUnavailable>`; `stopChannel(token, channel: { id: string; resourceId: string }): Promise<void>`; `fileMeta(token, fileId): Promise<DriveFileMeta | ToolUnavailable>`.
- Produces (vault): `collectDriveChanges(ctx: ToolContext, pageToken: string): Promise<DriveChanges | ToolUnavailable>` with `DriveChanges = { changed: DriveFile[]; removed: string[]; pageToken: string }`.

- [ ] **Step 1: Write the failing test**

Create `collect-drive.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../tools/types.js';
import { isUnavailable } from '../tools/google/client.js';
import { collectDriveChanges } from './collect-drive.js';

const ctx = {
  userId: 'u',
  agentId: 'u',
  google: { getAccessToken: async () => 'token', hasScope: () => true },
} as unknown as ToolContext;

afterEach(() => vi.unstubAllGlobals());

describe('collecting what changed in a Drive', () => {
  it('turns a change list into new files with paths, and ids that are gone', async () => {
    const fetch = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/changes?')) {
        return new Response(
          JSON.stringify({
            newStartPageToken: '901',
            changes: [
              {
                fileId: 'doc1',
                removed: false,
                file: {
                  id: 'doc1',
                  name: 'Chair project',
                  mimeType: 'application/vnd.google-apps.document',
                  parents: ['folder1'],
                  ownedByMe: true,
                  modifiedTime: '2026-09-07T10:00:00Z',
                },
              },
              { fileId: 'gone1', removed: true },
              {
                fileId: 'bin1',
                removed: false,
                file: { id: 'bin1', name: 'old', mimeType: 'application/pdf', trashed: true },
              },
              {
                fileId: 'folder1',
                removed: false,
                file: {
                  id: 'folder1',
                  name: 'Design 10',
                  mimeType: 'application/vnd.google-apps.folder',
                },
              },
            ],
          }),
        );
      }
      if (url.includes('/files/folder1?')) {
        return new Response(
          JSON.stringify({
            id: 'folder1',
            name: 'Design 10',
            mimeType: 'application/vnd.google-apps.folder',
          }),
        );
      }
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal('fetch', fetch);

    const changes = await collectDriveChanges(ctx, '900');
    if (isUnavailable(changes)) throw new Error(changes.reason);

    expect(changes.pageToken).toBe('901');
    expect(changes.removed.sort()).toEqual(['bin1', 'gone1']);
    expect(changes.changed).toHaveLength(1);
    expect(changes.changed[0]).toMatchObject({
      fileId: 'doc1',
      name: 'Chair project',
      ownedByStudent: true,
      path: ['Design 10'],
      modifiedAt: '2026-09-07T10:00:00Z',
    });
    expect(String(fetch.mock.calls[0]?.[0])).toContain('pageToken=900');
    expect(String(fetch.mock.calls[0]?.[0])).toContain('includeRemoved=true');
  });

  it('reports Drive being unavailable rather than inventing an empty change', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 404 })),
    );
    const changes = await collectDriveChanges(ctx, 'stale');
    expect(isUnavailable(changes)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `pnpm test packages/agent/src/vault/collect-drive.test.ts` — FAIL, no `collectDriveChanges`.

- [ ] **Step 3: Add the tool functions**

In `tools/google/drive.ts`, add `trashed?: boolean;` to `DriveFileMeta`. Find the constant that holds `https://www.googleapis.com/drive/v3/files` (`FILES_URL`) and add beside it `const CHANGES_URL = 'https://www.googleapis.com/drive/v3/changes';` and `const CHANNELS_URL = 'https://www.googleapis.com/drive/v3/channels';`. Then append:

```ts
/** One file's listing fields, for a change that arrives without its folder. */
export async function fileMeta(
  token: string,
  fileId: string,
): Promise<DriveFileMeta | ToolUnavailable> {
  return googleFetch<DriveFileMeta>(
    `${FILES_URL}/${encodeURIComponent(fileId)}?fields=id,name,mimeType,parents&supportsAllDrives=true`,
    token,
  );
}

/**
 * Where the change feed starts for a Drive nothing has watched yet.
 *
 * Everything before this token is the full listing's business; everything
 * after it arrives through listChanges, deletions included.
 */
export async function startPageToken(token: string): Promise<string | ToolUnavailable> {
  const result = await googleFetch<{ startPageToken?: string }>(
    `${CHANGES_URL}/startPageToken?supportsAllDrives=true`,
    token,
  );
  if (isUnavailable(result)) return result;
  return result.startPageToken ?? '';
}

export interface DriveChange {
  fileId: string;
  removed: boolean;
  file?: DriveFileMeta;
}

const CHANGE_FIELDS =
  'nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType,parents,' +
  'ownedByMe,modifiedTime,webViewLink,trashed,owners(displayName,emailAddress)))';

/** Everything that changed since the token, and the token for next time. */
export async function listChanges(
  token: string,
  pageToken: string,
): Promise<{ changes: DriveChange[]; newStartPageToken: string } | ToolUnavailable> {
  const changes: DriveChange[] = [];
  let at = pageToken;
  for (;;) {
    const params = new URLSearchParams({
      pageToken: at,
      pageSize: '1000',
      includeRemoved: 'true',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
      fields: CHANGE_FIELDS,
    });
    const page = await googleFetch<{
      changes?: DriveChange[];
      nextPageToken?: string;
      newStartPageToken?: string;
    }>(`${CHANGES_URL}?${params.toString()}`, token);
    if (isUnavailable(page)) return page;
    changes.push(...(page.changes ?? []));
    if (page.nextPageToken) {
      at = page.nextPageToken;
      continue;
    }
    return { changes, newStartPageToken: page.newStartPageToken ?? at };
  }
}

/** Ask Drive to POST to `address` whenever anything changes. Expires within a week. */
export async function watchChanges(
  token: string,
  pageToken: string,
  channel: { id: string; address: string; token: string; expiresAt: number },
): Promise<{ resourceId: string; expiration: string } | ToolUnavailable> {
  const params = new URLSearchParams({
    pageToken,
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
  });
  return googleFetch<{ resourceId: string; expiration: string }>(
    `${CHANGES_URL}/watch?${params.toString()}`,
    token,
    {
      method: 'POST',
      body: {
        id: channel.id,
        type: 'web_hook',
        address: channel.address,
        token: channel.token,
        expiration: String(channel.expiresAt),
      },
    },
  );
}

/** Stop a channel that has been replaced. Failure is not worth reporting. */
export async function stopChannel(
  token: string,
  channel: { id: string; resourceId: string },
): Promise<void> {
  await googleFetch(`${CHANNELS_URL}/stop`, token, {
    method: 'POST',
    body: { id: channel.id, resourceId: channel.resourceId },
  });
}
```

Import `ToolUnavailable` from `'../types.js'` if the file does not already.

- [ ] **Step 4: Add the collector**

In `collect-drive.ts`, pull the per-file mapping out of `collectDriveFiles` into a function both paths use:

```ts
/** A listing row as the importer wants it, with the folder path already resolved. */
export function toDriveFile(file: DriveFileMeta, path: string[]): DriveFile {
  return {
    fileId: file.id,
    name: file.name ?? 'Untitled',
    mimeType: file.mimeType ?? '',
    ownedByStudent: file.ownedByMe ?? false,
    ...(file.ownedByMe
      ? {}
      : (() => {
          const owner = file.owners?.[0];
          const named = owner?.displayName ?? owner?.emailAddress;
          return named ? { owner: named } : {};
        })()),
    ...(file.modifiedTime ? { modifiedAt: file.modifiedTime } : {}),
    ...(file.webViewLink ? { link: file.webViewLink } : {}),
    ...(path.length > 0 ? { path } : {}),
  };
}
```

and make `collectDriveFiles` end with `return files.map((file) => toDriveFile(file, pathOf(file)));`. Keep the existing comments above the owner logic by moving them with it.

Then add:

```ts
export interface DriveChanges {
  /** Files created or changed, folders and shortcuts left out. */
  changed: DriveFile[];
  /** Ids of files deleted or trashed. */
  removed: string[];
  /** Where the next call starts. */
  pageToken: string;
}

/** Folders looked up for one batch of changes. Deeper than this is the full listing's job. */
const CHANGE_DEPTH = 3;

/**
 * What changed since the last token, for the live sync.
 *
 * A change arrives with parent ids and no names, so the folders a changed
 * file sits in are fetched one at a time and cached for the batch. The full
 * listing on the slow refresh corrects anything this misfiles.
 */
export async function collectDriveChanges(
  ctx: ToolContext,
  pageToken: string,
): Promise<DriveChanges | ToolUnavailable> {
  const token = await ctx.google?.getAccessToken('drive');
  if (!token) return unavailable('Google Drive is not connected.');

  const listed = await listChanges(token, pageToken);
  if (isUnavailable(listed)) return listed;

  const removed: string[] = [];
  const metas: DriveFileMeta[] = [];
  for (const change of listed.changes) {
    if (change.removed || change.file?.trashed) removed.push(change.fileId);
    else if (change.file && change.file.mimeType !== FOLDER) metas.push(change.file);
  }

  const folders = new Map<string, DriveFileMeta | null>();
  const folder = async (id: string): Promise<DriveFileMeta | null> => {
    if (folders.has(id)) return folders.get(id) ?? null;
    const meta = await fileMeta(token, id);
    const found = isUnavailable(meta) ? null : meta;
    folders.set(id, found);
    return found;
  };
  const pathOf = async (file: DriveFileMeta): Promise<string[]> => {
    const parts: string[] = [];
    let at = file.parents?.[0];
    for (let depth = 0; depth < CHANGE_DEPTH && at; depth += 1) {
      const parent = await folder(at);
      if (!parent) break;
      parts.unshift(parent.name ?? '');
      at = parent.parents?.[0];
    }
    return parts;
  };

  const changed: DriveFile[] = [];
  for (const meta of metas) changed.push(toDriveFile(meta, await pathOf(meta)));

  return { changed, removed, pageToken: listed.newStartPageToken };
}
```

Imports: `import { fileMeta, listAllDriveFiles, listChanges, type DriveFileMeta } from '../tools/google/drive.js';`, `import { unavailable, type ToolUnavailable } from '../tools/types.js';`.

- [ ] **Step 5: Export and verify**

Add to `packages/agent/src/index.ts`: export `collectDriveChanges`, `type DriveChanges` from `./vault/collect-drive.js` (extend the existing line if one exports `collectDriveFiles`), and `startPageToken, watchChanges, stopChannel, listChanges` from `./tools/google/drive.js` (find the existing drive tool export line and extend it). Also export `isUnavailable` from `./tools/google/client.js` if not already exported.

Run: `pnpm test packages/agent/src/vault/collect-drive.test.ts packages/agent/src/vault/drive.test.ts` — PASS. `pnpm typecheck` — clean.

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/tools/google/drive.ts packages/agent/src/vault/collect-drive.ts packages/agent/src/vault/collect-drive.test.ts packages/agent/src/index.ts
git commit -m "Ask Drive what changed, not for everything again"
```

---

### Task 4: Take a deleted Drive file out, and read only the files a sync brought in

**Files:**

- Modify: `packages/agent/src/vault/drive.ts` (add `removeDriveFiles`)
- Modify: `packages/agent/src/vault/files.ts` (add `only` to `FileReadOptions`)
- Modify: `packages/agent/src/vault/drive.test.ts`, `packages/agent/src/vault/files.test.ts`
- Modify: `packages/agent/src/index.ts`

**Interfaces:**

- Produces: `removeDriveFiles(vault: Vault, fileIds: readonly string[]): Promise<number>` — removes entity notes with `source: 'drive'` whose `externalId` is in `fileIds`; Classroom-attached files are untouched.
- Produces: `FileReadOptions.only?: ReadonlySet<string>` — restrict reading to notes whose `externalId` is in the set.

- [ ] **Step 1: Failing tests**

In `drive.test.ts` add (using the file's existing temp-vault helper, or `new Vault(await mkdtemp(join(tmpdir(), 'v-')), 'u')`):

```ts
describe('removing files Drive no longer has', () => {
  it('removes the Drive note and leaves a Classroom attachment alone', async () => {
    const vault = await freshVault();
    await vault.write({
      name: 'essay',
      kind: 'entity',
      source: 'drive',
      description: 'File',
      externalId: 'f1',
      body: 'essay.',
    });
    await vault.write({
      name: 'worksheet',
      kind: 'entity',
      source: 'classroom',
      description: 'File',
      externalId: 'f2',
      body: 'worksheet.',
    });

    expect(await removeDriveFiles(vault, ['f1', 'f2', 'never'])).toBe(1);
    const names = (await vault.list('entity')).map((n) => n.name);
    expect(names).toEqual(['worksheet']);
  });
});
```

In `files.test.ts` add:

```ts
it('reads only the files it is pointed at', async () => {
  const vault = await freshVault();
  await vault.write({
    name: 'a',
    kind: 'entity',
    source: 'drive',
    description: 'File',
    externalId: 'fa',
    body: 'a.',
  });
  await vault.write({
    name: 'b',
    kind: 'entity',
    source: 'drive',
    description: 'File',
    externalId: 'fb',
    body: 'b.',
  });
  const read = vi.fn(async () => 'Some words about b.');
  const llm = {
    chat: vi.fn(async () => ({
      content: JSON.stringify({ summary: 'About b.', kind: 'notes', inCourse: [] }),
    })),
  };
  const result = await readFileContents(
    { llm, read },
    { vault, userId: 'u', only: new Set(['fb']) },
  );
  expect(read).toHaveBeenCalledTimes(1);
  expect(read).toHaveBeenCalledWith('fb');
  expect(result.remaining).toBe(0);
});
```

Match the JSON shape to the file's existing `summary` schema names (check `files.ts` lines 100-130: the fields are `summary`, `kind`, `inCourse`).

- [ ] **Step 2: Run to fail**

Run: `pnpm test packages/agent/src/vault/drive.test.ts packages/agent/src/vault/files.test.ts` — FAIL.

- [ ] **Step 3: Implement**

`drive.ts`, after `importDrive`:

```ts
/**
 * Files Drive says are gone, taken out.
 *
 * Only what Drive brought in. A file Classroom attached is Classroom's to
 * remove, and it may well still be attached to the assignment.
 */
export async function removeDriveFiles(vault: Vault, fileIds: readonly string[]): Promise<number> {
  if (fileIds.length === 0) return 0;
  const gone = new Set(fileIds);
  let removed = 0;
  for (const note of await vault.list('entity')) {
    if (note.source !== 'drive' || !note.externalId || !gone.has(note.externalId)) continue;
    if (await vault.remove('entity', note.name)) removed += 1;
  }
  return removed;
}
```

`files.ts`: add to `FileReadOptions`:

```ts
  /** Read only these files, by Drive id. The live sync points at what it just brought in. */
  only?: ReadonlySet<string>;
```

and in `readFileContents` destructure `only` and change the filter:

```ts
const files = entities.filter(
  (note) =>
    note.description === 'File' &&
    note.externalId &&
    !note.body.includes(SECTION) &&
    (!only || only.has(note.externalId)),
);
```

Export `removeDriveFiles` from `index.ts` beside `importDrive`.

- [ ] **Step 4: Verify and commit**

Run: `pnpm test packages/agent/src/vault` and `pnpm typecheck` — PASS.

```bash
git add packages/agent/src/vault/drive.ts packages/agent/src/vault/drive.test.ts packages/agent/src/vault/files.ts packages/agent/src/vault/files.test.ts packages/agent/src/index.ts
git commit -m "A file deleted from Drive leaves the vault, and a sync reads only what it brought"
```

---

### Task 5: Remember course verdicts, and ask again only when the question changes

**Files:**

- Modify: `packages/agent/src/vault/courses.ts`
- Modify: `packages/agent/src/vault/courses.test.ts`
- Modify: `packages/agent/src/index.ts`

**Interfaces:**

- Produces: `courseFingerprint(courses: ClassifiableCourse[], yearStart: string, yearEnd: string | undefined, school: string | undefined): string`
- Produces: `recallCourseVerdicts(vault, fingerprint): Promise<CourseVerdict[] | null>` — verdicts saved under the same rule and fingerprint, else null.
- Produces: `rememberCourseVerdicts(vault, fingerprint, verdicts): Promise<void>` — no-op when any verdict is held (`subject === null`).
- Produces: `lastCourseVerdicts(vault): Promise<CourseVerdict[]>` — whatever was last remembered, regardless of fingerprint; `[]` when nothing. The live sync uses this for `dropped` and `filterSnapshot`.

- [ ] **Step 1: Failing tests**

Append to `courses.test.ts`:

```ts
describe('remembering course verdicts', () => {
  const verdicts = [
    { course: '10 Chemistry', academic: true, subject: 'chemistry', year: '2026-2027', keep: true },
    { course: 'House Blue', academic: false, subject: 'house-blue', year: null, keep: true },
  ];

  it('recalls verdicts for the same question and not for a different one', async () => {
    const vault = await freshVault();
    await rememberCourseVerdicts(vault, 'abc', verdicts);
    expect(await recallCourseVerdicts(vault, 'abc')).toEqual(verdicts);
    expect(await recallCourseVerdicts(vault, 'xyz')).toBeNull();
    expect(await lastCourseVerdicts(vault)).toEqual(verdicts);
  });

  it('does not remember a held verdict', async () => {
    const vault = await freshVault();
    await rememberCourseVerdicts(vault, 'abc', [
      ...verdicts,
      { course: 'Mystery', academic: false, subject: null, year: null, keep: true },
    ]);
    expect(await recallCourseVerdicts(vault, 'abc')).toBeNull();
    expect(await lastCourseVerdicts(vault)).toEqual([]);
  });

  it('fingerprints what the classifier sees, not the day it sees it', () => {
    const a = [{ id: '1', name: 'Chem', work: ['Lab 1'], workCount: 1 }];
    const same = courseFingerprint(a, '2026-08-25', '06-20', 'a school');
    expect(courseFingerprint(a, '2026-08-25', '06-20', 'a school')).toBe(same);
    expect(
      courseFingerprint([{ ...a[0]!, work: ['Lab 2'] }], '2026-08-25', '06-20', 'a school'),
    ).not.toBe(same);
    expect(courseFingerprint(a, '2027-08-25', '06-20', 'a school')).not.toBe(same);
  });
});
```

- [ ] **Step 2: Run to fail**

Run: `pnpm test packages/agent/src/vault/courses.test.ts` — FAIL.

- [ ] **Step 3: Implement**

In `courses.ts` add imports `import { createHash } from 'node:crypto'; import { mkdir, readFile, writeFile } from 'node:fs/promises'; import { join } from 'node:path';` and:

```ts
/** Where the last verdicts live: beside the notes, like the Drive ledger. */
const COURSE_LEDGER = 'courses-judged.json';

/**
 * Which question the remembered verdicts answer. Bump when the prompt or the
 * rule that reads its answer changes, and every vault is asked once more.
 *
 *   1  the first remembered rule
 */
export const CLASSIFIER_RULE = 1;

/**
 * A fingerprint of everything the classifier is shown.
 *
 * The described courses are the prompt; the year boundary decides which are
 * over; the school page names the houses. Today's date is deliberately not
 * here: the answer changes with the year, not with the day.
 */
export function courseFingerprint(
  courses: ClassifiableCourse[],
  yearStart: string,
  yearEnd: string | undefined,
  school: string | undefined,
): string {
  const sorted = [...courses].sort((a, b) => a.id.localeCompare(b.id));
  const parts = JSON.stringify({
    rule: CLASSIFIER_RULE,
    sorted,
    yearStart,
    yearEnd: yearEnd ?? null,
    school: school ?? null,
  });
  return createHash('sha256').update(parts).digest('hex').slice(0, 16);
}

interface CourseLedger {
  rule: number;
  fingerprint: string;
  verdicts: CourseVerdict[];
}

async function readCourseLedger(vault: Vault): Promise<CourseLedger | null> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(join(vault.directory, COURSE_LEDGER), 'utf8'),
    );
    if (!parsed || typeof parsed !== 'object') return null;
    const { rule, fingerprint, verdicts } = parsed as Partial<CourseLedger>;
    if (rule !== CLASSIFIER_RULE || typeof fingerprint !== 'string' || !Array.isArray(verdicts))
      return null;
    return { rule, fingerprint, verdicts };
  } catch {
    return null;
  }
}

/** The verdicts given to exactly this question, or null. */
export async function recallCourseVerdicts(
  vault: Vault,
  fingerprint: string,
): Promise<CourseVerdict[] | null> {
  const ledger = await readCourseLedger(vault);
  return ledger && ledger.fingerprint === fingerprint ? ledger.verdicts : null;
}

/** The verdicts last given, whatever the question was. For a pass with no model. */
export async function lastCourseVerdicts(vault: Vault): Promise<CourseVerdict[]> {
  return (await readCourseLedger(vault))?.verdicts ?? [];
}

/**
 * Keep the verdicts, unless one of them is silence.
 *
 * A held course is a question the model did not answer, and remembering that
 * would make the silence permanent. The next pass asks again.
 */
export async function rememberCourseVerdicts(
  vault: Vault,
  fingerprint: string,
  verdicts: CourseVerdict[],
): Promise<void> {
  if (verdicts.some((verdict) => verdict.subject === null)) return;
  await mkdir(vault.directory, { recursive: true });
  await writeFile(
    join(vault.directory, COURSE_LEDGER),
    JSON.stringify({ rule: CLASSIFIER_RULE, fingerprint, verdicts }, null, 2),
  );
}
```

`vault.directory` is the accessor `drive-triage.ts` already uses. Export the four functions from `index.ts` beside `classifyCourses`.

- [ ] **Step 4: Verify and commit**

Run: `pnpm test packages/agent/src/vault/courses.test.ts` and `pnpm typecheck` — PASS.

```bash
git add packages/agent/src/vault/courses.ts packages/agent/src/vault/courses.test.ts packages/agent/src/index.ts
git commit -m "Remember what the classifier said until the question changes"
```

---

### Task 6: user.md is rewritten only when the pages under it changed

**Files:**

- Modify: `packages/agent/src/vault/user-doc.ts`
- Modify: `packages/agent/src/vault/user-doc.test.ts`

**Interfaces:**

- `writeUserDoc` keeps its signature. When the fingerprint of its inputs matches the stored `sourceHash`, it returns the existing body without a model call.

- [ ] **Step 1: Failing test**

Append to `user-doc.test.ts` (the file has helpers to write class docs; reuse them):

```ts
it('does not rewrite a page whose sources have not changed', async () => {
  const vault = await freshVault();
  await writeDocument(vault, {
    name: 'class-chemistry',
    description: 'Chemistry',
    body: 'Chem.',
    academic: true,
    sourceHash: 'h1',
  });
  const llm = { chat: vi.fn(async () => ({ content: 'Who they are.' })) };

  await writeUserDoc({ llm }, { vault, userId: 'u', name: 'Lucas' });
  await writeUserDoc({ llm }, { vault, userId: 'u', name: 'Lucas' });
  expect(llm.chat).toHaveBeenCalledTimes(1);

  await writeDocument(vault, {
    name: 'class-chemistry',
    description: 'Chemistry',
    body: 'Chem, now with labs.',
    academic: true,
    sourceHash: 'h2',
  });
  await writeUserDoc({ llm }, { vault, userId: 'u', name: 'Lucas' });
  expect(llm.chat).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 2: Run to fail**

Run: `pnpm test packages/agent/src/vault/user-doc.test.ts` — FAIL (called 3 times).

- [ ] **Step 3: Implement**

In `user-doc.ts` add `import { createHash } from 'node:crypto';` and, above `writeUserDoc`:

```ts
/**
 * A fingerprint of what the page is written from.
 *
 * The class pages carry their own source hashes, so a page whose notes have
 * not changed reads the same here; the school and chats pages are hashed
 * whole. The date is left out on purpose -- it changes every day and the
 * student does not.
 */
function userDocFingerprint(input: {
  classes: VaultNote[];
  school: VaultNote | undefined;
  chats: VaultNote | undefined;
  student: string | undefined;
  grade: number | null;
}): string {
  const short = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);
  const parts = [
    `student:${input.student ?? ''}`,
    `grade:${input.grade ?? ''}`,
    ...input.classes
      .map((doc) => `${doc.name}:${doc.academic ?? ''}:${doc.sourceHash ?? short(doc.body)}`)
      .sort(),
    `school:${input.school ? short(input.school.body) : ''}`,
    `chats:${input.chats ? short(input.chats.body) : ''}`,
  ];
  return short(parts.join('\n'));
}
```

In `writeUserDoc`, after `grade` is read and before `retrying(...)`:

```ts
const sourceHash = userDocFingerprint({
  classes,
  school,
  chats,
  student,
  grade: grade?.grade ?? null,
});
// Nothing it is written from has changed since it was last written.
if (existing?.sourceHash === sourceHash) return existing.body;
```

and add `sourceHash,` to the `writeDocument` call at the end. Import `VaultNote` type from `./vault.js` if not already.

- [ ] **Step 4: Verify and commit**

Run: `pnpm test packages/agent/src/vault/user-doc.test.ts` and `pnpm typecheck`.

```bash
git add packages/agent/src/vault/user-doc.ts packages/agent/src/vault/user-doc.test.ts
git commit -m "user.md is not rewritten when nothing under it changed"
```

---

### Task 7: The `vault_sync` table, its migration, and the Gmail watch call

**Files:**

- Create: `packages/db/src/schema/vault-sync.ts`
- Modify: `packages/db/src/schema/index.ts`
- Create: `packages/db/migrations/0015_*.sql` (generated)
- Create: `apps/api/src/vault-sync-state.ts`
- Create: `apps/api/src/vault-sync-state.integration.test.ts`
- Modify: `packages/agent/src/tools/google/gmail.ts` (add `watchMailbox`), `packages/agent/src/index.ts`

**Interfaces:**

- Produces: `vaultSync` table; `SyncState = typeof vaultSync.$inferSelect`.
- Produces: `syncStateOf(db, userId): Promise<SyncState | null>`; `updateSyncState(db, userId, patch: Partial<Omit<SyncState, 'userId'>>): Promise<void>` (upsert); `syncStateByChannel(db, channelId): Promise<SyncState | null>`; `allSyncStates(db): Promise<SyncState[]>`.
- Produces: `watchMailbox(token, topicName): Promise<{ historyId: string; expiration: string } | ToolUnavailable>`.

- [ ] **Step 1: Schema**

Create `packages/db/src/schema/vault-sync.ts`:

```ts
import { index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { user } from './auth.js';

/**
 * Where the live sync stands for one student.
 *
 * Small on purpose: a Drive change token, the two Google watches and when
 * each tier last ran. The vault itself stays on disk; this is the bookmark.
 */
export const vaultSync = pgTable(
  'vault_sync',
  {
    userId: text('user_id')
      .primaryKey()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** Where the next Drive changes.list starts. */
    drivePageToken: text('drive_page_token'),
    driveChannelId: text('drive_channel_id'),
    driveResourceId: text('drive_resource_id'),
    /** Echoed by Drive on every notification, so a forged one is refused. */
    driveChannelSecret: text('drive_channel_secret'),
    driveChannelExpiresAt: timestamp('drive_channel_expires_at', { withTimezone: true }),
    gmailWatchExpiresAt: timestamp('gmail_watch_expires_at', { withTimezone: true }),
    /**
     * The school's mail domains, found by the slow refresh.
     *
     * Discovery reads hundreds of sent messages, so the live sync must not
     * repeat it on every bell.
     */
    schoolDomains: jsonb('school_domains').$type<string[]>(),
    lastLiveSyncAt: timestamp('last_live_sync_at', { withTimezone: true }),
    lastRefreshAt: timestamp('last_refresh_at', { withTimezone: true }),
  },
  (t) => [index('vault_sync_drive_channel_id_idx').on(t.driveChannelId)],
);
```

Add `export * from './vault-sync.js';` to `packages/db/src/schema/index.ts`.

- [ ] **Step 2: Generate the migration**

Run: `pnpm db:generate`. Expected: a new `packages/db/migrations/0015_<name>.sql` creating `vault_sync` plus updated `meta/`. If it fails for a missing `DATABASE_URL`, run `DATABASE_URL=postgres://x pnpm db:generate` (generation does not connect). Read the SQL and confirm it creates one table and one index.

- [ ] **Step 3: Failing integration test for the helpers**

Create `apps/api/src/vault-sync-state.integration.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { createUser, reset, testDb } from './test-support/harness.js';
import {
  allSyncStates,
  syncStateByChannel,
  syncStateOf,
  updateSyncState,
} from './vault-sync-state.js';

describe('the live sync bookmark', () => {
  beforeEach(reset);

  it('starts absent, upserts, and is found by its Drive channel', async () => {
    const db = await testDb();
    const { id } = await createUser();
    expect(await syncStateOf(db, id)).toBeNull();

    await updateSyncState(db, id, { drivePageToken: '900' });
    await updateSyncState(db, id, { driveChannelId: 'ch1', driveChannelSecret: 's' });

    const state = await syncStateOf(db, id);
    expect(state?.drivePageToken).toBe('900');
    expect(state?.driveChannelId).toBe('ch1');
    expect((await syncStateByChannel(db, 'ch1'))?.userId).toBe(id);
    expect(await syncStateByChannel(db, 'nope')).toBeNull();
    expect((await allSyncStates(db)).map((s) => s.userId)).toEqual([id]);
  });
});
```

Check `createUser()` in `test-support/harness.ts` returns an object with `id`; adapt the destructure if it returns `{ user: { id } }` or similar.

- [ ] **Step 4: Implement the helpers**

Create `apps/api/src/vault-sync-state.ts`:

```ts
import { eq } from 'drizzle-orm';
import { vaultSync, type Database } from '@contexto/db';

export type SyncState = typeof vaultSync.$inferSelect;
export type SyncPatch = Partial<Omit<SyncState, 'userId'>>;

export async function syncStateOf(db: Database, userId: string): Promise<SyncState | null> {
  const [row] = await db.select().from(vaultSync).where(eq(vaultSync.userId, userId)).limit(1);
  return row ?? null;
}

export async function syncStateByChannel(
  db: Database,
  channelId: string,
): Promise<SyncState | null> {
  const [row] = await db
    .select()
    .from(vaultSync)
    .where(eq(vaultSync.driveChannelId, channelId))
    .limit(1);
  return row ?? null;
}

export async function allSyncStates(db: Database): Promise<SyncState[]> {
  return db.select().from(vaultSync);
}

/** Write some fields, creating the row the first time. */
export async function updateSyncState(
  db: Database,
  userId: string,
  patch: SyncPatch,
): Promise<void> {
  await db
    .insert(vaultSync)
    .values({ userId, ...patch })
    .onConflictDoUpdate({ target: vaultSync.userId, set: patch });
}
```

Run the migration against the test database the way the other integration tests expect (check `harness.ts` `reset`/`testDb` for how the schema is applied; if it runs `drizzle-kit migrate` or `migrate()` on setup, nothing more is needed).

Run: `pnpm test apps/api/src/vault-sync-state.integration.test.ts` — PASS.

- [ ] **Step 5: Gmail watch**

In `tools/google/gmail.ts` append:

```ts
/**
 * Ask Gmail to publish a Pub/Sub message whenever this mailbox changes.
 *
 * Not a tool. Expires within seven days; the live sync renews it daily. The
 * historyId in the answer is not kept -- the bell is a bell, and the sync
 * searches rather than replays history.
 */
export async function watchMailbox(
  token: string,
  topicName: string,
): Promise<{ historyId: string; expiration: string } | ToolUnavailable> {
  return googleFetch<{ historyId: string; expiration: string }>(`${GMAIL}/watch`, token, {
    method: 'POST',
    body: { topicName },
  });
}
```

Export `watchMailbox` from `packages/agent/src/index.ts` on the line that exports the Gmail tools (find `readMail` there).

- [ ] **Step 6: Verify and commit**

Run: `pnpm typecheck && pnpm test apps/api/src/vault-sync-state.integration.test.ts`.

```bash
git add packages/db/src/schema/vault-sync.ts packages/db/src/schema/index.ts packages/db/migrations apps/api/src/vault-sync-state.ts apps/api/src/vault-sync-state.integration.test.ts packages/agent/src/tools/google/gmail.ts packages/agent/src/index.ts
git commit -m "A bookmark per student for the live sync, and the Gmail watch that rings it"
```

---

### Task 8: One queue per student, and the button goes through it

**Files:**

- Create: `apps/api/src/vault-queue.ts`
- Create: `apps/api/src/vault-queue.test.ts`
- Modify: `apps/api/src/vault-build.ts:154-179` (`startBuild` runs `work` through the queue)

**Interfaces:**

- Produces: `class StudentQueue { run<T>(userId: string, job: () => Promise<T>): Promise<T>; busy(userId: string): boolean }` and a module singleton `export const studentQueue = new StudentQueue()`.

- [ ] **Step 1: Failing tests**

Create `apps/api/src/vault-queue.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { StudentQueue } from './vault-queue.js';

/**
 * One student's vault is written by one job at a time.
 *
 * The button, the six-hourly pass and the live sync all reach the same
 * files. Two of them at once pay twice and interleave writes; the queue is
 * what makes that impossible rather than merely unlikely.
 */

const gate = () => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
};

describe('StudentQueue', () => {
  it("runs one student's jobs in order, one at a time", async () => {
    const queue = new StudentQueue();
    const order: string[] = [];
    const first = gate();

    const a = queue.run('s1', async () => {
      order.push('a-start');
      await first.opened;
      order.push('a-end');
    });
    const b = queue.run('s1', async () => {
      order.push('b');
    });

    await Promise.resolve();
    expect(order).toEqual(['a-start']);
    expect(queue.busy('s1')).toBe(true);
    first.open();
    await Promise.all([a, b]);
    expect(order).toEqual(['a-start', 'a-end', 'b']);
    expect(queue.busy('s1')).toBe(false);
  });

  it('lets different students run at once', async () => {
    const queue = new StudentQueue();
    const first = gate();
    const started: string[] = [];
    const a = queue.run('s1', async () => {
      started.push('s1');
      await first.opened;
    });
    const b = queue.run('s2', async () => {
      started.push('s2');
    });
    await b;
    expect(started).toEqual(['s1', 's2']);
    first.open();
    await a;
  });

  it('runs the next job after a failure', async () => {
    const queue = new StudentQueue();
    await expect(
      queue.run('s1', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await queue.run('s1', async () => 'ok')).toBe('ok');
  });
});
```

- [ ] **Step 2: Run to fail**

Run: `pnpm test apps/api/src/vault-queue.test.ts` — FAIL.

- [ ] **Step 3: Implement**

Create `apps/api/src/vault-queue.ts`:

```ts
/**
 * One job at a time per student.
 *
 * Everything that writes a vault -- the build button, the six-hourly pass,
 * the live sync -- goes through here, so two of them can never write the
 * same notes at once. In memory, like the build lock: a job is bounded by
 * this process and a restart is exactly when the queue should be empty.
 */
export class StudentQueue {
  readonly #tails = new Map<string, Promise<unknown>>();
  readonly #pending = new Map<string, number>();

  run<T>(userId: string, job: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(userId) ?? Promise.resolve();
    this.#pending.set(userId, (this.#pending.get(userId) ?? 0) + 1);

    // Runs after the previous job however that job ended.
    const next = previous.then(job, job);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    this.#tails.set(userId, settled);

    void settled.then(() => {
      const left = (this.#pending.get(userId) ?? 1) - 1;
      if (left <= 0) {
        this.#pending.delete(userId);
        if (this.#tails.get(userId) === settled) this.#tails.delete(userId);
      } else this.#pending.set(userId, left);
    });

    return next;
  }

  /** Whether anything is running or waiting for this student. */
  busy(userId: string): boolean {
    return (this.#pending.get(userId) ?? 0) > 0;
  }
}

export const studentQueue = new StudentQueue();
```

- [ ] **Step 4: The button uses it**

In `vault-build.ts` import `studentQueue` from `./vault-queue.js` and change `void work()` in `startBuild` to `void studentQueue.run(userId, work)`. Update the comment above it: "Queued behind any live sync or refresh already running for this student, so the two never write at once."

- [ ] **Step 5: Verify and commit**

Run: `pnpm test apps/api/src/vault-queue.test.ts apps/api/src/vault-build.test.ts` and `pnpm typecheck`.

```bash
git add apps/api/src/vault-queue.ts apps/api/src/vault-queue.test.ts apps/api/src/vault-build.ts
git commit -m "One writer per vault at a time"
```

---

### Task 9: Environment variables for the live sync

**Files:**

- Modify: `apps/api/src/env.ts`
- Modify: `apps/api/src/env.test.ts` if it exists (else skip the test step; `loadEnv` is exercised by the refine)
- Modify: `.env.example`

**Interfaces:**

- Produces on `Env`: `GMAIL_PUBSUB_TOPIC?: string`, `VAULT_HOOK_SECRET?: string`, `VAULT_LIVE_POLL_MINUTES: number` (default 5), `VAULT_REFRESH_BUDGET_MINUTES: number` (default 50).

- [ ] **Step 1: Add to the schema**

In `envSchema`, after `VAULT_ROOT`:

```ts
  /**
   * Live sync. All optional; without them the live tier polls on
   * VAULT_LIVE_POLL_MINUTES and nothing is pushed.
   *
   * GMAIL_PUBSUB_TOPIC is the full name, projects/<id>/topics/<name>, of a
   * topic Gmail may publish to. See deploy/README.md for the Console steps.
   */
  GMAIL_PUBSUB_TOPIC: optional(z.string().regex(/^projects\/[^/]+\/topics\/[^/]+$/)),
  /** Shared secret in the Pub/Sub push URL. Required with GMAIL_PUBSUB_TOPIC. */
  VAULT_HOOK_SECRET: optional(z.string().min(16)),
  /** How often the poll trigger rings every student's bell. 0 disables it. */
  VAULT_LIVE_POLL_MINUTES: z.coerce.number().int().min(0).default(5),
  /** How long one slow pass may keep starting students. */
  VAULT_REFRESH_BUDGET_MINUTES: z.coerce.number().int().positive().default(50),
```

Add a refine beside the Telegram one:

```ts
    .refine((env) => !env.GMAIL_PUBSUB_TOPIC || Boolean(env.VAULT_HOOK_SECRET), {
      path: ['VAULT_HOOK_SECRET'],
      message:
        'Required when GMAIL_PUBSUB_TOPIC is set -- without it anyone who finds the hook ' +
        'URL can ring every student\'s bell. Generate one with: openssl rand -hex 32',
    })
```

- [ ] **Step 2: Document in `.env.example`**

Append after the `VAULT_ROOT` line:

```
# Live sync (optional). See deploy/README.md, "Live sync".
# GMAIL_PUBSUB_TOPIC=projects/your-project/topics/contexto-gmail
# VAULT_HOOK_SECRET=
# VAULT_LIVE_POLL_MINUTES=5
# VAULT_REFRESH_BUDGET_MINUTES=50
```

- [ ] **Step 3: Verify and commit**

Run: `pnpm typecheck` and `pnpm test apps/api/src/env.test.ts` if present. Confirm the integration tests that build an `env` object literally (`routes/vault.integration.test.ts`) still typecheck; they cast with `as never`, so they do.

```bash
git add apps/api/src/env.ts .env.example
git commit -m "Settings for the live sync"
```

---

### Task 10: The bells, the live sync, the watches and the triggers

**Files:**

- Create: `apps/api/src/vault-live.ts`
- Create: `apps/api/src/vault-live.test.ts`

**Interfaces:**

- Consumes: `studentQueue` (Task 8); `syncStateOf`, `updateSyncState`, `allSyncStates` (Task 7); `collectSchoolMail` with `skip`/`newerThan` (Task 1); `classroomEpisode` (Task 2); `collectDriveChanges`, `startPageToken`, `watchChanges`, `stopChannel`, `watchMailbox`, `isUnavailable` (Tasks 3, 7); `removeDriveFiles`, `readFileContents` with `only` (Task 4); `lastCourseVerdicts` (Task 5); `checkReadiness`, `grantedScopes`, `unreadyReason` from `vault-build.ts`; `getGoogleGrant`, `BetterAuthGoogleTokenProvider` from `google/connections.ts`; `schoolDomains` from `@contexto/agent` (export it from `packages/agent/src/index.ts` from `./vault/mail-query.js` if missing).
- Produces: `class Bells { constructor(delays?: { gmail: number; drive: number }); onRing(handler: (userId: string, sources: Sources) => void): void; ring(userId: string, source: 'gmail' | 'drive'): void; pending(userId): boolean }` with `type Sources = { gmail: boolean; drive: boolean }`; module singleton `liveBells`.
- Produces: `liveSync(ctx: AppContext, userId: string, sources: Sources): Promise<string>`.
- Produces: `armWatches(ctx: AppContext, userId: string): Promise<void>`.
- Produces: `startVaultLive(ctx: AppContext): () => void`.

- [ ] **Step 1: Failing tests for the bells**

Create `apps/api/src/vault-live.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Bells } from './vault-live.js';

/**
 * Bells coalesce.
 *
 * Google rings once per mailbox change and once per keystroke's autosave in
 * Docs. Syncing on every one would be dozens of syncs for one edit; the
 * bell waits for quiet and then rings once, with everything that rang.
 */
describe('Bells', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('rings once after quiet, with every source that rang', () => {
    const bells = new Bells({ gmail: 20_000, drive: 90_000 });
    const rang = vi.fn();
    bells.onRing(rang);

    bells.ring('s1', 'drive');
    vi.advanceTimersByTime(30_000);
    bells.ring('s1', 'drive');
    bells.ring('s1', 'gmail');
    expect(rang).not.toHaveBeenCalled();

    vi.advanceTimersByTime(20_000);
    expect(rang).toHaveBeenCalledTimes(1);
    expect(rang).toHaveBeenCalledWith('s1', { gmail: true, drive: true });
    expect(bells.pending('s1')).toBe(false);
  });

  it('does not let a slow source push out a fast one', () => {
    const bells = new Bells({ gmail: 20_000, drive: 90_000 });
    const rang = vi.fn();
    bells.onRing(rang);
    bells.ring('s1', 'gmail');
    vi.advanceTimersByTime(10_000);
    bells.ring('s1', 'drive');
    vi.advanceTimersByTime(10_000);
    expect(rang).toHaveBeenCalledTimes(1);
  });

  it('keeps students apart', () => {
    const bells = new Bells({ gmail: 1000, drive: 1000 });
    const rang = vi.fn();
    bells.onRing(rang);
    bells.ring('s1', 'gmail');
    bells.ring('s2', 'drive');
    vi.advanceTimersByTime(1000);
    expect(rang).toHaveBeenCalledWith('s1', { gmail: true, drive: false });
    expect(rang).toHaveBeenCalledWith('s2', { gmail: false, drive: true });
  });
});
```

- [ ] **Step 2: Run to fail**

Run: `pnpm test apps/api/src/vault-live.test.ts` — FAIL.

- [ ] **Step 3: Write `vault-live.ts`**

```ts
import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { user } from '@contexto/db';
import {
  FALLBACK_YEAR_END,
  SCHOOL_DOC_NAME,
  Vault,
  academicYearEnd,
  academicYearStart,
  classroomEpisode,
  collectClassroomSnapshot,
  collectDriveChanges,
  collectSchoolMail,
  domainOf,
  filterSnapshot,
  importClassroom,
  importDrive,
  importMail,
  isUnavailable,
  judgeDriveFiles,
  lastCourseVerdicts,
  readDocument,
  readDriveFile,
  readFileContents,
  readGrade,
  rememberDriveFilesOut,
  removeDriveFiles,
  schoolDomains,
  startPageToken,
  stopChannel,
  textFromDriveRead,
  watchChanges,
  watchMailbox,
} from '@contexto/agent';
import type { ToolContext } from '@contexto/agent';
import type { AppContext } from './context.js';
import { BetterAuthGoogleTokenProvider, getGoogleGrant } from './google/connections.js';
import { checkReadiness, grantedScopes, unreadyReason } from './vault-build.js';
import { studentQueue } from './vault-queue.js';
import { syncStateOf, updateSyncState } from './vault-sync-state.js';

/**
 * The live tier: a teacher posts, a school email lands, a student saves a
 * document, and within about a minute it is in the vault.
 *
 * One engine, liveSync, fetches only what changed. Two things ring it: a
 * push from Google, arriving at routes/hooks.ts, or the poll timer below
 * where push is not set up. Both go through the same Bells, which wait for
 * quiet and ring once, and every sync runs on the student's own queue.
 */

export interface Sources {
  gmail: boolean;
  drive: boolean;
}

/** Quiet before a bell rings. Docs autosaves every few seconds while a student types. */
const DEBOUNCE_MS = { gmail: 20_000, drive: 90_000 } as const;

/** Files summarised per live sync. The slow refresh reads the rest. */
const LIVE_FILE_CAP = 20;

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** Renew a watch this close to its end. Both expire within a week. */
const RENEW_WITHIN = 2 * DAY;

export class Bells {
  readonly #pending = new Map<
    string,
    { sources: Sources; timer: NodeJS.Timeout; deadline: number }
  >();
  #handler: (userId: string, sources: Sources) => void = () => {};

  constructor(private readonly delays: { gmail: number; drive: number } = DEBOUNCE_MS) {}

  onRing(handler: (userId: string, sources: Sources) => void): void {
    this.#handler = handler;
  }

  ring(userId: string, source: keyof Sources): void {
    const now = Date.now();
    const wanted = now + this.delays[source];
    const current = this.#pending.get(userId);
    const sources: Sources = current?.sources ?? { gmail: false, drive: false };
    sources[source] = true;

    // A fast source may bring the deadline forward; a slow one never pushes it back.
    const deadline = current ? Math.min(current.deadline, wanted) : wanted;
    if (current) clearTimeout(current.timer);
    const timer = setTimeout(() => {
      this.#pending.delete(userId);
      this.#handler(userId, sources);
    }, deadline - now);
    this.#pending.set(userId, { sources, timer, deadline });
  }

  pending(userId: string): boolean {
    return this.#pending.has(userId);
  }
}

/** The bells the webhook routes ring. Wired to a handler by startVaultLive. */
export const liveBells = new Bells();

/**
 * Sync one student from what changed.
 *
 * Reads the delta from each source that rang, writes and links the new
 * items, and spends a model call only where a person's words need
 * summarising. Returns a one-line summary for the log.
 */
export async function liveSync(ctx: AppContext, userId: string, sources: Sources): Promise<string> {
  const [owner] = await ctx.db.select().from(user).where(eq(user.id, userId)).limit(1);
  if (!owner) return 'no owner';

  const grant = await getGoogleGrant(ctx.db, userId);
  const google = new BetterAuthGoogleTokenProvider(ctx.auth, userId, grant.groups, grant.scope);
  const readiness = await checkReadiness(grantedScopes(grant.scope), owner.email, () =>
    google.getAccessToken('classroom'),
  );
  if (!readiness.ready) return `not ready: ${unreadyReason(readiness)}`;

  const vault = new Vault(ctx.env.VAULT_ROOT as string, userId);
  // The first build makes the vault; a live sync has nothing to add to nothing.
  if (!(await vault.has())) return 'no vault yet';

  const toolContext: ToolContext = { userId, agentId: userId, google };
  const state = await syncStateOf(ctx.db, userId);
  const today = new Date().toISOString().slice(0, 10);
  const yearEnd = await academicYearEnd(vault);
  const yearStart = academicYearStart(today, yearEnd ?? FALLBACK_YEAR_END);
  const school = (await readDocument(vault, SCHOOL_DOC_NAME))?.body;
  const verdicts = await lastCourseVerdicts(vault);
  const dropped = verdicts.filter((verdict) => !verdict.keep).map((verdict) => verdict.course);
  const parts: string[] = [];
  let classroomPosted = false;

  if (sources.gmail && domainOf(owner.email)) {
    const domains = state?.schoolDomains ?? schoolDomains(owner.email, []);
    const known = new Set(
      (await vault.list('episode')).map((note) => note.externalId).filter(Boolean) as string[],
    );
    const found = await collectSchoolMail(toolContext, { domains, newerThan: '2d', skip: known });
    if (found.messages.length > 0) {
      const entities = (await vault.list('entity')).map((note) => note.name);
      const mail = await importMail(
        { llm: await ctx.llm.resolve(userId) },
        { vault, messages: found.messages, entities, userId, domains, dropped, since: yearStart },
      );
      parts.push(`${mail.written} episodes`);
      classroomPosted = found.messages.some((message) => classroomEpisode(message)?.keep === true);
    }
  }

  /*
   * A Classroom notification means Classroom has something new. The tools
   * cannot fetch one course, so the whole snapshot is pulled -- sixty
   * requests, twenty seconds, no model -- and imported under the verdicts
   * the slow refresh last gave. No verdicts yet means no slow refresh yet,
   * and that pass will import everything itself.
   */
  if (classroomPosted && verdicts.length > 0) {
    const { snapshot } = await collectClassroomSnapshot(toolContext);
    const classroom = await importClassroom(vault, filterSnapshot(snapshot, verdicts));
    parts.push(`${classroom.written}+${classroom.updated} classroom`);
  }

  if (sources.drive) {
    const token = await google.getAccessToken('drive');
    if (token && !state?.drivePageToken) {
      // Nothing to diff against yet. From here on, changes are changes.
      const fresh = await startPageToken(token);
      if (!isUnavailable(fresh)) await updateSyncState(ctx.db, userId, { drivePageToken: fresh });
      parts.push('drive token armed');
    } else if (token && state?.drivePageToken) {
      const changes = await collectDriveChanges(toolContext, state.drivePageToken);
      if (isUnavailable(changes)) {
        // A token Drive no longer honours. Start again; the slow refresh's
        // full listing reconciles whatever happened in between.
        const fresh = await startPageToken(token);
        if (!isUnavailable(fresh)) await updateSyncState(ctx.db, userId, { drivePageToken: fresh });
        parts.push('drive token reset');
      } else {
        const removed = await removeDriveFiles(vault, changes.removed);
        let written = 0;
        let read = 0;
        if (changes.changed.length > 0) {
          const grade = await readGrade(vault, { today, ...(yearEnd ? { yearEnd } : {}) });
          const llm = await ctx.llm.resolve(userId);
          const judged = await judgeDriveFiles(
            { llm },
            {
              vault,
              files: changes.changed,
              today,
              yearStart,
              ...(school ? { school } : {}),
              dropped,
              ...(grade ? { grade: grade.grade } : {}),
              userId,
            },
          );
          const drive = await importDrive(vault, changes.changed, judged);
          written = drive.written;
          const files = await readFileContents(
            {
              llm,
              read: async (fileId) =>
                textFromDriveRead(await readDriveFile.execute({ fileId } as never, toolContext)),
            },
            {
              vault,
              userId,
              limit: LIVE_FILE_CAP,
              only: new Set(changes.changed.map((file) => file.fileId)),
            },
          );
          read = files.read;
          await rememberDriveFilesOut(vault, changes.changed, files.blank);
        }
        await updateSyncState(ctx.db, userId, { drivePageToken: changes.pageToken });
        parts.push(`${written} drive files, ${read} read, ${removed} removed`);
      }
    }
  }

  await updateSyncState(ctx.db, userId, { lastLiveSyncAt: new Date() });
  return parts.join(', ') || 'nothing new';
}

/**
 * Arm or renew this student's Google watches.
 *
 * Gmail publishes to the Pub/Sub topic when one is configured. Drive posts
 * to our hook when this API is reachable over https. Both lapse within a
 * week, so anything ending within two days is renewed, and a replaced Drive
 * channel is stopped so it does not ring twice.
 */
export async function armWatches(ctx: AppContext, userId: string): Promise<void> {
  const [owner] = await ctx.db.select().from(user).where(eq(user.id, userId)).limit(1);
  if (!owner) return;
  const grant = await getGoogleGrant(ctx.db, userId);
  const google = new BetterAuthGoogleTokenProvider(ctx.auth, userId, grant.groups, grant.scope);
  const readiness = await checkReadiness(grantedScopes(grant.scope), owner.email, () =>
    google.getAccessToken('classroom'),
  );
  if (!readiness.ready) {
    await updateSyncState(ctx.db, userId, {
      gmailWatchExpiresAt: null,
      driveChannelExpiresAt: null,
    });
    return;
  }

  const state = await syncStateOf(ctx.db, userId);
  const soon = Date.now() + RENEW_WITHIN;
  const lapsing = (at: Date | null | undefined) => !at || at.getTime() < soon;

  if (ctx.env.GMAIL_PUBSUB_TOPIC && lapsing(state?.gmailWatchExpiresAt)) {
    const token = await google.getAccessToken('gmail');
    if (token) {
      const watch = await watchMailbox(token, ctx.env.GMAIL_PUBSUB_TOPIC);
      if (!isUnavailable(watch)) {
        await updateSyncState(ctx.db, userId, {
          gmailWatchExpiresAt: new Date(Number(watch.expiration)),
        });
      } else console.warn(`[live] ${userId} gmail watch refused: ${watch.reason}`);
    }
  }

  if (ctx.env.API_BASE_URL.startsWith('https://') && lapsing(state?.driveChannelExpiresAt)) {
    const token = await google.getAccessToken('drive');
    if (token) {
      const pageToken = state?.drivePageToken ?? (await startPageToken(token));
      if (isUnavailable(pageToken)) return;
      const channel = {
        id: randomUUID(),
        address: `${ctx.env.API_BASE_URL}/api/hooks/drive`,
        token: randomBytes(24).toString('hex'),
        expiresAt: Date.now() + 7 * DAY - MINUTE,
      };
      const watch = await watchChanges(token, pageToken, channel);
      if (isUnavailable(watch)) {
        console.warn(`[live] ${userId} drive watch refused: ${watch.reason}`);
        return;
      }
      if (state?.driveChannelId && state.driveResourceId) {
        await stopChannel(token, { id: state.driveChannelId, resourceId: state.driveResourceId });
      }
      await updateSyncState(ctx.db, userId, {
        drivePageToken: pageToken,
        driveChannelId: channel.id,
        driveResourceId: watch.resourceId,
        driveChannelSecret: channel.token,
        driveChannelExpiresAt: new Date(Number(watch.expiration)),
      });
    }
  }
}

/**
 * Start the live tier: wire the bells, the poll trigger and the daily renewal.
 *
 * Returns a stop function so a test or a shutdown can end it.
 */
export function startVaultLive(ctx: AppContext): () => void {
  if (!ctx.env.VAULT_ROOT) return () => {};

  liveBells.onRing((userId, sources) => {
    void studentQueue
      .run(userId, () => liveSync(ctx, userId, sources))
      .then(
        (summary) => console.log(`Live ${userId}: ${summary}`),
        (error: unknown) => console.error(`Live sync failed for ${userId}`, error),
      );
  });

  const everyone = async (): Promise<string[]> =>
    (await ctx.db.select({ id: user.id }).from(user)).map((row) => row.id);

  const timers: NodeJS.Timeout[] = [];

  const pollMinutes = ctx.env.VAULT_LIVE_POLL_MINUTES;
  if (pollMinutes > 0) {
    const poll = async () => {
      try {
        for (const userId of await everyone()) {
          liveBells.ring(userId, 'gmail');
          liveBells.ring(userId, 'drive');
        }
      } catch (error) {
        console.error('Live poll failed', error);
      }
    };
    timers.push(setInterval(() => void poll(), pollMinutes * MINUTE));
  }

  const renewAll = async () => {
    try {
      for (const userId of await everyone()) {
        try {
          await armWatches(ctx, userId);
        } catch (error) {
          console.error(`Arming watches failed for ${userId}`, error);
        }
      }
    } catch (error) {
      console.error('Watch renewal failed', error);
    }
  };
  // Soon after boot, then daily. Renewal is idempotent, so a deploy costs nothing.
  timers.push(setTimeout(() => void renewAll(), MINUTE));
  timers.push(setInterval(() => void renewAll(), DAY));

  return () => {
    for (const timer of timers) clearTimeout(timer);
  };
}
```

`readDriveFile`, `textFromDriveRead`, `rememberDriveFilesOut`, `judgeDriveFiles`, `readGrade`, `academicYearEnd`, `academicYearStart`, `FALLBACK_YEAR_END`, `SCHOOL_DOC_NAME`, `readDocument`, `filterSnapshot`, `importClassroom`, `collectClassroomSnapshot`, `domainOf`, `importMail`, `importDrive` are all already exported from `@contexto/agent` (they are imported by `vault-refresh.ts`). Export `schoolDomains` and `isUnavailable` if Tasks 3/10 have not already.

- [ ] **Step 4: Verify**

Run: `pnpm test apps/api/src/vault-live.test.ts` — PASS. `pnpm typecheck` — clean. `pnpm lint` — clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/vault-live.ts apps/api/src/vault-live.test.ts packages/agent/src/index.ts
git commit -m "The live tier: a bell, a sync from the delta, and watches that ring it"
```

---

### Task 11: The two webhook routes

**Files:**

- Create: `apps/api/src/routes/hooks.ts`
- Create: `apps/api/src/routes/hooks.integration.test.ts`
- Modify: `apps/api/src/routes/index.ts` (mount `/hooks`)

**Interfaces:**

- Consumes: `liveBells` (Task 10), `syncStateByChannel`, `updateSyncState` (Task 7).
- Produces: `createHookRoutes(ctx: AppContext, bells: Pick<Bells, 'ring'> = liveBells)`.

- [ ] **Step 1: Failing integration test**

Create `apps/api/src/routes/hooks.integration.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { AppContext } from '../context.js';
import { createUser, reset, testDb } from '../test-support/harness.js';
import { updateSyncState } from '../vault-sync-state.js';
import { createHookRoutes } from './hooks.js';

/**
 * Google rings the bell here.
 *
 * A forged ring can at most cause one extra sync of a student's own data
 * with their own token, so the checks are cheap and the answers are quick:
 * Pub/Sub retries anything that is not a 2xx.
 */

const SECRET = 's'.repeat(32);

async function appWith(bells: { ring: ReturnType<typeof vi.fn> }) {
  const ctx = {
    db: await testDb(),
    env: { VAULT_HOOK_SECRET: SECRET },
  } as unknown as AppContext;
  return new Hono().route('/api/hooks', createHookRoutes(ctx, bells));
}

const pubsub = (emailAddress: string) =>
  JSON.stringify({
    message: {
      data: Buffer.from(JSON.stringify({ emailAddress, historyId: 1 })).toString('base64'),
      messageId: '1',
    },
    subscription: 'projects/p/subscriptions/s',
  });

describe('POST /api/hooks/gmail', () => {
  beforeEach(reset);

  it('refuses a wrong secret', async () => {
    const bells = { ring: vi.fn() };
    const app = await appWith(bells);
    const res = await app.request('/api/hooks/gmail?token=wrong', {
      method: 'POST',
      body: pubsub('a@b.c'),
    });
    expect(res.status).toBe(401);
    expect(bells.ring).not.toHaveBeenCalled();
  });

  it('rings the bell for a known mailbox and stays quiet for an unknown one', async () => {
    const bells = { ring: vi.fn() };
    const app = await appWith(bells);
    const { id, email } = await createUser();

    const known = await app.request(`/api/hooks/gmail?token=${SECRET}`, {
      method: 'POST',
      body: pubsub(email.toUpperCase()),
    });
    expect(known.status).toBe(204);
    expect(bells.ring).toHaveBeenCalledWith(id, 'gmail');

    const unknown = await app.request(`/api/hooks/gmail?token=${SECRET}`, {
      method: 'POST',
      body: pubsub('nobody@nowhere.example'),
    });
    expect(unknown.status).toBe(204);
    expect(bells.ring).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/hooks/drive', () => {
  beforeEach(reset);

  it('rings for a channel it knows, acknowledges sync, refuses the rest', async () => {
    const bells = { ring: vi.fn() };
    const app = await appWith(bells);
    const { id } = await createUser();
    await updateSyncState(await testDb(), id, {
      driveChannelId: 'ch1',
      driveChannelSecret: 'secret1',
    });

    const headers = (state: string, token = 'secret1', channel = 'ch1') => ({
      'x-goog-channel-id': channel,
      'x-goog-channel-token': token,
      'x-goog-resource-state': state,
      'x-goog-resource-id': 'r1',
    });

    expect(
      (await app.request('/api/hooks/drive', { method: 'POST', headers: headers('sync') })).status,
    ).toBe(200);
    expect(bells.ring).not.toHaveBeenCalled();

    expect(
      (await app.request('/api/hooks/drive', { method: 'POST', headers: headers('change') }))
        .status,
    ).toBe(200);
    expect(bells.ring).toHaveBeenCalledWith(id, 'drive');

    expect(
      (
        await app.request('/api/hooks/drive', {
          method: 'POST',
          headers: headers('change', 'nope'),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await app.request('/api/hooks/drive', {
          method: 'POST',
          headers: headers('change', 'secret1', 'other'),
        })
      ).status,
    ).toBe(401);
    expect(bells.ring).toHaveBeenCalledTimes(1);
  });
});
```

Check `createUser()` returns `email`; if the harness only returns `id`, read the email back with `db.select({ email: user.email })`.

- [ ] **Step 2: Run to fail**

Run: `pnpm test apps/api/src/routes/hooks.integration.test.ts` — FAIL.

- [ ] **Step 3: Implement**

Create `apps/api/src/routes/hooks.ts`:

```ts
import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { user } from '@contexto/db';
import type { AppContext } from '../context.js';
import { liveBells, type Bells } from '../vault-live.js';
import { syncStateByChannel } from '../vault-sync-state.js';

/**
 * Where Google rings the bell.
 *
 * No session: these are called by Pub/Sub and by Drive. Each carries a
 * secret instead -- the Pub/Sub push URL has one in its query string, and a
 * Drive channel echoes the token it was created with. A forged call can at
 * most trigger one extra sync of a student's own data with their own token.
 *
 * Answer fast and answer 2xx: Pub/Sub retries anything else, and the work
 * belongs to the queue, not to the request.
 */

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createHookRoutes(ctx: AppContext, bells: Pick<Bells, 'ring'> = liveBells) {
  return (
    new Hono()
      /** Pub/Sub push: `{ message: { data: base64 JSON { emailAddress, historyId } } }`. */
      .post('/gmail', async (c) => {
        const secret = ctx.env.VAULT_HOOK_SECRET;
        if (!secret || !sameSecret(c.req.query('token') ?? '', secret)) return c.body(null, 401);

        const body = (await c.req.json().catch(() => null)) as {
          message?: { data?: string };
        } | null;
        const data = body?.message?.data;
        if (!data) return c.body(null, 204);

        let mailbox: string | null = null;
        try {
          const parsed = JSON.parse(Buffer.from(data, 'base64').toString('utf8')) as {
            emailAddress?: unknown;
          };
          mailbox =
            typeof parsed.emailAddress === 'string' ? parsed.emailAddress.toLowerCase() : null;
        } catch {
          return c.body(null, 204);
        }
        if (!mailbox) return c.body(null, 204);

        const [row] = await ctx.db
          .select({ id: user.id })
          .from(user)
          .where(sql`lower(${user.email}) = ${mailbox}`)
          .limit(1);
        if (row) bells.ring(row.id, 'gmail');
        return c.body(null, 204);
      })

      /** Drive channel: everything is in the headers, the body is empty. */
      .post('/drive', async (c) => {
        const channelId = c.req.header('x-goog-channel-id');
        const token = c.req.header('x-goog-channel-token');
        if (!channelId || !token) return c.body(null, 401);

        const state = await syncStateByChannel(ctx.db, channelId);
        if (!state?.driveChannelSecret || !sameSecret(token, state.driveChannelSecret)) {
          return c.body(null, 401);
        }

        // 'sync' is Drive saying the channel exists. Nothing changed.
        if (c.req.header('x-goog-resource-state') !== 'sync') bells.ring(state.userId, 'drive');
        return c.body(null, 200);
      })
  );
}
```

Mount in `routes/index.ts`: import `createHookRoutes` and add `.route('/hooks', createHookRoutes(ctx))` beside the other `.route(...)` lines.

- [ ] **Step 4: Verify and commit**

Run: `pnpm test apps/api/src/routes/hooks.integration.test.ts apps/api/src/routes/vault.integration.test.ts` and `pnpm typecheck`.

```bash
git add apps/api/src/routes/hooks.ts apps/api/src/routes/hooks.integration.test.ts apps/api/src/routes/index.ts
git commit -m "Two doors for Google to ring the bell"
```

---

### Task 12: The slow refresh spends only on change, and treats every student fairly

**Files:**

- Modify: `apps/api/src/vault-refresh.ts`
- Modify: `apps/api/src/vault-refresh.test.ts`

**Interfaces:**

- Consumes: `courseFingerprint`, `recallCourseVerdicts`, `rememberCourseVerdicts` (Task 5); `collectSchoolMail` `skip` (Task 1); `allSyncStates`, `updateSyncState` (Task 7); `studentQueue` (Task 8); `Env.VAULT_REFRESH_BUDGET_MINUTES` (Task 9).
- Produces: `studentsToRefresh(rows, lastRefreshed: ReadonlyMap<string, Date | null>, options?: { overdueBefore?: Date }): string[]` — every distinct student, never-refreshed first, then oldest first; with `overdueBefore`, only students whose last refresh is missing or older than it.

- [ ] **Step 1: Rewrite the ordering tests**

Replace the body of `describe('choosing whose vault to refresh', ...)` in `vault-refresh.test.ts` with:

```ts
describe('choosing whose vault to refresh', () => {
  const rows = [
    { userId: 'alice', agentId: 'a1' },
    { userId: 'alice', agentId: 'a2' },
    { userId: 'bob', agentId: null },
    { userId: 'cara', agentId: 'c1' },
  ];
  const at = (iso: string) => new Date(iso);

  it('visits a student once however many agents they have, and includes one with none', () => {
    expect(studentsToRefresh(rows, new Map())).toEqual(['alice', 'bob', 'cara']);
  });

  it('puts the never-refreshed first, then the stalest', () => {
    const last = new Map([
      ['alice', at('2026-09-07T06:00:00Z')],
      ['bob', at('2026-09-06T06:00:00Z')],
      ['cara', null],
    ]);
    expect(studentsToRefresh(rows, last)).toEqual(['cara', 'bob', 'alice']);
  });

  it('can keep only the overdue', () => {
    const last = new Map([
      ['alice', at('2026-09-07T06:00:00Z')],
      ['bob', at('2026-09-06T06:00:00Z')],
    ]);
    const overdueBefore = at('2026-09-07T00:00:00Z');
    expect(studentsToRefresh(rows, last, { overdueBefore })).toEqual(['cara', 'bob']);
  });

  it('copes with nobody at all', () => {
    expect(studentsToRefresh([], new Map())).toEqual([]);
  });
});
```

Run: `pnpm test apps/api/src/vault-refresh.test.ts` — FAIL.

- [ ] **Step 2: Implement the ordering**

In `vault-refresh.ts` replace `BATCH` and `studentsToRefresh`:

```ts
/** Wait this long after boot before the first pass, so a deploy settles first. */
const AFTER_BOOT = 3 * 60 * 1000;

/**
 * The students to refresh this pass, stalest first.
 *
 * The vault used to belong to an agent, so this loop was over agents, and a
 * student with none was never refreshed. Then it took the first five rows in
 * table order, and a sixth student was never refreshed either. Now every
 * student is listed, those never refreshed come first, and the pass runs
 * down the list until its time budget ends -- so nobody waits for ever, and
 * one wake still cannot run for an hour.
 */
export function studentsToRefresh(
  rows: readonly { userId: string; agentId: string | null }[],
  lastRefreshed: ReadonlyMap<string, Date | null>,
  options: { overdueBefore?: Date } = {},
): string[] {
  const students = [...new Set(rows.map((row) => row.userId))];
  const when = (userId: string) => lastRefreshed.get(userId)?.getTime() ?? 0;
  const due = options.overdueBefore
    ? students.filter((userId) => when(userId) < (options.overdueBefore as Date).getTime())
    : students;
  return due.sort((a, b) => when(a) - when(b));
}
```

- [ ] **Step 3: Cached verdicts, known mail, cached domains, last refresh**

In `refreshOne`:

Replace the `classifyCourses(...)` call so the verdicts are recalled when the question is unchanged:

```ts
const described = [
  ...describeCourses(snapshot, today),
  ...(await describeOrphanCourses(vault, snapshot, today)),
];
const fingerprint = courseFingerprint(described, yearStart, yearEnd, school);
/*
 * Asked only when the question changed.
 *
 * The described courses, the year boundary and the school page are the
 * whole prompt. Same prompt, same rule: the last answer stands, and a
 * quiet pass costs no call here. Held verdicts are never remembered, so a
 * silence is asked again.
 */
const verdicts =
  (await recallCourseVerdicts(vault, fingerprint)) ??
  (await classifyCourses(
    { llm: await ctx.llm.resolve(userId) },
    {
      courses: described,
      today,
      ...(yearEnd ? { yearEnd } : {}),
      ...(school ? { school } : {}),
      userId,
    },
  ));
await rememberCourseVerdicts(vault, fingerprint, verdicts);
```

(`yearStart` must be computed before this block; move `const yearStart = ...` above it if it is not already.)

In the mail block, after `const domains = await discoverSchoolDomains(...)`, add `await updateSyncState(ctx.db, userId, { schoolDomains: domains });` and pass the known ids:

```ts
const known = new Set(
  (await vault.list('episode')).map((note) => note.externalId).filter(Boolean) as string[],
);
const found = await collectSchoolMail(toolContext, { domains, skip: known });
```

At the end of `refreshOne`, before the `return`, add `await updateSyncState(ctx.db, userId, { lastRefreshAt: new Date() });`, and include `${mail.known ?? 0} mail already held` in the summary only if you tracked `found` outside the block; simplest is to add `let mailKnown = 0;` beside `let mail = ...`, set `mailKnown = found.known;` after collecting, and append `, ${mailKnown} mail already held` to the summary.

Imports to add from `@contexto/agent`: `courseFingerprint, recallCourseVerdicts, rememberCourseVerdicts`. From local: `import { updateSyncState, allSyncStates } from './vault-sync-state.js'; import { studentQueue } from './vault-queue.js';`.

- [ ] **Step 4: The pass: ordering, budget, boot, queue**

Replace `startVaultRefresh`:

```ts
export function startVaultRefresh(ctx: AppContext): () => void {
  if (!ctx.env.VAULT_ROOT) return () => {};

  const pass = async (options: { onlyOverdue: boolean }): Promise<void> => {
    try {
      const rows = await ctx.db
        .select({ userId: user.id, agentId: agents.id })
        .from(user)
        .leftJoin(agents, eq(agents.userId, user.id));
      const lastRefreshed = new Map(
        (await allSyncStates(ctx.db)).map((state) => [state.userId, state.lastRefreshAt]),
      );
      const students = studentsToRefresh(
        rows,
        lastRefreshed,
        options.onlyOverdue ? { overdueBefore: new Date(Date.now() - EVERY) } : {},
      );

      // Bounded by time, not by a count: one wake still cannot run for an hour.
      const deadline = Date.now() + ctx.env.VAULT_REFRESH_BUDGET_MINUTES * 60 * 1000;
      for (const userId of students) {
        if (Date.now() > deadline) {
          console.log(
            `[vault] refresh budget spent; ${students.indexOf(userId)} of ${students.length} done`,
          );
          break;
        }
        try {
          const agentId = rows.find((row) => row.userId === userId)?.agentId ?? userId;
          const summary = await studentQueue.run(userId, () => refreshOne(ctx, agentId, userId));
          console.log(`Vault ${userId}: ${summary}`);
        } catch (error) {
          // One student's expired token must not stop the rest.
          console.error(`Vault refresh failed for ${userId}`, error);
        }
      }
    } catch (error) {
      console.error('Vault refresh pass failed', error);
    }
  };

  /*
   * Soon after boot, for the overdue only. A deploy restarts the process,
   * and the old rule of "never on boot" meant a deploy every few hours
   * stopped the refresh from ever running. Only the overdue, so a deploy
   * does not re-import for students refreshed an hour ago.
   */
  const first = setTimeout(() => void pass({ onlyOverdue: true }), AFTER_BOOT);
  const timer = setInterval(() => void pass({ onlyOverdue: false }), EVERY);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
```

Delete the now-unused `BATCH` constant and its comment.

- [ ] **Step 5: Verify**

Run: `pnpm test apps/api/src/vault-refresh.test.ts apps/api/src/vault-refresh.integration.test.ts` and `pnpm typecheck && pnpm lint`. The integration test's fake context has no `VAULT_REFRESH_BUDGET_MINUTES`; it only calls `refreshVaultFor`, which does not read it, and `updateSyncState` runs against the real test database, so it passes.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/vault-refresh.ts apps/api/src/vault-refresh.test.ts
git commit -m "The slow refresh spends only on what changed, and reaches every student"
```

---

### Task 13: Wire it up, and write the runbook

**Files:**

- Modify: `apps/api/src/index.ts` (start the live tier)
- Modify: `deploy/README.md` (a "Live sync" section)
- Modify: `docs/superpowers/specs/2026-09-07-live-vault-sync-design.md` (the two deviations)

- [ ] **Step 1: Start the live tier**

In `apps/api/src/index.ts` import `startVaultLive` from `./vault-live.js` and add after `startVaultRefresh(ctx);`:

```ts
/*
 * And hearing about changes as they happen.
 *
 * Push from Gmail and Drive where the deploy has set it up, a poll timer
 * where it has not. Either way the same sync runs, on the student's own queue.
 */
startVaultLive(ctx);
```

- [ ] **Step 2: Runbook**

Add to `deploy/README.md` a section before "## Subsequent deploys":

```markdown
## Live sync

The vault hears about new mail, Classroom posts and Drive files within about
a minute. Without the steps below it still works, by polling every
`VAULT_LIVE_POLL_MINUTES` (default 5). With them, Google pushes.

### Gmail, via Cloud Pub/Sub

In the same Google Cloud project as the OAuth client:

1. APIs & Services → Enable **Cloud Pub/Sub API**.
2. Pub/Sub → Topics → Create topic `contexto-gmail`.
3. On the topic, Permissions → Add principal
   `gmail-api-push@system.gserviceaccount.com` with role **Pub/Sub Publisher**.
4. Pub/Sub → Subscriptions → Create subscription on that topic, delivery type
   **Push**, endpoint
   `https://contextoagent.ai/api/hooks/gmail?token=<VAULT_HOOK_SECRET>`.
   Generate the secret with `openssl rand -hex 32`.
5. In `.env`: `GMAIL_PUBSUB_TOPIC=projects/<project-id>/topics/contexto-gmail`
   and `VAULT_HOOK_SECRET=<the same secret>`. Restart the API.

Within a minute of boot the API arms a watch for every connected student and
renews it daily. A watch lasts seven days.

### Drive, via a webhook channel

Drive posts to `https://contextoagent.ai/api/hooks/drive`. It needs the
domain registered:

1. Search Console already verifies `contextoagent.ai` (done for OAuth).
2. APIs & Services → **Domain verification** → Add domain → `contextoagent.ai`.

Nothing else. Channels are armed with the Gmail watches and renewed daily.

### Checking it
```

journalctl -u contexto-api -f | grep -E 'Live |\[live\]'

```

Post an announcement on a test course, or create a Google Doc, and watch for
`Live <userId>: ...` within a minute or two.
```

- [ ] **Step 3: Record the deviations in the spec**

In the spec's "Classroom, via Gmail" section replace "the live sync pulls that one course from the Classroom API -- coursework, topics, materials, announcements, submissions, filtered by course --" with "the live sync pulls the Classroom snapshot again -- the tools cannot fetch one course, and the whole snapshot is sixty requests and twenty seconds --". In "Plumbing" delete the `collect.ts` bullet. In "Data" add a row `school_domains | the school's mail domains, found by the slow refresh so the live sync need not read sent mail`. In "Gmail" under Live sync add: "School domains come from the row, found by the slow refresh; discovery reads hundreds of sent messages and must not run per bell."

- [ ] **Step 4: Verify everything**

Run, in order, and fix anything named:

```bash
pnpm format:check || pnpm format
pnpm lint
pnpm typecheck
pnpm test
```

Expected: all green. Then start the API locally against the dev database (`pnpm --filter @contexto/api dev`) and confirm the log shows it listening with no error from `startVaultLive`, and that after five minutes a `Live <id>: ...` line appears for any connected local account, or `not ready: ...` for one that is not.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/index.ts deploy/README.md docs/superpowers/specs/2026-09-07-live-vault-sync-design.md
git commit -m "Start the live tier, and say how to plug Google into it"
```

---

## Self-review

**Spec coverage.** Live Gmail as doorbell: Task 1 + 10. Classroom via Gmail and deterministic episodes: Tasks 2, 10. Drive change token, additive import, removals, 20-file cap, blank-then-filled path: Tasks 3, 4, 10. Debounce and poll fallback: Task 10. Slow refresh: known ids (Task 12), cached verdicts (5, 12), user.md skip (6), ordering + budget + boot (12), queue (8, 12). Push infrastructure, renewal, threat model: Tasks 10, 11, 13. Data table and env: Tasks 7, 9. Failure handling: token reset in Task 10, 401/204 in Task 11, per-student try/catch in Tasks 10 and 12. Not in scope items untouched.

**Type consistency.** `Sources` is `{ gmail: boolean; drive: boolean }` in Tasks 10 and 11. `SyncPatch` fields match the schema column names in camelCase. `collectSchoolMail` options `newerThan`/`skip` used in Tasks 10 and 12 match Task 1. `readFileContents` `only` (Task 4) used in Task 10. `studentsToRefresh` new signature (Task 12) matches its tests.

**Known judgement calls for the implementer.** Where a test helper name such as `freshVault()` is used, reuse the file's existing helper or add the three-line `mkdtemp` version shown in Task 2. Where the plan says "find the existing export line", extend it rather than adding a duplicate export.
