import { useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { chatTitle } from '../lib/chatTitle.js';
import { handOff } from '../lib/handoff.js';
import { pickGreeting } from '../lib/greeting.js';
import { navigate } from '../lib/router.js';
import { AttachButton, AttachedFiles, withAttachments } from './AttachButton.js';
import type { Attachment } from './AttachButton.js';
import { LogoMark } from './LogoMark.js';

interface Props {
  /** The signed-in student, if their account carries a name. */
  name?: string | null;
}

/**
 * The screen a new chat starts on: a greeting, and somewhere to type.
 *
 * The greeting is chosen once per mount rather than on every render. It reads
 * the clock at the moment the screen opens, which is the only moment it is
 * about -- recomputing it while the student types would swap the sentence
 * under them mid-thought, and at 4:59am it would do it for real.
 */
export function NewChat({ name }: Props) {
  const greeting = useMemo(() => pickGreeting(new Date(), name ?? undefined), [name]);
  const [draft, setDraft] = useState('');
  const [files, setFiles] = useState<Attachment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  /**
   * Start the chat.
   *
   * The agent is created first and named after what was typed, then the
   * message is left for the conversation to send as it opens. Navigating
   * before the turn runs is the point: the reply can take several seconds, and
   * the student should be watching the conversation while it does, not a
   * screen that has not changed.
   */
  async function start(event: React.FormEvent) {
    event.preventDefault();
    const content = withAttachments(draft.trim(), files);
    if (!content || starting) return;

    setStarting(true);
    setError(null);

    try {
      const res = await api.agents.$post({ json: { name: titleFor(draft, files), purpose: '' } });
      if (!res.ok) throw new Error(`Could not start a chat (${res.status})`);
      const { agent } = await res.json();
      handOff(agent.id, content);
      navigate({ name: 'chat', agentId: agent.id });
    } catch (cause) {
      // The draft is still in the box, so there is nothing to restore -- only
      // the button to give back.
      setError(cause instanceof Error ? cause.message : 'Unknown error');
      setStarting(false);
    }
  }

  /** Added without duplicates, so picking the same file twice shows one chip. */
  function add(incoming: Attachment[]) {
    setFiles((prev) => [...prev, ...incoming.filter((doc) => !prev.some((p) => p.id === doc.id))]);
  }

  return (
    <div className="newchat">
      <h1 className="newchat-greeting">
        <LogoMark size={36} working={false} />
        <span>{greeting}</span>
      </h1>

      {/*
        The glow is on the wrapper rather than the card, because it is painted
        by a blurred copy sitting behind it -- a shadow on the card itself
        cannot hold a three-colour gradient. It plays once, on entry.
      */}
      <div className="composer-glow">
        <form className="newchat-composer" onSubmit={(event) => void start(event)}>
          <textarea
            className="newchat-input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              // Enter sends, Shift+Enter breaks the line -- what every chat
              // box does, and a textarea does neither by default.
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder="How can I help you today?"
            rows={1}
            disabled={starting}
            aria-label="Message ContextoAgent"
          />

          <AttachedFiles
            files={files}
            onRemove={(id) => setFiles((prev) => prev.filter((f) => f.id !== id))}
          />

          <div className="newchat-tools">
            <AttachButton
              onAttached={add}
              onError={(message) => setError(message || null)}
              disabled={starting}
            />

            <button
              className="composer-send primary"
              type="submit"
              disabled={starting || (!draft.trim() && files.length === 0)}
            >
              {starting ? 'Starting…' : 'Send'}
            </button>
          </div>
        </form>
      </div>

      {error && <p className="muted newchat-error">{error}</p>}
    </div>
  );
}

/** What the chat is called: what they typed, or what they attached instead. */
function titleFor(draft: string, files: Attachment[]): string {
  return chatTitle(draft.trim() || files.map((file) => file.label).join(', '));
}
