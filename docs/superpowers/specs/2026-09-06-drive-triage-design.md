# Every Drive file judged

Approved 2026-09-06. A student who connects Drive has handed over the whole of it; the vault should decide about every file in it, not only the ones filed under a course folder.

## Why

The importer keeps a Drive file only when a folder on its path names a course the student takes. The title and the contents are never consulted at that gate. It was the right first rule for a Drive with a thousand loose files, but it throws away the personal half of a Drive that is about school -- a CAS brainstorming document, an application, revision notes with no folder. Full read access is already granted when Drive is connected (the elective `drive.readonly` scope, on by default), so the listing sees everything and the gate is the only thing in the way.

## The rule

Every listed file is judged. Judgement decides whether it stays and what it links to.

1. **Passed over without judgement:** folders, shortcuts, files Classroom already knows (they carry more), and files last changed before last school year began -- the same window the courses use.
2. **A folder that names a course** places the file, as today. No model call.
3. **Everything else is triaged** in batches of about fifty, on metadata alone: name, file type, whether the student owns it or who shared it, the folder if visible, when it last changed. The model is shown the student's courses and the school page, which names programmes such as CAS, and answers per file: keep or not, and the one course it plainly belongs to, or none. Keep what is about their schooling -- coursework, revision, projects, applications, programmes and clubs. Leave out what is not -- photographs, music, games.
4. **A kept file becomes a note** as today. Linked `Part of [[course]]` when triage named one. A kept file with no course carries the line _About your schooling, though not one course's._, and the loose-file sweep spares any file carrying it.
5. **The reading pass** then opens every kept file it has not read, one model call each, and writes its sentence. It can still link a file to a course from its contents. It already trickles at 40 files per timer pass and reads everything on a full build.
6. **Verdicts are remembered** in `drive-judged.json` at the root of the vault directory, keyed by file id with the last-changed time and the verdict. A file is asked about again only when it has changed. A batch whose answer cannot be read leaves its files unjudged: nothing kept, nothing remembered, asked again next refresh.

## Cost

One triage call per fifty files, on names. One read call per kept file, paid once. A Drive of five hundred files is about ten triage calls and perhaps a hundred or two reads.

## Not in scope

Reading contents before deciding. The reading pass does that for what stays, and it is ten times the cost for the ambiguous minority.

## Plumbing

- `packages/agent/src/vault/drive-triage.ts`: `judgeDriveFiles({ llm }, { vault, files, today, yearStart, school?, userId })` returns a map of file id to `{ keep, course }`, reading and writing the ledger.
- `packages/agent/src/vault/drive.ts`: `importDrive(vault, files, judged?)` keeps a folder-placed file as before, a judged-in file with its course or the loose line, and skips the rest. Exports the loose line.
- `packages/agent/src/vault/courses.ts`: `sweepUnattachedFiles` spares a file carrying the loose line.
- `apps/api/src/vault-refresh.ts`: judges before importing, handing over the school page and the year boundary it already has.
