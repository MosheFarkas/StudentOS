# The reading feed: what the agent read, on screen

When the agent loads a skill, the student sees it: a row above the thinking line saying "Reading skill" with the skill's name while the turn runs, and the same row, as "Read skill", above the reply for as long as the conversation exists. The pattern is Hermes Agent's tool feed, kept in scrollback, and a search assistant's "Searched the web".

## Why

Loading a skill is the one step a student can recognise. "Running skill_load" means nothing to them; "reading the vault-reading skill" says the agent consulted its notes on their vault before answering about their vault, and that is a reason to trust the answer.

## The rule

1. **The turn reports the skill, not the tool.** `runAgentTurn` reports `{ kind: 'skill', name }` before running `skill_load`, in place of the tool report, and only for a skill this student actually has: a wrong name or a vault skill without a vault stays an ordinary tool call, so the student is never told the agent read something it did not.
2. **The turn hands the names back.** `AgentRunResult.skillsRead`, in order, each once.
3. **The registry keeps a list, not a step.** Reading a skill is over in milliseconds, and the poll runs every few seconds, so `turns-in-flight` keeps `skills: string[]` beside the current activity and drops it with the turn. `GET /agents/:id/messages` returns it as `skills`.
4. **The reply keeps them.** `agent_messages.skills_read`, jsonb, default empty; `Message.skillsRead` on the shared schema; migration `0016_messages_skills_read`.
5. **The chat shows both.** The live list above the thinking line, emptied the moment the reply lands, and the persisted list above every assistant message. Chrome face, faint ink, the name in a chip: the product reporting a step, not the agent speaking.

## Plumbing

- `packages/shared/src/agent.ts`: `agentActivitySchema` gains `skill`; `messageSchema` gains `skillsRead`.
- `packages/agent/src/tools/skills.ts`: `skillRequested(call, situation)`.
- `packages/agent/src/run.ts`: reports and returns.
- `apps/api/src/turns-in-flight.ts`: `turnSkills`. `apps/api/src/routes/agents.ts`: `skills` on the poll. `apps/api/src/agent-turn.ts`: saves and maps `skillsRead`.
- `packages/db/src/schema/messages.ts` and migration 0016.
- `apps/web/src/screens/SkillsRead.tsx`, `Chat.tsx`, `index.css`; `lib/thinkingPhrases.ts` keys and themes the new kind.
