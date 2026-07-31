import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client.ts';
import type { Clip } from '../api/types.ts';
import { useDebounced, useInfiniteScroll } from '../hooks/index.ts';
import { useApp, useFavoriteToggle } from '../state/store.tsx';
import { ClipCard } from './ClipCard.tsx';
import { ContextMenu, type ContextMenuItem } from './ContextMenu.tsx';
import { EmptyState } from './EmptyState.tsx';
import { PendingCard } from './PendingCard.tsx';
import { RenamePrompt } from './RenamePrompt.tsx';
import { SoundbiteDialog } from './SoundbiteDialog.tsx';
import { TagPrompt } from './TagPrompt.tsx';
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
  rename: (
    <svg viewBox="0 0 24 24" width="15" height="15">
      <path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M14.5 6.5 17.5 9.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  ),
  tag: (
    <svg viewBox="0 0 24 24" width="15" height="15">
      <path d="M4 11.4V5a1 1 0 0 1 1-1h6.4a1 1 0 0 1 .7.3l7.3 7.3a1 1 0 0 1 0 1.4l-6.4 6.4a1 1 0 0 1-1.4 0L4.3 12.1a1 1 0 0 1-.3-.7Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <circle cx="8.3" cy="8.3" r="1.3" fill="currentColor" />
    </svg>
  ),
  copy: (
    <svg viewBox="0 0 24 24" width="15" height="15">
      <rect x="9" y="9" width="11" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M15 6.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  ),
  trash: (
    <svg viewBox="0 0 24 24" width="15" height="15">
      <path d="M4.5 7h15M9.5 7V5.5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1V7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M6.5 7h11l-.8 12a1 1 0 0 1-1 .9H8.3a1 1 0 0 1-1-.9Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  ),
  soundboard: (
    <svg viewBox="0 0 24 24" width="15" height="15">
      <path d="M5 9.5h3l4-3.5v12l-4-3.5H5a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M15.8 9a4 4 0 0 1 0 6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M18.4 6.6a7.5 7.5 0 0 1 0 10.8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  ),
} as const;

type MenuState = { clip: Clip; x: number; y: number };

const MIME_BY_EXTENSION: Record<string, string> = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  gif: 'image/gif',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

/** A filename a person would recognise, derived from the clip's own title. */
function downloadNameFor(clip: Clip): { filename: string; mime: string } {
  const source = clip.media.play ?? clip.media.download;
  const extension = (source.split('?')[0]!.split('.').pop() ?? 'mp4').toLowerCase();
  const base =
    (clip.title || clip.source.filename || 'clip')
      .replace(/\.[a-z0-9]{2,5}$/i, '')
      .replace(/[/\\?%*:|"<>]/g, '')
      .trim()
      .slice(0, 80) || 'clip';

  return { filename: `${base}.${extension}`, mime: MIME_BY_EXTENSION[extension] ?? 'application/octet-stream' };
}

/**
 * Put a clip's picture on the clipboard as a PNG.
 *
 * PNG because it is the only image type the clipboard API accepts across
 * browsers. For a video there is no frame to copy other than its poster, so
 * that is what gets copied — and the menu item says so rather than pretending
 * the video itself went to the clipboard.
 */
async function copyImageToClipboard(source: string): Promise<void> {
  const image = new Image();
  // Same-origin, but being explicit keeps the canvas untainted if media ever
  // moves to a CDN.
  image.crossOrigin = 'anonymous';
  image.src = source;

  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('That image could not be loaded.'));
  });

  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  canvas.getContext('2d')?.drawImage(image, 0, 0);

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('That image could not be converted.');

  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
}

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

      /*
       * Dragging a single clip out of the window drops the actual file.
       *
       * `DownloadURL` is what makes a drag into a file manager or a chat app
       * fetch and save the media rather than paste a link; it is Chromium-only,
       * so text/uri-list is set alongside for everything else. Only for a
       * single clip: the format carries one file, and a multi-selection drag
       * is aimed at the category shelves anyway.
       */
      if (ids.length === 1) {
        const { filename, mime } = downloadNameFor(clip);
        const absolute = new URL(clip.media.download, window.location.origin).href;
        event.dataTransfer.setData('DownloadURL', `${mime}:${filename}:${absolute}`);
        event.dataTransfer.setData('text/uri-list', absolute);
      }

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

  const [tagPrompt, setTagPrompt] = useState<{ ids: string[]; x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState<{ clip: Clip; x: number; y: number } | null>(null);
  const [soundbiteClip, setSoundbiteClip] = useState<Clip | null>(null);

  const renameClip = useCallback(
    async (clip: Clip, title: string) => {
      // Optimistic: the card is right there under the menu that was just used,
      // and a round trip before the text changes reads as a dead action.
      setClips((current) => current.map((c) => (c.id === clip.id ? { ...c, title } : c)));
      try {
        await api.updateClip(clip.id, { title });
      } catch (error) {
        setClips((current) => current.map((c) => (c.id === clip.id ? { ...c, title: clip.title } : c)));
        reportError(error, 'Could not rename that clip.');
      }
    },
    [reportError],
  );

  const copyImage = useCallback(
    async (clip: Clip) => {
      const source = clip.kind === 'image' ? clip.media.play : clip.media.poster;
      if (!source) {
        notify({ kind: 'error', message: 'That clip has no picture to copy yet.' });
        return;
      }

      // Writing to the clipboard needs a secure context, so over plain http
      // on a LAN address the API simply is not there.
      if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
        notify({
          kind: 'error',
          message: 'This browser will not let the page copy images.',
          hint: 'Clipboard access needs an https connection — it works over the tunnel, but not on a plain http LAN address.',
        });
        return;
      }

      try {
        await copyImageToClipboard(source);
        notify({ kind: 'success', message: clip.kind === 'image' ? 'Image copied.' : 'Poster frame copied.' });
      } catch (error) {
        reportError(error, 'Could not copy that image.');
      }
    },
    [notify, reportError],
  );

  const addTagTo = useCallback(
    async (ids: string[], name: string) => {
      try {
        await Promise.all(ids.map((id) => api.addTag(id, name)));
        await load({ append: false });
        notify({
          kind: 'success',
          message: ids.length === 1 ? `Tagged "${name}".` : `Tagged ${ids.length} clips "${name}".`,
        });
      } catch (error) {
        reportError(error, 'Could not add that tag.');
      }
    },
    [load, notify, reportError],
  );

  const saveClips = useCallback(
    (ids: string[]) => {
      // A top-level navigation so the browser streams the archive straight to
      // disk; buffering a few hundred megabytes into a blob first would cost
      // memory for nothing.
      window.location.href = `/api/clips/bulk/download.zip?ids=${ids.join(',')}`;
      notify({
        kind: 'info',
        message: ids.length === 1 ? 'Saving that clip…' : `Zipping ${ids.length} clips…`,
        hint: ids.length > 1 ? 'Large selections take a moment before the download starts.' : null,
      });
    },
    [notify],
  );

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
        id: 'rename',
        label: 'Rename',
        icon: ICONS.rename,
        // Renaming several clips to one title is never what anyone means.
        disabled: many,
        run: () => setRenaming({ clip: menu.clip, x: menu.x, y: menu.y }),
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
        id: 'tag',
        label: many ? `Tag ${targets.length} clips…` : 'Add tag…',
        icon: ICONS.tag,
        run: () => setTagPrompt({ ids: targets.map((clip) => clip.id), x: menu.x, y: menu.y }),
      },
      {
        id: 'copy',
        // Honest about what actually reaches the clipboard: a video cannot go
        // on it, so for one the poster frame is what gets copied.
        label: menu.clip.kind === 'image' ? 'Copy image' : 'Copy poster frame',
        icon: ICONS.copy,
        disabled: many,
        run: () => void copyImage(menu.clip),
      },
      {
        id: 'download',
        // One file downloads directly; several are zipped, because browsers
        // block a burst of separate downloads.
        label: many ? `Save ${targets.length} as .zip` : 'Save',
        icon: ICONS.download,
        run: () =>
          many
            ? saveClips(targets.map((clip) => clip.id))
            : (window.location.href = `/api/clips/${menu.clip.id}/download`),
      },
      // Admin-only: this writes into a shared soundboard everyone in Discord
      // hears, which is a different blast radius from anything else here.
      ...(user?.role === 'admin'
        ? [
            {
              id: 'soundboard',
              label: 'Send to CarbonBoard…',
              icon: ICONS.soundboard,
              hint: 'as MP3',
              // One clip at a time: the range is chosen per clip, so a
              // multi-selection has nothing coherent to mean.
              disabled: many || menu.clip.kind === 'image' || !menu.clip.hasAudio || menu.clip.status !== 'ready',
              run: () => setSoundbiteClip(menu.clip),
            } satisfies ContextMenuItem,
          ]
        : []),
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

      {renaming && (
        <RenamePrompt
          x={renaming.x}
          y={renaming.y}
          initial={renaming.clip.title}
          label="Rename clip"
          placeholder={renaming.clip.source.filename ?? 'Give this clip a title'}
          onSubmit={(title) => void renameClip(renaming.clip, title)}
          onClose={() => setRenaming(null)}
        />
      )}

      {tagPrompt && (
        <TagPrompt
          x={tagPrompt.x}
          y={tagPrompt.y}
          count={tagPrompt.ids.length}
          onSubmit={(name) => void addTagTo(tagPrompt.ids, name)}
          onClose={() => setTagPrompt(null)}
        />
      )}

      {soundbiteClip && (
        <SoundbiteDialog clip={soundbiteClip} onClose={() => setSoundbiteClip(null)} />
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
