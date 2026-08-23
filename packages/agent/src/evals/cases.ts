/**
 * The messages the agent is measured on.
 *
 * Every one is answerable from the model's own knowledge, with no tool call.
 * That is deliberate: this suite measures how the agent writes, and routing a
 * case through Gmail or a school portal would make the result depend on
 * whether the network was having a good day.
 *
 * They are also written the way a student types -- lowercase, unpunctuated,
 * occasionally rude about their own subject -- because a corpus of
 * well-formed queries measures the agent's behaviour on a population that
 * does not exist.
 *
 * `bait` records what the case is expected to provoke. It is documentation
 * rather than an assertion: a case that provokes nothing is still a valid
 * observation, and hard-coding the expected failure would stop us noticing a
 * new one.
 */

export interface EvalCase {
  id: string;
  message: string;
  /** The formatting habit this case is most likely to draw out. */
  bait: string;
}

export const EVAL_CASES: EvalCase[] = [
  // Maths and science: the strongest LaTeX bait there is.
  { id: 'derivative', message: 'how do i find the derivative of x^3 + 2x', bait: 'latex' },
  { id: 'quadratic', message: 'whats the quadratic formula again', bait: 'latex' },
  { id: 'integration', message: 'i genuinely do not get integration by parts', bait: 'latex' },
  {
    id: 'std-dev',
    message: 'can you explain what standard deviation actually measures',
    bait: 'latex',
  },
  { id: 'balancing', message: 'balance this for me: Fe + O2 -> Fe2O3', bait: 'latex' },
  { id: 'sig-figs', message: 'how many sig figs in 0.00450', bait: 'terse answer' },

  // Explanation: where a model reaches for headings and bullets.
  { id: 'ww1', message: 'explain the causes of world war 1', bait: 'headings' },
  { id: 'photosynthesis', message: 'how does photosynthesis actually work', bait: 'headings' },
  { id: 'macbeth-themes', message: 'what are the main themes in macbeth', bait: 'bullet-list' },
  { id: 'supply-demand', message: 'explain supply and demand like im 15', bait: 'bullet-list' },

  // Comparison: table bait.
  { id: 'mitosis', message: 'whats the difference between mitosis and meiosis', bait: 'table' },
  { id: 'revolutions', message: 'compare the french and russian revolutions', bait: 'table' },

  // Planning: numbered-list bait.
  {
    id: 'revision-plan',
    message: 'help me plan revision for 3 exams in 2 weeks',
    bait: 'numbered-list',
  },
  {
    id: 'essay-structure',
    message: 'how should i structure a history essay',
    bait: 'numbered-list',
  },

  // Code: fenced-block bait.
  { id: 'python-loop', message: 'how do i write a for loop in python', bait: 'fenced-code' },

  // Casual and emotional: emoji and cheerleading bait.
  { id: 'stressed', message: 'im so stressed about exams i cant focus on anything', bait: 'emoji' },
  { id: 'hey', message: 'hey', bait: 'over-long greeting' },
  { id: 'thanks', message: 'thanks that actually helped a lot', bait: 'emoji' },

  // Simple factual: padding and praise-opener bait.
  { id: 'capital', message: 'whats the capital of australia', bait: 'praise-opener' },

  // Graded work: the adaptive stance, and the softest refusal in the document.
  {
    id: 'write-essay',
    message: 'write me a 500 word essay on macbeth for tomorrow',
    bait: 'headings',
  },
];
