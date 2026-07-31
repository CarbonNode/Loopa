import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import './ContextMenu.css';

export type ContextMenuItem = {
  /** Stable across renders; also the React key. */
  id: string;
  label: string;
  icon?: React.ReactNode;
  /** Right-aligned hint, e.g. a shortcut or a count. */
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  /** A rule above this item, to separate destructive actions from safe ones. */
  separatorBefore?: boolean;
  run: () => void;
};

type ContextMenuProps = {
  /** Viewport coordinates of the click that opened it. */
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
  /** Announced to screen readers, e.g. the clip's title. */
  label?: string;
};

/** Keep the menu clear of the viewport edge. */
const EDGE_GAP = 8;

/**
 * A menu anchored to a point.
 *
 * Positioned after measuring rather than from a guess at its size: a menu
 * opened near the bottom of the grid has to flip upwards, and the only way to
 * know whether it fits is to measure the rendered thing.
 */
export function ContextMenu({ x, y, items, onClose, label }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState({ left: x, top: y, ready: false });
  // A ref, not state: focus is what renders the highlight, so tracking the
  // index in state would re-render the menu to change nothing.
  const activeIndex = useRef(-1);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;

    const { width, height } = menu.getBoundingClientRect();
    const maxLeft = window.innerWidth - width - EDGE_GAP;
    const maxTop = window.innerHeight - height - EDGE_GAP;

    setPosition({
      // Flips to the other side of the cursor when there is no room, then
      // clamps — on a narrow phone neither side may fit.
      left: Math.max(EDGE_GAP, Math.min(x, maxLeft)),
      top: Math.max(EDGE_GAP, Math.min(y, maxTop)),
      ready: true,
    });

    // preventScroll matters: the browser scrolling an ancestor to reveal the
    // focused item fires a scroll event, and the scroll handler below closes
    // the menu — so a plain focus() makes the menu shut the instant it opens.
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  }, [x, y, items.length]);

  // Dismiss on anything that means "I'm done with this": Escape, a click
  // anywhere else, another right-click, a scroll, or the window resizing out
  // from under it.
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };

    /*
     * The menu is anchored to a card, so when the page scrolls it no longer
     * points at anything — but a scroll that happens *inside* the menu, or
     * that the menu itself caused, must not count.
     */
    const onScroll = (event: Event) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      onClose();
    };

    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', onClose);

    // A frame late, so any scrolling caused by opening the menu has already
    // settled and cannot immediately close it again.
    const frame = requestAnimationFrame(() => {
      window.addEventListener('scroll', onScroll, true);
    });

    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [onClose]);

  const enabled = items.filter((item) => !item.disabled);

  const move = (delta: number) => {
    if (enabled.length === 0) return;
    const index = (activeIndex.current + delta + enabled.length) % enabled.length;
    activeIndex.current = index;
    const target = enabled[index];
    if (target) menuRef.current?.querySelector<HTMLButtonElement>(`[data-item="${target.id}"]`)?.focus();
  };

  return (
    <div
      ref={menuRef}
      className="context-menu"
      style={{
        left: position.left,
        top: position.top,
        // Hidden for the single frame between mount and measurement, so it
        // never flashes at the raw cursor position before correcting.
        visibility: position.ready ? 'visible' : 'hidden',
      }}
      role="menu"
      aria-label={label ?? 'Actions'}
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          move(1);
        } else if (event.key === 'ArrowUp') {
          event.preventDefault();
          move(-1);
        }
      }}
      // The menu is opened by a right-click; a second one inside it should
      // not stack the browser's own menu on top.
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item) => (
        <div key={item.id} className="context-menu__row">
          {item.separatorBefore && <span className="context-menu__separator" role="separator" />}
          <button
            type="button"
            role="menuitem"
            data-item={item.id}
            className={`context-menu__item${item.danger ? ' context-menu__item--danger' : ''}`}
            disabled={item.disabled}
            onClick={() => {
              item.run();
              onClose();
            }}
          >
            {item.icon && (
              <span className="context-menu__icon" aria-hidden="true">
                {item.icon}
              </span>
            )}
            <span className="context-menu__label">{item.label}</span>
            {item.hint && <span className="context-menu__hint">{item.hint}</span>}
          </button>
        </div>
      ))}
    </div>
  );
}
