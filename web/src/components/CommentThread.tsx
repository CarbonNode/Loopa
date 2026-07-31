import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client.ts';
import type { Comment } from '../api/types.ts';
import { useApp } from '../state/store.tsx';
import { formatAbsoluteTime, formatRelativeTime, initialsOf } from '../utils/format.ts';
import './CommentThread.css';

const MAX_LENGTH = 2000;
/** Show the counter only once it is close enough to matter. */
const COUNTER_FROM = MAX_LENGTH - 200;

/**
 * The conversation under a clip.
 *
 * Self-contained: it owns its own fetch and list state rather than taking them
 * from the lightbox, so opening a clip does not block on loading comments and
 * a slow thread never delays the video appearing.
 */
export function CommentThread({ clipId }: { clipId: string }) {
  const { user, notify, reportError } = useApp();

  const [comments, setComments] = useState<Comment[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');

  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setComments([]);
    setDraft('');
    setEditingId(null);

    void api
      .comments(clipId)
      .then((result) => {
        if (!cancelled) setComments(result.comments);
      })
      .catch(() => {
        // A thread that fails to load should not take the lightbox with it;
        // the empty state below reads the same either way.
        if (!cancelled) setComments([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [clipId]);

  const post = useCallback(async () => {
    const body = draft.trim();
    if (!body || posting) return;

    setPosting(true);
    try {
      const { comment } = await api.addComment(clipId, body);
      setComments((current) => [...current, comment]);
      setDraft('');
      // Keep the caret where it was so a second thought can be typed straight
      // away without reaching for the mouse.
      inputRef.current?.focus();
    } catch (error) {
      reportError(error, 'Could not post that comment.');
    } finally {
      setPosting(false);
    }
  }, [draft, posting, clipId, reportError]);

  const saveEdit = useCallback(async () => {
    if (!editingId) return;
    const body = editDraft.trim();
    if (!body) return;

    try {
      const { comments: next } = await api.editComment(editingId, body);
      setComments(next);
      setEditingId(null);
    } catch (error) {
      reportError(error, 'Could not save that edit.');
    }
  }, [editingId, editDraft, reportError]);

  const remove = useCallback(
    async (comment: Comment) => {
      if (!window.confirm('Delete this comment?')) return;
      try {
        const { comments: next } = await api.deleteComment(comment.id);
        setComments(next);
        notify({ kind: 'info', message: 'Comment deleted.' });
      } catch (error) {
        reportError(error, 'Could not delete that comment.');
      }
    },
    [notify, reportError],
  );

  const visible = comments.filter((comment) => !comment.deleted || comments.length > 1);

  return (
    <section className="comments">
      <h3 className="comments__title">
        Comments
        {comments.filter((comment) => !comment.deleted).length > 0 && (
          <span className="comments__count">{comments.filter((comment) => !comment.deleted).length}</span>
        )}
      </h3>

      {loading ? (
        <div className="comments__loading" aria-hidden="true">
          <div className="comments__skeleton skeleton" />
          <div className="comments__skeleton comments__skeleton--short skeleton" />
        </div>
      ) : visible.length === 0 ? (
        <p className="comments__empty">No comments yet. Say something about it.</p>
      ) : (
        <ul className="comments__list">
          {visible.map((comment) => {
            const mine = comment.author?.id === user?.id;

            if (comment.deleted) {
              return (
                <li key={comment.id} className="comments__item comments__item--deleted">
                  <span className="comments__tombstone">Comment deleted</span>
                </li>
              );
            }

            return (
              <li key={comment.id} className={`comments__item${mine ? ' is-mine' : ''}`}>
                <span
                  className="comments__avatar"
                  style={{ '--avatar-color': comment.author?.avatarColor ?? 'var(--accent)' } as React.CSSProperties}
                  aria-hidden="true"
                >
                  {initialsOf(comment.author?.displayName ?? '?')}
                </span>

                <div className="comments__body">
                  <div className="comments__head">
                    <span className="comments__author truncate">
                      {comment.author?.displayName ?? 'Someone who left'}
                    </span>
                    <time className="comments__time" dateTime={new Date(comment.createdAt).toISOString()} title={formatAbsoluteTime(comment.createdAt)}>
                      {formatRelativeTime(comment.createdAt)}
                    </time>
                    {comment.editedAt && <span className="comments__edited">edited</span>}
                  </div>

                  {editingId === comment.id ? (
                    <div className="comments__edit">
                      <textarea
                        className="input comments__input"
                        value={editDraft}
                        onChange={(event) => setEditDraft(event.target.value)}
                        maxLength={MAX_LENGTH}
                        rows={3}
                        autoFocus
                        onKeyDown={(event) => {
                          if (event.key === 'Escape') {
                            event.stopPropagation();
                            setEditingId(null);
                          } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                            event.preventDefault();
                            void saveEdit();
                          }
                        }}
                      />
                      <div className="comments__edit-actions">
                        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setEditingId(null)}>
                          Cancel
                        </button>
                        <button
                          type="button"
                          className="btn btn--primary btn--sm"
                          onClick={() => void saveEdit()}
                          disabled={!editDraft.trim()}
                        >
                          Save
                        </button>
                      </div>
                    </div>
                  ) : (
                    <p className="comments__text">{comment.body}</p>
                  )}

                  {comment.canEdit && editingId !== comment.id && (
                    <div className="comments__actions">
                      {mine && (
                        <button
                          type="button"
                          className="comments__action"
                          onClick={() => {
                            setEditingId(comment.id);
                            setEditDraft(comment.body);
                          }}
                        >
                          Edit
                        </button>
                      )}
                      <button
                        type="button"
                        className="comments__action comments__action--danger"
                        onClick={() => void remove(comment)}
                      >
                        Delete
                      </button>
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <form
        className="comments__compose"
        onSubmit={(event) => {
          event.preventDefault();
          void post();
        }}
      >
        <textarea
          ref={inputRef}
          className="input comments__input"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Add a comment…"
          rows={2}
          maxLength={MAX_LENGTH}
          aria-label="Add a comment"
          onKeyDown={(event) => {
            // Enter inserts a newline; ⌘/Ctrl+Enter sends. A bare Enter would
            // send half-written thoughts, which is the wrong default for a box
            // people write paragraphs in.
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void post();
            }
          }}
        />

        <div className="comments__compose-foot">
          <span className="comments__hint">
            {draft.length >= COUNTER_FROM ? (
              <span className={draft.length >= MAX_LENGTH ? 'comments__over' : undefined}>
                {MAX_LENGTH - draft.length} left
              </span>
            ) : (
              <>
                <kbd>⌘</kbd>/<kbd>Ctrl</kbd> + <kbd>↵</kbd> to post
              </>
            )}
          </span>
          <button type="submit" className="btn btn--primary btn--sm" disabled={!draft.trim() || posting}>
            {posting ? 'Posting…' : 'Post'}
          </button>
        </div>
      </form>
    </section>
  );
}
