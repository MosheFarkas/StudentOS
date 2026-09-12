# Twenty general skills

Twenty built-in skills join browser, vault-reading and vault-writing. Each is a prompt document loaded on demand through `skill_load`, named for the job rather than the artefact, and written so that every request has one obvious home. The catalog and its evidence are in the two research memos published alongside this work; this is the record of what shipped and the rules it follows.

## The twenty

Learning: tutoring, reading, problem-solving, practice, feedback, study-skills. Making: writing, research, presenting, data, brainstorming. Organising: planning, progress, communication, admin, group-work, submitting. Life: applications, decisions, wellbeing.

The three existing skills are not in the groups. They say how to reach something (a site, the vault, a note), and any of the twenty loads one alongside: a planning turn loads planning and vault-reading, a research turn loads research and browser.

## The rules

1. **Named for the job.** feedback, not draft-feedback; practice, not exam-prep; reading, not study-notes. A skill covers every artefact its job applies to.
2. **One stage each.** writing does not judge and feedback does not draft; planning is what comes next and progress is where they stand.
3. **Every trigger names its neighbours.** Each description says what to load it for and then what it is not for, naming the skills it is not, so the model chooses between two named things rather than guessing. Every description begins "Load" and carries a "Not for" clause; a test holds this.
4. **Universal, none gated.** Each works for a student who has connected nothing, by asking for what it cannot fetch, so the block is byte-identical for everyone in the same vault situation. Gating on Classroom or Gmail was considered and rejected: a draft is still useful without the tool to send it, and every gate is another prompt variant in the cached prefix.
5. **The always-on document is not restated.** responding.md settles tone, plain-text replies, and how far to go on graded work. A skill refers to those in a sentence and never repeats them.
6. **Bodies are 700 to 1,000 words**, prose, in the voice of the three existing skills, with every rule carrying its reason and tools named by exact id. Each says what to do when a source is missing and closes with how to talk about what was done.
7. **Skills that compose others say so.** applications hands essays to writing and references to communication; group-work hands its own parts to writing, data and presenting.

## Cost and measurement

The skills block with all twenty-three is about 7,700 characters, roughly 1,900 tokens, in the cached prefix. The routing eval (`pnpm --filter @contexto/agent eval:skills`) has 28 cases: the original eight plus one per new skill, each written to sit near its closest neighbour with that neighbour in `noLoad`. First run: 26 of 28 held, every new case loading its intended skill; the two misses loaded a neighbour as well, and the reading and group-work triggers and the block's intro were tightened in response.

## Plumbing

- `packages/agent/src/prompts/<name>.md`, twenty files.
- `packages/agent/src/prompts/documents.ts`: twenty exports. `packages/agent/src/skills/builtin.ts`: `GENERAL`, listed between browser and the vault skills.
- `packages/agent/src/skills/builtin.test.ts`: the order, the availability, the trigger shape.
- `packages/agent/src/evals/skill-choice.ts`: the twenty cases.

## Not in scope, and what would unlock it

Support files loaded on demand (citation styles for research, rubrics for feedback); a Google Calendar scope so planning can write the week; deck and review state so practice has real spaced repetition; a spreadsheet tool for data beyond a page of numbers; agent-written skills into the `agent_skills` table for per-school procedures.
