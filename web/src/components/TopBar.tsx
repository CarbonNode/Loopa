import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client.ts';
import type { SortKey, TagWithCount } from '../api/types.ts';
import { useDebounced, useDismissable, useHotkey } from '../hooks/index.ts';
import { useApp } from '../state/store.tsx';
import { formatCount, highlightMatches, initialsOf } from '../utils/format.ts';
import './TopBar.css';

const SORT_LABELS: Record<SortKey, string> = {
  recent: 'Newest',
  oldest: 'Oldest',
  popular: 'Most watched',
  random: 'Shuffle',
  title: 'A–Z',
};

type TopBarProps = {
  onOpenImport: () => void;
  onOpenSettings: () => void;
  onPickFiles: () => void;
};

export function TopBar({ onOpenImport, onOpenSettings, onPickFiles }: TopBarProps) {
  const { filters, setFilters, user, signOut, status, theme, toggleTheme, sidebarOpen, setSidebarOpen } = useApp();

  const [suggestions, setSuggestions] = useState<TagWithCount[]>([]);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(-1);
  const [menuOpen, setMenuOpen] = useState(false);

  const searchRef = useRef<HTMLInputElement | null>(null);
  const debouncedQuery = useDebounced(filters.query, 160);

  const menuRef = useDismissable(menuOpen, () => setMenuOpen(false));
  const suggestRef = useDismissable(suggestOpen, () => setSuggestOpen(false));

  // `/` focuses search, the convention people already expect from every
  // media and code tool.
  useHotkey('/', (event) => {
    event.preventDefault();
    searchRef.current?.focus();
    searchRef.current?.select();
  });

  useHotkey('k', (event) => {
    event.preventDefault();
    searchRef.current?.focus();
    searchRef.current?.select();
  }, { meta: true, allowInInput: true });

  // Tag suggestions for the typeahead.
  useEffect(() => {
    const term = debouncedQuery.trim();
    if (term.length < 2) {
      setSuggestions([]);
      return;
    }

    let cancelled = false;
    void api
      .tags({ q: term, limit: 8 })
      .then(({ tags }) => {
        if (!cancelled) setSuggestions(tags);
      })
      .catch(() => {
        // Suggestions are an enhancement; a failure just means none show.
        if (!cancelled) setSuggestions([]);
      });

    return () => {
      cancelled = true;
    };
  }, [debouncedQuery]);

  const handleSearchKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Escape') {
        if (filters.query) setFilters({ query: '' });
        else searchRef.current?.blur();
        setSuggestOpen(false);
        return;
      }

      if (suggestions.length === 0 || !suggestOpen) return;

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setHighlighted((current) => (current + 1) % suggestions.length);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setHighlighted((current) => (current <= 0 ? suggestions.length - 1 : current - 1));
      } else if (event.key === 'Enter' && highlighted >= 0) {
        event.preventDefault();
        const tag = suggestions[highlighted];
        if (tag) {
          setFilters({ tagId: tag.id, query: '' });
          setSuggestOpen(false);
          setHighlighted(-1);
          searchRef.current?.blur();
        }
      }
    },
    [suggestions, suggestOpen, highlighted, filters.query, setFilters],
  );

  const busyCount = (status?.jobs.queued ?? 0) + (status?.jobs.running ?? 0);

  const activeTag = useMemo(() => suggestions.find((tag) => tag.id === filters.tagId), [suggestions, filters.tagId]);

  return (
    <header className="topbar">
      <button
        type="button"
        className="topbar__menu-toggle btn btn--ghost btn--icon"
        onClick={() => setSidebarOpen(!sidebarOpen)}
        aria-label={sidebarOpen ? 'Close navigation' : 'Open navigation'}
        aria-expanded={sidebarOpen}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>

      <a className="topbar__brand" href="/" aria-label="Loopa home">
        <span className="topbar__logo" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="20" height="20">
            <path
              d="M12 3a9 9 0 1 0 9 9"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
            />
            <path d="M10 9.2v5.6l4.8-2.8z" fill="currentColor" />
          </svg>
        </span>
        <span className="topbar__wordmark">Loopa</span>
      </a>

      <div className="topbar__search" ref={suggestRef}>
        <span className="topbar__search-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="16" height="16">
            <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="2" />
            <path d="m16 16 4.5 4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </span>

        <input
          ref={searchRef}
          type="search"
          className="topbar__search-input"
          value={filters.query}
          placeholder="Search clips, tags, captions…"
          aria-label="Search the library"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            setFilters({ query: event.target.value });
            setSuggestOpen(true);
            setHighlighted(-1);
          }}
          onFocus={() => setSuggestOpen(true)}
          onKeyDown={handleSearchKeyDown}
        />

        {filters.query ? (
          <button
            type="button"
            className="topbar__search-clear"
            onClick={() => {
              setFilters({ query: '' });
              searchRef.current?.focus();
            }}
            aria-label="Clear search"
          >
            ×
          </button>
        ) : (
          <kbd className="topbar__search-kbd" aria-hidden="true">
            /
          </kbd>
        )}

        {suggestOpen && suggestions.length > 0 && (
          <ul className="topbar__suggestions" role="listbox" aria-label="Matching tags">
            <li className="topbar__suggestions-heading">Tags</li>
            {suggestions.map((tag, index) => (
              <li key={tag.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={index === highlighted}
                  className={`topbar__suggestion${index === highlighted ? ' is-highlighted' : ''}`}
                  // mousedown, not click: the input's blur would close the
                  // list before a click could land.
                  onMouseDown={(event) => {
                    event.preventDefault();
                    setFilters({ tagId: tag.id, query: '' });
                    setSuggestOpen(false);
                  }}
                  onMouseEnter={() => setHighlighted(index)}
                >
                  <span className="topbar__suggestion-name">
                    {highlightMatches(tag.name, debouncedQuery).map((part, partIndex) =>
                      part.match ? <mark key={partIndex}>{part.text}</mark> : <span key={partIndex}>{part.text}</span>,
                    )}
                  </span>
                  <span className="topbar__suggestion-count">{formatCount(tag.count)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {filters.tagId && (
        <button
          type="button"
          className="topbar__active-filter"
          onClick={() => setFilters({ tagId: null })}
          title="Clear tag filter"
        >
          <span className="truncate">#{activeTag?.name ?? 'tag'}</span>
          <span aria-hidden="true">×</span>
        </button>
      )}

      <div className="topbar__spacer" />

      <label className="topbar__sort">
        <span className="visually-hidden">Sort clips</span>
        <select
          className="topbar__sort-select"
          value={filters.sort}
          onChange={(event) => setFilters({ sort: event.target.value as SortKey })}
        >
          {(Object.keys(SORT_LABELS) as SortKey[]).map((key) => (
            <option key={key} value={key}>
              {SORT_LABELS[key]}
            </option>
          ))}
        </select>
      </label>

      {busyCount > 0 && (
        <span className="topbar__busy" title={`${busyCount} job(s) in progress`}>
          <span className="spinner" />
          <span className="topbar__busy-count">{busyCount}</span>
        </span>
      )}

      <div className="topbar__actions">
        <button type="button" className="btn btn--secondary topbar__upload" onClick={onPickFiles}>
          <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
            <path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M4 16v2.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <span className="topbar__label-wide">Upload</span>
        </button>

        <button type="button" className="btn btn--primary" onClick={onOpenImport}>
          <span aria-hidden="true">+</span>
          <span className="topbar__label-wide">Add link</span>
        </button>
      </div>

      <div className="topbar__user" ref={menuRef}>
        <button
          type="button"
          className="topbar__avatar"
          style={{ '--avatar-color': user?.avatarColor ?? 'var(--accent)' } as React.CSSProperties}
          onClick={() => setMenuOpen((open) => !open)}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={`Account menu for ${user?.displayName ?? 'you'}`}
        >
          {initialsOf(user?.displayName ?? '?')}
        </button>

        {menuOpen && (
          <div className="topbar__menu" role="menu">
            <div className="topbar__menu-header">
              <strong className="truncate">{user?.displayName}</strong>
              <span className="topbar__menu-sub truncate">
                @{user?.username}
                {user?.role === 'admin' ? ' · admin' : ''}
              </span>
            </div>

            <button
              type="button"
              role="menuitem"
              className="topbar__menu-item"
              onClick={() => {
                toggleTheme();
                setMenuOpen(false);
              }}
            >
              {theme === 'dark' ? '☀' : '☾'} {theme === 'dark' ? 'Light theme' : 'Dark theme'}
            </button>

            <button
              type="button"
              role="menuitem"
              className="topbar__menu-item"
              onClick={() => {
                onOpenSettings();
                setMenuOpen(false);
              }}
            >
              ⚙ Settings
            </button>

            <button
              type="button"
              role="menuitem"
              className="topbar__menu-item topbar__menu-item--danger"
              onClick={() => void signOut()}
            >
              ⏻ Sign out
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
