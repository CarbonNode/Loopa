import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ApiError, api } from '../api/client.ts';
import type { Category, Clip, Filters, SystemStatus, User } from '../api/types.ts';
import { usePersistedState } from '../hooks/index.ts';

export type Toast = {
  id: string;
  kind: 'success' | 'error' | 'info';
  message: string;
  hint?: string | null;
  /** Optional inline action, e.g. Undo. */
  action?: { label: string; run: () => void };
};

export type Theme = 'dark' | 'light';

type AppState = {
  // Auth
  user: User | null;
  setupPending: boolean;
  authLoading: boolean;
  signIn: (user: User) => void;
  signOut: () => Promise<void>;

  // Library
  categories: Category[];
  refreshCategories: () => Promise<void>;
  status: SystemStatus | null;
  refreshStatus: () => Promise<void>;

  // Filters
  filters: Filters;
  setFilters: (patch: Partial<Filters>) => void;
  resetFilters: () => void;

  // Selection (for bulk drag-and-drop)
  selection: Set<string>;
  toggleSelected: (id: string, additive: boolean) => void;
  clearSelection: () => void;
  isSelected: (id: string) => boolean;

  // Lightbox
  activeClipId: string | null;
  openClip: (id: string | null) => void;

  // Chrome
  theme: Theme;
  toggleTheme: () => void;
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;

  // Feedback
  toasts: Toast[];
  notify: (toast: Omit<Toast, 'id'>) => void;
  dismissToast: (id: string) => void;
  reportError: (error: unknown, fallback?: string) => void;

  /** Bumped to make the clip grid refetch after an ingest or delete. */
  libraryVersion: number;
  invalidateLibrary: () => void;
};

const AppContext = createContext<AppState | null>(null);

const DEFAULT_FILTERS: Filters = {
  query: '',
  categoryId: null,
  tagId: null,
  favorites: false,
  kind: null,
  sort: 'recent',
};

let toastCounter = 0;

