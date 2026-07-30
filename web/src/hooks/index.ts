import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Debounce a value.
 *
 * Search-as-you-type fires on every keystroke; without this, typing "golden
 * retriever" would issue 16 requests and render results out of order.
 */
export function useDebounced<T>(value: T, delayMs = 220): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}

/**
 * Fire a callback when a sentinel element scrolls into view.
 *
 * `rootMargin` deliberately extends well past the viewport so the next page
 * is already loading before the user reaches the bottom.
 */
export function useInfiniteScroll(
  onReachEnd: () => void,
  options: { enabled: boolean; rootMargin?: string } = { enabled: true },
) {
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const callbackRef = useRef(onReachEnd);
  callbackRef.current = onReachEnd;

  const { enabled, rootMargin = '800px' } = options;

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !enabled) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) callbackRef.current();
      },
      { rootMargin },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [enabled, rootMargin]);

  return sentinelRef;
}

/** Global keyboard shortcut, suppressed while the user is typing in a field. */
export function useHotkey(
  key: string,
  handler: (event: KeyboardEvent) => void,
  options: { meta?: boolean; allowInInput?: boolean; enabled?: boolean } = {},
) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  const { meta = false, allowInInput = false, enabled = true } = options;

  useEffect(() => {
    if (!enabled) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== key.toLowerCase()) return;
      if (meta !== (event.metaKey || event.ctrlKey)) return;

      if (!allowInInput) {
        const target = event.target as HTMLElement | null;
        const tag = target?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return;
      }

      handlerRef.current(event);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [key, meta, allowInInput, enabled]);
}

/** Close on Escape and on a click outside — the two ways people dismiss things. */
export function useDismissable(isOpen: boolean, onDismiss: () => void) {
  const ref = useRef<HTMLDivElement | null>(null);
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  useEffect(() => {
    if (!isOpen) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        dismissRef.current();
      }
    };

    const onPointerDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) dismissRef.current();
    };

    document.addEventListener('keydown', onKeyDown);
    // Capture phase, so a dismiss beats any handler inside the trigger.
    document.addEventListener('pointerdown', onPointerDown, true);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [isOpen]);

  return ref;
}

/**
 * Trap focus inside an open dialog.
 *
 * Without this, tabbing out of a modal lands on the page behind it — the
 * dialog looks modal but is not, which is disorienting for keyboard and
 * screen-reader users alike.
 */
export function useFocusTrap(isActive: boolean) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isActive) return;
    const container = ref.current;
    if (!container) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;

    const focusables = () =>
      Array.from(
        container.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => element.offsetParent !== null);

    // Prefer an explicitly marked element, else the first focusable.
    const initial = container.querySelector<HTMLElement>('[data-autofocus]') ?? focusables()[0];
    initial?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) return;

      const first = items[0]!;
      const last = items[items.length - 1]!;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    container.addEventListener('keydown', onKeyDown);
    return () => {
      container.removeEventListener('keydown', onKeyDown);
      // Return focus to whatever opened the dialog.
      previouslyFocused?.focus?.();
    };
  }, [isActive]);

  return ref;
}

/** Prevent the page behind a modal from scrolling. */
export function useScrollLock(isLocked: boolean) {
  useEffect(() => {
    if (!isLocked) return;

    const { overflow, paddingRight } = document.body.style;
    // Compensate for the scrollbar's width so locking does not shift the
    // whole layout sideways.
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;

    document.body.style.overflow = 'hidden';
    if (scrollbarWidth > 0) document.body.style.paddingRight = `${scrollbarWidth}px`;

    return () => {
      document.body.style.overflow = overflow;
      document.body.style.paddingRight = paddingRight;
    };
  }, [isLocked]);
}

/** State persisted to localStorage, tolerant of quota errors and bad JSON. */
export function usePersistedState<T>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored === null ? initial : (JSON.parse(stored) as T);
    } catch {
      return initial;
    }
  });

  const update = useCallback(
    (next: T) => {
      setValue(next);
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // Private browsing or a full quota — the in-memory value still works.
      }
    },
    [key],
  );

  return [value, update];
}

/** True once the media query matches; re-evaluates on change. */
export function useMediaQuery(queryString: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(queryString).matches : false,
  );

  useEffect(() => {
    const media = window.matchMedia(queryString);
    const onChange = (event: MediaQueryListEvent) => setMatches(event.matches);

    setMatches(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [queryString]);

  return matches;
}
