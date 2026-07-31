import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { api } from '../api/client.ts';
import { useApp } from '../state/store.tsx';
import './DropZone.css';

export type DropZoneHandle = { pickFiles: () => void };

type UploadTask = { id: number; label: string; progress: number; total: number };

let taskCounter = 0;

const pad = (value: number) => String(value).padStart(2, '0');

/**
 * Name a file that arrived through the clipboard.
 *
 * A pasted screenshot has no meaningful name — browsers hand over "image.png"
 * every time, and the grid falls back to the filename when a clip has no
 * title yet. Without this, pasting five screenshots produces five cards all
 * called "image.png", indistinguishable until the tagger gets to them.
 */
function nameForPastedFile(file: File, index: number): string {
  if (file.name && !/^(image|screenshot|clipboard)\.\w+$/i.test(file.name)) return file.name;

  const extension = (file.type.split('/')[1] ?? 'png').split('+')[0]!.replace('jpeg', 'jpg');
  const now = new Date();
  const stamp =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

  return `pasted-${stamp}${index > 0 ? `-${index + 1}` : ''}.${extension}`;
}

/** Only media is worth uploading; a pasted spreadsheet is not a clip. */
function isMedia(file: File): boolean {
  return file.type.startsWith('image/') || file.type.startsWith('video/');
}

/** True when the caret is somewhere a paste is meant to insert text. */
function isTextTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return Boolean(element?.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"]'));
}

function extractUrls(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\s,]+/)
        .map((entry) => entry.trim())
        .filter((entry) => /^https?:\/\/\S+$/i.test(entry)),
    ),
  ].slice(0, 20);
}

/**
 * Whole-window drag-and-drop upload, plus the file picker behind the Upload
 * button.
 *
 * Listens on `window` rather than wrapping the app in a drop target, so a
 * file can be dropped anywhere — including onto the grid — without every
 * intermediate component needing drag handlers.
 */
