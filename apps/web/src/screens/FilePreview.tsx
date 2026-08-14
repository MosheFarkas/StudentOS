import { useEffect } from 'react';
import type { PreviewTarget } from '../lib/preview.js';

interface Props {
  target: PreviewTarget;
  onClose: () => void;
}

/**
 * The file pane.
 *
 * Renders the real document via Google's /preview route, which authenticates
 * against the student's own Google session in this browser -- so it shows
 * exactly the files they can already open, and nothing they cannot. We never
 * see the contents, which is also why no Drive scope is involved.
 *
 * "Open in Google" is deliberately always present, not a fallback shown on
 * error: a Workspace domain can forbid embedding, and that failure renders
 * inside the iframe where we cannot detect it cross-origin. An escape hatch
 * that is always visible costs one link and covers a case we are blind to.
 */
export function FilePreview({ target, onClose }: Props) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <aside className="preview-pane" aria-label={`Preview: ${target.label}`}>
      <div className="preview-header">
        <strong title={target.label}>{target.label}</strong>
        <span className="preview-actions">
          <a href={target.sourceUrl} target="_blank" rel="noreferrer noopener">
            Open in Google
          </a>
          <button onClick={onClose} aria-label="Close preview">
            ✕
          </button>
        </span>
      </div>

      {/*
       * Keyed on the URL so switching files remounts the frame. Without it,
       * React reuses the element and some Google viewers keep showing the
       * previous document.
       */}
      <iframe
        key={target.embedUrl}
        src={target.embedUrl}
        title={target.label}
        allow="autoplay; encrypted-media"
        allowFullScreen
      />
    </aside>
  );
}
