import './EmptyState.css';

type EmptyStateProps = {
  icon: string;
  title: string;
  body: string;
  action?: { label: string; run: () => void };
  secondaryAction?: { label: string; run: () => void };
};

/**
 * The empty state.
 *
 * Always says what this surface is *for* and how to put something in it —
 * an empty grid with no guidance reads as broken rather than new.
 */
export function EmptyState({ icon, title, body, action, secondaryAction }: EmptyStateProps) {
  return (
    <div className="empty-state">
      <div className="empty-state__icon" aria-hidden="true">
        {icon}
      </div>
      <h2 className="empty-state__title">{title}</h2>
      <p className="empty-state__body">{body}</p>

      {(action || secondaryAction) && (
        <div className="empty-state__actions">
          {action && (
            <button type="button" className="btn btn--primary" onClick={action.run}>
              {action.label}
            </button>
          )}
          {secondaryAction && (
            <button type="button" className="btn btn--secondary" onClick={secondaryAction.run}>
              {secondaryAction.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
