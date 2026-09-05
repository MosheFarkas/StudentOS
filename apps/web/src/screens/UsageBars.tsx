import type { QuotaBar, UsageStatus } from '@contexto/shared';

/**
 * The two limits a student actually meets.
 *
 * The month is what the allowance is defined as; these are how it is spent.
 * The session window is the one an ordinary heavy afternoon reaches and it
 * comes back within hours; the week is the backstop and comes back on Monday.
 * They are independent, so one can be nearly gone while the other is barely
 * touched -- which is exactly why both are shown rather than a single number.
 */
export function UsageBars({ usage }: { usage: UsageStatus }) {
  if (!usage.limits) {
    return (
      <p className="muted">
        {usage.activeProvider === 'platform'
          ? 'No limit applies to this account.'
          : 'You are on your own API key, so nothing here is metered.'}
      </p>
    );
  }

  return (
    <>
      <Bar
        title="This session"
        note="A five-hour window. It refills as older messages fall out of it."
        bar={usage.limits.session}
      />
      <Bar title="This week" note={resetNote(usage.limits.week.resetsAt)} bar={usage.limits.week} />

      <p className="muted usage-footnote">
        Your month&apos;s allowance is spread evenly across the weeks. A session can spend faster
        than that pace, so a long afternoon is not held back — five of them is the week.
      </p>
    </>
  );
}

function Bar({ title, note, bar }: { title: string; note: string; bar: QuotaBar }) {
  /*
   * Capped at 100. Two calls can pass the check at once by design -- see
   * assertWithinQuota -- so a student can finish a window fractionally over
   * it, and a bar that overflowed its track would look like a bug.
   */
  const percent = Math.min(100, Math.round((bar.used / bar.limit) * 100));

  return (
    <div className="usage-bar">
      <div className="usage-bar-head">
        <div>
          <strong>{title}</strong>
          <span className="muted">{note}</span>
        </div>
        <span className="usage-percent">{percent}% used</span>
      </div>

      <div
        className="usage-track"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={title}
      >
        <div
          className={`usage-fill${percent >= 90 ? ' is-low' : ''}`}
          style={{ width: `${percent}%` }}
        />
      </div>

      <p className="muted usage-numbers">
        {bar.used.toLocaleString()} of {bar.limit.toLocaleString()} tokens
      </p>
    </div>
  );
}

/** "Resets Monday" is something to plan around; a timestamp is not. */
function resetNote(resetsAt: string | null): string {
  if (!resetsAt) return 'Resets weekly.';
  const at = new Date(resetsAt);
  if (Number.isNaN(at.getTime())) return 'Resets weekly.';
  return `Resets ${at.toLocaleDateString(undefined, { weekday: 'long' })}.`;
}
