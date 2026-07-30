import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client.ts';
import type { Clip } from '../api/types.ts';
import { useDebounced, useInfiniteScroll } from '../hooks/index.ts';
import { useApp, useFavoriteToggle } from '../state/store.tsx';
import { ClipCard } from './ClipCard.tsx';
import { EmptyState } from './EmptyState.tsx';
import './ClipGrid.css';

const PAGE_SIZE = 60;

export function ClipGrid() {
  const {
    filters,
    libraryVersion,
    selection,
    toggleSelected,
    clearSelection,
    openClip,
    categories,
  } = useApp();

  const [clips, setClips] = useState<Clip[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const debouncedQuery = useDebounced(filters.query, 220);

  // Guards an out-of-order response from overwriting a newer one — typing
  // fast means several requests are in flight at once.
  const requestId = useRef(0);

  const load = useCallback(
    async (options: { append: boolean; cursor?: string | null }) => {
      const id = (requestId.current += 1);

      if (options.append) setLoadingMore(true);
      else setLoading(true);
      setFailed(null);

      try {
        const page = await api.clips({
          query: debouncedQuery,
          categoryId: filters.categoryId,
          tagId: filters.tagId,
          favorites: filters.favorites,
          kind: filters.kind,
          sort: filters.sort,
          cursor: options.cursor ?? undefined,
          limit: PAGE_SIZE,
          includeProcessing: true,
        });

        // A newer request has since started; discard this result.
        if (id !== requestId.current) return;

        setClips((current) => {
          if (!options.append) return page.clips;
          // Dedupe on append: a clip inserted between pages could otherwise
          // appear twice.
          const seen = new Set(current.map((clip) => clip.id));
          return [...current, ...page.clips.filter((clip) => !seen.has(clip.id))];
        });
        setCursor(page.nextCursor);
        setTotal(page.total);
      } catch (error) {
        if (id !== requestId.current) return;
        setFailed(error instanceof Error ? error.message : 'Could not load clips.');
      } finally {
        if (id === requestId.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [debouncedQuery, filters.categoryId, filters.tagId, filters.favorites, filters.kind, filters.sort],
  );

  // Reload from the top whenever the view changes.
  useEffect(() => {
    setCursor(null);
    void load({ append: false });
  }, [load, libraryVersion]);

  const sentinelRef = useInfiniteScroll(
    () => {
      if (cursor && !loadingMore && !loading) void load({ append: true, cursor });
    },
    { enabled: Boolean(cursor) && !loading },
  );

  const toggleFavorite = useFavoriteToggle();

  const handleToggleFavorite = useCallback(
    (clip: Clip) => {
      void toggleFavorite(clip, (favorited) => {
        setClips((current) => current.map((c) => (c.id === clip.id ? { ...c, favorited } : c)));
      });
    },
    [toggleFavorite],
  );

  /**
   * Start a drag.
   *
   * If the dragged card is part of a multi-selection the whole selection
   * travels; otherwise it is a single-clip drag.
   */
  const handleDragStart = useCallback(
    (clip: Clip, event: React.DragEvent) => {
      const ids = selection.has(clip.id) ? [...selection] : [clip.id];

      event.dataTransfer.effectAllowed = 'copy';
      event.dataTransfer.setData('application/x-loopa-clips', JSON.stringify(ids));
      // A text/plain fallback means dragging into a chat window or editor
      // produces the clip's URL rather than nothing.
      event.dataTransfer.setData('text/plain', ids.map((id) => `${window.location.origin}/clip/${id}`).join('\n'));

      if (ids.length > 1) {
        const ghost = document.createElement('div');
        ghost.className = 'drag-ghost';
        ghost.textContent = `${ids.length} clips`;
        document.body.append(ghost);
        event.dataTransfer.setDragImage(ghost, 12, 12);
        // Remove after the browser has snapshotted it.
        setTimeout(() => ghost.remove(), 0);
      }
    },
    [selection],
  );

  // Clear a selection by clicking empty space in the grid.
  const handleBackgroundClick = useCallback(
    (event: React.MouseEvent) => {
      if (event.target === event.currentTarget && selection.size > 0) clearSelection();
    },
    [selection.size, clearSelection],
  );

  if (loading) {
    return (
      <div className="clip-grid" aria-busy="true" aria-label="Loading clips">
        {Array.from({ length: 12 }, (_, index) => (
          <div key={index} className="clip-grid__skeleton">
            <div className="clip-grid__skeleton-media skeleton" />
            <div className="clip-grid__skeleton-body">
              <div className="skeleton clip-grid__skeleton-line" />
              <div className="skeleton clip-grid__skeleton-line clip-grid__skeleton-line--short" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (failed) {
    return (
      <EmptyState
        icon="⚠"
        title="Could not load the library"
        body={failed}
        action={{ label: 'Try again', run: () => void load({ append: false }) }}
      />
    );
  }

  if (clips.length === 0) {
    const activeCategory = categories.find((category) => category.id === filters.categoryId);

    if (debouncedQuery) {
      return (
        <EmptyState
          icon="🔍"
          title={`Nothing matches "${debouncedQuery}"`}
          body="Try a shorter phrase, or a word that would appear in the clip itself — Loopa searches titles, tags, captions and on-screen text."
        />
      );
    }
    if (filters.favorites) {
      return (
        <EmptyState
          icon="♥"
          title="No favourites yet"
          body="Hit the heart on any clip and it will show up here."
        />
      );
    }
    if (activeCategory) {
      return (
        <EmptyState
          icon={activeCategory.emoji || '📁'}
          title={`${activeCategory.name} is empty`}
          body="Drag clips onto this category in the sidebar to file them here."
        />
      );
    }

    return (
      <EmptyState
        icon="🎬"
        title="Your library is empty"
        body="Drop a video anywhere on this page to add it, or paste an Instagram, TikTok or YouTube link with the Add button."
      />
    );
  }

  return (
    <>
      <div className="clip-grid" onClick={handleBackgroundClick}>
        {clips.map((clip) => (
          <ClipCard
            key={clip.id}
            clip={clip}
            query={debouncedQuery}
            selected={selection.has(clip.id)}
            onOpen={openClip}
            onToggleSelect={toggleSelected}
            onToggleFavorite={handleToggleFavorite}
            onDragStart={handleDragStart}
          />
        ))}
      </div>

      {cursor && (
        <div ref={sentinelRef} className="clip-grid__more">
          {loadingMore ? (
            <>
              <span className="spinner" />
              <span>Loading more…</span>
            </>
          ) : (
            <button type="button" className="btn btn--secondary" onClick={() => void load({ append: true, cursor })}>
              Load more
            </button>
          )}
        </div>
      )}

      {!cursor && clips.length > 0 && (
        <p className="clip-grid__end">
          {total.toLocaleString()} {total === 1 ? 'clip' : 'clips'}
          {clips.length < total ? ` · showing ${clips.length.toLocaleString()}` : ''}
        </p>
      )}
    </>
  );
}
