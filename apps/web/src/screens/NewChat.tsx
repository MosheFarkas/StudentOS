import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { chatTitle } from '../lib/chatTitle.js';
import { handOff } from '../lib/handoff.js';
import { uploadFile } from '../lib/upload.js';
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
  const [files, setFiles] = useState<Attachment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const chooser = useRef<HTMLInputElement>(null);

  /*
   * Fetch Google's libraries now, so the click that opens the picker does not
   * have to wait for them. See warmPicker: the wait is what gets the popup
   * blocked.
   */
  /** A menu that ignores a click elsewhere is a menu you cannot put away. */
  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent) => {
      if (!(event.target as HTMLElement).closest('.attach')) setMenuOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', escape);
    };
  }, [menuOpen]);

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

  /**
   * Files from this machine, which go into the vault.
   *
   * Uploaded as they are chosen rather than held until the message is sent.
   * The refusals are the reason: a scan or an oversized file has to be said
   * while the student is still thinking about the file, not after they have
   * written a paragraph and pressed send.
   */
  async function attachFromDisk(chosen: FileList | null) {
    if (!chosen || chosen.length === 0) return;
    setUploading(true);
    setError(null);

    try {
      for (const file of Array.from(chosen)) {
        const uploaded = await uploadFile(file);
        add([{ id: `upload:${uploaded.name}`, label: uploaded.filename }]);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not upload that file.');
    } finally {
      setUploading(false);
      // So choosing the same file again still fires a change event.
      if (chooser.current) chooser.current.value = '';
    }
  }

  /** Added without duplicates, so picking the same file twice shows one chip. */
  function add(incoming: Attachment[]) {
    setFiles((prev) => [...prev, ...incoming.filter((doc) => !prev.some((p) => p.id === doc.id))]);
  }

  return (
    <div className="newchat">
      <h1 className="newchat-greeting">
        <LogoMark size={42} working={false} />
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
                  {file.label}
                  <button
                    type="button"
                    aria-label={`Remove ${file.label}`}
                    onClick={() => setFiles((prev) => prev.filter((f) => f.id !== file.id))}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}

          <div className="newchat-tools">
            <div className="attach">
              {menuOpen && (
                <div className="attach-menu" role="menu">
                  <button role="menuitem" type="button" onClick={() => chooser.current?.click()}>
                    Upload from this computer
                  </button>
                </div>
              )}

              <input
                ref={chooser}
                type="file"
                multiple
                hidden
                accept=".pdf,.txt,.md,.markdown,.csv,.json,application/pdf,text/plain,text/markdown,text/csv"
                onChange={(event) => {
                  setMenuOpen(false);
                  void attachFromDisk(event.target.files);
                }}
              />

              <button
                type="button"
                className="composer-attach"
                aria-label="Attach files"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                disabled={uploading}
                onClick={() => setMenuOpen((was) => !was)}
              >
                <PlusIcon />
              </button>
            </div>

            {uploading && <span className="muted attach-status">Reading…</span>}

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

/** Something the agent can open. */
interface Attachment {
  id: string;
  /** What the student sees on the chip, and what the agent is told. */
  label: string;
}

/**
 * The message, with the attached files named in it.
 *
 * There is no attachment channel beside the text, and none is needed: an
 * uploaded file is already a note in the vault, and the agent opens vault
 * notes by name. Naming them is the whole of the handover.
 */
function withAttachments(text: string, files: Attachment[]): string {
  if (files.length === 0) return text;
  const named = files.map((file) => file.label).join(', ');
  return [text, `Files I have uploaded to my vault: ${named}`]
    .filter((part) => part !== '')
    .join('\n\n');
}

/** What the chat is called: what they typed, or what they attached instead. */
function titleFor(draft: string, files: Attachment[]): string {
  return chatTitle(draft.trim() || files.map((file) => file.label).join(', '));
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
