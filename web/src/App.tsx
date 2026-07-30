import { useRef, useState } from 'react';
import { ClipGrid } from './components/ClipGrid.tsx';
import { DropZone, type DropZoneHandle } from './components/DropZone.tsx';
import { ImportDialog } from './components/ImportDialog.tsx';
import { Lightbox } from './components/Lightbox.tsx';
import { Sidebar } from './components/Sidebar.tsx';
import { Toasts } from './components/Toasts.tsx';
import { TopBar } from './components/TopBar.tsx';
import { useHotkey } from './hooks/index.ts';
import { AuthScreen } from './screens/AuthScreen.tsx';
import { SettingsDialog } from './screens/SettingsDialog.tsx';
import { useApp } from './state/store.tsx';
import './App.css';

export function App() {
  const {
    user,
    authLoading,
    filters,
    categories,
    selection,
    clearSelection,
    setFilters,
    sidebarOpen,
    setSidebarOpen,
  } = useApp();

  const [importOpen, setImportOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const dropZoneRef = useRef<DropZoneHandle | null>(null);

  useHotkey('u', () => dropZoneRef.current?.pickFiles(), { enabled: Boolean(user) });
  useHotkey('n', () => setImportOpen(true), { enabled: Boolean(user) });

  // Escape unwinds one layer at a time, outermost first — the mobile drawer
  // covers the page, so dismissing it has to take priority over clearing a
  // selection hidden behind it.
  useHotkey(
    'Escape',
    () => {
      if (sidebarOpen) setSidebarOpen(false);
      else if (selection.size > 0) clearSelection();
    },
    { enabled: Boolean(user) && (sidebarOpen || selection.size > 0) },
  );

  // Hold the shell until the session is resolved: rendering the sign-in form
  // and then swapping to the library is a jarring flash for a signed-in user.
  if (authLoading) {
    return (
      <div className="app-boot" role="status" aria-label="Loading Loopa">
        <span className="spinner" />
      </div>
    );
  }

  if (!user) {
    return (
      <>
        <AuthScreen />
        <Toasts />
      </>
    );
  }

  const activeCategory = categories.find((category) => category.id === filters.categoryId);
  const heading = filters.favorites
    ? 'Favourites'
    : activeCategory
      ? activeCategory.name
      : filters.query
        ? `Results for "${filters.query}"`
        : 'All clips';

  return (
    <>
      <a className="skip-link" href="#library">
        Skip to the library
      </a>

      <TopBar
        onOpenImport={() => setImportOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        onPickFiles={() => dropZoneRef.current?.pickFiles()}
      />

      <div className="app-shell">
        <Sidebar />

        <main className="app-main" id="library">
          <div className="app-content">
            <header className="app-heading">
              <div className="app-heading__text">
                <h1 className="app-heading__title">{heading}</h1>
                {activeCategory?.description && (
                  <p className="app-heading__subtitle">{activeCategory.description}</p>
                )}
              </div>

              {(filters.categoryId || filters.tagId || filters.favorites || filters.query) && (
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => setFilters({ categoryId: null, tagId: null, favorites: false, query: '' })}
                >
                  Clear filters
                </button>
              )}
            </header>

            <ClipGrid />
          </div>
        </main>
      </div>

      {/* Bulk action bar — only while a multi-selection exists. */}
      {selection.size > 0 && (
        <div className="selection-bar" role="status">
          <span className="selection-bar__count">
            {selection.size} selected
          </span>
          <span className="selection-bar__hint">Drag onto a category to file them</span>
          <button type="button" className="btn btn--ghost btn--sm" onClick={clearSelection}>
            Clear
          </button>
        </div>
      )}

      <DropZone ref={dropZoneRef} />
      <Lightbox />
      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <Toasts />
    </>
  );
}
