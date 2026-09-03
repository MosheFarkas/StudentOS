/**
 * What the new-chat screen says at the top.
 *
 * A single fixed greeting is the kind of thing a student stops reading after
 * the second day. One drawn at random reads as noise instead -- "Still up?" at
 * nine in the morning is worse than saying nothing. So the pool is narrowed by
 * the clock first, and only then is one of them picked.
 *
 * Two things narrow it. The band of the day is the obvious one. The weekday is
 * the less obvious one, and it is deliberately partial: Monday, Friday and
 * Sunday evening are the three a student actually feels, and the rest of the
 * week gets nothing day-specific because there is nothing true to say about a
 * Wednesday.
 *
 * Pure on purpose, matching thinkingPhrases next door: the clock arrives as an
 * argument and the randomness is injectable, so what a given moment can say is
 * something a test can pin down rather than something you have to wait until
 * 2am to see.
 */

/** The four times of day worth telling apart. */
export const BANDS = ['morning', 'afternoon', 'evening', 'night'] as const;
export type Band = (typeof BANDS)[number];

/**
 * Which band a moment falls in.
 *
 * The boundaries are set by how the hours feel rather than by dividing
 * twenty-four by four. Night runs to 5am and not to midnight, because 1am is
 * not morning to anyone who is awake for it -- and the student most likely to
 * be reading this at 1am is the one it should sound different for.
 */
export function bandFor(now: Date): Band {
  const hour = now.getHours();
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 22) return 'evening';
  return 'night';
}

/**
 * A greeting, and whether it needs a name to be written.
 *
 * The name is not always known -- an account may have none, and the sidebar
 * would rather say nothing than say "Hi ,". Lines that want one are kept
 * separate rather than falling back to a blank, so the pool stays honest.
 */
interface Line {
  /** `{name}` is substituted, and marks the line as needing one. */
  text: string;
}

const BY_BAND: Record<Band, Line[]> = {
  morning: [
    { text: 'Morning. What are we starting with?' },
    { text: 'Morning, {name}. Where do we begin?' },
    { text: 'Early start. What is first?' },
    { text: 'Good morning. What needs doing?' },
  ],
  afternoon: [
    { text: 'What are we working on?' },
    { text: 'Afternoon, {name}. Picking up where you left off?' },
    { text: 'Afternoon. What is on the list?' },
    { text: 'Back at it. What do you need?' },
  ],
  evening: [
    { text: 'Evening, how are things?' },
    { text: 'Evening, {name}. What is left?' },
    { text: 'Evening. Anything still open?' },
    { text: 'How did today go?' },
  ],
  night: [
    { text: 'Still up?' },
    { text: 'Late one. What is due?' },
    { text: 'It is late, {name}. What can I take off you?' },
    { text: 'Burning the midnight oil?' },
  ],
};

/**
 * The days that get a line of their own, and when.
 *
 * Keyed by weekday as `Date.getDay` reports it, and narrowed further by band
 * where the day only means something at one end of it: Sunday is unremarkable
 * at 10am and quite specific at 8pm.
 */
const BY_DAY: { day: number; bands: readonly Band[]; lines: Line[] }[] = [
  {
    day: 1,
    bands: ['morning', 'afternoon'],
    lines: [
      { text: 'Monday. Shall we line up the week?' },
      { text: 'Monday again. Where do we start?' },
    ],
  },
  {
    day: 5,
    bands: ['afternoon', 'evening'],
    lines: [
      { text: 'Friday. What is left before the weekend?' },
      { text: 'Friday, {name}. Anything you want off your plate?' },
    ],
  },
  {
    day: 0,
    bands: ['evening', 'night'],
    lines: [
      { text: 'Sunday night. Want to get ahead of the week?' },
      { text: 'Sunday. What does tomorrow look like?' },
    ],
  },
];

/**
 * Every greeting that suits this moment, name written in.
 *
 * The day-specific lines are added to the band's rather than replacing them,
 * so a Monday morning can still say something that is merely about mornings.
 * A student opening this five times on one Monday should not get the same
 * sentence five times.
 */
export function greetingsFor(now: Date, name?: string): string[] {
  const band = bandFor(now);
  const day = now.getDay();

  const lines = [
    ...BY_BAND[band],
    ...BY_DAY.filter((entry) => entry.day === day && entry.bands.includes(band)).flatMap(
      (entry) => entry.lines,
    ),
  ];

  const trimmed = name?.trim();
  return lines
    .filter((line) => trimmed || !line.text.includes('{name}'))
    .map((line) => line.text.replace('{name}', trimmed ?? ''));
}

/** One of them, at random. */
export function pickGreeting(now: Date, name?: string, random: () => number = Math.random): string {
  const pool = greetingsFor(now, name);
  return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))] ?? pool[0] ?? '';
}
