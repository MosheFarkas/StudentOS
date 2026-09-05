import { useEffect, useRef, useState } from 'react';
import type { Attachment } from '../lib/attachments.js';

interface Props {
  /** Called with the files chosen. Nothing is sent anywhere yet. */
  onChosen: (files: File[]) => void;
  disabled?: boolean;
  /**
   * Which way the menu opens. Up, unless told otherwise: a composer at the
   * foot of the window has no room below it. The new-chat screen, whose
   * composer sits mid-screen, asks for down so the menu hangs under the bar
   * instead of covering the prompt.
   */
  opens?: 'up' | 'down';
}

/**
 * The + on a composer.
 *
 * Shared by the new-chat screen and the conversation, because attaching a file
 * means the same thing in both and a student who has learned it in one should
 * not find it missing in the other.
 *
 * A menu with a single item today, deliberately. It is where the next source
 * lands, and a button that silently changes into a menu later is a worse
 * introduction than a menu that grows an entry.
 */
export function AttachButton({ onChosen, disabled, opens = 'up' }: Props) {
  const [open, setOpen] = useState(false);
  const chooser = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);

  /** A menu that ignores a click elsewhere is a menu you cannot put away. */
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  const down = opens === 'down' ? ' opens-down' : '';

  return (
    <div className={`attach${down}`} ref={box}>
      {open && (
        <div className={`attach-menu${down}`} role="menu">
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
        /*
         * No accept list, deliberately.
         *
         * An accept attribute makes the system dialog open filtered -- macOS
         * shows "Custom Files" and hides everything else until the student
         * finds the dropdown. Since what can be read is decided by looking
         * inside the file rather than at its extension, a filter here would
         * only be a worse guess made earlier.
         */
        onChange={(event) => {
          setOpen(false);
          onChosen(Array.from(event.target.files ?? []));
          // So choosing the same file again still fires a change event.
          event.target.value = '';
        }}
      />

      <button
        type="button"
        className="composer-attach"
        aria-label="Attach files"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        title="Attach files"
        onClick={() => setOpen((was) => !was)}
      >
        <PlusIcon />
      </button>
    </div>
  );
}

/**
 * What is riding on the message, shown above where it is typed.
 *
 * A picture shows itself. Everything else gets its name and its kind, because
 * a row of identical grey squares is no more use than a list of filenames and
 * takes four times the room.
 */
export function AttachedFiles({
  files,
  busy,
  onRemove,
}: {
  files: Attachment[];
  busy?: boolean;
  onRemove: (id: string) => void;
}) {
  if (files.length === 0) return null;

  return (
    <div className="attached">
      {files.map((item) => (
        <div key={item.id} className={`attached-item${item.preview ? ' is-image' : ''}`}>
          {item.preview ? (
            <img src={item.preview} alt={item.file.name} />
          ) : (
            <div className="attached-doc">
              <span className="attached-kind">{kindOf(item.file.name)}</span>
              <span className="attached-name">{item.file.name}</span>
            </div>
          )}

          {/*
            Hidden until the pointer is on the card, and always reachable by
            keyboard. It sits over the corner of the picture rather than beside
            it, which is where the room is.
          */}
          <button
            type="button"
            className="attached-remove"
            aria-label={`Remove ${item.file.name}`}
            disabled={busy}
            onClick={() => onRemove(item.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

/** The extension, upper-cased. Enough to tell a deck from a spreadsheet. */
function kindOf(filename: string): string {
  return /\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toUpperCase() ?? 'FILE';
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
