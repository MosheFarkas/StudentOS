/**
 * A settings row: a mark if it has one, what it is on the left, the control
 * on the right.
 *
 * Every section is a column of these, and the rule under each is what makes
 * the column readable rather than a list of floating pairs. A sub row belongs
 * to the row above it and is indented under it with a rule down the left.
 */
export function Row({
  icon,
  label,
  hint,
  sub = false,
  children,
}: {
  icon?: React.ReactNode;
  label: React.ReactNode;
  hint?: React.ReactNode;
  sub?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className={sub ? 'settings-row sub' : 'settings-row'}>
      {icon && (
        <span className="settings-icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <div className="settings-label">
        <span>{label}</span>
        {hint && <span className="muted">{hint}</span>}
      </div>
      {children && <div className="settings-control">{children}</div>}
    </div>
  );
}
