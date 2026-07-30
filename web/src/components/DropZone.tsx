import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { api } from '../api/client.ts';
import { useApp } from '../state/store.tsx';
import './DropZone.css';

export type DropZoneHandle = { pickFiles: () => void };

type UploadTask = { id: number; label: string; progress: number; total: number };

let taskCounter = 0;

/**
 * Whole-window drag-and-drop upload, plus the file picker behind the Upload
 * button.
 *
 * Listens on `window` rather than wrapping the app in a drop target, so a
 * file can be dropped anywhere — including onto the grid — without every
 * intermediate component needing drag handlers.
 */
export const DropZone = forwardRef<DropZoneHandle>(function DropZone(_props, ref) {
  const { notify, reportError, invalidateLibrary, refreshCategories, filters } = useApp();

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
            <p className="dropzone__hint">Videos, GIFs and images — as many as you like</p>
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
