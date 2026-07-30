import { useCallback, useMemo, useRef, useState } from 'react';
import { api } from '../api/client.ts';
import type { Category, ClipKind } from '../api/types.ts';
import { useApp } from '../state/store.tsx';
import { formatCount } from '../utils/format.ts';
import './Sidebar.css';

/** Read the dragged clip ids, tolerating a drag that came from elsewhere. */
function readDraggedClips(event: React.DragEvent): string[] {
  const raw = event.dataTransfer.getData('application/x-loopa-clips');
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Media-type filter options.
 *
 * A refinement rather than a destination: it intersects with whatever view is
 * already open, so "the GIFs in Bangers" is one click from "Bangers".
 */
const KIND_FILTERS: ReadonlyArray<{ value: ClipKind | null; label: string; hint: string }> = [
  { value: null, label: 'All', hint: 'Everything in the library' },
  { value: 'video', label: 'Video', hint: 'Videos only' },
  { value: 'gif', label: 'GIF', hint: 'GIFs only' },
  { value: 'image', label: 'Image', hint: 'Images and screenshots only' },
];

export function Sidebar() {
  const {
    categories,
    refreshCategories,
    filters,
    setFilters,
    status,
    notify,
    reportError,
    invalidateLibrary,
    clearSelection,
    sidebarOpen,
    setSidebarOpen,
  } = useApp();

  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [reorderTarget, setReorderTarget] = useState<{ id: string; edge: 'above' | 'below' } | null>(null);

  const draggingCategory = useRef<string | null>(null);
  // dragenter/dragleave fire for every child element, so a plain boolean
  // would flicker. Counting entries and exits is the reliable pattern.
  const dragDepth = useRef(new Map<string, number>());

  /**
   * Only show the category filter once the list is long enough to need it.
   *
   * Below ~10, scanning is faster than typing; above it, a search field is
   * what keeps the sidebar usable as the library grows.
   */
  const showFilter = categories.length >= 10;

  const visibleCategories = useMemo(() => {
    if (!categoryFilter.trim()) return categories;
    const needle = categoryFilter.trim().toLowerCase();
    return categories.filter((category) => category.name.toLowerCase().includes(needle));
  }, [categories, categoryFilter]);

  const closeOnMobile = useCallback(() => setSidebarOpen(false), [setSidebarOpen]);

  // ── Clip → category drops ─────────────────────────────────────────────────

  const handleDropOnCategory = useCallback(
    async (event: React.DragEvent, category: Category) => {
      event.preventDefault();
      setDropTarget(null);
      dragDepth.current.delete(category.id);

      const clipIds = readDraggedClips(event);
      if (clipIds.length === 0) return;

      try {
        await api.bulkCategorise(clipIds, category.id, 'add');
        await refreshCategories();
        invalidateLibrary();
        clearSelection();

        notify({
          kind: 'success',
          message:
            clipIds.length === 1
              ? `Added to ${category.name}`
              : `Added ${clipIds.length} clips to ${category.name}`,
          action: {
            label: 'Undo',
            run: () => {
              void api
                .bulkCategorise(clipIds, category.id, 'remove')
                .then(() => {
                  void refreshCategories();
                  invalidateLibrary();
                })
                .catch((error: unknown) => reportError(error, 'Could not undo that.'));
            },
          },
        });
      } catch (error) {
        reportError(error, 'Could not file those clips.');
      }
    },
    [refreshCategories, invalidateLibrary, clearSelection, notify, reportError],
  );

  const handleDragOver = useCallback((event: React.DragEvent, categoryId: string) => {
    // Clip drags file into the category; category drags reorder the list.
    if (draggingCategory.current) {
      event.preventDefault();
      const bounds = event.currentTarget.getBoundingClientRect();
      const edge = event.clientY < bounds.top + bounds.height / 2 ? 'above' : 'below';
      setReorderTarget({ id: categoryId, edge });
      return;
    }

    if (event.dataTransfer.types.includes('application/x-loopa-clips')) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    }
  }, []);

  const handleDragEnter = useCallback((event: React.DragEvent, categoryId: string) => {
    if (draggingCategory.current) return;
    if (!event.dataTransfer.types.includes('application/x-loopa-clips')) return;

    const depth = (dragDepth.current.get(categoryId) ?? 0) + 1;
    dragDepth.current.set(categoryId, depth);
    setDropTarget(categoryId);
  }, []);

  const handleDragLeave = useCallback((categoryId: string) => {
    const depth = (dragDepth.current.get(categoryId) ?? 1) - 1;
    if (depth <= 0) {
      dragDepth.current.delete(categoryId);
      setDropTarget((current) => (current === categoryId ? null : current));
    } else {
      dragDepth.current.set(categoryId, depth);
    }
  }, []);

  // ── Category reordering ───────────────────────────────────────────────────

  const handleCategoryDrop = useCallback(
    async (event: React.DragEvent, target: Category) => {
      if (!draggingCategory.current) return;
      event.preventDefault();

      const movingId = draggingCategory.current;
      draggingCategory.current = null;
      const edge = reorderTarget?.edge ?? 'below';
      setReorderTarget(null);

      if (movingId === target.id) return;

      const ordered = categories.filter((category) => category.id !== movingId);
      const targetIndex = ordered.findIndex((category) => category.id === target.id);
      if (targetIndex < 0) return;

      const insertAt = edge === 'above' ? targetIndex : targetIndex + 1;
      const before = ordered[insertAt - 1] ?? null;
      const after = ordered[insertAt] ?? null;

      try {
        await api.reorderCategory(movingId, before?.id ?? null, after?.id ?? null);
        await refreshCategories();
      } catch (error) {
        reportError(error, 'Could not reorder the categories.');
      }
    },
    [categories, reorderTarget, refreshCategories, reportError],
  );

  // ── Create ────────────────────────────────────────────────────────────────

  const handleCreate = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      const name = newName.trim();
      if (!name) return;

      try {
        const { category } = await api.createCategory({ name });
        setNewName('');
        setCreating(false);
        await refreshCategories();
        setFilters({ categoryId: category.id });
      } catch (error) {
        reportError(error, 'Could not create that category.');
      }
    },
    [newName, refreshCategories, setFilters, reportError],
  );

  const totalClips = status?.stats.clips ?? 0;

  return (
    <>
      {/* Tap-to-dismiss backdrop, mobile only. */}
      {sidebarOpen && <div className="sidebar__backdrop" onClick={closeOnMobile} aria-hidden="true" />}

      <aside className={`sidebar${sidebarOpen ? ' sidebar--open' : ''}`} aria-label="Library navigation">
        <nav className="sidebar__section">
          <ul className="sidebar__list">
            <li>
              <button
                type="button"
                className={`sidebar__item${!filters.categoryId && !filters.tagId && !filters.favorites ? ' is-active' : ''}`}
                onClick={() => {
                  setFilters({ categoryId: null, tagId: null, favorites: false });
                  closeOnMobile();
                }}
              >
                <span className="sidebar__icon" aria-hidden="true">
                  ▦
                </span>
                <span className="sidebar__label">All clips</span>
                {totalClips > 0 && <span className="sidebar__count">{formatCount(totalClips)}</span>}
              </button>
            </li>
            <li>
              <button
                type="button"
                className={`sidebar__item${filters.favorites ? ' is-active' : ''}`}
                onClick={() => {
                  setFilters({ favorites: true });
                  closeOnMobile();
                }}
              >
                <span className="sidebar__icon" aria-hidden="true">
                  ♥
                </span>
                <span className="sidebar__label">Favourites</span>
              </button>
            </li>
          </ul>

          {/* Deliberately not a nav row: this narrows the current view instead
              of replacing it, so it must not look like another destination.
              It also stays open on mobile — you often set a type and then pick
              a category, and closing the drawer between the two is hostile. */}
          <div className="sidebar__kinds" role="group" aria-label="Filter by media type">
            {KIND_FILTERS.map((option) => {
              const active = filters.kind === option.value;
              return (
                <button
                  key={option.label}
                  type="button"
                  className={`sidebar__kind${active ? ' is-active' : ''}`}
                  onClick={() => setFilters({ kind: option.value })}
                  aria-pressed={active}
                  title={option.hint}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </nav>

        <div className="sidebar__section sidebar__section--grow">
          <div className="sidebar__heading">
            <h2 className="sidebar__heading-text">Categories</h2>
            <button
              type="button"
              className="sidebar__add"
              onClick={() => setCreating((open) => !open)}
              aria-label="New category"
              aria-expanded={creating}
              title="New category"
            >
              +
            </button>
          </div>

          {creating && (
            <form className="sidebar__create" onSubmit={handleCreate}>
              <input
                className="input sidebar__create-input"
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                placeholder="Category name"
                maxLength={60}
                autoFocus
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    setCreating(false);
                    setNewName('');
                  }
                }}
              />
              <button type="submit" className="btn btn--primary btn--sm" disabled={!newName.trim()}>
                Add
              </button>
            </form>
          )}

          {showFilter && (
            <input
              type="search"
              className="input sidebar__filter"
              value={categoryFilter}
              onChange={(event) => setCategoryFilter(event.target.value)}
              placeholder={`Filter ${categories.length} categories…`}
              aria-label="Filter categories"
            />
          )}

          <ul className="sidebar__list sidebar__list--scroll">
            {visibleCategories.map((category) => (
              <li key={category.id} className="sidebar__row">
                {reorderTarget?.id === category.id && reorderTarget.edge === 'above' && (
                  <span className="sidebar__drop-line" aria-hidden="true" />
                )}

                <button
                  type="button"
                  draggable
                  className={[
                    'sidebar__item',
                    'sidebar__item--category',
                    filters.categoryId === category.id ? 'is-active' : '',
                    dropTarget === category.id ? 'is-drop-target' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  style={{ '--category-color': category.color } as React.CSSProperties}
                  onClick={() => {
                    setFilters({ categoryId: filters.categoryId === category.id ? null : category.id });
                    closeOnMobile();
                  }}
                  onDragStart={() => {
                    draggingCategory.current = category.id;
                  }}
                  onDragEnd={() => {
                    draggingCategory.current = null;
                    setReorderTarget(null);
                  }}
                  onDragOver={(event) => handleDragOver(event, category.id)}
                  onDragEnter={(event) => handleDragEnter(event, category.id)}
                  onDragLeave={() => handleDragLeave(category.id)}
                  onDrop={(event) => {
                    if (draggingCategory.current) void handleCategoryDrop(event, category);
                    else void handleDropOnCategory(event, category);
                  }}
                  title={category.description || category.name}
                >
                  <span className="sidebar__swatch" aria-hidden="true">
                    {category.emoji || ''}
                  </span>
                  <span className="sidebar__label">{category.name}</span>
                  <span className="sidebar__count">{formatCount(category.count)}</span>
                </button>

                {reorderTarget?.id === category.id && reorderTarget.edge === 'below' && (
                  <span className="sidebar__drop-line" aria-hidden="true" />
                )}
              </li>
            ))}

            {visibleCategories.length === 0 && (
              <li className="sidebar__empty">
                {categoryFilter ? `No category matches "${categoryFilter}"` : 'No categories yet.'}
              </li>
            )}
          </ul>
        </div>

        <p className="sidebar__hint">
          Drag clips onto a category to file them. Hold <kbd>⌘</kbd>/<kbd>Ctrl</kbd> to select several first.
        </p>
      </aside>
    </>
  );
}
