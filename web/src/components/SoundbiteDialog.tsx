import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client.ts';
import type { Clip, SoundboardStatus } from '../api/types.ts';
import { useDismissable, useFocusTrap, useScrollLock } from '../hooks/index.ts';
import { useApp } from '../state/store.tsx';
import { formatTimecode } from '../utils/format.ts';
import { RangeTimeline } from './RangeTimeline.tsx';
import { TimeRange } from './TimeRange.tsx';
import './SoundbiteDialog.css';

type SoundbiteDialogProps = { clip: Clip; onClose: () => void };

/** Keys the Lightbox also listens for on `window`; swallowed while this is open. */
const STOLEN_KEYS = new Set([' ', 'ArrowLeft', 'ArrowRight', 'm', 'M']);

function isTyping(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return (
    element?.tagName === 'INPUT' ||
    element?.tagName === 'TEXTAREA' ||
    element?.isContentEditable === true
  );
}

/**
 * Cut a range out of a clip's audio and send it to CarbonBoard.
 *
 * Admin-only, and deliberately its own dialog rather than an extra mode on the
 * clip studio: the studio's job is pulling a range out of a *remote* video it
 * cannot play locally, so it is built around a YouTube embed. Here the file is
 * already on disk and streams from Loopa, which means a real media element,
 * frame-accurate scrubbing, and being able to *listen* to the selection before
 * committing it — which is the whole point when the output is audio.
 */