export const DropZone = forwardRef<DropZoneHandle>(function DropZone(_props, ref) {
  const { notify, reportError, invalidateLibrary, refreshCategories, refreshStatus, filters } = useApp();

  const [dragging, setDragging] = useState(false);
  const [tasks, setTasks] = useState<UploadTask[]>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // dragenter/dragleave fire per element; count them so the overlay does not
  // flicker as the pointer crosses child boundaries.
  const dragDepth = useRef(0);

  const upload = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;

      const id = (taskCounter += 1);
      const label = files.length === 1 ? files[0]!.name : `${files.length} files`;
      setTasks((current) => [...current, { id, label, progress: 0, total: files.length }]);

      try {
        const result = await api.upload(files, {
          // A drop while viewing a category files straight into it.
          categoryId: filters.categoryId,
          onProgress: (fraction) => {
            setTasks((current) => current.map((task) => (task.id === id ? { ...task, progress: fraction } : task)));
          },
        });

        const added = result.clips.length - result.duplicates.length;

        if (added > 0) {
          notify({
            kind: 'success',
            message: added === 1 ? 'Clip added — processing now.' : `${added} clips added — processing now.`,
          });
        }
        if (result.duplicates.length > 0) {
          notify({
            kind: 'info',
            message:
              result.duplicates.length === 1
                ? `${result.duplicates[0]} is already in the library.`
                : `${result.duplicates.length} files were already in the library.`,
          });
        }
        for (const failure of result.failures) {
          notify({ kind: 'error', message: `${failure.filename}: ${failure.error}`, hint: failure.hint ?? null });
        }

        invalidateLibrary();
        void refreshCategories();
      } catch (error) {
        reportError(error, 'The upload failed.');
      } finally {
        setTasks((current) => current.filter((task) => task.id !== id));
      }
    },
    [filters.categoryId, notify, reportError, invalidateLibrary, refreshCategories],
  );

  /** Queue pasted links, the same path the Add-link dialog uses. */
  const importPasted = useCallback(
    async (urls: string[]) => {
      try {
        const result = await api.importUrls(urls, filters.categoryId);

        if (result.queued.length > 0) {
          notify({
            kind: 'success',
            message:
              result.queued.length === 1
                ? `Pasted a ${result.queued[0]!.site} link — downloading…`
                : `Pasted ${result.queued.length} links — downloading…`,
            hint: 'They will appear in the library as each one finishes.',
          });
          void refreshStatus();
          invalidateLibrary();
        }
        for (const rejection of result.rejected) {
          notify({ kind: 'error', message: `${rejection.url}: ${rejection.error}`, hint: rejection.hint ?? null });
        }
      } catch (error) {
        reportError(error, 'Could not queue that link.');
      }
    },
    [filters.categoryId, notify, refreshStatus, invalidateLibrary, reportError],
  );

  /**
   * Paste straight into the library.
   *
   * Screenshotting something and hitting ⌘V is the fastest possible way to
   * add a clip, and it is the gesture people already have in their fingers
   * from every chat app.
   */
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const data = event.clipboardData;
      if (!data) return;

      // Files first, and regardless of focus: pasting an image into a search
      // box has no text meaning, so uploading it is the only sensible reading.
      const files = Array.from(data.files).filter(isMedia);
      if (files.length > 0) {
        event.preventDefault();
        void upload(files.map((file, index) => new File([file], nameForPastedFile(file, index), { type: file.type })));
        return;
      }

      // Text only counts when the caret is not somewhere that wants it —
      // otherwise pasting a link into the search box would import it.
      if (isTextTarget(event.target)) return;

      const urls = extractUrls(data.getData('text/plain'));
      if (urls.length === 0) return;

      event.preventDefault();
      void importPasted(urls);
    };

    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [upload, importPasted]);

  useImperativeHandle(ref, () => ({ pickFiles: () => inputRef.current?.click() }), []);

  useEffect(() => {
    const isFileDrag = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files');

    const onDragEnter = (event: DragEvent) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      dragDepth.current += 1;
      setDragging(true);
    };

    const onDragOver = (event: DragEvent) => {
      if (!isFileDrag(event)) return;
      // Both dragover and dragenter must preventDefault, or the browser
      // navigates away to open the file instead of firing our drop handler.
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    };

    const onDragLeave = (event: DragEvent) => {
      if (!isFileDrag(event)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragging(false);
    };

    const onDrop = (event: DragEvent) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      dragDepth.current = 0;
      setDragging(false);

      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length > 0) void upload(files);
    };

    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);

    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [upload]);

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept="video/*,image/gif,image/jpeg,image/png,image/webp,.mkv,.avi,.mov,.webm"
        className="visually-hidden"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          if (files.length > 0) void upload(files);
          // Reset so re-picking the same file fires change again.
          event.target.value = '';
        }}
      />

      {dragging && (
        <div className="dropzone" role="presentation">
          <div className="dropzone__card">
            <div className="dropzone__icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="36" height="36">
                <path
                  d="M12 16V4m0 0L7 9m5-5 5 5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path
                  d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
              </svg>
            </div>
            <p className="dropzone__title">Drop to add to your library</p>
            <p className="dropzone__hint">
              Videos, GIFs and images — as many as you like. You can paste them too.
            </p>
          </div>
        </div>
      )}

      {tasks.length > 0 && (
        <div className="upload-tray" role="status" aria-live="polite">
          {tasks.map((task) => (
            <div key={task.id} className="upload-tray__item">
              <div className="upload-tray__head">
                <span className="upload-tray__label truncate">{task.label}</span>
                <span className="upload-tray__pct">
                  {task.progress >= 1 ? 'Processing…' : `${Math.round(task.progress * 100)}%`}
                </span>
              </div>
              <div className="upload-tray__bar">
                <div
                  className={`upload-tray__fill${task.progress >= 1 ? ' is-indeterminate' : ''}`}
                  style={{ width: `${Math.max(3, task.progress * 100)}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
});
