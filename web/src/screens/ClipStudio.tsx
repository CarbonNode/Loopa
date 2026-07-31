import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client.ts';
import type { ResolvedVideo, VideoChapter } from '../api/types.ts';
import { RangeTimeline } from '../components/RangeTimeline.tsx';
import { useHotkey } from '../hooks/index.ts';
import { useApp } from '../state/store.tsx';
import { formatTimecode, parseTimecode } from '../utils/format.ts';
import {
  PLAYER_STATE,
  describePlayerError,
  loadYouTubeApi,
  parseYouTubeUrl,
  watchUrl,
  type YouTubePlayer,
} from '../utils/youtube.ts';
import './ClipStudio.css';

/** Long enough to be a joke, short enough to trim down rather than up. */
const DEFAULT_SELECTION_MS = 15_000;
const MIN_SELECTION_MS = 250;
/** Playhead sampling. Fast enough for a tight preview loop, cheap enough to run while playing. */
const TICK_MS = 100;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * A timecode field that only commits when it parses.
 *
 * Rewriting the value on every keystroke would fight the user: clearing the
 * field to retype "1:30" momentarily reads as "", which would otherwise snap
 * the handle to zero and lose their place.
 */
function TimeField({
  id,
  label,
  valueMs,
  onCommit,
  disabled,
}: {
  id: string;
  label: string;
  valueMs: number;
  onCommit: (ms: number) => void;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState(() => formatTimecode(valueMs, { tenths: true }));
  const [focused, setFocused] = useState(false);
  const [invalid, setInvalid] = useState(false);

  // Track the outside world only while the user is not mid-edit.
  useEffect(() => {
    if (!focused) {
      setDraft(formatTimecode(valueMs, { tenths: true }));
      setInvalid(false);
    }
  }, [valueMs, focused]);

  const commit = useCallback(() => {
    const parsed = parseTimecode(draft);
    if (parsed === null) {
      setInvalid(true);
      setDraft(formatTimecode(valueMs, { tenths: true }));
      // Clear the warning once it has been seen, rather than leaving the
      // field permanently red after a recovered typo.
      setTimeout(() => setInvalid(false), 1200);
      return;
    }
    onCommit(parsed);
  }, [draft, valueMs, onCommit]);

  return (
    <div className="studio__time-field">
      <label className="studio__time-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className={`input studio__time-input${invalid ? ' input--invalid' : ''}`}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onFocus={(event) => {
          setFocused(true);
          event.target.select();
        }}
        onBlur={() => {
          setFocused(false);
          commit();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
            event.currentTarget.blur();
          } else if (event.key === 'Escape') {
            setDraft(formatTimecode(valueMs, { tenths: true }));
            event.currentTarget.blur();
          }
        }}
        inputMode="numeric"
        spellCheck={false}
        autoComplete="off"
        disabled={disabled}
        aria-invalid={invalid}
      />
    </div>
  );
}

/**
 * Paste a YouTube link, pick a range, send it to the library.
 *
 * The player is an embed rather than a local file on purpose: downloading a
 * video before it can be shown would turn "grab that bit" into a two-minute
 * wait for something the user may not clip at all. Only the chosen range is
 * ever fetched, and only once they commit to it.
 */
