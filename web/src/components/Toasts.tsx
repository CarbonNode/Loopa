import { useApp } from '../state/store.tsx';
import './Toasts.css';

const ICONS = { success: '✓', error: '!', info: 'i' } as const;

export function Toasts() {
  const { toasts, dismissToast } = useApp();

  if (toasts.length === 0) return null;

  return (
    // aria-live="polite" so a screen reader announces results without
    // interrupting whatever the user is currently doing.
    <div className="toasts" role="region" aria-label="Notifications" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast--${toast.kind}`} role={toast.kind === 'error' ? 'alert' : 'status'}>
          <span className="toast__icon" aria-hidden="true">
            {ICONS[toast.kind]}
          </span>

          <div className="toast__content">
            <p className="toast__message">{toast.message}</p>
            {toast.hint && <p className="toast__hint">{toast.hint}</p>}
          </div>

          {toast.action && (
            <button
              type="button"
              className="toast__action"
              onClick={() => {
                toast.action?.run();
                dismissToast(toast.id);
              }}
            >
              {toast.action.label}
            </button>
          )}

          <button
            type="button"
            className="toast__close"
            onClick={() => dismissToast(toast.id)}
            aria-label="Dismiss notification"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
