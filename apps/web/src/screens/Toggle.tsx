interface Props {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label: string;
}

/**
 * On/off switch.
 *
 * A real checkbox underneath, positioned off the visible area rather than
 * hidden with display:none -- that keeps keyboard focus, the space bar, and
 * the accessible name. A styled div with a click handler looks identical and
 * cannot be operated without a mouse.
 */
export function Toggle({ checked, onChange, disabled, label }: Props) {
  return (
    <span className="switch">
      <input
        type="checkbox"
        role="switch"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="switch-track" />
      <span className="switch-thumb" />
    </span>
  );
}
