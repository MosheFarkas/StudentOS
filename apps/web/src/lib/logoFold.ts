/**
 * The clock and the easing behind the folding mark.
 *
 * Split from the component because this is the part that can be wrong in a way
 * nobody notices until it is shipped: the loop plays the fold forwards and then
 * back to front, and a mirror that is off by anything at all makes the mark
 * jump at the turn, twice a loop, in the header of every screen.
 *
 * The scene list and the easing curves are the ones the animation was authored
 * against. Changing a duration here re-times the animation; changing a curve
 * changes how it moves.
 */

export const SCENES: readonly { name: string; dur: number }[] = [
  { name: 'The fold', dur: 0.7 },
  { name: 'Merge', dur: 0.2 },
  { name: 'Second fold', dur: 0.7 },
  { name: 'Merge 2', dur: 0.2 },
  { name: 'Third fold', dur: 0.7 },
  { name: 'Fourth fold', dur: 0.7 },
  { name: 'Reverse', dur: 3.2 },
];

/** Each scene's start, as a running sum of the ones before it. */
export const CUES: Readonly<Record<string, number>> = (() => {
  const cues: Record<string, number> = {};
  let at = 0;
  for (const scene of SCENES) {
    cues[scene.name] = Math.round(at * 1000) / 1000;
    at += scene.dur;
  }
  return cues;
})();

export const LOOP_SECONDS = Math.round(SCENES.reduce((sum, s) => sum + s.dur, 0) * 1000) / 1000;

/** Where the folding stops and the unfolding starts. */
export const REVERSE_AT = CUES['Reverse'] ?? 0;

/** Where the folding began -- the whole logo, and what the reverse returns to. */
const OPENS_AT = CUES['The fold'] ?? 0;

/**
 * The authored moment to draw, for a mark that has been running this long.
 *
 * Wraps, and time-mirrors the second half onto the first, so the loop closes on
 * the same frame it opened with.
 */
export function authoredTime(elapsedSeconds: number): number {
  if (!(elapsedSeconds > 0)) return OPENS_AT;
  const raw = elapsedSeconds % LOOP_SECONDS;
  if (raw < REVERSE_AT) return raw;

  const through = (raw - REVERSE_AT) / Math.max(LOOP_SECONDS - REVERSE_AT, 0.001);
  return REVERSE_AT - through * (REVERSE_AT - OPENS_AT);
}

export const Easing = {
  easeInOutQuad: (t: number) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
  easeInOutCubic: (t: number) =>
    t < 0.5 ? 4 * t * t * t : (t - 1) * (2 * t - 2) * (2 * t - 2) + 1,
};

/** A value that moves from `from` to `to` between two moments, and holds outside them. */
export function animate({
  from = 0,
  to = 1,
  start = 0,
  end = 1,
  ease = Easing.easeInOutCubic,
}: {
  from?: number;
  to?: number;
  start?: number;
  end?: number;
  ease?: (t: number) => number;
}): (t: number) => number {
  return (t: number) => {
    if (t <= start) return from;
    if (t >= end) return to;
    return from + (to - from) * ease((t - start) / (end - start));
  };
}
