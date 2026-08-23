# Graph memory

**Status:** designing, not approved
**Date:** 2026-08-23

The agent's memory of a student becomes a vault of linked markdown files rather
than a log of exchanges. Notes reference each other; the ones referenced most
are the ones the agent knows best. Time is a real axis through the vault, not a
decay weight, and the whole thing is eventually something a student can look at.

## The idea, as it was described

A web of markdown files, Obsidian-style, each file a circle in a graph, sized
by how many other files link to it. Laid out as a cylinder on its side: time
along the long axis, the most-linked files in the core, sparser ones toward the
surface. The agent consults it; the student can see it.

Two properties in that are load-bearing and worth stating separately from the
geometry, because they are what actually change the product.

**Importance is measured, not assumed.** Today's selection policy is "the last
eight exchanges", which uses recency as a proxy for importance. Recency is a bad
proxy: yesterday's small talk outranks the fact that their chemistry teacher is
Mr Ali. A note that thirty others point at is important by evidence.

**The memory is inspectable.** `skills/types.ts` already argues that the
artefact of an agent's improvement "should be inspectable rather than buried in
weights or an ever-growing prompt". A student who can read what their agent
believes about them, and delete a line of it, is being offered something no
other study tool offers.

## Where this sits in what exists

Letta's three-tier framing is the clearest way to see the gap. Core memory is a
small bounded block pinned in the prompt; recall memory is conversation history
outside it; archival memory is queried by tool call.

| Tier                         | StudentOS today | Cost                       |
| ---------------------------- | --------------- | -------------------------- |
| Core — always in the prompt  | **missing**     | —                          |
| Recall — recent history      | 8 exchanges     | ~751 tokens/turn, uncached |
| Archival — queried on demand | `memory_search` | free until called          |

The recall and archival tiers were built on 2026-08-23 and work. The core tier
has never existed: nothing durable about a student is ever in the prompt unless
it happens to fall inside the last eight exchanges. That is the hole this fills,
and `summarize.ts` — a stub returning `{ summarized: 0 }` since the beginning —
is where the filling goes.

## Why this shape

Zep's Graphiti is the current state of the art for agent memory as a temporal
knowledge graph, at 94.8% on Deep Memory Retrieval. Its architecture arrived at
the same split proposed here, independently, and adds two things worth taking.

**Three subgraphs, not two.** Episodes (raw events, timestamped, never
rewritten), entities (extracted, persistent, linked), and communities (clusters
of densely-connected entities, maintained by label propagation). The third tier
is what the cylinder's unassigned angular dimension is for: cluster determines
bearing, so each subject becomes a visible thread running the length of the
vault.

**Facts expire.** Graphiti is bi-temporal — every edge records when the fact was
true and when it was learned, with explicit `t_valid` and `t_invalid`
intervals. Superseded facts are invalidated rather than deleted, so history
stays reconstructable.

For a student this is not a nicety. Teachers change mid-year, subjects get
dropped, deadlines pass. A memory that only knows a fact exists will state
confidently that Mr Ali teaches chemistry six months after he left. A memory
that knows when a fact was true will not.

**Retrieval makes no model calls.** Graphiti reaches P95 300ms by combining
keyword search, embeddings and graph traversal, with no LLM in the retrieval
path. Whatever we build must keep that property: the student is waiting.

## The vault

```
/srv/contexto/vaults/<agent-id>/
  entities/
    mr-ali.md
    chemistry.md
    epq.md
  episodes/
    2026-08-23-1430-mock-exam-panic.md
```

Files are the truth. Not a projection of rows — the vault is what exists, and
anything derived from it (a link index, centrality scores) is a cache that can
be deleted and rebuilt by walking the directory.

This was chosen over Postgres rows deliberately, with the costs understood:
centrality means reading the vault rather than querying an index, and running
on more than one box will eventually mean a shared volume. In exchange, the
memory is directly readable over SSH during development, and a student could one
day be handed the actual folder — their second brain, in a format that opens in
real Obsidian, that they own whether or not they keep using this product.

Frontmatter follows the convention `prompts/documents.ts` already established:
`name` and `description`, plus `kind`. The two markdown systems in the codebase
should parse alike.

### Entities

One per thing that persists. A person, a subject, an assignment, a preference.
The body is prose the agent wrote about it. `aliases` matters more than it
looks — see entity resolution below.

```markdown
---
name: mr-ali
kind: entity
description: Chemistry teacher, Year 12
aliases: [Mr Ali, Ali, my chem teacher, Mr. Ali]
---

Teaches chemistry. Posts to Classroom late, often the evening before
something is due. Marks harshly on method rather than answers.
```

### Episodes

One per conversation. A point in time that never moves and is never rewritten —
the ground truth corpus, in Zep's terms. Links outward to the entities it
touched, at most three of them.

