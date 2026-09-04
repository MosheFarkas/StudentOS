/**
 * What the new-chat screen says at the top.
 *
 * One line, drawn from a written list rather than composed. Two rules shape
 * how it is chosen.
 *
 * It holds still for three hours. A greeting that changes on every render
 * reads as noise, and one that changes on every reload invites reloading to
 * see the next one -- so the choice is derived from which three-hour window
 * the clock is in, which means it survives a refresh and needs nothing stored.
 *
 * And a few lines are pinned to when they make sense. Most are not: the list
 * is mostly things that read fine at any hour. But "Rise and shine" at
 * midnight and "Still up?" at nine in the morning are worse than dull, so the
 * handful that describe a time of day only appear in it.
 */

/** The four times of day worth telling apart. */
export const BANDS = ['morning', 'afternoon', 'evening', 'night'] as const;
export type Band = (typeof BANDS)[number];

/** How long one greeting lasts. */
export const WINDOW_MS = 3 * 60 * 60 * 1000;

/**
 * Which band a moment falls in.
 *
 * The boundaries are set by how the hours feel rather than by dividing
 * twenty-four by four. Night runs to 5am and not to midnight, because 1am is
 * not morning to anyone who is awake for it.
 */
export function bandFor(now: Date): Band {
  const hour = now.getHours();
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 22) return 'evening';
  return 'night';
}

interface Line {
  text: string;
  /** The bands this line makes sense in. Absent means all of them. */
  when?: readonly Band[];
  /** Saturday and Sunday only. */
  weekend?: true;
  /** `[day]` means tomorrow here, not today. */
  tomorrow?: true;
}

const EARLY = ['morning'] as const;
const LATE = ['evening', 'night'] as const;
const NIGHT = ['night'] as const;
const DAYTIME = ['morning', 'afternoon'] as const;

/**
 * The list, as written.
 *
 * Order is not meaningful -- the choice is a hash, not a walk -- but the
 * grouping is kept so a line is easy to find and change.
 */
const LINES: Line[] = [
  { text: '[name] fr fr?' },
  { text: "Ok [name] we're so back." },
  { text: "[name], it's giving productive." },
  { text: 'Bro [name] is back.' },
  { text: '[name] you a real one for showing up.' },
  { text: "[name], let's cook" },
  { text: 'Lowkey missed you, [name].' },
  { text: 'Not [name] pulling up again.' },
  { text: '[name], W [time_of_day]?' },
  { text: 'Rizzler [name] has entered.' },
  { text: '[name], aight bet I gotchu.' },
  { text: "We yappin', [name]?" },
  { text: '[name] is him fr.' },
  { text: 'Chat, [name] is here.' },

  { text: 'Good [time_of_day], [name].' },
  { text: '[time_of_day], [name].' },
  { text: 'Late [time_of_day], [name]?', when: LATE },
  { text: 'Early [time_of_day], [name]?', when: EARLY },
  { text: 'Rise and shine, [name].', when: EARLY },
  { text: 'Burning the midnight oil, [name]?', when: NIGHT },
  { text: 'Up early, [name]?', when: EARLY },
  { text: 'Still up, [name]?', when: NIGHT },

  { text: 'Happy [day], [name].' },
  { text: '[day] again, [name]?' },
  { text: 'Happy [day], [name]!' },
  { text: 'Almost [day], [name].', tomorrow: true },
  { text: '[day] check-in, [name]?' },
  { text: 'Weekend mode, [name]?', weekend: true },
  { text: '[day] scaries, [name]?', when: LATE },

  { text: 'Welcome back, [name].' },
  { text: 'Good to see you, [name].' },
  { text: '[name]! Long time no chat.' },
  { text: 'Back again, [name]?' },
  { text: 'Missed you, [name].' },
  { text: 'Picking up where we left off, [name]?' },
  { text: 'Round [number], [name]?' },

  { text: 'Hey, [name].' },
  { text: "Hey [name], what's up?" },
  { text: 'Yo, [name].' },
  { text: 'Hi [name]!' },
  { text: 'Hiya, [name].' },
  { text: "What's good, [name]?" },
  { text: "[name], what's the move?" },
  { text: 'Ready to roll, [name]?' },
  { text: 'Hi [name], ready when you are.' },
  { text: '[name].' },
  { text: 'Hello, [name].' },
  { text: 'Good to have you, [name].' },
  { text: 'Here we go, [name].' },
  { text: 'All set, [name]?' },

  { text: 'Cozy night in, [name]?', when: LATE },
  { text: 'Long [day], [name]?', when: LATE },
  { text: 'Coffee first, [name]?', when: EARLY },
  { text: 'Big day ahead, [name]?', when: EARLY },
  { text: 'Winding down, [name]?', when: LATE },
  { text: 'Heads down today, [name]?', when: DAYTIME },
  { text: "[name], what've you got today?", when: DAYTIME },

  { text: 'Look who’s back, [name].' },
  { text: 'Speak of the devil, [name].' },
  { text: '[name] returns.' },
  { text: 'Knock knock, [name].' },
  { text: 'Plot twist, [name] is here.' },
  { text: '[name] —' },
  { text: 'Hey.' },
  { text: '[name], hi.' },
  { text: 'Right on time, [name].' },
  { text: 'Good timing, [name].' },
];

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * The name to greet them by.
 *
 * The first word of whatever the account carries. Google hands over a full
 * name, and "Hey, Lucas Liu." is how a dentist's receptionist says it.
 */
