import type { PendingImport } from '../api/types.ts';
import './PendingCard.css';

/** Best-effort site label from the URL, so the placeholder is identifiable. */
function siteOf(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    if (/instagram/.test(host)) return 'Instagram';
    if (/tiktok/.test(host)) return 'TikTok';
    if (/youtu/.test(host)) return 'YouTube';
    if (/reddit|redd\.it|redgifs/.test(host)) return 'Reddit';
    if (/twitter|x\.com/.test(host)) return 'X';
    if (/imgur/.test(host)) return 'Imgur';
    return host;
  } catch {
    return 'Link';
  }
}

/** The tail of the path — usually the post id, enough to tell two apart. */
function labelOf(url: string): string {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/').filter(Boolean);
    return segments.at(-1) ?? parsed.hostname;
  } catch {
    return url.slice(0, 40);
  }
}

/**
 * A placeholder card for a download that has not landed yet.
 *
 * A URL import creates no clip row until yt-dlp finishes, so without this the
 * grid is unchanged after pasting a link — which reads as nothing happened.
 * Shaped exactly like a real card so the grid does not reflow when the clip
 * replaces it.
 */
export function PendingCard({ item, onCancel }: { item: PendingImport; onCancel: (jobId: number) => void }) {
  const retrying = item.attempts > 0 && item.status === 'queued';
  const waitSeconds = Math.max(0, Math.round((item.runAfter - Date.now()) / 1000));

  const state = item.status === 'running' ? 'Downloading…' : retrying ? 'Retrying…' : 'Queued';

  return (
    <article className="pending-card" aria-live="polite">
      <div className="pending-card__media">
        <div className="pending-card__shimmer skeleton" aria-hidden="true" />

        <div className="pending-card__overlay">
          <span className="pending-card__site">{siteOf(item.url)}</span>

          <div className="pending-card__state">
            {item.status === 'running' ? <span className="spinner" /> : <span className="pending-card__dot" />}
            <span>{state}</span>
          </div>

          {retrying && item.attempts > 0 && (
            <span className="pending-card__attempt">
              attempt {item.attempts + 1} of {item.maxAttempts}
              {waitSeconds > 1 ? ` · in ${waitSeconds}s` : ''}
            </span>
          )}
        </div>

        {item.status === 'queued' && (
          <button
            type="button"
            className="pending-card__cancel"
            onClick={() => onCancel(item.jobId)}
            aria-label="Cancel this download"
            title="Cancel"
          >
            ×
          </button>
        )}
      </div>

      <div className="pending-card__body">
        <p className="pending-card__label truncate" title={item.url}>
          {labelOf(item.url)}
        </p>
        {/* The previous attempt's error, so a retry loop is not silent. */}
        {item.lastError && retrying ? (
          <p className="pending-card__error clamp-2">{item.lastError}</p>
        ) : (
          <div className="pending-card__line skeleton" aria-hidden="true" />
        )}
      </div>
    </article>
  );
}
