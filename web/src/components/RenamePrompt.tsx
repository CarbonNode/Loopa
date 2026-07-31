import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import './RenamePrompt.css';

type RenamePromptProps = {
  x: number;
  y: number;
  /** Pre-filled and fully selected, so typing replaces it outright. */
  initial: string;
  label: string;
  placeholder?: string;
  maxLength?: number;
  onSubmit: (value: string) => void;
  onClose: () => void;
};

const EDGE_GAP = 8;

/**
 * A one-field editor anchored to the cursor.
 *
 * Renaming from the grid rather than the lightbox: the lightbox's Edit button
 * sits below the tags, comments, categories, share and activity blocks, which
 * on a laptop is off the bottom of the screen — so the feature existed but was
 * effectively unreachable.
 */
export function RenamePrompt({
  x,
  y,
  initial,
  label,
  placeholder,
  maxLength = 140,
  onSubmit,
  onClose,
}: RenamePromptProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [value, setValue] = useState(initial);
  const [position, setPosition] = useState({ left: x, top: y, ready: false });

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;

    const { width, height } = panel.getBoundingClientRect();
    setPosition({
      left: Math.max(EDGE_GAP, Math.min(x, window.innerWidth - width - EDGE_GAP)),
      top: Math.max(EDGE_GAP, Math.min(y, window.innerHeight - height - EDGE_GAP)),
      ready: true,
    });

    // preventScroll, for the same reason the context menu needs it: scrolling
    // an ancestor to reveal the field fires the dismiss handlers below.
    inputRef.current?.focus({ preventScroll: true });
    inputRef.current?.select();
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

  const commit = () => {
    const trimmed = value.trim();
    // An empty title is legitimate — the grid falls back to the filename — but
    // an unchanged one means there is nothing to send.
    if (trimmed !== initial.trim()) onSubmit(trimmed);
    onClose();
  };

  return (
    <div
      ref={panelRef}
      className="rename-prompt"
      style={{ left: position.left, top: position.top, visibility: position.ready ? 'visible' : 'hidden' }}
      role="dialog"
      aria-label={label}
    >
      <p className="rename-prompt__heading">{label}</p>

      <input
        ref={inputRef}
        className="input rename-prompt__input"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder={placeholder}
        maxLength={maxLength}
        autoComplete="off"
        aria-label={label}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
          }
        }}
      />

      <div className="rename-prompt__foot">
        <span className="rename-prompt__hint">
          <kbd>↵</kbd> save · <kbd>Esc</kbd> cancel
        </span>
        <button type="button" className="btn btn--primary btn--sm" onClick={commit}>
          Save
        </button>
      </div>
    </div>
  );
}
