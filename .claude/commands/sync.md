---
description: Update this clone to the latest on origin and verify it still runs (install, migrate, CI checks)
argument-hint: [branch] [--quick]
allowed-tools: Bash(./scripts/sync.sh:*), Bash(git status:*), Bash(git log:*), Bash(git diff:*)
---

Run `./scripts/sync.sh $ARGUMENTS` and tell me where things stand.

With no branch it updates the one I'm on; a branch name switches to it first.
`--quick` skips the tests and the build.

The script is deliberately unwilling to guess: it stops on a dirty tree or a
branch that has diverged from origin rather than stashing or rebasing. If it
stops for either reason, show me what's actually there — `git status --short`,
or `git log --oneline --left-right HEAD...origin/<branch>` — and let me decide.
Don't pick a resolution yourself.

Everything after the pull is graded rather than fatal, so a failure is a
finding, not a stopped script. Read the summary it prints at the end:

- Failures under **Not ready yet** are what to fix. Say whether each one looks
  like this machine (Docker down, missing `.env` values, no SSH key) or like the
  branch itself (type errors, failing tests) — the second kind isn't mine to fix
  by setting something up.
- **Worth knowing** notes are informational. Pass on anything that needs me: a
  generated `.env` still missing `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`
  means Google sign-in won't work until I paste the real ones in, and no amount
  of rerunning changes that.

If it all passes, one line is enough — the branch, the commit, and that it's
ready.
