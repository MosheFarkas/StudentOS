import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { chatTitle } from '../lib/chatTitle.js';
import { handOff } from '../lib/handoff.js';
import { pickDriveFiles, pickerConfigured, warmPicker } from '../lib/picker.js';
import type { PickerDoc } from '../lib/picker.js';
import { pickGreeting } from '../lib/greeting.js';
import { navigate } from '../lib/router.js';
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
  const [files, setFiles] = useState<PickerDoc[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  /*
   * Fetch Google's libraries now, so the click that opens the picker does not
   * have to wait for them. See warmPicker: the wait is what gets the popup
   * blocked.
   */
  useEffect(warmPicker, []);

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

  async function attach() {
    setError(null);
    try {
      const picked = await pickDriveFiles();
      // Cancelling hands back an empty list, which must not clear what was
      // already attached.
      if (picked.length === 0) return;
      setFiles((prev) => [...prev, ...picked.filter((doc) => !prev.some((p) => p.id === doc.id))]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not open your Drive.');
    }
  }

  return (
    <div className="newchat">
      <h1 className="newchat-greeting">
        <LogoMark size={30} working={false} />
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

          {files.length > 0 && (
            <div className="newchat-files">
              {files.map((file) => (
                <span key={file.id} className="file-chip">
                  {file.name ?? 'Untitled'}
                  <button
                    type="button"
                    aria-label={`Remove ${file.name ?? 'file'}`}
                    onClick={() => setFiles((prev) => prev.filter((f) => f.id !== file.id))}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}

          <div className="newchat-tools">
            <button
              type="button"
              className="composer-attach"
              aria-label="Attach files"
              title={pickerConfigured() ? 'Attach files' : 'File picking is not configured here'}
              disabled={!pickerConfigured()}
              onClick={() => void attach()}
            >
              <PlusIcon />
            </button>

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

/**
 * The message, with the picked files named in it.
 *
 * There is no attachment channel beside the text, and it does not need one:
 * picking a file in the Google Picker is itself what grants access to it. The
 * drive.file scope covers exactly what the student chose, so the agent's own
 * Drive tools can already open these and nothing else -- naming them is what
 * tells it there is something to open.
 */
function withAttachments(text: string, files: PickerDoc[]): string {
  if (files.length === 0) return text;
  const named = nameList(files);
  return text
    ? `${text}\n\nFrom my Google Drive: ${named}`
    : `Take a look at ${named} in my Google Drive.`;
}

/** What the chat is called: what they typed, or what they attached instead. */
function titleFor(draft: string, files: PickerDoc[]): string {
  return chatTitle(draft.trim() || nameList(files));
}

function nameList(files: PickerDoc[]): string {
  return files.map((file) => file.name ?? 'a file').join(', ');
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true" focusable="false">
      <path
        d="M9 3.75v10.5M3.75 9h10.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}