export function SoundbiteDialog({ clip, onClose }: SoundbiteDialogProps) {
  const { notify, reportError } = useApp();

  const mediaRef = useRef<HTMLVideoElement | null>(null);
  const dialogRef = useFocusTrap(true);
  const dismissRef = useDismissable(true, onClose);
  useScrollLock(true);

  const [status, setStatus] = useState<SoundboardStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  const [durationMs, setDurationMs] = useState(clip.durationMs ?? 0);
  const [positionMs, setPositionMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  /** True while auditioning the selection, which loops until stopped. */
  const [looping, setLooping] = useState(false);

  const [startMs, setStartMs] = useState(0);
  const [endMs, setEndMs] = useState(0);

  const [name, setName] = useState(clip.title || clip.source.filename || 'Soundbite');
  const [category, setCategory] = useState('');
  const [categoryOpen, setCategoryOpen] = useState(false);
  const [categoryHighlight, setCategoryHighlight] = useState(-1);
  const [normalise, setNormalise] = useState(true);
  const [includeArt, setIncludeArt] = useState(true);
  const [sending, setSending] = useState(false);

  const maxLengthMs = (status?.maxSeconds ?? 60) * 1000;

  // ── Load CarbonBoard's state ────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    void api
      .soundboardStatus()
      .then((result) => {
        if (cancelled) return;
        setStatus(result);
        if (!result.reachable && result.error) setStatusError(result.error);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        // The dialog stays usable: the category list is a convenience, and the
        // send itself is what actually reports a dead clip server.
        setStatus({ enabled: true, url: null, maxSeconds: 60, categories: [], reachable: false, error: null });
        setStatusError(error instanceof Error ? error.message : 'Could not read the CarbonBoard library.');
      });

    return () => {
      cancelled = true;
    };
  }, []);

  /*
   * Seed the selection once the length is known.
   *
   * A short clip is very often the soundbite in its entirety, so it starts
   * fully selected. Anything longer opens on the first `maxSeconds`, because a
   * selection spanning a five-minute clip is not a starting point anyone
   * wants — and the server would refuse it anyway.
   */
  useEffect(() => {
    if (durationMs <= 0 || endMs > 0) return;
    setStartMs(0);
    setEndMs(Math.min(durationMs, maxLengthMs));
  }, [durationMs, endMs, maxLengthMs]);

  // ── Media element wiring ────────────────────────────────────────────────
  useEffect(() => {
    const media = mediaRef.current;
    if (!media) return;

    const onLoaded = () => {
      if (Number.isFinite(media.duration) && media.duration > 0) {
        setDurationMs((current) => (current > 0 ? current : Math.round(media.duration * 1000)));
      }
    };
    const onTime = () => {
      const ms = media.currentTime * 1000;
      setPositionMs(ms);
      // Looping is checked here rather than on a timer: timeupdate already
      // fires several times a second and carries the authoritative position.
      //
      // Both edges, not just the end. The selection can move *while* the loop
      // runs — that is the whole point of auditioning one — and dragging the
      // start past the playhead would otherwise leave it playing through
      // everything before the cut until it happened to reach the end.
      if (looping && (ms >= endMs - 20 || ms < startMs - 150)) {
        media.currentTime = startMs / 1000;
      }
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => {
      setPlaying(false);
      setLooping(false);
    };

    media.addEventListener('loadedmetadata', onLoaded);
    media.addEventListener('timeupdate', onTime);
    media.addEventListener('play', onPlay);
    media.addEventListener('pause', onPause);
    onLoaded();

    return () => {
      media.removeEventListener('loadedmetadata', onLoaded);
      media.removeEventListener('timeupdate', onTime);
      media.removeEventListener('play', onPlay);
      media.removeEventListener('pause', onPause);
    };
  }, [looping, startMs, endMs]);

  const seek = useCallback((ms: number) => {
    const media = mediaRef.current;
    if (!media) return;
    media.currentTime = Math.max(0, ms / 1000);
    setPositionMs(ms);
  }, []);

  const togglePlay = useCallback(() => {
    const media = mediaRef.current;
    if (!media) return;
    setLooping(false);
    if (media.paused) void media.play().catch(() => undefined);
    else media.pause();
  }, []);

  /**
   * Start — or restart — the selection on a loop.
   *
   * Deliberately never a stop. Pressing it a second time after nudging a
   * handle means "play it again from where I just put it", which is the entire
   * rhythm of trimming: move the edge, hear it, move it again. Making the
   * second press pause instead was actively wrong — it stopped the audio at
   * the exact moment the change was worth hearing. Space and the transport
   * button are how you stop.
   */
  const playSelection = useCallback(() => {
    const media = mediaRef.current;
    if (!media) return;

    media.currentTime = startMs / 1000;
    setPositionMs(startMs);
    setLooping(true);
    void media.play().catch(() => undefined);
  }, [startMs]);

  /*
   * The same clamping rules the timeline enforces, so typing a value and
   * dragging a handle cannot disagree — and so `[` past the end carries the
   * window along instead of silently doing nothing.
   */
  const setStartTo = useCallback(
    (ms: number) => {
      const next = Math.max(0, Math.min(ms, durationMs - 250));
      setStartMs(next);
      setEndMs((current) => {
        const lower = Math.max(next + 250, Math.min(current, next + maxLengthMs));
        return Math.min(durationMs, lower);
      });
    },
    [durationMs, maxLengthMs],
  );

  const setEndTo = useCallback(
    (ms: number) => {
      const next = Math.min(durationMs, Math.max(ms, 250));
      setEndMs(next);
      setStartMs((current) => Math.max(0, Math.min(current, next - 250), next - maxLengthMs));
    },
    [durationMs, maxLengthMs],
  );

  // ── Keyboard ────────────────────────────────────────────────────────────
  /*
   * Bubble phase on `document`, not capture on `window`. Capture would fire
   * before the timeline's own arrow-key handling and kill it; document-bubble
   * runs after everything inside the dialog has had the event, but before the
   * Lightbox's window listener behind us — which would otherwise scrub the
   * clip playing underneath while someone types in here.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (STOLEN_KEYS.has(event.key)) event.stopPropagation();
      if (isTyping(event.target)) return;

      if (event.key === '[') {
        event.preventDefault();
        setStartTo(positionMs);
      } else if (event.key === ']') {
        event.preventDefault();
        setEndTo(positionMs);
      } else if (event.key === ' ') {
        event.preventDefault();
        togglePlay();
      } else if (event.key === 'ArrowUp') {
        // Back to the selection. Scrubbing away to check something and then
        // having to find the cut again by hand is the fiddliest part of this,
        // and the two edges are the only positions worth returning to.
        // preventDefault or the dialog body scrolls instead.
        event.preventDefault();
        seek(startMs);
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        // Leaving the loop is not incidental: a loop cannot sit at its own
        // end, so without this the jump would bounce straight back to the
        // start and "go to the end" would look broken. Playback itself
        // continues, which is how you hear what comes after the cut.
        setLooping(false);
        seek(endMs);
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [positionMs, startMs, endMs, seek, setStartTo, setEndTo, togglePlay]);

  // ── Category suggestions ────────────────────────────────────────────────
  const categoryMatches = useMemo(() => {
    const all = status?.categories ?? [];
    const term = category.trim().toLowerCase();
    if (!term) return all;
    return all.filter((entry) => entry.toLowerCase().includes(term));
  }, [status, category]);

  const isNewCategory =
    category.trim().length > 0 &&
    !(status?.categories ?? []).some((entry) => entry.toLowerCase() === category.trim().toLowerCase());

  /*
   * Where the listbox goes.
   *
   * Positioned `fixed` and measured, rather than absolutely inside the field.
   * Two reasons, both of which bit in testing: the panel clips its overflow,
   * so an absolute list simply loses its last options off the bottom edge; and
   * dropping down unconditionally buries the dialog's own Send button, which
   * turns picking a category and sending into two clicks where the first one
   * silently only dismisses the list.
   *
   * Measured, it takes whichever side has more room and caps its height to
   * fit — the same rule ContextMenu follows, for the same reason.
   */
  const categoryInputRef = useRef<HTMLInputElement | null>(null);
  const [categoryBox, setCategoryBox] = useState<{
    left: number;
    width: number;
    top?: number;
    bottom?: number;
    maxHeight: number;
  } | null>(null);

  useLayoutEffect(() => {
    if (!categoryOpen || categoryMatches.length === 0) {
      setCategoryBox(null);
      return;
    }

    const place = () => {
      const input = categoryInputRef.current;
      if (!input) return;

      const field = input.getBoundingClientRect();
      // Bounded by the panel rather than the viewport: a list hanging out of
      // the bottom of the dialog reads as a rendering fault even though it is
      // perfectly clickable.
      const panel = input.closest('.modal__panel')?.getBoundingClientRect();
      const below = (panel?.bottom ?? window.innerHeight) - field.bottom - 12;
      const above = field.top - (panel?.top ?? 0) - 12;
      // Down unless it genuinely does not fit. Flipping for a few missing
      // pixels would move the list out from under the cursor for no reason.
      const up = below < 120 && above > below;

      setCategoryBox({
        left: field.left,
        width: field.width,
        ...(up ? { bottom: window.innerHeight - field.top + 4 } : { top: field.bottom + 4 }),
        maxHeight: Math.max(96, Math.min(208, up ? above : below)),
      });
    };

    place();
    // Capture phase: the dialog body is the scroller, and a scroll event on it
    // does not bubble to window.
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [categoryOpen, categoryMatches.length]);

  // ── Send ────────────────────────────────────────────────────────────────
  const lengthMs = Math.max(0, endMs - startMs);
  const tooLong = lengthMs > maxLengthMs;
  const tooShort = lengthMs < 250;
  const canSend = !sending && !tooLong && !tooShort && name.trim().length > 0 && durationMs > 0;

  const send = useCallback(async () => {
    if (!canSend) return;
    mediaRef.current?.pause();
    setSending(true);

    try {
      const { soundbite } = await api.sendToSoundboard(clip.id, {
        startMs: Math.round(startMs),
        endMs: Math.round(endMs),
        name: name.trim(),
        category: category.trim() || null,
        normalise,
        includeArt,
      });

      notify({
        kind: 'success',
        message: `"${soundbite.name}" is on CarbonBoard.`,
        hint: soundbite.category
          ? `Filed under ${soundbite.category} — play it from Cortex → Discord → Sounds.`
          : 'Play it from Cortex → Discord → Sounds.',
      });
      onClose();
    } catch (error) {
      reportError(error, 'Could not send that to CarbonBoard.');
    } finally {
      setSending(false);
    }
  }, [canSend, clip.id, startMs, endMs, name, category, normalise, includeArt, notify, reportError, onClose]);

  const unavailable = status !== null && !status.enabled;

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-labelledby="soundbite-title">
      <div className="modal__backdrop" aria-hidden="true" />

      <div className="modal__panel soundbite" ref={dismissRef}>
        <div ref={dialogRef}>
          <header className="modal__header">
            <h2 className="modal__title" id="soundbite-title">
              Send to CarbonBoard
            </h2>
            <button type="button" className="modal__close" onClick={onClose} aria-label="Close">
              ×
            </button>
          </header>

          <div className="modal__body soundbite__body">
            {unavailable ? (
              <p className="soundbite__notice soundbite__notice--error">
                No CarbonBoard is configured on this server. Set <code>CARBONBOARD_URL</code> to the clip
                server and restart.
              </p>
            ) : (
              <>
                {statusError && (
                  <p className="soundbite__notice">
                    <span aria-hidden="true">⚠</span>
                    <span>
                      {statusError} You can still cut a soundbite — the send will report if it is still
                      down.
                    </span>
                  </p>
                )}

                {/* The player. Small on purpose: this is an audio task, and the
                    picture is only here to find the moment. */}
                <div className="soundbite__stage">
                  <video
                    ref={mediaRef}
                    className="soundbite__media"
                    src={clip.media.play ?? undefined}
                    poster={clip.media.poster ?? undefined}
                    preload="metadata"
                    playsInline
                  />
                  <div className="soundbite__transport">
                    {/* Reflects playback, looping or not — a pause button that
                        reads "play" while audio is coming out is a lie. */}
                    <button
                      type="button"
                      className="btn btn--secondary btn--icon"
                      onClick={togglePlay}
                      aria-label={playing ? 'Pause' : 'Play'}
                      title={playing ? 'Pause (Space)' : 'Play (Space)'}
                    >
                      {playing ? '❚❚' : '▶'}
                    </button>
                    <button
                      type="button"
                      className={`btn btn--sm${looping ? ' btn--primary' : ' btn--ghost'}`}
                      onClick={playSelection}
                      title="Loop the selection — press again to jump back to the start"
                    >
                      {looping ? 'Replay selection' : 'Play selection'}
                    </button>
                    <span className="soundbite__clock">
                      {formatTimecode(positionMs, { tenths: true })}
                      <span className="soundbite__clock-total"> / {formatTimecode(durationMs)}</span>
                    </span>
                  </div>
                </div>

                <RangeTimeline
                  durationMs={durationMs}
                  startMs={startMs}
                  endMs={endMs}
                  positionMs={positionMs}
                  maxLengthMs={maxLengthMs}
                  disabled={durationMs <= 0}
                  onRangeChange={({ startMs: nextStart, endMs: nextEnd }) => {
                    setStartMs(nextStart);
                    setEndMs(nextEnd);
                  }}
                  onSeek={seek}
                />

                {/* The exact path. Dragging a handle is fast, but a two-second
                    cut inside a seventy-second clip is a few pixels wide, and
                    until now the only place the actual times appeared was a
                    footnote under the buttons. */}
                <div className="soundbite__marks">
                  <TimeRange
                    idPrefix="soundbite"
                    startMs={startMs}
                    endMs={endMs}
                    lengthMs={lengthMs}
                    onCommitStart={setStartTo}
                    onCommitEnd={setEndTo}
                    disabled={durationMs <= 0}
                    over={tooLong}
                  />

                  <div className="soundbite__mark-buttons">
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => setStartTo(positionMs)}
                      title="Set the start to the playhead"
                    >
                      <kbd>[</kbd> Start here
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => setEndTo(positionMs)}
                      title="Set the end to the playhead"
                    >
                      <kbd>]</kbd> End here
                    </button>
                  </div>
                </div>

                {tooLong && (
                  <p className="soundbite__notice" role="status">
                    <span aria-hidden="true">⚠</span>
                    <span>
                      That selection is {Math.round(lengthMs / 1000)}s — this server caps a soundbite at{' '}
                      {status?.maxSeconds ?? 60}s.
                    </span>
                  </p>
                )}

                {/* None of these are guessable, and all three are what makes
                    trimming by ear quick rather than fiddly. */}
                <p className="soundbite__keys">
                  <kbd>Space</kbd> play or pause
                  <span aria-hidden="true"> · </span>
                  <kbd>↑</kbd> <kbd>↓</kbd> jump to the start or end of the selection
                  <span aria-hidden="true"> · </span>
                  <kbd>←</kbd> <kbd>→</kbd> nudge a handle once it has focus
                </p>

                <div className="soundbite__fields">
                  <div className="field">
                    <label className="field__label" htmlFor="soundbite-name">
                      Button name
                    </label>
                    <input
                      id="soundbite-name"
                      className="input"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      maxLength={120}
                      placeholder="What it says"
                      autoComplete="off"
                      data-autofocus
                    />
                  </div>

                  {/* A combobox rather than a select: CarbonBoard's categories
                      are free text, so this has to accept a new one as easily
                      as it picks an existing one. */}
                  <div className="field soundbite__combo">
                    <label className="field__label" htmlFor="soundbite-category">
                      Category
                    </label>
                    <input
                      id="soundbite-category"
                      ref={categoryInputRef}
                      className="input"
                      value={category}
                      onChange={(event) => {
                        setCategory(event.target.value);
                        setCategoryOpen(true);
                        setCategoryHighlight(-1);
                      }}
                      onFocus={() => setCategoryOpen(true)}
                      onBlur={() => window.setTimeout(() => setCategoryOpen(false), 120)}
                      onKeyDown={(event) => {
                        if (categoryMatches.length === 0) return;
                        if (event.key === 'ArrowDown') {
                          event.preventDefault();
                          setCategoryOpen(true);
                          setCategoryHighlight((current) => (current + 1) % categoryMatches.length);
                        } else if (event.key === 'ArrowUp') {
                          event.preventDefault();
                          setCategoryHighlight((current) =>
                            current <= 0 ? categoryMatches.length - 1 : current - 1,
                          );
                        } else if (event.key === 'Enter' && categoryHighlight >= 0) {
                          event.preventDefault();
                          setCategory(categoryMatches[categoryHighlight]!);
                          setCategoryOpen(false);
                        }
                      }}
                      role="combobox"
                      aria-expanded={categoryOpen && categoryMatches.length > 0}
                      aria-controls="soundbite-category-list"
                      aria-autocomplete="list"
                      placeholder="Optional — e.g. quotes"
                      maxLength={60}
                      autoComplete="off"
                    />

                    {categoryOpen && categoryMatches.length > 0 && categoryBox && (
                      <ul
                        className="soundbite__options"
                        style={{
                          left: categoryBox.left,
                          width: categoryBox.width,
                          top: categoryBox.top,
                          bottom: categoryBox.bottom,
                          maxHeight: categoryBox.maxHeight,
                        }}
                        id="soundbite-category-list"
                        role="listbox"
                      >
                        {categoryMatches.slice(0, 8).map((entry, index) => (
                          <li key={entry}>
                            <button
                              type="button"
                              role="option"
                              aria-selected={index === categoryHighlight}
                              className={`soundbite__option${index === categoryHighlight ? ' is-highlighted' : ''}`}
                              // mousedown, not click: blur would close the list
                              // before a click could land.
                              onMouseDown={(event) => {
                                event.preventDefault();
                                setCategory(entry);
                                setCategoryOpen(false);
                              }}
                              onMouseEnter={() => setCategoryHighlight(index)}
                            >
                              {entry}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}

                    {isNewCategory && !categoryOpen && (
                      <p className="soundbite__hint">New category — it will be created on CarbonBoard.</p>
                    )}
                  </div>
                </div>

                <div className="soundbite__toggles">
                  <label className="soundbite__toggle">
                    <input
                      type="checkbox"
                      checked={normalise}
                      onChange={(event) => setNormalise(event.target.checked)}
                    />
                    <span>
                      Match loudness
                      <span className="soundbite__toggle-hint">
                        Levels it to the same target as every other button, so it does not blow anyone out.
                      </span>
                    </span>
                  </label>

                  <label className={`soundbite__toggle${clip.media.poster ? '' : ' is-disabled'}`}>
                    <input
                      type="checkbox"
                      checked={includeArt && Boolean(clip.media.poster)}
                      disabled={!clip.media.poster}
                      onChange={(event) => setIncludeArt(event.target.checked)}
                    />
                    <span>
                      Use the poster frame as button art
                      <span className="soundbite__toggle-hint">
                        {clip.media.poster
                          ? 'CarbonBoard draws its buttons as cards — a picture beats a text label.'
                          : 'This clip has no poster frame yet.'}
                      </span>
                    </span>
                  </label>
                </div>
              </>
            )}

            <footer className="modal__footer">
              <span className="soundbite__footer-note">
                {unavailable
                  ? 'Nothing to send to.'
                  : `MP3 · ${formatTimecode(lengthMs, { tenths: true })} from ${formatTimecode(startMs)}`}
              </span>
              <div className="modal__footer-actions">
                <button type="button" className="btn btn--ghost" onClick={onClose}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => void send()}
                  disabled={unavailable || !canSend}
                >
                  {sending ? 'Sending…' : 'Send to CarbonBoard'}
                </button>
              </div>
            </footer>
          </div>
        </div>
      </div>
    </div>
  );
}
