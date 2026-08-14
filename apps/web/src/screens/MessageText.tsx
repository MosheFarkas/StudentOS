import { parseSegments, type PreviewTarget } from '../lib/preview.js';

interface Props {
  text: string;
  onPreview: (target: PreviewTarget) => void;
}

/**
 * Render assistant text with its links live.
 *
 * Previewable links stay real anchors with a working href rather than becoming
 * buttons, so cmd-click and "open in new tab" behave the way a link should;
 * the click handler only intercepts the plain left-click.
 */
export function MessageText({ text, onPreview }: Props) {
  return (
    <>
      {parseSegments(text).map((segment, i) =>
        segment.type === 'text' ? (
          <span key={i}>{segment.value}</span>
        ) : segment.preview ? (
          <a
            key={i}
            className="chip"
            href={segment.url}
            target="_blank"
            rel="noreferrer noopener"
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey) return;
              event.preventDefault();
              onPreview(segment.preview as PreviewTarget);
            }}
          >
            {segment.label}
          </a>
        ) : (
          <a key={i} href={segment.url} target="_blank" rel="noreferrer noopener">
            {segment.label}
          </a>
        ),
      )}
    </>
  );
}
