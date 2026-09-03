import { describe, expect, it } from 'vitest';
import { groupByStudent } from './grouping.js';

/**
 * One page per student, however many chats they had.
 *
 * This is the join the memory model rests on. What a student tells their agent
 * is kept once, on a page of their own -- chats.md -- so a new chat opens
 * already knowing them. The staleness query underneath works per chat, and the
 * gap between those two facts is closed here and nowhere else.
 *
 * It used to be a modest concern: a student had two or three agents. Now that
 * a chat is an agent, an afternoon of short conversations is a dozen rows out
 * of that query, and the difference between grouping them and not is a dozen
 * model calls racing to overwrite one file.
 */
const chat = (agentId: string, userId: string) => ({ agentId, userId });

describe('gathering a student’s stale chats', () => {
  it('puts every chat of one student under that student', () => {
    const grouped = groupByStudent([chat('c1', 'lucas'), chat('c2', 'lucas'), chat('c3', 'lucas')]);

    expect([...grouped.keys()]).toEqual(['lucas']);
    expect(grouped.get('lucas')).toEqual(['c1', 'c2', 'c3']);
  });

  it('keeps one student’s chats out of another’s page', () => {
    const grouped = groupByStudent([chat('c1', 'lucas'), chat('c2', 'sam'), chat('c3', 'lucas')]);

    expect(grouped.get('lucas')).toEqual(['c1', 'c3']);
    expect(grouped.get('sam')).toEqual(['c2']);
  });

  it('yields one entry per student, which is one page written per student', () => {
    // The count is the point: it is exactly the number of model calls the
    // pass will make, and the number of times chats.md is rewritten.
    const grouped = groupByStudent(
      Array.from({ length: 12 }, (_, i) => chat(`c${i}`, i % 2 === 0 ? 'lucas' : 'sam')),
    );

    expect(grouped.size).toBe(2);
    expect(grouped.get('lucas')).toHaveLength(6);
    expect(grouped.get('sam')).toHaveLength(6);
  });

  it('keeps the order the query returned them in', () => {
    // Exchanges are handed to the writer oldest first, and that ordering
    // starts here.
    const grouped = groupByStudent([chat('c3', 'lucas'), chat('c1', 'lucas'), chat('c2', 'lucas')]);
    expect(grouped.get('lucas')).toEqual(['c3', 'c1', 'c2']);
  });

  it('has nothing to do when no chat has gone quiet', () => {
    expect(groupByStudent([]).size).toBe(0);
  });
});
