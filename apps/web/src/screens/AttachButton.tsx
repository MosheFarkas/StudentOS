import { useEffect, useRef, useState } from 'react';
import { uploadFile } from '../lib/upload.js';

/** Something the agent can open. */
export interface Attachment {
  id: string;
  /** What the student sees on the chip, and what the agent is told. */
  label: string;
}

interface Props {
  /** Called with whatever was uploaded, already in the vault. */
  onAttached: (files: Attachment[]) => void;
  onError: (message: string) => void;
  disabled?: boolean;
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
export function AttachButton({ onAttached, onError, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
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

  /**
   * Uploaded as they are chosen rather than held until the message is sent.
   *
   * The refusals are the reason: a scan or an oversized file has to be said
   * while the student is still thinking about the file, not after they have
   * written a paragraph and pressed send.
   */
  async function take(chosen: FileList | null) {
    if (!chosen || chosen.length === 0) return;
    setUploading(true);
    onError('');

    try {
      for (const file of Array.from(chosen)) {
        const uploaded = await uploadFile(file);
        onAttached([{ id: `upload:${uploaded.name}`, label: uploaded.filename }]);
      }
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : 'Could not upload that file.');
    } finally {
      setUploading(false);
      // So choosing the same file again still fires a change event.
      if (chooser.current) chooser.current.value = '';
    }
  }

  return (
    <div className="attach" ref={box}>
      {open && (
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
        /*
         * No accept list, deliberately.
         *
         * An accept attribute makes the system dialog open filtered -- macOS
         * shows "Custom Files" and hides everything else until the student
         * finds the dropdown and changes it. Since what can actually be read
         * is decided by looking inside the file rather than at its extension,
         * a filter here would only be a worse guess made earlier, and the
         * server's refusal says far more than a greyed-out filename does.
         */
        onChange={(event) => {
          setOpen(false);
          void take(event.target.files);
        }}
      />

      <button
        type="button"
        className="composer-attach"
        aria-label="Attach files"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled || uploading}
        title={uploading ? 'Reading…' : 'Attach files'}
        onClick={() => setOpen((was) => !was)}
      >
        <PlusIcon />
      </button>
    </div>
  );
}

/** The chips under a composer, and the way to take one back off. */
export function AttachedFiles({
  files,
  onRemove,
}: {
  files: Attachment[];
  onRemove: (id: string) => void;
}) {
  if (files.length === 0) return null;

  return (
    <div className="newchat-files">
      {files.map((file) => (
        <span key={file.id} className="file-chip">
          {file.label}
          <button
            type="button"
            aria-label={`Remove ${file.label}`}
            onClick={() => onRemove(file.id)}
          >
            ×
          </button>
        </span>
      ))}
    </div>
  );
}

/**
 * The message, with the attached files named in it.
 *
 * There is no attachment channel beside the text, and none is needed: an
 * uploaded file is already a note in the vault, and the agent opens vault
 * notes by name. Naming them is the whole of the handover.
 */
export function withAttachments(text: string, files: Attachment[]): string {
  if (files.length === 0) return text;
  const named = files.map((file) => file.label).join(', ');
  return [text, `Files I have uploaded to my vault: ${named}`]
    .filter((part) => part !== '')
    .join('\n\n');
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
