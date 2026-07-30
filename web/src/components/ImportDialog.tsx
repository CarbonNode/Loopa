import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client.ts';
import type { IngestStatus } from '../api/types.ts';
import { useDebounced, useDismissable, useFocusTrap, useScrollLock } from '../hooks/index.ts';
import { useApp } from '../state/store.tsx';
import './ImportDialog.css';

type ImportDialogProps = { open: boolean; onClose: () => void };

/** Split a pasted blob into individual links. */
function extractUrls(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).map((entry) => entry.trim()).filter((entry) => /^https?:\/\//i.test(entry)))];
}

/** Best-effort local guess so the site badge appears before the server replies. */
function guessSite(url: string): string | null {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    if (/instagram/.test(host)) return 'Instagram';
    if (/tiktok/.test(host)) return 'TikTok';
    if (/youtu/.test(host)) return 'YouTube';
    if (/reddit|redd\.it|redgifs/.test(host)) return 'Reddit';
    if (/twitter|x\.com/.test(host)) return 'X';
    if (/imgur/.test(host)) return 'Imgur';
    return host;
  } catch {
    return null;
  }
}

export function ImportDialog({ open, onClose }: ImportDialogProps) {
  const { categories, filters, notify, reportError, invalidateLibrary, refreshStatus, user, navigate } = useApp();

  const [text, setText] = useState('');
  const [categoryId, setCategoryId] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const [ingest, setIngest] = useState<IngestStatus | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  const dialogRef = useFocusTrap(open);
  const dismissRef = useDismissable(open, onClose);
  useScrollLock(open);

  const urls = useMemo(() => extractUrls(text), [text]);
  const debouncedFirst = useDebounced(urls[0] ?? '', 400);

  // Default the target category to whatever the user is currently viewing.
  useEffect(() => {
    if (open) setCategoryId(filters.categoryId ?? '');
  }, [open, filters.categoryId]);

  useEffect(() => {
    if (!open) return;
    void api
      .ingestStatus()
      .then(setIngest)
      .catch(() => setIngest(null));
  }, [open]);

  /**
   * Warn before submitting rather than after.
   *
   * Instagram in particular refuses most anonymous downloads, and finding
   * that out after queueing twenty links is a bad experience.
   */
  useEffect(() => {
    if (!debouncedFirst) {
      setWarning(null);
      return;
    }

    let cancelled = false;
    void api
      .inspectUrl(debouncedFirst)
      .then((result) => {
        if (cancelled) return;
        setWarning(result.ok ? (result.warning ?? null) : (result.error ?? null));
      })
      .catch(() => {
        if (!cancelled) setWarning(null);
      });

    return () => {
      cancelled = true;
    };
  }, [debouncedFirst]);

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (urls.length === 0) return;

      setSubmitting(true);
      try {
        const result = await api.importUrls(urls, categoryId || null);

        if (result.queued.length > 0) {
          notify({
            kind: 'success',
            message:
              result.queued.length === 1
                ? `Downloading from ${result.queued[0]!.site}…`
                : `Downloading ${result.queued.length} links…`,
            hint: 'They will appear in the library as each one finishes.',
          });
        }
        for (const rejection of result.rejected) {
          notify({ kind: 'error', message: `${rejection.url}: ${rejection.error}`, hint: rejection.hint ?? null });
        }

        if (result.queued.length > 0) {
          setText('');
          onClose();
          void refreshStatus();
          invalidateLibrary();
        }
      } catch (error) {
        reportError(error, 'Could not queue those links.');
      } finally {
        setSubmitting(false);
      }
    },
    [urls, categoryId, notify, onClose, refreshStatus, invalidateLibrary, reportError],
  );

  if (!open) return null;

  const needsInstagramCookies = ingest ? !ingest.cookies.instagram && !ingest.cookies.default : false;

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-labelledby="import-title">
      <div className="modal__backdrop" aria-hidden="true" />

      <div className="modal__panel import-dialog" ref={dismissRef}>
        <div ref={dialogRef}>
          <header className="modal__header">
            <h2 className="modal__title" id="import-title">
              Add from a link
            </h2>
            <button type="button" className="modal__close" onClick={onClose} aria-label="Close">
              ×
            </button>
          </header>

          <form onSubmit={submit} className="modal__body">
            <div className="field">
              <label className="field__label" htmlFor="import-urls">
                Paste one or more links
              </label>
              <textarea
                id="import-urls"
                className="input import-dialog__input"
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder={'https://www.instagram.com/reel/…\nhttps://www.tiktok.com/@someone/video/…'}
                rows={4}
                spellCheck={false}
                autoComplete="off"
                data-autofocus
              />
              <p className="import-dialog__help">
                Instagram Reels, TikToks, YouTube, Reddit, X and direct video links. Paste several at once —
                one per line.
              </p>

              {/* Importing a 40-minute YouTube video whole is almost never what
                  someone wants; offer the trim path at the moment they paste one. */}
              {urls.some((url) => /youtu\.?be|youtube\.com/i.test(url)) && (
                <button
                  type="button"
                  className="btn btn--ghost btn--sm import-dialog__studio"
                  onClick={() => {
                    onClose();
                    navigate('studio');
                  }}
                >
                  <span aria-hidden="true">✂</span> Trim it first in the clip studio
                </button>
              )}
            </div>

            {urls.length > 0 && (
              <ul className="import-dialog__preview">
                {urls.slice(0, 6).map((url) => (
                  <li key={url} className="import-dialog__preview-item">
                    <span className="import-dialog__site">{guessSite(url)}</span>
                    <span className="import-dialog__url truncate">{url}</span>
                  </li>
                ))}
                {urls.length > 6 && (
                  <li className="import-dialog__preview-item import-dialog__preview-more">
                    + {urls.length - 6} more
                  </li>
                )}
              </ul>
            )}

            {warning && (
              <div className="import-dialog__warning">
                <span aria-hidden="true">⚠</span>
                <span>{warning}</span>
              </div>
            )}

            {needsInstagramCookies && urls.some((url) => /instagram/i.test(url)) && !warning && (
              <div className="import-dialog__warning">
                <span aria-hidden="true">⚠</span>
                <span>
                  No Instagram cookies are configured, so Reels will probably be refused.
                  {user?.role === 'admin' ? ' Add a cookies.txt in Settings → Ingest.' : ' Ask an admin to add one.'}
                </span>
              </div>
            )}

            {categories.length > 0 && (
              <div className="field">
                <label className="field__label" htmlFor="import-category">
                  File into (optional)
                </label>
                <select
                  id="import-category"
                  className="input"
                  value={categoryId}
                  onChange={(event) => setCategoryId(event.target.value)}
                >
                  <option value="">Don't file anywhere</option>
                  {categories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.emoji ? `${category.emoji} ` : ''}
                      {category.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <footer className="modal__footer">
              <span className="import-dialog__count">
                {urls.length === 0 ? 'No links yet' : `${urls.length} link${urls.length === 1 ? '' : 's'} ready`}
              </span>
              <div className="modal__footer-actions">
                <button type="button" className="btn btn--ghost" onClick={onClose}>
                  Cancel
                </button>
                <button type="submit" className="btn btn--primary" disabled={urls.length === 0 || submitting}>
                  {submitting ? 'Queueing…' : `Import${urls.length > 1 ? ` ${urls.length}` : ''}`}
                </button>
              </div>
            </footer>
          </form>
        </div>
      </div>
    </div>
  );
}