export function AppProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [setupPending, setSetupPending] = useState(false);
  const [authLoading, setAuthLoading] = useState(true);

  const [categories, setCategories] = useState<Category[]>([]);
  const [status, setStatus] = useState<SystemStatus | null>(null);

  const [filters, setFiltersState] = useState<Filters>(DEFAULT_FILTERS);
  const [selection, setSelection] = useState<Set<string>>(() => new Set());
  const [activeClipId, setActiveClipId] = useState<string | null>(null);

  const [theme, setTheme] = usePersistedState<Theme>('loopa.theme', 'dark');
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const [toasts, setToasts] = useState<Toast[]>([]);
  const [libraryVersion, setLibraryVersion] = useState(0);

  // ── Toasts ───────────────────────────────────────────────────────────────

  const dismissToast = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const notify = useCallback(
    (toast: Omit<Toast, 'id'>) => {
      const id = `toast-${(toastCounter += 1)}`;
      setToasts((current) => [...current.slice(-4), { ...toast, id }]);

      // Errors stay until dismissed — they usually carry a hint worth reading.
      if (toast.kind !== 'error') {
        setTimeout(() => dismissToast(id), toast.action ? 8000 : 4500);
      }
    },
    [dismissToast],
  );

  const reportError = useCallback(
    (error: unknown, fallback = 'Something went wrong.') => {
      if (error instanceof ApiError) {
        notify({ kind: 'error', message: error.message, hint: error.hint });
      } else {
        notify({ kind: 'error', message: error instanceof Error ? error.message : fallback });
      }
    },
    [notify],
  );

  // ── Data ─────────────────────────────────────────────────────────────────

  const refreshCategories = useCallback(async () => {
    try {
      const { categories: next } = await api.categories();
      setCategories(next);
    } catch (error) {
      // A 401 here just means the session expired; the auth effect handles it.
      if (!(error instanceof ApiError && error.status === 401)) {
        reportError(error, 'Could not load categories.');
      }
    }
  }, [reportError]);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await api.systemStatus());
    } catch {
      // Status drives a background indicator only — never surface a failure.
    }
  }, []);

  const invalidateLibrary = useCallback(() => setLibraryVersion((v) => v + 1), []);

  // ── Auth ─────────────────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const state = await api.authState();
        if (cancelled) return;
        setUser(state.user);
        setSetupPending(state.setupPending);
      } catch (error) {
        if (!cancelled) reportError(error, 'Could not reach the server.');
      } finally {
        if (!cancelled) setAuthLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [reportError]);

  const signIn = useCallback((next: User) => {
    setUser(next);
    setSetupPending(false);
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setUser(null);
      setCategories([]);
      setSelection(new Set());
      setActiveClipId(null);
      setFiltersState(DEFAULT_FILTERS);
    }
  }, []);

  // Load library data once signed in.
  useEffect(() => {
    if (!user) return;
    void refreshCategories();
    void refreshStatus();
  }, [user, refreshCategories, refreshStatus]);

  /**
   * Poll while work is in flight.
   *
   * Only while something is actually queued or running — an idle library
   * should not be issuing a request every few seconds forever.
   */
  const busy = (status?.jobs.queued ?? 0) + (status?.jobs.running ?? 0) > 0;
  const previousBusy = useRef(busy);

  useEffect(() => {
    if (!user || !busy) {
      // Work just finished: pull the freshly processed clips into the grid.
      if (previousBusy.current && !busy) {
        invalidateLibrary();
        void refreshCategories();
      }
      previousBusy.current = busy;
      return;
    }

    previousBusy.current = busy;
    const timer = setInterval(() => {
      void refreshStatus();
      invalidateLibrary();
    }, 2500);

    return () => clearInterval(timer);
  }, [user, busy, refreshStatus, refreshCategories, invalidateLibrary]);

  // ── Filters ──────────────────────────────────────────────────────────────

  const setFilters = useCallback((patch: Partial<Filters>) => {
    setFiltersState((current) => {
      const next = { ...current, ...patch };

      // Category, tag and favourites are alternative views of the library, so
      // choosing one clears the others rather than silently intersecting.
      if (patch.categoryId !== undefined && patch.categoryId !== null) {
        next.tagId = null;
        next.favorites = false;
      }
      if (patch.tagId !== undefined && patch.tagId !== null) {
        next.categoryId = null;
        next.favorites = false;
      }
      if (patch.favorites) {
        next.categoryId = null;
        next.tagId = null;
      }

      return next;
    });
  }, []);

  const resetFilters = useCallback(() => setFiltersState(DEFAULT_FILTERS), []);

  // ── Selection ────────────────────────────────────────────────────────────

  const toggleSelected = useCallback((id: string, additive: boolean) => {
    setSelection((current) => {
      const next = additive ? new Set(current) : new Set<string>();
      if (current.has(id) && additive) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => setSelection(new Set()), []);
  const isSelected = useCallback((id: string) => selection.has(id), [selection]);

  // ── Theme ────────────────────────────────────────────────────────────────

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', theme === 'dark' ? '#0c0d12' : '#f7f7fa');
  }, [theme]);

  const toggleTheme = useCallback(
    () => setTheme(theme === 'dark' ? 'light' : 'dark'),
    [theme, setTheme],
  );

  const value = useMemo<AppState>(
    () => ({
      user,
      setupPending,
      authLoading,
      signIn,
      signOut,
      categories,
      refreshCategories,
      status,
      refreshStatus,
      filters,
      setFilters,
      resetFilters,
      selection,
      toggleSelected,
      clearSelection,
      isSelected,
      activeClipId,
      openClip: setActiveClipId,
      theme,
      toggleTheme,
      sidebarOpen,
      setSidebarOpen,
      toasts,
      notify,
      dismissToast,
      reportError,
      libraryVersion,
      invalidateLibrary,
    }),
    [
      user, setupPending, authLoading, signIn, signOut,
      categories, refreshCategories, status, refreshStatus,
      filters, setFilters, resetFilters,
      selection, toggleSelected, clearSelection, isSelected,
      activeClipId, theme, toggleTheme, sidebarOpen,
      toasts, notify, dismissToast, reportError,
      libraryVersion, invalidateLibrary,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppState {
  const context = useContext(AppContext);
  if (!context) throw new Error('useApp must be used inside <AppProvider>');
  return context;
}

/** Optimistic favourite toggle that rolls back if the request fails. */
export function useFavoriteToggle() {
  const { reportError } = useApp();

  return useCallback(
    async (clip: Clip, onLocalChange: (favorited: boolean) => void) => {
      const next = !clip.favorited;
      onLocalChange(next);
      try {
        await api.setFavorite(clip.id, next);
      } catch (error) {
        onLocalChange(!next);
        reportError(error, 'Could not update your favourites.');
      }
    },
    [reportError],
  );
}