```markdown
---
name: 2026-08-23-1430-mock-exam-panic
kind: episode
description: Panicking about the chemistry mock, wanted a revision plan
occurred: 2026-08-23T14:30:00Z
---

Asked for help two days before the [[chemistry]] mock. Had not started.
[[mr-ali]] had set past papers that were never opened.
```

An entity's position through time is derived, never stored: its thread is the
set of dates of the episodes linking to it. Nothing to drift out of sync.

## Entity resolution is the whole problem

Everything else here is mechanical. This is the part that decides whether the
vault becomes a knowledge graph or a junk drawer.

The literature is unambiguous. LLMs produce duplicate entities _even at
temperature zero_ — the same candidate set and prompt can produce "merge" on one
call and "create new" on the next. Left unresolved, a graph fragments into
`mr-ali`, `mr.-ali`, `ali`, `chemistry-teacher`, four files, none linked, each
holding a quarter of what is known. Published pipelines report that resolution
cuts graph size by around 40% while improving answer quality.

**With files, the slug is the identity**, which makes this sharper than it is
for a database. Choosing a filename _is_ deciding what exists. Merging after the
fact means rewriting every inbound wikilink across the vault.

So resolution happens before a filename is chosen, never as a later cleanup:

- The writer is shown existing entity names, descriptions and **aliases**, and
  must justify creating rather than matching. Aliases are the cheap fix for most
  duplication: "Mr Ali", "my chem teacher" and "Ali" resolve to one file.
- Structure is a resolution signal on its own. Two candidate entities sharing
  most of their neighbours are usually the same thing, regardless of how their
  names compare.
- Merging is a real operation with a test: rewrite inbound links, leave a
  tombstone so nothing dangles.

The link budget — at most three per episode — exists for the mirror-image
failure. Unconstrained, a model links everything to everything, centrality
flattens, and the core/periphery distinction the whole design rests on
dissolves. Obsidian graphs are sparse because a human pays to type each link;
automated linking needs an artificial equivalent of that cost.

## Reading

Per turn, the core block carries the highest-centrality entity notes under a
**hard character cap**, Hermes-style. The cap is not a tuning parameter. Hermes
runs its entire persistent memory in 3,575 characters, and the bound is what
forces curation rather than accumulation. Uncapped, this grows back into the
flat log that was just bounded.

Beyond the cap, `memory_search` extends to search notes and walk one hop of
links. No model call in the retrieval path.

Centrality starts as plain in-degree. PageRank only if in-degree measurably
fails to discriminate — at a few hundred notes it very likely will not.

## Staging

This is Zep-scale work and cannot be one build. Each stage has to earn the next
by measurement, in the order that de-risks fastest.

**1. Memory evals.** LongMemEval's five abilities, adapted to a student:
information extraction, multi-session reasoning, knowledge update, temporal
reasoning, and abstention — declining to invent a fact never given. Measure the
current system to get a baseline. Nothing after this is meaningful without it.

**2. A flat core block.** Implement `summarize.ts` as a bounded student profile
under a hard cap, with no graph, no links, no files. One day's work. It fills
the missing tier and, crucially, becomes the control the graph must beat: if a
1,400-character profile captures most of the recall improvement, the graph has
to justify itself against that rather than against nothing.

**3. The vault.** Entities and episodes as files, with resolution as the
centrepiece. Centrality replaces recency for choosing the core block.

**4. Communities and validity.** Clustering for the angular dimension, and
bi-temporal edges so stale facts stop being asserted.

**5. The cylinder.** A crude force-directed view first, to check the graph is
sane and has edges at all; the real thing once it is.

## How we would know it works

The formatting evals cannot see any of this — they are single-turn. Memory needs
its own corpus of multi-session scenarios where something established early is
referenced much later, scored the same way: deterministically, with the checkers
themselves tested.

The abstention category deserves particular attention. An agent that confabulates
a teacher's name it was never told is worse than one that forgets, and a recall
metric alone rewards confident invention.

## Out of scope

Embeddings and semantic similarity — in-degree and substring matching should be
tried and shown insufficient first, at this scale. Entity-to-entity links, until
there is real data showing which clusters actually form. Sharing or comparing
vaults between students. Any student-facing editing of the vault before there is
something worth editing.

## Risks

**One droplet.** The vault is local disk. Horizontal scaling means a shared
volume or a migration, and that decision was accepted knowingly rather than
overlooked.

**Path traversal.** Note titles become filenames, and the agent writes those
titles after reading web pages, emails and school portals — all untrusted. Every
write slugifies, resolves, and verifies the path is still inside the vault, with
a test that tries to escape. Writes are temp-file-then-rename so a crashed job
cannot leave half a note.

**Backup.** Postgres has a backup story; the vault does not yet. Making each
vault a git repository would give history, diffing and revert for free, and
would let a student see exactly what their agent changed about them last week —
worth considering, not yet decided.

**Cost.** One extra model call per conversation, off the critical path. Cheap
against per-turn, but it grows with conversation volume rather than with
students, which is the wrong axis to be surprised by.
