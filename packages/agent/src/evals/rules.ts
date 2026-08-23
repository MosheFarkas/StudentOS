/**
 * What counts as the agent breaking its own formatting rules.
 *
 * These are the measuring instrument for prompts/responding.md. Every rule
 * here corresponds to a sentence in that document, and every one is decided by
 * a regular expression rather than by judgement -- a rule that needs a model to
 * adjudicate it is a rule that cannot tell us whether the model improved.
 *
 * The distinction between the two severities is worth keeping. A `rendering`
 * violation is something the student literally sees as garbage on screen,
 * because nothing in this product renders markup. A `voice` violation reads
 * fine but sounds like a chatbot. The first is a bug; the second is a
 * regression in tone. Scoring them together would let a drop in one hide a
 * rise in the other.
 */

export type Severity = 'rendering' | 'voice';

export interface FormattingRule {
  id: string;
  severity: Severity;
  /** What the student sees when this fires. Printed in the report. */
  symptom: string;
  /** Offending excerpts, empty when the reply is clean. */
  find(reply: string): string[];
}

/** Collect matches, trimmed and capped so a report line stays readable. */
function excerpts(reply: string, pattern: RegExp): string[] {
  return [...reply.matchAll(pattern)].map((m) => m[0].trim().replace(/\s+/g, ' ').slice(0, 60));
}

/**
 * Single-asterisk emphasis, without catching multiplication.
 *
 * `3 * 4` is maths the document explicitly asks for, and a pattern that just
 * looks for a pair of asterisks eats it. Requiring a non-space immediately
 * inside both asterisks separates emphasis from multiplication cleanly.
 */
const ASTERISK_EMPHASIS = /(?<!\*)\*(?!\s)[^*\n]{1,80}(?<!\s)\*(?!\*)/g;

/**
 * Numbered lists, bounded to two digits.
 *
 * `\d+\.` at the start of a line also matches a sentence opening with a year,
 * which is a plausible thing for a history answer to do. List numbers are
 * small; years are not.
 */
const NUMBERED_LIST = /^[ \t]*\d{1,2}[.)][ \t]+\S.*$/gm;

/**
 * LaTeX, by delimiter or by command.
 *
 * A bare `$` is deliberately not here: it is far more likely to be a price in
 * a student's message about a trip than it is to be maths.
 */
const LATEX =
  /\\\(|\\\)|\\\[|\\\]|\$\$|\\(?:frac|sqrt|int|sum|prod|cdot|times|div|leq|geq|neq|approx|alpha|beta|gamma|theta|lambda|mu|sigma|pi|infty|begin|end|text|mathrm|left|right)\b/g;

/** Praise or throat-clearing before the answer starts. */
const OPENER =
  /^\s*(?:(?:great|excellent|good|fantastic|awesome|nice)\s+question|(?:sure|certainly|absolutely|of course)\b\s*[,!.]|(?:i'?d be happy to|happy to help|i'?d love to help))/i;

/**
 * The menu of next steps at the end of a reply.
 *
 * Narrowed to the offer-a-menu phrasings. "Let me know if" and "feel free to"
 * were tried here and removed: both are ordinary friendly English and flagging
 * them made the metric noisy without making the replies better.
 */
const NEXT_STEP_MENU =
  /(?:would you like me to|do you want me to|shall i|i can also|want me to|anything else you'?d like)/gi;

export const FORMATTING_RULES: FormattingRule[] = [
  {
    id: 'bold',
    severity: 'rendering',
    symptom: 'literal ** around a word',
    find: (r) => excerpts(r, /\*\*[^*\n]+\*\*/g),
  },
  {
    id: 'asterisk-emphasis',
    severity: 'rendering',
    symptom: 'literal * around a word, or an *action*',
    find: (r) => excerpts(r, ASTERISK_EMPHASIS),
  },
  {
    id: 'heading',
    severity: 'rendering',
    symptom: 'a line beginning with visible # marks',
    find: (r) => excerpts(r, /^#{1,6}[ \t]\S.*$/gm),
  },
  {
    id: 'bullet-list',
    severity: 'rendering',
    symptom: 'a list the document asks to be written as a sentence',
    find: (r) => excerpts(r, /^[ \t]*[-*+][ \t]+\S.*$/gm),
  },
  {
    id: 'numbered-list',
    severity: 'rendering',
    symptom: 'a numbered list',
    find: (r) => excerpts(r, NUMBERED_LIST),
  },
  {
    id: 'table',
    severity: 'rendering',
    symptom: 'a heap of pipes and dashes',
    find: (r) => excerpts(r, /^[ \t]*\|.*\|[ \t]*$/gm),
  },
  {
    id: 'fenced-code',
    severity: 'rendering',
    symptom: 'three visible backticks',
    find: (r) => excerpts(r, /```/g),
  },
  {
    id: 'latex',
    severity: 'rendering',
    symptom: 'backslashes and braces where maths should be',
    find: (r) => excerpts(r, LATEX),
  },
  {
    id: 'context-leak',
    severity: 'rendering',
    symptom: 'the turn-context wrapper echoed back at the student',
    /*
     * A failure mode introduced by moving the clock and memory into the user
     * message. The tag keeps the model from reading that block as something
     * the student typed -- but a model that repeats it has handed the student
     * a piece of our plumbing.
     */
    find: (r) => excerpts(r, /<\/?turn_context>/g),
  },
  {
    id: 'emoji',
    severity: 'voice',
    symptom: 'an emoji the student did not invite',
    find: (r) => excerpts(r, /\p{Extended_Pictographic}/gu),
  },
  {
    id: 'praise-opener',
    severity: 'voice',
    symptom: 'praising the question before answering it',
    find: (r) => (OPENER.test(r) ? [r.slice(0, 60).replace(/\s+/g, ' ')] : []),
  },
  {
    id: 'next-step-menu',
    severity: 'voice',
    symptom: 'a menu of things it could do next',
    find: (r) => excerpts(r, NEXT_STEP_MENU),
  },
];

export interface RuleHit {
  rule: FormattingRule;
  excerpts: string[];
}

/** Every rule this reply breaks. Empty means clean. */
export function checkReply(reply: string): RuleHit[] {
  const hits: RuleHit[] = [];
  for (const rule of FORMATTING_RULES) {
    const found = rule.find(reply);
    if (found.length > 0) hits.push({ rule, excerpts: found });
  }
  return hits;
}
