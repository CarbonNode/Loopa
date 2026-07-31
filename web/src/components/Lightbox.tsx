import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client.ts';
import { ClipActivity } from './ClipActivity.tsx';
import type { Clip } from '../api/types.ts';
import { useFocusTrap, useScrollLock } from '../hooks/index.ts';
import { useApp } from '../state/store.tsx';
import {
  formatAbsoluteTime,
  formatBytes,
  formatCount,
  formatRelativeTime,
  hostOf,
} from '../utils/format.ts';
import './Lightbox.css';

export function Lightbox() {
  const {
    activeClipId,
    openClip,
    categories,
    refreshCategories,
    invalidateLibrary,
    notify,
    reportError,
    user,
  } = useApp();

  const [clip, setClip] = useState<Clip | null>(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftDescription, setDraftDescription] = useState('');
  const [newTag, setNewTag] = useState('');
  const [saving, setSaving] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const isOpen = activeClipId !== null;

  const dialogRef = useFocusTrap(isOpen);
  useScrollLock(isOpen);

  const close = useCallback(() => {
    openClip(null);
    setClip(null);
    setEditing(false);
  }, [openClip]);

  // Load the clip whenever the active id changes.
  useEffect(() => {
    if (!activeClipId) return;

    let cancelled = false;
    setLoading(true);
    setClip(null);

    void api
      .clip(activeClipId)
      .then(({ clip: loaded }) => {
        if (cancelled) return;
        setClip(loaded);
        setDraftTitle(loaded.title);
        setDraftDescription(loaded.description);
        // Fire-and-forget: a failed view count must never break playback.
        void api.recordView(loaded.id).catch(() => undefined);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          reportError(error, 'Could not open that clip.');
          close();
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [activeClipId, reportError, close]);

  // Player shortcuts, scoped to the open dialog.
  useEffect(() => {
    if (!isOpen) return;

    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable;

      if (event.key === 'Escape') {
        if (typing) return;
        event.preventDefault();
        close();
        return;
      }

      const video = videoRef.current;
      if (!video || typing) return;

      if (event.key === ' ') {
        event.preventDefault();
        if (video.paused) void video.play().catch(() => undefined);
        else video.pause();
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        video.currentTime = Math.max(0, video.currentTime - 5);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        video.currentTime = Math.min(video.duration || Infinity, video.currentTime + 5);
      } else if (event.key.toLowerCase() === 'm') {
        video.muted = !video.muted;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, close]);

  const saveEdits = useCallback(async () => {
    if (!clip) return;
    setSaving(true);
    try {
      const { clip: updated } = await api.updateClip(clip.id, {
        title: draftTitle,
        description: draftDescription,
      });
      setClip(updated);
      setEditing(false);
      invalidateLibrary();
    } catch (error) {
      reportError(error, 'Could not save your changes.');
    } finally {
      setSaving(false);
    }
  }, [clip, draftTitle, draftDescription, invalidateLibrary, reportError]);

  const toggleCategory = useCallback(
    async (categoryId: string) => {
      if (!clip) return;
      const attached = clip.categoryIds.includes(categoryId);

      try {
        const { clip: updated } = attached
          ? await api.removeClipFromCategory(clip.id, categoryId)
          : await api.addClipToCategory(clip.id, categoryId);
        setClip(updated);
        void refreshCategories();
        invalidateLibrary();
      } catch (error) {
        reportError(error, 'Could not update the categories.');
      }
    },
    [clip, refreshCategories, invalidateLibrary, reportError],
  );

  const addTag = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      const name = newTag.trim();
      if (!clip || !name) return;

      try {
        await api.addTag(clip.id, name);
        setNewTag('');
        const { clip: refreshed } = await api.clip(clip.id);
        setClip(refreshed);
        invalidateLibrary();
      } catch (error) {
        reportError(error, 'Could not add that tag.');
      }
    },
    [clip, newTag, invalidateLibrary, reportError],
  );

  const removeTag = useCallback(
    async (tagId: string) => {
      if (!clip) return;
      // Optimistic: removing a chip should feel instant.
      const previous = clip.tags;
      setClip({ ...clip, tags: clip.tags.filter((tag) => tag.id !== tagId) });
      try {
        await api.removeTag(clip.id, tagId);
        invalidateLibrary();
      } catch (error) {
        setClip((current) => (current ? { ...current, tags: previous } : current));
        reportError(error, 'Could not remove that tag.');
      }
    },
    [clip, invalidateLibrary, reportError],
  );

  const deleteClip = useCallback(async () => {
    if (!clip) return;
    try {
      await api.deleteClip(clip.id);
      close();
      invalidateLibrary();
      void refreshCategories();
      notify({ kind: 'success', message: 'Clip removed.', hint: 'The file is kept until an admin purges it.' });
    } catch (error) {
      reportError(error, 'Could not remove that clip.');
    }
  }, [clip, close, invalidateLibrary, refreshCategories, notify, reportError]);

  if (!isOpen) return null;

  const canDelete = clip && (user?.role === 'admin' || clip.uploaderId === user?.id);
  const sourceHost = hostOf(clip?.source.url ?? null);

  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={clip?.title || 'Clip'}>
      <div className="lightbox__backdrop" onClick={close} aria-hidden="true" />

      <div className="lightbox__panel" ref={dialogRef}>
        <button
          type="button"
          className="lightbox__close"
          onClick={close}
          aria-label="Close"
          data-autofocus
        >
          ×
        </button>

        <div className="lightbox__stage">
          {loading && <div className="lightbox__stage-loading skeleton" />}

          {clip && clip.kind === 'image' && clip.media.play && (
            <img className="lightbox__media" src={clip.media.play} alt={clip.title || 'Clip'} />
          )}

          {clip && clip.kind !== 'image' && clip.media.play && (
            <video
              ref={videoRef}
              className="lightbox__media"
              src={clip.media.play}
              poster={clip.media.poster ?? undefined}
              controls
              autoPlay
              // GIFs have no audio and are expected to loop; videos are not.
              loop={clip.kind === 'gif' || (clip.durationMs ?? 0) < 10_000}
              muted={clip.kind === 'gif' || !clip.hasAudio}
              playsInline
              preload="auto"
            />
          )}

          {clip && !clip.media.play && (
            <div className="lightbox__stage-error">
              <p>This clip is still processing.</p>
            </div>
          )}
        </div>

        <div className="lightbox__details">
          {clip ? (
            <>
              <header className="lightbox__header">
                {editing ? (
                  <input
                    className="input lightbox__title-input"
                    value={draftTitle}
                    onChange={(event) => setDraftTitle(event.target.value)}
                    maxLength={140}
                    placeholder="Give this clip a title"
                    aria-label="Clip title"
                  />
                ) : (
                  <h2 className="lightbox__title">{clip.title || 'Untitled clip'}</h2>
                )}

                <div className="lightbox__meta">
                  <span title={formatAbsoluteTime(clip.createdAt)}>{formatRelativeTime(clip.createdAt)}</span>
                  <span aria-hidden="true">·</span>
                  <span>{formatBytes(clip.bytes)}</span>
                  {clip.width && clip.height && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span>
                        {clip.width}×{clip.height}
                      </span>
                    </>
                  )}
                  {clip.viewCount > 0 && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span>{formatCount(clip.viewCount)} views</span>
                    </>
                  )}
                  {sourceHost && (
                    <>
                      <span aria-hidden="true">·</span>
                      <a
                        className="lightbox__source"
                        href={clip.source.url ?? '#'}
                        target="_blank"
                        rel="noreferrer noopener"
                      >
                        {sourceHost}
                      </a>
                    </>
                  )}
                </div>
              </header>

              {editing ? (
                <textarea
                  className="input lightbox__description-input"
                  value={draftDescription}
                  onChange={(event) => setDraftDescription(event.target.value)}
                  maxLength={2000}
                  placeholder="What happens in this clip?"
                  aria-label="Clip description"
                />
              ) : (
                clip.description && <p className="lightbox__description">{clip.description}</p>
              )}

              <section className="lightbox__block">
                <h3 className="lightbox__block-title">Tags</h3>
                <div className="lightbox__tags">
                  {clip.tags.map((tag) => (
                    <span key={tag.id} className="chip lightbox__tag">
                      <span className="chip__label">{tag.name}</span>
                      <button
                        type="button"
                        className="lightbox__tag-remove"
                        onClick={() => void removeTag(tag.id)}
                        aria-label={`Remove tag ${tag.name}`}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  {clip.tags.length === 0 && (
                    <span className="lightbox__muted">
                      {clip.ai.status === 'pending' || clip.ai.status === 'running'
                        ? 'AI tagging in progress…'
                        : 'No tags yet.'}
                    </span>
                  )}
                </div>

                <form className="lightbox__tag-add" onSubmit={addTag}>
                  <input
                    className="input"
                    value={newTag}
                    onChange={(event) => setNewTag(event.target.value)}
                    placeholder="Add a tag…"
                    maxLength={48}
                    aria-label="Add a tag"
                  />
                  <button type="submit" className="btn btn--secondary btn--sm" disabled={!newTag.trim()}>
                    Add
                  </button>
                </form>
              </section>

              <section className="lightbox__block">
                <h3 className="lightbox__block-title">Categories</h3>
                <div className="lightbox__categories">
                  {categories.map((category) => {
                    const active = clip.categoryIds.includes(category.id);
                    return (
                      <button
                        key={category.id}
                        type="button"
                        className={`chip lightbox__category${active ? ' is-active' : ''}`}
                        style={{ '--category-color': category.color } as React.CSSProperties}
                        onClick={() => void toggleCategory(category.id)}
                        aria-pressed={active}
                      >
                        <span aria-hidden="true">{category.emoji || (active ? '✓' : '+')}</span>
                        <span className="chip__label">{category.name}</span>
                      </button>
                    );
                  })}
                  {categories.length === 0 && <span className="lightbox__muted">No categories yet.</span>}
                </div>
              </section>

              <ClipActivity clipId={clip.id} />

              {clip.ai.status === 'failed' && (
                <p className="lightbox__muted lightbox__ai-note">
                  AI tagging failed for this clip. You can retry it below.
                </p>
              )}

              <footer className="lightbox__actions">
                {editing ? (
                  <>
                    <button
                      type="button"
                      className="btn btn--primary"
                      onClick={() => void saveEdits()}
                      disabled={saving}
                    >
                      {saving ? 'Saving…' : 'Save'}
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost"
                      onClick={() => {
                        setEditing(false);
                        setDraftTitle(clip.title);
                        setDraftDescription(clip.description);
                      }}
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    <button type="button" className="btn btn--secondary" onClick={() => setEditing(true)}>
                      Edit
                    </button>
                    <a className="btn btn--ghost" href={clip.media.download}>
                      Download
                    </a>
                    <button
                      type="button"
                      className="btn btn--ghost"
                      onClick={() => {
                        void api
                          .retag(clip.id)
                          .then(() => notify({ kind: 'info', message: 'Queued for re-tagging.' }))
                          .catch((error: unknown) => reportError(error, 'Could not queue a re-tag.'));
                      }}
                    >
                      Re-tag
                    </button>
                    {canDelete && (
                      <button type="button" className="btn btn--danger lightbox__delete" onClick={() => void deleteClip()}>
                        Remove
                      </button>
                    )}
                  </>
                )}
              </footer>
            </>
          ) : (
            <div className="lightbox__details-loading">
              <div className="skeleton" style={{ height: 22, width: '70%' }} />
              <div className="skeleton" style={{ height: 12, width: '45%' }} />
              <div className="skeleton" style={{ height: 60, width: '100%' }} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