export function ClipStudio() {
  const { categories, notify, reportError, refreshStatus, navigate } = useApp();

  const [input, setInput] = useState('');
  const [videoId, setVideoId] = useState<string | null>(null);
  const [pendingStartSeconds, setPendingStartSeconds] = useState(0);

  const [video, setVideo] = useState<ResolvedVideo | null>(null);
  const [maxClipSeconds, setMaxClipSeconds] = useState(600);
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState<{ message: string; hint: string | null } | null>(null);

  const [playerReady, setPlayerReady] = useState(false);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [playerDurationMs, setPlayerDurationMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [positionMs, setPositionMs] = useState(0);

  const [range, setRange] = useState({ startMs: 0, endMs: DEFAULT_SELECTION_MS });
  const [looping, setLooping] = useState(false);

  const [title, setTitle] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [mute, setMute] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [queued, setQueued] = useState<Array<{ jobId: number; label: string; title: string }>>([]);
  const [chapterFilter, setChapterFilter] = useState('');

  const containerRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<YouTubePlayer | null>(null);
  // Read inside the sampling interval, which must not be torn down and rebuilt
  // every time the selection moves.
  const loopingRef = useRef(looping);
  const rangeRef = useRef(range);
  loopingRef.current = looping;
  rangeRef.current = range;

  const durationMs = video?.durationMs ?? playerDurationMs;
  const maxLengthMs = maxClipSeconds * 1000;
  const selectionMs = range.endMs - range.startMs;

  // ── Load a pasted link ────────────────────────────────────────────────────

  const load = useCallback(
    (raw: string) => {
      const parsed = parseYouTubeUrl(raw);
      if (!parsed) {
        setResolveError({
          message: 'That does not look like a YouTube link.',
          hint: 'The studio trims YouTube videos. For a Reel, TikTok or direct file, use "Add link" — those import whole.',
        });
        return;
      }

      setVideoId(parsed.videoId);
      setPendingStartSeconds(parsed.startSeconds);
      setVideo(null);
      setResolveError(null);
      setPlayerError(null);
      setPlayerDurationMs(0);
      setPositionMs(parsed.startSeconds * 1000);
      setLooping(false);
      setTitle('');
      setQueued([]);
      setChapterFilter('');
      // A sensible window at the moment the link points to, so there is always
      // something valid selected before the user touches anything.
      setRange({
        startMs: parsed.startSeconds * 1000,
        endMs: parsed.startSeconds * 1000 + DEFAULT_SELECTION_MS,
      });
    },
    [],
  );

  // Server-side metadata: the real duration, chapters and "most replayed".
  useEffect(() => {
    if (!videoId) return;

    let cancelled = false;
    setResolving(true);

    void api
      .resolveVideo(watchUrl(videoId))
      .then((result) => {
        if (cancelled) return;
        setVideo(result.video);
        setMaxClipSeconds(result.limits.maxClipSeconds);

        const total = result.video.durationMs ?? 0;
        if (total > 0) {
          setRange((current) => {
            const start = clamp(current.startMs, 0, Math.max(0, total - MIN_SELECTION_MS));
            const end = clamp(current.endMs, start + MIN_SELECTION_MS, total);
            return { startMs: start, endMs: end };
          });
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const apiError = error as { message?: string; hint?: string | null };
        setResolveError({
          message: apiError.message ?? 'Could not read that video.',
          hint: apiError.hint ?? null,
        });
      })
      .finally(() => {
        if (!cancelled) setResolving(false);
      });

    return () => {
      cancelled = true;
    };
  }, [videoId]);

  // ── The embedded player ───────────────────────────────────────────────────

  useEffect(() => {
    if (!videoId) return;

    let cancelled = false;
    let player: YouTubePlayer | null = null;

    setPlayerReady(false);

    void loadYouTubeApi()
      .then((YT) => {
        if (cancelled || !containerRef.current) return;

        // The API *replaces* the element it is given with an iframe, so it is
        // handed a node React does not own. Letting it swap out a React-managed
        // child would leave React trying to remove a node that is no longer
        // there, which throws on unmount.
        const host = document.createElement('div');
        containerRef.current.append(host);

        player = new YT.Player(host, {
          videoId,
          playerVars: {
            autoplay: 0,
            controls: 1,
            rel: 0,
            modestbranding: 1,
            playsinline: 1,
            enablejsapi: 1,
            start: pendingStartSeconds,
            origin: window.location.origin,
          },
          events: {
            onReady: (event) => {
              if (cancelled) return;
              playerRef.current = event.target;
              setPlayerReady(true);
              setPlayerDurationMs(Math.round(event.target.getDuration() * 1000));
              if (pendingStartSeconds > 0) event.target.seekTo(pendingStartSeconds, true);
            },
            onStateChange: (event) => {
              if (cancelled) return;
              setPlaying(event.data === PLAYER_STATE.playing);
              // Duration is only reliable once playback has actually started
              // for some videos.
              const total = event.target.getDuration();
              if (total > 0) setPlayerDurationMs(Math.round(total * 1000));
            },
            onError: (event) => {
              if (!cancelled) setPlayerError(describePlayerError(event.data));
            },
          },
        });
      })
      .catch(() => {
        if (!cancelled) setPlayerError('The YouTube player could not be loaded.');
      });

    return () => {
      cancelled = true;
      playerRef.current = null;
      setPlayerReady(false);
      try {
        player?.destroy();
      } catch {
        // Already torn down with the iframe — nothing left to clean up.
      }
      if (containerRef.current) containerRef.current.replaceChildren();
    };
  }, [videoId, pendingStartSeconds]);

  // Sample the playhead, and wrap the preview loop at the out-point.
  useEffect(() => {
    if (!playerReady) return;

    const timer = setInterval(() => {
      const player = playerRef.current;
      if (!player) return;

      const ms = player.getCurrentTime() * 1000;
      setPositionMs(ms);

      if (loopingRef.current && ms >= rangeRef.current.endMs) {
        player.seekTo(rangeRef.current.startMs / 1000, true);
      }
    }, TICK_MS);

    return () => clearInterval(timer);
  }, [playerReady]);

  // ── Player controls ───────────────────────────────────────────────────────

  const seek = useCallback((ms: number) => {
    setPositionMs(ms);
    playerRef.current?.seekTo(Math.max(0, ms) / 1000, true);
  }, []);

  const togglePlay = useCallback(() => {
    const player = playerRef.current;
    if (!player) return;
    if (player.getPlayerState() === PLAYER_STATE.playing) player.pauseVideo();
    else player.playVideo();
  }, []);

  const startPreview = useCallback(() => {
    const player = playerRef.current;
    if (!player) return;
    player.seekTo(range.startMs / 1000, true);
    player.playVideo();
    setLooping(true);
  }, [range.startMs]);

  const stopPreview = useCallback(() => {
    setLooping(false);
    playerRef.current?.pauseVideo();
  }, []);

  const togglePreview = useCallback(() => {
    if (looping) stopPreview();
    else startPreview();
  }, [looping, startPreview, stopPreview]);

  // ── Range editing ─────────────────────────────────────────────────────────

  /**
   * Move the in-point.
   *
   * Setting a start past the current end is not an error to be rejected — it
   * means "the clip starts here now", so the end travels with it and keeps
   * the length. Refusing instead makes a typed timecode appear to be ignored,
   * which is exactly how it felt before this carried the window along.
   */
  const setStart = useCallback(
    (ms: number) => {
      setRange((current) => {
        const ceiling = durationMs > 0 ? durationMs : Math.max(current.endMs, ms + MIN_SELECTION_MS);
        const start = clamp(ms, 0, Math.max(0, ceiling - MIN_SELECTION_MS));

        if (start >= current.endMs - MIN_SELECTION_MS) {
          const length = Math.min(current.endMs - current.startMs, maxLengthMs);
          return { startMs: start, endMs: Math.min(ceiling, Math.max(start + MIN_SELECTION_MS, start + length)) };
        }
        // Still bounded by the per-clip ceiling from the other direction.
        return { startMs: Math.max(start, current.endMs - maxLengthMs), endMs: current.endMs };
      });
    },
    [durationMs, maxLengthMs],
  );

  /** The mirror image: an end before the start drags the start back with it. */
  const setEnd = useCallback(
    (ms: number) => {
      setRange((current) => {
        const ceiling = durationMs > 0 ? durationMs : Math.max(ms, current.endMs);
        const end = clamp(ms, MIN_SELECTION_MS, ceiling);

        if (end <= current.startMs + MIN_SELECTION_MS) {
          const length = Math.min(current.endMs - current.startMs, maxLengthMs);
          return { startMs: Math.max(0, end - length), endMs: end };
        }
        return { startMs: current.startMs, endMs: Math.min(end, current.startMs + maxLengthMs) };
      });
    },
    [durationMs, maxLengthMs],
  );

  // Marking at the playhead and typing a timecode are the same operation, so
  // they go through the same rules rather than each having their own.
  const markIn = useCallback(() => setStart(positionMs), [setStart, positionMs]);
  const markOut = useCallback(() => setEnd(positionMs), [setEnd, positionMs]);

  const selectChapter = useCallback(
    (chapter: VideoChapter) => {
      const end = Math.min(chapter.endMs, chapter.startMs + maxLengthMs, durationMs || chapter.endMs);
      setRange({ startMs: chapter.startMs, endMs: Math.max(chapter.startMs + MIN_SELECTION_MS, end) });
      seek(chapter.startMs);
    },
    [maxLengthMs, durationMs, seek],
  );

  /** The single most-replayed moment, which is usually the bit worth clipping. */
  const peakMs = useMemo(() => {
    if (!video?.heatmap.length) return null;
    return video.heatmap.reduce((best, point) => (point.value > best.value ? point : best)).atMs;
  }, [video]);

  const jumpToPeak = useCallback(() => {
    if (peakMs === null) return;
    // Centre the window on the peak: the laugh usually needs its run-up.
    const half = Math.min(DEFAULT_SELECTION_MS, maxLengthMs) / 2;
    const start = Math.max(0, peakMs - half);
    const end = durationMs > 0 ? Math.min(durationMs, start + half * 2) : start + half * 2;
    setRange({ startMs: start, endMs: Math.max(start + MIN_SELECTION_MS, end) });
    seek(start);
  }, [peakMs, maxLengthMs, durationMs, seek]);

  // ── Hotkeys ───────────────────────────────────────────────────────────────

  const hasVideo = Boolean(videoId);

  useHotkey(
    ' ',
    (event) => {
      // Space also activates whatever has focus; let the control win.
      const target = event.target as HTMLElement | null;
      if (target?.closest('button, [role="slider"], a[href]')) return;
      event.preventDefault();
      togglePlay();
    },
    { enabled: hasVideo && playerReady },
  );

  useHotkey('[', markIn, { enabled: hasVideo });
  useHotkey(']', markOut, { enabled: hasVideo });
  useHotkey('p', togglePreview, { enabled: hasVideo && playerReady });
  useHotkey('j', () => seek(Math.max(0, positionMs - 5000)), { enabled: hasVideo && playerReady });
  useHotkey('l', () => seek(positionMs + 5000), { enabled: hasVideo && playerReady });

  // ── Submit ────────────────────────────────────────────────────────────────

  const tooLong = selectionMs > maxLengthMs;
  const tooShort = selectionMs < MIN_SELECTION_MS;
  const canSubmit = hasVideo && !submitting && !tooLong && !tooShort && durationMs > 0;

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (!videoId || !canSubmit) return;

      setSubmitting(true);
      try {
        const result = await api.createStudioClip({
          url: watchUrl(videoId),
          startMs: Math.round(range.startMs),
          endMs: Math.round(range.endMs),
          title: title.trim() || undefined,
          categoryId: categoryId || null,
          mute,
        });

        const label = `${formatTimecode(result.startMs)} – ${formatTimecode(result.endMs)}`;
        setQueued((current) => [
          { jobId: result.jobId, label, title: title.trim() || video?.title || 'Clip' },
          ...current,
        ]);

        notify({
          kind: 'success',
          message: `Clipping ${label}…`,
          hint: 'It will appear in the library once it has downloaded and been tagged.',
        });

        // Keep the video and the selection: people clip several bits from one
        // video in a row. Only the title resets, so the next cut gets its own.
        setTitle('');
        void refreshStatus();
      } catch (error) {
        reportError(error, 'Could not queue that clip.');
      } finally {
        setSubmitting(false);
      }
    },
    [videoId, canSubmit, range, title, categoryId, mute, video, notify, refreshStatus, reportError],
  );

  // ── Chapters ──────────────────────────────────────────────────────────────

  const chapters = video?.chapters ?? [];
  const visibleChapters = useMemo(() => {
    const needle = chapterFilter.trim().toLowerCase();
    if (!needle) return chapters;
    return chapters.filter((chapter) => chapter.title.toLowerCase().includes(needle));
  }, [chapters, chapterFilter]);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <main className="studio" id="library">
      <div className="studio__inner">
        <header className={`studio__header${videoId ? '' : ' studio__header--hero'}`}>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => navigate('library')}>
            <span aria-hidden="true">←</span> Library
          </button>

          <div className="studio__header-text">
            <h1 className="studio__title">Clip studio</h1>
            <p className="studio__subtitle">
              Paste a YouTube link, drag out the funny bit, send it straight to the library.
            </p>
          </div>
        </header>

        <form
          className={`studio__paste${videoId ? '' : ' studio__paste--hero'}`}
          onSubmit={(event) => {
            event.preventDefault();
            load(input);
          }}
        >
          <label className="visually-hidden" htmlFor="studio-url">
            YouTube link
          </label>

          <div className="studio__paste-field">
            <span className="studio__paste-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="17" height="17">
                <rect x="2.5" y="5" width="19" height="14" rx="4" fill="none" stroke="currentColor" strokeWidth="1.9" />
                <path d="M10.2 9.4v5.2l4.5-2.6z" fill="currentColor" />
              </svg>
            </span>
            <input
              id="studio-url"
              className="input studio__paste-input"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onPaste={(event) => {
                // Load on paste: the extra click on "Load" is pure friction when
                // pasting a link is unambiguous about what you want.
                const pasted = event.clipboardData.getData('text');
                if (parseYouTubeUrl(pasted)) {
                  event.preventDefault();
                  setInput(pasted);
                  load(pasted);
                }
              }}
              placeholder="Paste a YouTube link…"
              spellCheck={false}
              autoComplete="off"
              type="url"
              data-autofocus
            />
            {input && (
              <button
                type="button"
                className="studio__paste-clear"
                onClick={() => setInput('')}
                aria-label="Clear the link"
              >
                ×
              </button>
            )}
          </div>

          <button type="submit" className="btn btn--primary" disabled={!input.trim()}>
            {resolving ? 'Loading…' : 'Load'}
          </button>
        </form>

        {resolveError && (
          <div className="studio__notice studio__notice--error" role="alert">
            <span aria-hidden="true">⚠</span>
            <span>
              {resolveError.message}
              {resolveError.hint && <span className="studio__notice-hint">{resolveError.hint}</span>}
            </span>
          </div>
        )}

        {!videoId ? (
          <section className="studio__empty">
            <span className="studio__empty-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="26" height="26">
                <circle cx="6" cy="6.5" r="2.6" fill="none" stroke="currentColor" strokeWidth="1.8" />
                <circle cx="6" cy="17.5" r="2.6" fill="none" stroke="currentColor" strokeWidth="1.8" />
                <path d="M8.3 7.9 20 17M8.3 16.1 20 7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </span>

            <h2 className="studio__empty-title">Grab the funny bit</h2>
            <p className="studio__empty-body">
              Only the range you pick gets downloaded — ten seconds out of a three-hour stream costs ten
              seconds.
            </p>

            <ol className="studio__steps">
              <li className="studio__step">
                <span className="studio__step-number" aria-hidden="true">
                  1
                </span>
                <strong className="studio__step-title">Paste a link</strong>
                <span className="studio__step-body">Any YouTube video, Short, or link with a timestamp.</span>
              </li>
              <li className="studio__step">
                <span className="studio__step-number" aria-hidden="true">
                  2
                </span>
                <strong className="studio__step-title">Trim it</strong>
                <span className="studio__step-body">
                  Drag the handles, or hit <kbd>[</kbd> and <kbd>]</kbd> as it plays. Loop it until the timing
                  is right.
                </span>
              </li>
              <li className="studio__step">
                <span className="studio__step-number" aria-hidden="true">
                  3
                </span>
                <strong className="studio__step-title">Send it over</strong>
                <span className="studio__step-body">
                  It downloads, gets tagged, and turns up in your library.
                </span>
              </li>
            </ol>
          </section>
        ) : (
          <div className="studio__layout">
            {/* ── Player + timeline ───────────────────────────────────── */}
            <section className="studio__stage">
              <div className="studio__player">
                <div className="studio__player-frame" ref={containerRef} />

                {!playerReady && !playerError && (
                  <div className="studio__player-loading skeleton" aria-hidden="true" />
                )}

                {playerError && (
                  <div className="studio__player-fallback" role="status">
                    {video?.thumbnail && (
                      <img className="studio__player-thumb" src={video.thumbnail} alt="" loading="lazy" />
                    )}
                    <div className="studio__player-fallback-text">
                      <strong>{playerError}</strong>
                      <span>
                        You can still clip it — the timeline below works from the video's own duration, and the
                        download happens on the server.
                      </span>
                    </div>
                  </div>
                )}
              </div>

              <div className="studio__transport">
                <button
                  type="button"
                  className="btn btn--secondary btn--sm"
                  onClick={togglePlay}
                  disabled={!playerReady}
                  title="Play / pause (Space)"
                >
                  {playing ? '❙❙ Pause' : '▶ Play'}
                </button>

                <span className="studio__position" aria-live="off">
                  {formatTimecode(positionMs, { tenths: true })}
                  <span className="studio__position-total"> / {durationMs ? formatTimecode(durationMs) : '—'}</span>
                </span>

                <div className="studio__transport-spacer" />

                {/* Kept in one group: these are a pair, and letting them wrap
                    independently strands "Set end" alone on its own row. */}
                <div className="studio__marks">
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={markIn}
                    title="Set the clip start at the playhead ( [ )"
                  >
                    Set start
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={markOut}
                    title="Set the clip end at the playhead ( ] )"
                  >
                    Set end
                  </button>
                </div>
              </div>

              {durationMs > 0 ? (
                <RangeTimeline
                  durationMs={durationMs}
                  startMs={range.startMs}
                  endMs={range.endMs}
                  positionMs={positionMs}
                  maxLengthMs={maxLengthMs}
                  chapters={chapters}
                  heatmap={video?.heatmap ?? []}
                  onRangeChange={setRange}
                  onSeek={seek}
                />
              ) : (
                <div className="studio__timeline-skeleton skeleton" aria-hidden="true" />
              )}

              <div className="studio__range-row">
                {/* One cluster, because these three are a single reading:
                    from here, to here, this long. Spread out as separate
                    fields they read as three unrelated settings. */}
                <div className="studio__range-cluster">
                  <TimeField
                    id="studio-start"
                    label="Start"
                    valueMs={range.startMs}
                    onCommit={setStart}
                    disabled={durationMs === 0}
                  />
                  <span className="studio__range-arrow" aria-hidden="true">
                    →
                  </span>
                  <TimeField
                    id="studio-end"
                    label="End"
                    valueMs={range.endMs}
                    onCommit={setEnd}
                    disabled={durationMs === 0}
                  />

                  <div className="studio__length">
                    <span className="studio__time-label">Length</span>
                    <span className={`studio__length-value${tooLong ? ' is-over' : ''}`}>
                      {formatTimecode(Math.max(0, selectionMs), { tenths: true })}
                    </span>
                  </div>
                </div>

                <button
                  type="button"
                  className={`btn ${looping ? 'btn--secondary' : 'btn--primary'} studio__preview-btn`}
                  onClick={togglePreview}
                  disabled={!playerReady || tooShort}
                  title="Loop the selection ( P )"
                >
                  {looping ? '■ Stop preview' : '▶ Preview selection'}
                </button>
              </div>

              {tooLong && (
                <p className="studio__notice studio__notice--warning" role="status">
                  <span aria-hidden="true">⚠</span>
                  <span>
                    That selection is {Math.round(selectionMs / 1000)}s — this server caps a single clip at{' '}
                    {maxClipSeconds}s.
                  </span>
                </p>
              )}
            </section>

            {/* ── Details panel ───────────────────────────────────────── */}
            <aside className="studio__panel">
              <div className="studio__meta">
                {resolving && !video ? (
                  <>
                    <div className="studio__meta-line skeleton" />
                    <div className="studio__meta-line studio__meta-line--short skeleton" />
                  </>
                ) : (
                  <>
                    <h2 className="studio__meta-title clamp-2" title={video?.title ?? undefined}>
                      {video?.title ?? 'Loading…'}
                    </h2>
                    {video?.uploader && <p className="studio__meta-sub truncate">{video.uploader}</p>}
                  </>
                )}
              </div>

              {peakMs !== null && (
                <button type="button" className="btn btn--ghost btn--sm studio__peak" onClick={jumpToPeak}>
                  <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                    <path
                      d="M3 17.5 8 11l4 3.5L21 5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                    <path d="M15.5 5H21v5.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  Jump to most replayed
                </button>
              )}

              <form className="studio__form" onSubmit={submit}>
                <div className="field">
                  <label className="field__label" htmlFor="studio-title">
                    Title <span className="studio__optional">optional</span>
                  </label>
                  <input
                    id="studio-title"
                    className="input"
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    placeholder={video?.title ? `${video.title.slice(0, 40)}…` : 'Auto from the video'}
                    maxLength={140}
                    autoComplete="off"
                  />
                </div>

                {categories.length > 0 && (
                  <div className="field">
                    <label className="field__label" htmlFor="studio-category">
                      File into <span className="studio__optional">optional</span>
                    </label>
                    <select
                      id="studio-category"
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

                <label className="studio__checkbox">
                  <input type="checkbox" checked={mute} onChange={(event) => setMute(event.target.checked)} />
                  <span>Drop the audio</span>
                </label>

                <button type="submit" className="btn btn--primary studio__submit" disabled={!canSubmit}>
                  {submitting
                    ? 'Queueing…'
                    : `Add ${formatTimecode(Math.max(0, selectionMs), { tenths: true })} to Loopa`}
                </button>
              </form>

              {queued.length > 0 && (
                <div className="studio__queued">
                  <h3 className="studio__queued-heading">Queued from this video</h3>
                  <ul className="studio__queued-list">
                    {queued.map((entry) => (
                      <li key={entry.jobId} className="studio__queued-item">
                        <span className="studio__queued-range">{entry.label}</span>
                        <span className="studio__queued-title truncate">{entry.title}</span>
                      </li>
                    ))}
                  </ul>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm studio__queued-link"
                    onClick={() => navigate('library')}
                  >
                    See them in the library →
                  </button>
                </div>
              )}

              {chapters.length > 0 && (
                <div className="studio__chapters">
                  <h3 className="studio__queued-heading">
                    Chapters <span className="studio__count">{chapters.length}</span>
                  </h3>

                  {/* Past ~10 entries, scanning is slower than typing. */}
                  {chapters.length >= 10 && (
                    <input
                      type="search"
                      className="input studio__chapter-filter"
                      value={chapterFilter}
                      onChange={(event) => setChapterFilter(event.target.value)}
                      placeholder={`Filter ${chapters.length} chapters…`}
                      aria-label="Filter chapters"
                    />
                  )}

                  <ul className="studio__chapter-list">
                    {visibleChapters.map((chapter) => (
                      <li key={`${chapter.startMs}-${chapter.title}`}>
                        <button
                          type="button"
                          className="studio__chapter"
                          onClick={() => selectChapter(chapter)}
                          title={`Select "${chapter.title}"`}
                        >
                          <span className="studio__chapter-time">{formatTimecode(chapter.startMs)}</span>
                          <span className="studio__chapter-title truncate">{chapter.title}</span>
                        </button>
                      </li>
                    ))}
                    {visibleChapters.length === 0 && (
                      <li className="studio__chapter-empty">No chapter matches "{chapterFilter}"</li>
                    )}
                  </ul>
                </div>
              )}

              <dl className="studio__hotkeys">
                <div>
                  <dt>
                    <kbd>Space</kbd>
                  </dt>
                  <dd>Play / pause</dd>
                </div>
                <div>
                  <dt>
                    <kbd>[</kbd> <kbd>]</kbd>
                  </dt>
                  <dd>Set start / end</dd>
                </div>
                <div>
                  <dt>
                    <kbd>P</kbd>
                  </dt>
                  <dd>Preview loop</dd>
                </div>
                <div>
                  <dt>
                    <kbd>J</kbd> <kbd>L</kbd>
                  </dt>
                  <dd>Back / forward 5s</dd>
                </div>
              </dl>
            </aside>
          </div>
        )}
      </div>
    </main>
  );
}
