---
description: Wipe a test account back to a never-used state (backs up, revokes Google, deletes)
argument-hint: [email]
allowed-tools: Bash(./scripts/reset-account.sh:*), Bash(ssh:*)
---

Reset the account for: **$1**

Run `./scripts/reset-account.sh $1` and report what it did.

If no email was given, ask which account rather than guessing — the script
refuses a default for the same reason.

The script backs up to `/srv/contexto/backups/` before deleting anything, and
revokes the Google grant so the next sign-in shows a real consent screen
rather than silently re-approving. Point out the backup path in your summary,
and if it prints a note about unlimited usage, pass that on — that flag lives
on the deleted row and has to be restored by hand after they sign back in.
