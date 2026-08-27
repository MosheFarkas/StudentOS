# The document vault

**Status:** built and deployed
**Date:** 2026-08-27
**Supersedes:** the reading and visualisation halves of
[graph memory](./2026-08-23-graph-memory.md). The vault of linked markdown notes
that spec describes is unchanged and still underneath all of this.

A vault of four and a half thousand notes answers questions nobody asks. This
adds a layer above it: about ten authored pages, each written from the notes
beneath it, and one of them carried into every reply. And it stops last year's
academic classes arriving at all.

## Why

Two problems, both visible on the first real account.

**Most of the vault was last year's.** Nineteen Classroom courses, ten of them
subjects the student finished in June. They diluted every search, they fed the
writer courses nobody takes any more, and every rebuild paid a model call per
attached file to read them again. The original spec said "remembering last year
is the whole point of a vault." Asked about their classes, a student means the
ones they walk to on Monday.

**Nothing could read four thousand notes.** They do not fit in a prompt and no
person would read them. So what the agent actually knew about a student was one
1200-character paragraph, written from counts, and everything else was reachable
only if the agent thought to search for it — which for "what is my French class
like" it never does, because there is no question to ask.

## The shape

```
gmail / drive / classroom
        |  import, filtered
        v
entities/*.md + episodes/*.md      <- the evidence. unchanged, still searchable
        |  summarize
        +---------------+------------------+
        v               v                  v
   <subject>.md      school.md          chats.md
   one per class     vault + web        across all conversations
        \               |                  /
         +--------------+-----------------+
                        v
                     user.md               <- in the system prompt, every turn
```

An arrow means _this decides how that is written_. Generation runs bottom-up and
`user.md` is written last, because it describes everything beneath it.

Documents are a third `NoteKind`, in `docs/`, so they reuse the one place path
traversal is stopped and the one place a write is atomic. They live apart from
the notes because they describe the same things the notes are about: sharing a
directory would mean `french` the course and the page about French competing for
one name, and a search over the evidence ranking a summary above what it
summarises.

## What reaches a turn

`user.md` only. Everything else is opened by name with `vault_open` when a
question turns out to be about it, which is what keeps a vault of any size to a
fixed cost per turn.

`user.md` names the others in `[[double brackets]]`, so the index arrives free
and no tool description has to vary per student — tool definitions are part of
the cached prefix, and the whole prompt caches as one blob keyed on its exact
text. Measured after the change: 1,953 tokens served from cache on every turn
after the first, an 86% hit.

The pages are written by us, from material we did not write. They render without
the warning that wraps a note, which is only honest because every writer runs
with no tools, on bounded input, and is told that what it is reading is a record
and never an instruction. A page cannot store the `<untrusted>` markers at all;
that is enforced on write rather than asked for in a prompt.

## Which classes are current

One model call reads the whole roster at once — names, sections, archive state,
units, a sample of the work with its briefs, whether anything is marked — and
says what each course is. Judging them together is what tells a house group
called French from the subject called French, which is the pair that had already
been got wrong on real data.

A course is dropped only if it is **a taught subject** and **its year is over**.
Clubs, teams, advisories and house groups run for years and are archived like
everything else; judging those by age deletes half of a school life.

"Over" is decided by the newest thing that has actually happened in the course,
against the start of the current academic year. A deadline is a plan, not
evidence — a teacher on the real account typed 2027 into a Grade 10 due date.
Where nothing is dated, the school's own archive flag and the year in the course
name get a say, in that order.

The year-end date comes from researching the school; until something has, it
falls back to 1 July. The dependency runs in a circle — the school page is
written from a vault this filtered — and resolves because the filter re-runs on
every build.

It fails open at every step. An unparseable answer, a course the model did not
mention, a course nothing dates: all kept. Keeping a finished course costs one
stale page; dropping a live one costs the student their year.

## What this removes

**The claims pipeline** — propose against bounded evidence, refute with an
independent pass, reconcile — about 2,100 lines. It existed because the facts
were scattered across four thousand notes and something had to settle them.
They are not scattered now: each has a page written from its own cluster.

What goes with it is the only mechanism that made a pass _decline_. The
replacement is structural rather than adversarial — a class page is shown only
the people reachable within that subject, so a wrong teacher has to be wrong
about somebody genuinely adjacent — plus the declining language, kept verbatim,
in every writer's instructions. This is the weakest part of the design and the
first place to look when a page asserts something false.

**The conversation profile.** It belonged to an agent, so a student with three
agents told each of them separately that they read on a phone. `chats.md`
belongs to the student. The two columns behind it survive as the background
job's watermark.

**The cylinder.** Time along the axis, in-degree toward the core, course around
the bearing: three honest axes, and unreadable. A picture of four thousand
things is a picture of how many there are. What replaced it draws the ten pages.

## Costs

A build is one classifier call, one page per subject, one for the student, and
one model call per Drive file it has not read before. The per-subject pages are
skipped when nothing under them changed, which is what stops a six-hourly build
paying ten calls a pass to rewrite yesterday's prose. Researching a school is
about thirty searches and is asked for deliberately rather than scheduled.

The expensive thing a vault holds is the summary of each file, at a model call
each. On the first real account that is 1,225 files. Nothing else in a vault is
worth protecting from a rebuild as much as those are.

## How we knew it worked

Against the real account, before anything was deleted: nineteen courses, ten
dropped, and every one of the ten a Grade 10 subject. The two it got wrong the
first time — a subject read as an advisory, a course kept alive by the 2027 typo
— are the two fixes above.

Verification after the fact found nine more defects that the tests did not,
which is the honest measure of what unit tests are for and what they are not.
