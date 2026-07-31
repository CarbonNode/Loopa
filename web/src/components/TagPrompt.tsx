import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../api/client.ts';
import type { TagWithCount } from '../api/types.ts';
import { useDebounced } from '../hooks/index.ts';
import { formatCount } from '../utils/format.ts';
import './TagPrompt.css';

type TagPromptProps = {
  x: number;
  y: number;
  /** How many clips the tag will be applied to. */
  count: number;
  onSubmit: (name: string) => void;
  onClose: () => void;
};

const EDGE_GAP = 8;

/**
 * A small anchored field for tagging without opening a clip.
 *
 * Suggests as you type rather than offering a bare text box: tags only earn
 * their keep when the same word is reused, and a library with "dog", "dogs"
 * and "Dog" in it is three tags that should have been one.
 */
export function TagPrompt({ x, y, count, onSubmit, onClose }: TagPromptProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const [value, setValue] = useState('');
  const [suggestions, setSuggestions] = useState<TagWithCount[]>([]);
  const [highlighted, setHighlighted] = useState(-1);
  const [position, setPosition] = useState({ left: x, top: y, ready: false });

  const debounced = useDebounced(value, 160);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;

    const { width, height } = panel.getBoundingClientRect();
    setPosition({
      left: Math.max(EDGE_GAP, Math.min(x, window.innerWidth - width - EDGE_GAP)),
      top: Math.max(EDGE_GAP, Math.min(y, window.innerHeight - height - EDGE_GAP)),
      ready: true,
    });
    // preventScroll for the same reason the context menu needs it: scrolling
    // an ancestor to reveal the field would fire the dismiss handlers.
    inputRef.current?.focus({ preventScroll: true });
  }, [x, y]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!panelRef.current?.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };

    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [onClose]);

  useEffect(() => {
    const term = debounced.trim();
    if (term.length < 1) {
      setSuggestions([]);
      return;
    }

    let cancelled = false;
    void api
      .tags({ q: term, limit: 6 })
      .then(({ tags }) => {
        if (!cancelled) setSuggestions(tags);
      })
      .catch(() => {
        // Suggestions are an enhancement; typing a new tag still works.
        if (!cancelled) setSuggestions([]);
      });

    return () => {
      cancelled = true;
    };
  }, [debounced]);

  const commit = useCallback(
    (name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      onSubmit(trimmed);
      onClose();
    },
    [onSubmit, onClose],
  );

  return (
    <div
      ref={panelRef}
      className="tag-prompt"
      style={{ left: position.left, top: position.top, visibility: position.ready ? 'visible' : 'hidden' }}
      role="dialog"
      aria-label={count > 1 ? `Tag ${count} clips` : 'Tag this clip'}
    >
      <p className="tag-prompt__heading">{count > 1 ? `Tag ${count} clips` : 'Add a tag'}</p>

      <input
        ref={inputRef}
        className="input tag-prompt__input"
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          setHighlighted(-1);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            const picked = highlighted >= 0 ? suggestions[highlighted] : undefined;
            commit(picked ? picked.name : value);
          } else if (event.key === 'ArrowDown' && suggestions.length > 0) {
            event.preventDefault();
            setHighlighted((current) => (current + 1) % suggestions.length);
          } else if (event.key === 'ArrowUp' && suggestions.length > 0) {
            event.preventDefault();
            setHighlighted((current) => (current <= 0 ? suggestions.length - 1 : current - 1));
          }
        }}
        placeholder="dog, fail, cursed…"
        maxLength={48}
        autoComplete="off"
        spellCheck={false}
        aria-label="Tag name"
      />

      {suggestions.length > 0 && (
        <ul className="tag-prompt__list" role="listbox" aria-label="Existing tags">
          {suggestions.map((tag, index) => (
            <li key={tag.id}>
              <button
                type="button"
                role="option"
                aria-selected={index === highlighted}
                className={`tag-prompt__item${index === highlighted ? ' is-highlighted' : ''}`}
                // mousedown, not click: the input's blur would otherwise
                // dismiss the panel before the click landed.
                onMouseDown={(event) => {
                  event.preventDefault();
                  commit(tag.name);
                }}
                onMouseEnter={() => setHighlighted(index)}
              >
                <span className="tag-prompt__name truncate">{tag.name}</span>
                <span className="tag-prompt__count">{formatCount(tag.count)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <p className="tag-prompt__hint">
        <kbd>↵</kbd> to add · <kbd>Esc</kbd> to cancel
      </p>
    </div>
  );
}
