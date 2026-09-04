import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { agents } from './agents.js';

/**
 * The verbatim conversation transcript.
 *
 * Deliberately separate from agent_memories, which is tempting to reuse and
 * would be a mistake. They have opposite lifecycles:
 *
 *   transcript  complete, verbatim, permanent -- it is the student's record of
 *               what they said, and deleting any of it is a bug
 *   memory      curated and lossy by design -- the summarisation job collapses
 *               old episodic rows precisely so context stays affordable
 *
 * Storing messages as memories means the summariser eventually eats the chat
 * history. Storing memories as messages means every context assembly has to
 * re-derive what matters. Keep them apart.
 */
export const agentMessages = pgTable(
  'agent_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    /** 'user' | 'assistant' -- only what the student actually sees. */
    role: text('role').notNull(),
    content: text('content').notNull(),
    /** Tool ids invoked while producing this message, for UI attribution. */
    toolsUsed: jsonb('tools_used').$type<string[]>().notNull().default([]),
    /**
     * Files the student attached to this message.
     *
     * Stored on the message rather than derived from its text, because the
     * text is what they typed and this is what they sent with it. It is what
     * lets a conversation reopened next term still show the photograph above
     * the question about it, rather than a filename in a sentence.
     */
    attachments: jsonb('attachments')
      .$type<{ name: string; filename: string; image: boolean }[]>()
      .notNull()
      .default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('agent_messages_agent_created_idx').on(t.agentId, t.createdAt)],
);
