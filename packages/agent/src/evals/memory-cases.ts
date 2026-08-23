import type { MemoryCase } from './memory-grader.js';

/**
 * Scenarios that only a memory can answer.
 *
 * Each history is long enough that the fact being asked about has fallen out
 * of the eight-exchange recency window. That is the point: these measure
 * whether anything rescues a fact the window has dropped, which today means
 * memory_search and nothing else.
 *
 * The filler is deliberately ordinary school chatter rather than padding. A
 * window full of obviously irrelevant text is an easier problem than a window
 * full of plausible near-misses, and the easier problem is not the one a real
 * student produces.
 */

/** Twelve exchanges of ordinary noise, enough to push anything before it out. */
const FILLER: string[] = [
  'Student: whats the weather like tomorrow\nAgent: Rain in the morning, clearing by lunch.',
  'Student: how many sig figs in 0.00450\nAgent: Three. The leading zeros do not count.',
  'Student: can you convert 5 miles to km\nAgent: About 8 km.',
  'Student: whats 15% of 240\nAgent: 36.',
  'Student: how do i spell necessary\nAgent: n-e-c-e-s-s-a-r-y. One c, two s.',
  'Student: whats the capital of norway\nAgent: Oslo.',
  'Student: when do the clocks change\nAgent: Last Sunday in October, they go back an hour.',
  'Student: how long should a paragraph be\nAgent: Long enough to make one point properly.',
  'Student: whats the boiling point of water in fahrenheit\nAgent: 212 degrees.',
  'Student: is it affect or effect\nAgent: Affect is the verb, effect is the noun, nearly always.',
  'Student: how many days until christmas\nAgent: A long way off yet.',
  'Student: whats a good study playlist\nAgent: Something without lyrics tends to work better.',
];

export const MEMORY_CASES: MemoryCase[] = [
  // --- Information extraction: one fact, stated once, long ago. ---
  {
    id: 'teacher-name',
    category: 'extraction',
    history: ['Student: my chemistry teacher is Mr Ali\nAgent: Noted.', ...FILLER],
    question: 'whats my chemistry teacher called again',
    expect: ['Ali'],
  },
  {
    id: 'revision-habit',
    category: 'extraction',
    history: [
      'Student: i revise by rewriting my notes, rereading does nothing for me\nAgent: Understood.',
      ...FILLER,
    ],
    question: 'whats the best way for me to revise for this',
    expect: ['rewriting'],
  },
  {
    id: 'sport-clash',
    category: 'extraction',
    history: [
      'Student: i have football training every tuesday and thursday evening\nAgent: Got it.',
      ...FILLER,
    ],
    question: 'what evenings am i busy',
    expect: ['Tuesday', 'Thursday'],
  },

  // --- Multi-session reasoning: two facts, different points in time. ---
  {
    id: 'date-clash',
    category: 'multi-session',
    history: [
      'Student: my EPQ is due on the 14th\nAgent: Noted.',
      ...FILLER.slice(0, 6),
      'Student: just found out my chemistry mock is on the 14th as well\nAgent: Noted.',
      ...FILLER.slice(6),
    ],
    question: 'is anything clashing for me on the 14th',
    expect: ['EPQ', 'chemistry'],
  },
  {
    id: 'subject-count',
    category: 'multi-session',
    history: [
      'Student: im taking chemistry and history this year\nAgent: Noted.',
      ...FILLER.slice(0, 6),
      'Student: i picked up economics as a third subject\nAgent: Noted.',
      ...FILLER.slice(6),
    ],
    question: 'what subjects am i taking',
    expect: ['chemistry', 'history', 'economics'],
  },

  // --- Knowledge update: the corrected fact must win. ---
  {
    id: 'teacher-changed',
    category: 'update',
    history: [
      'Student: my chemistry teacher is Mr Ali\nAgent: Noted.',
      ...FILLER.slice(0, 6),
      'Student: mr ali left at half term, we have ms okonkwo now\nAgent: Noted.',
      ...FILLER.slice(6),
    ],
    question: 'who teaches me chemistry',
    expect: ['Okonkwo'],
    reject: ['Ali'],
  },
  {
    id: 'deadline-moved',
    category: 'update',
    history: [
      'Student: my history essay is due friday\nAgent: Noted.',
      ...FILLER.slice(0, 6),
      'Student: the history essay got pushed back to wednesday the week after\nAgent: Noted.',
      ...FILLER.slice(6),
    ],
    question: 'when is my history essay due',
    expect: ['Wednesday'],
    reject: ['Friday'],
  },

  // --- Temporal: resolving a relative reference to a past conversation. ---
  {
    id: 'last-discussed',
    category: 'temporal',
    history: [
      'Student: i want to do my EPQ on antibiotic resistance\nAgent: Strong topic.',
      ...FILLER,
    ],
    question: 'what topic did i say i wanted for my EPQ',
    expect: ['antibiotic resistance'],
  },
  {
    id: 'first-mentioned',
    category: 'temporal',
    history: [
      'Student: i failed my first chemistry mock in october\nAgent: That is recoverable.',
      ...FILLER,
    ],
    question: 'when did i say i failed my first chemistry mock',
    expect: ['October'],
  },

  // --- Abstention: never mentioned, must not be invented. ---
  {
    id: 'no-music-teacher',
    category: 'abstention',
    history: ['Student: my chemistry teacher is Mr Ali\nAgent: Noted.', ...FILLER],
    question: 'whats my music teacher called',
    abstain: true,
  },
  {
    id: 'no-sibling',
    category: 'abstention',
    history: [...FILLER],
    question: 'whats my sisters name again',
    abstain: true,
  },
  {
    id: 'no-exam-date',
    category: 'abstention',
    history: ['Student: im taking chemistry and history this year\nAgent: Noted.', ...FILLER],
    question: 'what date is my history exam',
    abstain: true,
  },
];
