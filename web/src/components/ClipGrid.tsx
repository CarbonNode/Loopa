import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client.ts';
import type { Clip } from '../api/types.ts';
import { useDebounced, useInfiniteScroll } from '../hooks/index.ts';
import { useApp, useFavoriteToggle } from '../state/store.tsx';
import { ClipCard } from './ClipCard.tsx';
import { ContextMenu, type ContextMenuItem } from './ContextMenu.tsx';
import { EmptyState } from './EmptyState.tsx';
import { PendingCard } from './PendingCard.tsx';
import './ClipGrid.css';

const PAGE_SIZE = 60;

/** Icons for the context menu, kept inline to match the rest of the app. */
const ICONS = {
  open: (
    <svg viewBox="0 0 24 24" width="15" height="15">
      <path d="M5 6.5A1.5 1.5 0 0 1 6.5 5H10" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
      <path d="M9 15V9h6" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
      <path d="m9 9 10 10" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  ),
  heart: (
    <svg viewBox="0 0 24 24" width="15" height="15">
      <path
        d="M12 20.5 4.8 13.6a4.6 4.6 0 0 1 6.5-6.5l.7.7.7-.7a4.6 4.6 0 1 1 6.5 6.5Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  ),
  share: (
    <svg viewBox="0 0 24 24" width="15" height="15">
      <path
        d="M10 14a3.6 3.6 0 0 0 5.3.3l3-3a3.6 3.6 0 0 0-5-5l-1.1 1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        d="M14 10a3.6 3.6 0 0 0-5.3-.3l-3 3a3.6 3.6 0 0 0 5 5l1.1-1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  ),
  select: (
    <svg viewBox="0 0 24 24" width="15" height="15">
      <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  ),
  download: (
    <svg viewBox="0 0 24 24" width="15" height="15">
      <path d="M12 4v11m0 0-4-4m4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 17.5V19a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-1.5" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  ),
  trash: (
    <svg viewBox="0 0 24 24" width="15" height="15">
      <path d="M4.5 7h15M9.5 7V5.5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1V7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M6.5 7h11l-.8 12a1 1 0 0 1-1 .9H8.3a1 1 0 0 1-1-.9Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  ),
} as const;

type MenuState = { clip: Clip; x: number; y: number };

export function ClipGrid() {
  const {
    filters,
    libraryVersion,
    selection,
    toggleSelected,
    clearSelection,
    openClip,
    categories,
    status,
    refreshStatus,
    refreshCategories,
    notify,
    reportError,
    user,
  } = useApp();

  /**
   * In-flight downloads, shown as placeholder cards at the top of the grid.
   *
   * Hidden while a filter is active: a queued download has no title, tags or
   * category yet, so it cannot honestly be said to match a search or belong
   * to the category you are looking at.
   */
  const filtering = Boolean(
    filters.query.trim() || filters.categoryId || filters.tagId || filters.favorites || filters.kind,
  );
  const pending = filtering ? [] : (status?.pendingImports ?? []);

  const cancelPending = useCallback(
    (jobId: number) => {
      void api
        .cancelImport(jobId)
        .then(() => {
          void refreshStatus();
          notify({ kind: 'info', message: 'Download cancelled.' });
        })
        .catch((error: unknown) => reportError(error, 'Could not cancel that download.'));
    },
    [refreshStatus, notify, reportError],
  );

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

  // ── Context menu ──────────────────────────────────────────────────────────

  const [menu, setMenu] = useState<MenuState | null>(null);

  /**
   * Deliberately depends on nothing but the setter.
   *
   * ClipCard is memoised on its data fields and ignores callback identity, so
   * a handler closing over `selection` would go stale on cards that did not
   * re-render. Storing only the click means the menu's items are built later,
   * in this component's render, where the selection is always current.
   */
  const handleContextMenu = useCallback((clip: Clip, event: React.MouseEvent) => {
    event.preventDefault();
    setMenu({ clip, x: event.clientX, y: event.clientY });
  }, []);

  const restoreClips = useCallback(
    async (ids: string[]) => {
      try {
        await Promise.all(ids.map((id) => api.restoreClip(id)));
        await load({ append: false });
        void refreshCategories();
        void refreshStatus();
        notify({ kind: 'info', message: ids.length === 1 ? 'Clip restored.' : `${ids.length} clips restored.` });
      } catch (error) {
        reportError(error, 'Could not restore that.');
        void load({ append: false });
      }
    },
    [load, refreshCategories, refreshStatus, notify, reportError],
  );

  const deleteClips = useCallback(
    async (ids: string[], skipped: number) => {
      // Removed from the grid first: waiting on the round trip leaves the card
      // sitting there after a deliberate action, which reads as a dead click.
      setClips((current) => current.filter((clip) => !ids.includes(clip.id)));
      setTotal((current) => Math.max(0, current - ids.length));
      clearSelection();

      try {
        await Promise.all(ids.map((id) => api.deleteClip(id)));
        void refreshCategories();
        void refreshStatus();

        notify({
          kind: 'success',
          message: ids.length === 1 ? 'Clip removed.' : `${ids.length} clips removed.`,
          hint: skipped > 0 ? `${skipped} left alone — only an admin or the uploader can remove those.` : null,
          action: { label: 'Undo', run: () => void restoreClips(ids) },
        });
      } catch (error) {
        reportError(error, 'Could not remove that clip.');
        // The optimistic removal was a guess and it was wrong; resync.
        void load({ append: false });
      }
    },
    [clearSelection, refreshCategories, refreshStatus, notify, restoreClips, reportError, load],
  );

  /**
   * Mint (or re-fetch) the clip's public link and put it on the clipboard.
   *
   * The endpoint is idempotent, so a second "Copy share link" on the same clip
   * hands back the URL already in circulation rather than orphaning it.
   */
  const shareClip = useCallback(
    async (clip: Clip) => {
      try {
        const { share } = await api.shareClip(clip.id);
        try {
          await navigator.clipboard.writeText(share.url);
          notify({
            kind: 'success',
            message: 'Share link copied.',
            hint: 'Anyone with it can watch — no account needed.',
          });
        } catch {
          // Insecure origin, or the user denied clipboard access. The URL is
          // the whole point, so show it rather than swallowing the failure.
          notify({ kind: 'info', message: share.url });
        }
      } catch (error) {
        reportError(error, 'Could not create a share link.');
      }
    },
    [notify, reportError],
  );

  /**
   * Build the menu for whatever was right-clicked.
   *
   * A right-click on a card inside a multi-selection acts on the whole
   * selection — the same rule drag-and-drop already follows. On a card
   * outside it, the selection is irrelevant and only that clip is affected.
   */
  const menuItems = useMemo<ContextMenuItem[]>(() => {
    if (!menu) return [];

    const inSelection = selection.has(menu.clip.id);
    const targets = inSelection && selection.size > 1 ? clips.filter((clip) => selection.has(clip.id)) : [menu.clip];

    const canDelete = (clip: Clip) => user?.role === 'admin' || clip.uploaderId === user?.id;
    const deletable = targets.filter(canDelete);
    const many = targets.length > 1;

    return [
      {
        id: 'open',
        label: 'Open',
        icon: ICONS.open,
        disabled: many,
        run: () => openClip(menu.clip.id),
      },
      {
        id: 'favorite',
        label: menu.clip.favorited ? 'Remove from favourites' : 'Add to favourites',
        icon: ICONS.heart,
        disabled: many,
        run: () => handleToggleFavorite(menu.clip),
      },
      {
        id: 'select',
        label: inSelection ? 'Deselect' : 'Select',
        icon: ICONS.select,
        run: () => toggleSelected(menu.clip.id, true),
      },
      {
        id: 'download',
        label: 'Download',
        icon: ICONS.download,
        // Browsers block a burst of downloads, so this stays single-clip.
        disabled: many,
        run: () => {
          window.location.href = `/api/clips/${menu.clip.id}/download`;
        },
      },
      {
        id: 'share',
        label: 'Copy share link',
        icon: ICONS.share,
        hint: 'no sign-in needed',
        // One link per clip, so this is meaningless on a multi-selection.
        disabled: many || menu.clip.status !== 'ready',
        run: () => void shareClip(menu.clip),
      },
      {
        id: 'delete',
        label: deletable.length > 1 ? `Delete ${deletable.length} clips` : 'Delete',
        icon: ICONS.trash,
        hint: deletable.length === 1 && many ? '1 of ' + targets.length : undefined,
        danger: true,
        separatorBefore: true,
        disabled: deletable.length === 0,
        run: () =>
          void deleteClips(
            deletable.map((clip) => clip.id),
            targets.length - deletable.length,
          ),
      },
    ];
  }, [menu, selection, clips, user, openClip, handleToggleFavorite, toggleSelected, deleteClips, shareClip]);

  if (loading) {
    return (
      <div className="clip-grid" aria-busy="true" aria-label="Loading clips">
        {pending.map((item) => (
          <PendingCard key={`pending-${item.jobId}`} item={item} onCancel={cancelPending} />
        ))}
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

  // Downloads in flight but nothing in the library yet — show the
  // placeholders rather than an empty state that contradicts them.
  if (clips.length === 0 && pending.length > 0) {
    return (
      <div className="clip-grid">
        {pending.map((item) => (
          <PendingCard key={`pending-${item.jobId}`} item={item} onCancel={cancelPending} />
        ))}
      </div>
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
        body="Drop a video anywhere on this page, paste one straight from your clipboard, or add an Instagram, TikTok or YouTube link with the Add button."
      />
    );
  }

  return (
    <>
      <div className="clip-grid" onClick={handleBackgroundClick}>
        {pending.map((item) => (
          <PendingCard key={`pending-${item.jobId}`} item={item} onCancel={cancelPending} />
        ))}
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
            onContextMenu={handleContextMenu}
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

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          label={menu.clip.title || 'Clip actions'}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}
