import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { chatTitle } from '../lib/chatTitle.js';
import { handOff } from '../lib/handoff.js';
import { pickDriveFiles, pickerConfigured, warmPicker } from '../lib/picker.js';
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
  useEffect(warmPicker, []);

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

  /** Files from Drive, which the agent reaches with its Drive tools. */
  async function attachFromDrive() {
    setMenuOpen(false);
    setError(null);
    try {
      const picked = await pickDriveFiles();
      // Cancelling hands back an empty list, which must not clear what was
      // already attached.
      if (picked.length === 0) return;
      add(picked.map((doc) => ({ id: doc.id, label: doc.name ?? 'Untitled', from: 'drive' })));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not open your Drive.');
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
        add([{ id: `upload:${uploaded.name}`, label: uploaded.filename, from: 'upload' }]);
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
                <span key={file.id} className={`file-chip from-${file.from}`}>
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
                  {/*
                    Offered only where it can work. The Drive picker needs two
                    build-time keys, and a deployment without them would show a
                    choice that silently does nothing.
                  */}
                  {pickerConfigured() && (
                    <button role="menuitem" type="button" onClick={() => void attachFromDrive()}>
                      Choose from Drive
                    </button>
                  )}
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

/** Something the agent can open, and where it will find it. */
interface Attachment {
  id: string;
  /** What the student sees on the chip, and what the agent is told. */
  label: string;
  from: 'drive' | 'upload';
}

/**
 * The message, with the attached files named in it.
 *
 * There is no attachment channel beside the text, and neither kind needs one.
 * A Drive file is reachable because picking it is itself what granted access
 * -- drive.file covers exactly what was chosen. An uploaded file is reachable
 * because its text is already a note in the vault. Both are opened by name, so
 * naming them is the whole of the handover.
 *
 * Named separately because the agent looks in a different place for each, and
 * one merged list would leave it guessing which.
 */
function withAttachments(text: string, files: Attachment[]): string {
  const lines = [
    named(files, 'upload', (list) => `Files I have uploaded to my vault: ${list}`),
    named(files, 'drive', (list) => `From my Google Drive: ${list}`),
  ].filter((line): line is string => line !== undefined);

  if (lines.length === 0) return text;
  return [text, ...lines].filter((part) => part !== '').join('\n\n');
}

function named(
  files: Attachment[],
  from: Attachment['from'],
  line: (list: string) => string,
): string | undefined {
  const mine = files.filter((file) => file.from === from);
  return mine.length === 0 ? undefined : line(mine.map((file) => file.label).join(', '));
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
