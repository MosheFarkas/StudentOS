/**
 * A settings row: what it is on the left, the control on the right.
 *
 * Every section is a column of these, and the rule under each is what makes
 * the column readable rather than a list of floating pairs. A sub row belongs
 * to the row above it -- the write half of an integration -- and is indented
 * under it with a rule down the left.
 */
export function Row({
  label,
  hint,
  sub = false,
  children,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  sub?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className={sub ? 'settings-row sub' : 'settings-row'}>
      <div className="settings-label">
        <span>{label}</span>
        {hint && <span className="muted">{hint}</span>}
      </div>
      {children && <div className="settings-control">{children}</div>}
    </div>
  );
}
