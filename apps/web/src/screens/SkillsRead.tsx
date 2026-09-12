interface Props {
  names: readonly string[];
  /** Still being read, under a running turn, rather than above a reply. */
  live?: boolean;
}

/**
 * The skills the agent read, one row each.
 *
 * Shown rather than hidden because it is a reason to trust the answer: a
 * student can see the agent consulted its notes on the vault before saying
 * what is due, the way a search assistant shows what it searched. Above the
 * line while the turn runs and above the reply once it lands, in the chrome
 * face rather than the agent's serif -- this is the product reporting a
 * step, not the agent speaking.
 */
export function SkillsRead({ names, live = false }: Props) {
  if (names.length === 0) return null;
  return (
    <div className="skills-read">
      {names.map((name) => (
        <span key={name} className="skill-read">
          <BookIcon />
          <span>{live ? 'Reading skill' : 'Read skill'}</span>
          <code>{name}</code>
        </span>
      ))}
    </div>
  );
}

/** An open book, in the text colour. */
function BookIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 7v14" />
      <path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z" />
    </svg>
  );
}
