import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { Clip } from '../api/types.ts';
import { useMediaQuery } from '../hooks/index.ts';
import { formatCount, formatDuration, highlightMatches } from '../utils/format.ts';
import './ClipCard.css';

type ClipCardProps = {
  clip: Clip;
  query: string;
  selected: boolean;
  onOpen: (id: string) => void;
  onToggleSelect: (id: string, additive: boolean) => void;
  onToggleFavorite: (clip: Clip) => void;
  /** Ids being dragged, so a multi-selection drags as a group. */
  onDragStart: (clip: Clip, event: React.DragEvent) => void;
};

/** Frozen SVG placeholder so a missing poster never renders as a broken image. */
const PLACEHOLDER =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 9'%3E%3Crect width='16' height='9' fill='%2314161d'/%3E%3C/svg%3E";

function ClipCardComponent({
  clip,
  query,
  selected,
  onOpen,
  onToggleSelect,
  onToggleFavorite,
  onDragStart,
}: ClipCardProps) {
  // Three chips in a ~160px card ellipsise to "f…", "overco…" — technically
  // present, useless to read. Two legible tags beat three stubs.
  const narrow = useMediaQuery('(max-width: 640px)');
  const maxTags = narrow ? 2 : 3;

  const [previewing, setPreviewing] = useState(false);
  const [posterLoaded, setPosterLoaded] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hoverTimer = useRef<number | null>(null);

  const isProcessing = clip.status === 'processing';
  const isFailed = clip.status === 'failed';
  const duration = formatDuration(clip.durationMs);

  /**
   * Delay before starting the preview.
   *
   * Without it, sweeping the cursor across the grid would kick off a video
   * fetch for every card it crosses.
   */
  const startPreview = useCallback(() => {
    if (!clip.media.preview || isProcessing) return;
    hoverTimer.current = window.setTimeout(() => setPreviewing(true), 220);
  }, [clip.media.preview, isProcessing]);

  const stopPreview = useCallback(() => {
    if (hoverTimer.current !== null) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
    setPreviewing(false);
  }, []);

  useEffect(() => () => {
    if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (previewing) {
      video.currentTime = 0;
      // A rejected play() is normal (autoplay policy, or the element unmounted
      // mid-load) and is not worth surfacing.
      void video.play().catch(() => undefined);
    } else {
      video.pause();
    }
  }, [previewing]);

  const handleClick = (event: React.MouseEvent) => {
    // Cmd/Ctrl-click builds a multi-selection to drag onto a category.
    if (event.metaKey || event.ctrlKey || event.shiftKey) {
      event.preventDefault();
      onToggleSelect(clip.id, true);
      return;
    }
    onOpen(clip.id);
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onOpen(clip.id);
    }
  };

  const titleParts = highlightMatches(clip.title || clip.source.filename || 'Untitled clip', query);

  return (
    <article
      className={`clip-card${selected ? ' clip-card--selected' : ''}${isProcessing ? ' clip-card--processing' : ''}`}
      draggable={!isProcessing}
      onDragStart={(event) => onDragStart(clip, event)}
      onMouseEnter={startPreview}
      onMouseLeave={stopPreview}
      onFocus={startPreview}
      onBlur={stopPreview}
    >
      <button
        type="button"
        className="clip-card__surface"
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        aria-label={`Open ${clip.title || 'clip'}`}
      >
        <div className="clip-card__media">
          {/* A blurred, cover-fitted copy fills the tile behind the poster.
              Tiles are a uniform square so grid rows stay even, and this is
              what lets a 9:16 Reel and a 16:9 clip share that shape without
              either being cropped. Same src, so it costs no extra request. */}
          {clip.media.poster && (
            <img className="clip-card__backdrop" src={clip.media.poster} alt="" aria-hidden="true" draggable={false} />
          )}

          <img
            className={`clip-card__poster${posterLoaded ? ' is-loaded' : ''}`}
            src={clip.media.poster ?? PLACEHOLDER}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
            onLoad={() => setPosterLoaded(true)}
            // A poster that 404s (mid-processing, or a purged derivative)
            // falls back rather than showing a broken-image glyph.
            onError={(event) => {
              event.currentTarget.src = PLACEHOLDER;
              setPosterLoaded(true);
            }}
          />

          {!posterLoaded && <div className="clip-card__poster-skeleton skeleton" aria-hidden="true" />}

          {clip.media.preview && (
            <video
              ref={videoRef}
              className={`clip-card__preview${previewing ? ' is-playing' : ''}`}
              // Only attach the source once hovering, so the grid does not
              // fetch a preview for every card on screen.
              src={previewing ? clip.media.preview : undefined}
              muted
              loop
              playsInline
              preload="none"
              tabIndex={-1}
              aria-hidden="true"
            />
          )}

          <div className="clip-card__scrim" aria-hidden="true" />

          {isProcessing && (
            <div className="clip-card__status" role="status">
              <span className="spinner" />
              <span>Processing…</span>
            </div>
          )}

          {isFailed && (
            <div className="clip-card__status clip-card__status--error" role="status">
              <span aria-hidden="true">⚠</span>
              <span>Failed</span>
            </div>
          )}

          <div className="clip-card__badges">
            {clip.kind === 'gif' && <span className="clip-card__badge">GIF</span>}
            {clip.ai.nsfw && <span className="clip-card__badge clip-card__badge--nsfw">NSFW</span>}
            {duration && <span className="clip-card__badge clip-card__badge--duration">{duration}</span>}
          </div>

          {clip.ai.status === 'pending' || clip.ai.status === 'running' ? (
            <span className="clip-card__tagging" title="AI tagging in progress">
              <span className="clip-card__tagging-dot" />
            </span>
          ) : null}
        </div>

        <div className="clip-card__body">
          <h3 className="clip-card__title clamp-2">
            {titleParts.map((part, index) =>
              part.match ? (
                <mark key={index} className="clip-card__mark">
                  {part.text}
                </mark>
              ) : (
                <span key={index}>{part.text}</span>
              ),
            )}
          </h3>

          {clip.tags.length > 0 && (
            <ul className="clip-card__tags">
              {clip.tags.slice(0, maxTags).map((tag) => (
                <li key={tag.id} className="chip">
                  <span className="chip__label">{tag.name}</span>
                </li>
              ))}
              {clip.tags.length > maxTags && (
                <li className="chip clip-card__tags-more">+{clip.tags.length - maxTags}</li>
              )}
            </ul>
          )}
        </div>
      </button>

      {/* Outside the main button: nesting interactive elements is invalid and
          breaks keyboard traversal. */}
      <div className="clip-card__actions">
        <button
          type="button"
          className={`clip-card__action${clip.favorited ? ' is-active' : ''}`}
          onClick={(event) => {
            event.stopPropagation();
            onToggleFavorite(clip);
          }}
          aria-label={clip.favorited ? 'Remove from favourites' : 'Add to favourites'}
          aria-pressed={clip.favorited}
          title={clip.favorited ? 'Remove from favourites' : 'Add to favourites'}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path
              d="M12 20.5 4.8 13.6a4.6 4.6 0 0 1 6.5-6.5l.7.7.7-.7a4.6 4.6 0 1 1 6.5 6.5Z"
              fill={clip.favorited ? 'currentColor' : 'none'}
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinejoin="round"
            />
          </svg>
        </button>

        <button
          type="button"
          className={`clip-card__action clip-card__action--select${selected ? ' is-active' : ''}`}
          onClick={(event) => {
            event.stopPropagation();
            onToggleSelect(clip.id, true);
          }}
          aria-label={selected ? 'Deselect' : 'Select'}
          aria-pressed={selected}
          title={selected ? 'Deselect' : 'Select for bulk actions'}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            {selected ? (
              <path d="M5 12.5 10 17.5 19 7" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
            ) : (
              <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="1.8" />
            )}
          </svg>
        </button>
      </div>

      {/* Only once a clip has actually been watched a few times. A bare "1"
          on every card is noise, and an unlabelled number reads as a mystery
          rather than a view count — hence the icon. */}
      {clip.viewCount >= 5 && (
        <span className="clip-card__views" aria-label={`${clip.viewCount} views`}>
          <svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true">
            <path
              d="M2 12s3.8-6 10-6 10 6 10 6-3.8 6-10 6-10-6-10-6Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            />
            <circle cx="12" cy="12" r="2.6" fill="currentColor" />
          </svg>
          {formatCount(clip.viewCount)}
        </span>
      )}
    </article>
  );
}

/**
 * Memoised on the fields the card actually renders.
 *
 * The grid re-renders on every filter keystroke; without this, hundreds of
 * cards reconcile per character typed.
 */
export const ClipCard = memo(ClipCardComponent, (prev, next) => {
  return (
    prev.clip.id === next.clip.id &&
    prev.clip.updatedAt === next.clip.updatedAt &&
    prev.clip.favorited === next.clip.favorited &&
    prev.clip.status === next.clip.status &&
    prev.clip.ai.status === next.clip.ai.status &&
    prev.clip.viewCount === next.clip.viewCount &&
    prev.selected === next.selected &&
    prev.query === next.query
  );
});