export function firstName(full: string): string {
  return full.trim().split(/\s+/)[0] ?? '';
}

/**
 * The start of the three-hour window a moment belongs to.
 *
 * Everything else is derived from this rather than from the moment itself,
 * which is what keeps a greeting still. Aligned to local midnight, not to the
 * epoch, so the windows fall on 3am, 6am, 9am rather than wherever a timezone
 * offset happens to put them.
 */
export function windowStart(now: Date): Date {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const since = now.getTime() - midnight.getTime();
  return new Date(midnight.getTime() + Math.floor(since / WINDOW_MS) * WINDOW_MS);
}

/**
 * Every greeting that suits this window, written out in full.
 *
 * A line whose placeholder cannot be filled is dropped rather than filled with
 * a blank: without a name, "Hey, ." is worse than any of the alternatives, and
 * `[number]` has nothing behind it unless a caller supplies one.
 */
export function greetingsFor(now: Date, name?: string, round?: number): string[] {
  const at = windowStart(now);
  const band = bandFor(at);
  const day = at.getDay();
  const weekend = day === 0 || day === 6;
  const person = name ? firstName(name) : '';

  return LINES.filter((line) => {
    if (line.when && !line.when.includes(band)) return false;
    if (line.weekend && !weekend) return false;
    if (!person && line.text.includes('[name]')) return false;
    if (round === undefined && line.text.includes('[number]')) return false;
    return true;
  }).map((line) =>
    line.text
      .replaceAll('[name]', person)
      .replaceAll('[time_of_day]', band)
      .replaceAll('[day]', DAYS[line.tomorrow ? (day + 1) % 7 : day] ?? '')
      .replaceAll('[number]', String(round ?? '')),
  );
}

/**
 * The one to show, held still for three hours.
 *
 * Derived from the window rather than drawn at random, so a refresh does not
 * reroll it. The name is mixed in so two students on the same screen at the
 * same moment are not greeted identically -- and so a student who changes
 * nothing still gets a different line from their friend.
 */
export function pickGreeting(now: Date, name?: string, round?: number): string {
  const pool = greetingsFor(now, name, round);
  if (pool.length === 0) return '';
  const seed = hash(`${windowStart(now).getTime()}:${name ?? ''}`);
  return pool[seed % pool.length] ?? pool[0] ?? '';
}

/**
 * A small non-cryptographic hash (FNV-1a), so the choice is stable across
 * reloads, machines and browsers -- Math.random would be none of those.
 */
function hash(text: string): number {
  let value = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}
