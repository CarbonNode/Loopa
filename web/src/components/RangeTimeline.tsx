import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HeatPoint, VideoChapter } from '../api/types.ts';
import { useElementWidth } from '../hooks/index.ts';
import { formatTimecode } from '../utils/format.ts';
import './RangeTimeline.css';

type RangeTimelineProps = {
  durationMs: number;
  startMs: number;
  endMs: number;
  /** The player's current position, drawn as the playhead. */
  positionMs: number;
  maxLengthMs: number;
  chapters?: readonly VideoChapter[];
  heatmap?: readonly HeatPoint[];
  disabled?: boolean;
  onRangeChange: (range: { startMs: number; endMs: number }) => void;
  onSeek: (ms: number) => void;
};

/** Two seconds across the full width is ~1.5ms per pixel — past useful. */
const MIN_SPAN_MS = 2000;
const MIN_SELECTION_MS = 250;

const NICE_INTERVALS_MS = [
  100, 250, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000,
  60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000,
];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** The finest "round" interval that still leaves labels room to breathe. */
function tickInterval(spanMs: number, widthPx: number): number {
  const maxTicks = Math.max(2, Math.floor(widthPx / 78));
  for (const interval of NICE_INTERVALS_MS) {
    if (spanMs / interval <= maxTicks) return interval;
  }
  return NICE_INTERVALS_MS[NICE_INTERVALS_MS.length - 1]!;
}

/**
 * Build a filled area path for the "most replayed" curve.
 *
 * Drawn in a 0–100 viewBox with preserveAspectRatio="none" so it stretches to
 * whatever width the track happens to be, with no pixel measurement involved.
 * The neighbours immediately outside the window are included so the curve
 * enters and leaves the frame at the right height instead of snapping to zero
 * at the edges.
 */
function heatPath(points: readonly HeatPoint[], fromMs: number, toMs: number): string | null {
  if (points.length < 2 || toMs <= fromMs) return null;

  const span = toMs - fromMs;
  const firstInside = points.findIndex((point) => point.atMs >= fromMs);
  const start = Math.max(0, (firstInside === -1 ? points.length : firstInside) - 1);

  const segments: string[] = [];
  for (let i = start; i < points.length; i += 1) {
    const point = points[i]!;
    const x = ((point.atMs - fromMs) / span) * 100;
    segments.push(`${x.toFixed(2)},${(100 - point.value * 100).toFixed(2)}`);
    if (point.atMs > toMs) break;
  }

  if (segments.length < 2) return null;

  const firstX = segments[0]!.split(',')[0]!;
  const lastX = segments[segments.length - 1]!.split(',')[0]!;
  return `M ${firstX},100 L ${segments.join(' L ')} L ${lastX},100 Z`;
}

/**
 * A trim selector with an overview strip above a zoomable detail track.
 *
 * One timeline is not enough. A 20-second selection inside a three-hour
 * stream is 0.2% of the width — under a pixel of travel per second, which is
 * not a control anyone can use. So the detail track shows a window into the
 * video and the overview shows where that window sits, which is how every
 * editor solves the same problem.
 */
export function RangeTimeline({
  durationMs,
  startMs,
  endMs,
  positionMs,
  maxLengthMs,
  chapters = [],
  heatmap = [],
  disabled = false,
  onRangeChange,
  onSeek,
}: RangeTimelineProps) {
  const [trackRef, trackWidth] = useElementWidth<HTMLDivElement>();

  const [viewStartMs, setViewStartMs] = useState(0);
  const [viewSpanMs, setViewSpanMs] = useState(() => Math.max(MIN_SPAN_MS, durationMs));
  const [dragging, setDragging] = useState<'start' | 'end' | 'move' | 'scrub' | null>(null);
  /** Where a mouse is hovering, for the ghost playhead. Null on touch. */
  const [hoverMs, setHoverMs] = useState<number | null>(null);

  // The pointer's offset from the selection start when a move began, so
  // grabbing the middle of the band does not teleport it under the cursor.
  const grabOffsetRef = useRef(0);
  const overviewRef = useRef<HTMLDivElement | null>(null);

  // A new video resets the view; without this, opening a 30-second clip after
  // a two-hour one leaves the track zoomed into a range that no longer exists.
  useEffect(() => {
    setViewStartMs(0);
    setViewSpanMs(Math.max(MIN_SPAN_MS, durationMs));
  }, [durationMs]);

  const span = Math.min(viewSpanMs, Math.max(MIN_SPAN_MS, durationMs));
  const viewStart = clamp(viewStartMs, 0, Math.max(0, durationMs - span));
  const viewEnd = viewStart + span;

  const toPercent = useCallback(
    (ms: number) => ((ms - viewStart) / span) * 100,
    [viewStart, span],
  );

  const msFromClientX = useCallback(
    (clientX: number, element: HTMLElement) => {
      const bounds = element.getBoundingClientRect();
      if (bounds.width === 0) return viewStart;
      const fraction = (clientX - bounds.left) / bounds.width;
      return clamp(viewStart + fraction * span, 0, durationMs);
    },
    [viewStart, span, durationMs],
  );

  /** Keep `ms` on screen by sliding the window, so a drag can leave the view. */
  const panToInclude = useCallback(
    (ms: number) => {
      const margin = span * 0.06;
      setViewStartMs((current) => {
        const clamped = clamp(current, 0, Math.max(0, durationMs - span));
        if (ms < clamped + margin) return clamp(ms - margin, 0, Math.max(0, durationMs - span));
        if (ms > clamped + span - margin) {
          return clamp(ms - span + margin, 0, Math.max(0, durationMs - span));
        }
        return current;
      });
    },
    [span, durationMs],
  );

  // ── Zoom ──────────────────────────────────────────────────────────────────

  const zoomAround = useCallback(
    (nextSpan: number, centreMs: number) => {
      const clampedSpan = clamp(nextSpan, MIN_SPAN_MS, Math.max(MIN_SPAN_MS, durationMs));
      setViewSpanMs(clampedSpan);
      setViewStartMs(clamp(centreMs - clampedSpan / 2, 0, Math.max(0, durationMs - clampedSpan)));
    },
    [durationMs],
  );

  const selectionCentre = (startMs + endMs) / 2;
  const canZoomIn = span > MIN_SPAN_MS + 1;
  const canZoomOut = span < durationMs - 1;

  const fitSelection = useCallback(() => {
    // A little air either side: trimming is easier when you can see what is
    // just outside the cut.
    zoomAround(Math.max(MIN_SPAN_MS, (endMs - startMs) * 1.6), (startMs + endMs) / 2);
  }, [zoomAround, startMs, endMs]);

  // ── Pointer dragging ──────────────────────────────────────────────────────

  const beginDrag = useCallback(
    (event: React.PointerEvent, mode: 'start' | 'end' | 'move' | 'scrub') => {
      if (disabled) return;
      const track = trackRef.current;
      if (!track) return;

      event.preventDefault();
      event.stopPropagation();
      track.setPointerCapture(event.pointerId);
      setDragging(mode);

      const ms = msFromClientX(event.clientX, track);
      if (mode === 'move') grabOffsetRef.current = ms - startMs;
      if (mode === 'scrub') onSeek(ms);
    },
    [disabled, trackRef, msFromClientX, startMs, onSeek],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent) => {
      const track = trackRef.current;
      if (!track) return;

      const ms = msFromClientX(event.clientX, track);

      if (!dragging) {
        // Ghost playhead. Touch has no hover, and showing one under a thumb
        // that is already gone would just be a stuck artefact.
        if (event.pointerType === 'mouse') setHoverMs(ms);
        return;
      }

      panToInclude(ms);

      if (dragging === 'scrub') {
        onSeek(ms);
        return;
      }

      if (dragging === 'start') {
        // Clamped by both ends: the selection cannot invert, and it cannot
        // grow past the server's per-clip ceiling.
        const next = clamp(ms, Math.max(0, endMs - maxLengthMs), endMs - MIN_SELECTION_MS);
        onRangeChange({ startMs: next, endMs });
        return;
      }

      if (dragging === 'end') {
        const next = clamp(ms, startMs + MIN_SELECTION_MS, Math.min(durationMs, startMs + maxLengthMs));
        onRangeChange({ startMs, endMs: next });
        return;
      }

      const length = endMs - startMs;
      const nextStart = clamp(ms - grabOffsetRef.current, 0, Math.max(0, durationMs - length));
      onRangeChange({ startMs: nextStart, endMs: nextStart + length });
    },
    [dragging, trackRef, msFromClientX, panToInclude, onSeek, onRangeChange, startMs, endMs, durationMs, maxLengthMs],
  );

  const endDrag = useCallback(
    (event: React.PointerEvent) => {
      if (!dragging) return;
      setDragging(null);
      const track = trackRef.current;
      if (track?.hasPointerCapture(event.pointerId)) track.releasePointerCapture(event.pointerId);
    },
    [dragging, trackRef],
  );

  // ── Keyboard ──────────────────────────────────────────────────────────────

  const nudge = useCallback(
    (which: 'start' | 'end', event: React.KeyboardEvent) => {
      const step = event.altKey ? 10 : event.shiftKey ? 1000 : 100;
      let delta = 0;

      if (event.key === 'ArrowLeft') delta = -step;
      else if (event.key === 'ArrowRight') delta = step;
      else if (event.key === 'PageDown') delta = -5000;
      else if (event.key === 'PageUp') delta = 5000;
      else if (event.key === 'Home') delta = which === 'start' ? -startMs : -(endMs - startMs - MIN_SELECTION_MS);
      else if (event.key === 'End') {
        delta = which === 'end' ? durationMs - endMs : endMs - startMs - MIN_SELECTION_MS;
      } else return;

      event.preventDefault();

      if (which === 'start') {
        const next = clamp(startMs + delta, Math.max(0, endMs - maxLengthMs), endMs - MIN_SELECTION_MS);
        onRangeChange({ startMs: next, endMs });
        panToInclude(next);
      } else {
        const next = clamp(endMs + delta, startMs + MIN_SELECTION_MS, Math.min(durationMs, startMs + maxLengthMs));
        onRangeChange({ startMs, endMs: next });
        panToInclude(next);
      }
    },
    [startMs, endMs, durationMs, maxLengthMs, onRangeChange, panToInclude],
  );

  // ── Overview panning ──────────────────────────────────────────────────────

  const panFromOverview = useCallback(
    (event: React.PointerEvent) => {
      if (disabled || durationMs <= 0) return;
      const element = overviewRef.current;
      if (!element) return;

      const bounds = element.getBoundingClientRect();
      if (bounds.width === 0) return;

      const fraction = clamp((event.clientX - bounds.left) / bounds.width, 0, 1);
      setViewStartMs(clamp(fraction * durationMs - span / 2, 0, Math.max(0, durationMs - span)));
    },
    [disabled, durationMs, span],
  );

  // ── Derived geometry ──────────────────────────────────────────────────────

  const ticks = useMemo(() => {
    if (trackWidth === 0 || span <= 0) return [];
    const interval = tickInterval(span, trackWidth);
    const first = Math.ceil(viewStart / interval) * interval;

    const result: Array<{ ms: number; label: string }> = [];
    for (let ms = first; ms <= viewEnd; ms += interval) {
      result.push({ ms, label: formatTimecode(ms, { tenths: interval < 1000 }) });
      // A hard stop, so a pathological span cannot spin here.
      if (result.length > 64) break;
    }
    return result;
  }, [trackWidth, span, viewStart, viewEnd]);

  const detailHeat = useMemo(() => heatPath(heatmap, viewStart, viewEnd), [heatmap, viewStart, viewEnd]);
  const overviewHeat = useMemo(() => heatPath(heatmap, 0, durationMs), [heatmap, durationMs]);

  const visibleChapters = useMemo(
    () => chapters.filter((chapter) => chapter.startMs >= viewStart && chapter.startMs <= viewEnd),
    [chapters, viewStart, viewEnd],
  );

  const selectionLeft = toPercent(startMs);
  const selectionWidth = Math.max(0, toPercent(endMs) - selectionLeft);
  const selectionPx = (selectionWidth / 100) * trackWidth;
  const playheadLeft = toPercent(positionMs);
  const playheadVisible = positionMs >= viewStart && positionMs <= viewEnd;
  const zoomed = span < durationMs - 1;

  /*
   * Handles normally sit just outside their edge, so they never cover the
   * frames being kept. At the very ends of the track that would put them
   * outside the (clipped) track entirely — and a selection starting at 0:00 is
   * the default, so the start handle would be ungrabbable most of the time.
   * Flip them inward when they would otherwise fall off.
   */
  const handlePx = 28;
  const flipStart = trackWidth > 0 && (selectionLeft / 100) * trackWidth < handlePx;
  const flipEnd =
    trackWidth > 0 && ((selectionLeft + selectionWidth) / 100) * trackWidth > trackWidth - handlePx;

  /*
   * The read-out that follows the pointer.
   *
   * While dragging, the exact value being set is the one thing worth looking
   * at, and it is precisely where the eye already is — reading it off a field
   * elsewhere on the page means looking away mid-drag.
   */
  const readout = useMemo(() => {
    if (dragging === 'start') return { text: formatTimecode(startMs, { tenths: true }), at: startMs, wide: false };
    if (dragging === 'end') return { text: formatTimecode(endMs, { tenths: true }), at: endMs, wide: false };
    if (dragging === 'move') {
      return {
        text: `${formatTimecode(startMs)} → ${formatTimecode(endMs)}`,
        at: (startMs + endMs) / 2,
        wide: true,
      };
    }
    if (dragging === 'scrub') return { text: formatTimecode(positionMs, { tenths: true }), at: positionMs, wide: false };
    if (hoverMs !== null) return { text: formatTimecode(hoverMs, { tenths: true }), at: hoverMs, wide: false };
    return null;
  }, [dragging, hoverMs, startMs, endMs, positionMs]);

  // Kept clear of the track's ends, or the bubble would hang off the edge and
  // widen the whole page.
  const readoutLeft = useMemo(() => {
    if (!readout || trackWidth === 0) return 50;
    const halfPx = readout.wide ? 74 : 38;
    const rawPx = (toPercent(readout.at) / 100) * trackWidth;
    return (clamp(rawPx, halfPx, Math.max(halfPx, trackWidth - halfPx)) / trackWidth) * 100;
  }, [readout, trackWidth, toPercent]);

  return (
    <div className={`timeline${disabled ? ' timeline--disabled' : ''}`}>
      {/* ── Overview: the whole video, and where the detail window sits ── */}
      {zoomed && (
        <div
          className="timeline__overview"
          ref={overviewRef}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            panFromOverview(event);
          }}
          onPointerMove={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) panFromOverview(event);
          }}
          role="presentation"
          title="Drag to move the visible window"
        >
          {overviewHeat && (
            <svg className="timeline__heat" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
              <path d={overviewHeat} />
            </svg>
          )}

          <span
            className="timeline__overview-selection"
            style={{
              left: `${(startMs / Math.max(1, durationMs)) * 100}%`,
              width: `${Math.max(0.4, ((endMs - startMs) / Math.max(1, durationMs)) * 100)}%`,
            }}
            aria-hidden="true"
          />
          <span
            className="timeline__overview-window"
            style={{
              left: `${(viewStart / Math.max(1, durationMs)) * 100}%`,
              width: `${(span / Math.max(1, durationMs)) * 100}%`,
            }}
            aria-hidden="true"
          />
        </div>
      )}

      {/* The stage lets the read-out sit above the track, which clips its own
          overflow to keep the heat curve and shoulders inside. */}
      <div className="timeline__stage">
        {readout && (
          <span
            className={`timeline__readout${readout.wide ? ' timeline__readout--wide' : ''}${dragging ? ' is-active' : ''}`}
            style={{ left: `${readoutLeft}%` }}
            aria-hidden="true"
          >
            {readout.text}
          </span>
        )}

        <div
          className={`timeline__track${dragging ? ` is-dragging is-dragging-${dragging}` : ''}`}
          ref={trackRef}
          onPointerDown={(event) => beginDrag(event, 'scrub')}
          onPointerMove={handlePointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onPointerLeave={() => setHoverMs(null)}
        >
          {detailHeat && (
            <svg className="timeline__heat" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
              <path d={detailHeat} />
            </svg>
          )}

          {visibleChapters.map((chapter) => (
            <span
              key={`${chapter.startMs}-${chapter.title}`}
              className="timeline__chapter-tick"
              style={{ left: `${toPercent(chapter.startMs)}%` }}
              aria-hidden="true"
            />
          ))}

          {/* Dimmed shoulders make the selection read as "kept" rather than
              "highlighted", which is the difference between an editor and a
              progress bar. */}
          <span className="timeline__shoulder" style={{ left: 0, width: `${clamp(selectionLeft, 0, 100)}%` }} aria-hidden="true" />
          <span
            className="timeline__shoulder"
            style={{ left: `${clamp(selectionLeft + selectionWidth, 0, 100)}%`, right: 0 }}
            aria-hidden="true"
          />

          {hoverMs !== null && !dragging && (
            <span className="timeline__ghost" style={{ left: `${toPercent(hoverMs)}%` }} aria-hidden="true" />
          )}

          <span
            className="timeline__selection"
            style={{ left: `${selectionLeft}%`, width: `${selectionWidth}%` }}
            onPointerDown={(event) => beginDrag(event, 'move')}
            role="presentation"
            title="Drag to move the selection"
          >
            {/* Only once there is room for it — a badge spilling out of a
                narrow selection reads as a rendering fault. */}
            {selectionPx > 78 && (
              <span className="timeline__selection-length">
                {formatTimecode(endMs - startMs, { tenths: true })}
              </span>
            )}
          </span>

          <div
            className={`timeline__handle timeline__handle--start${flipStart ? ' is-flipped' : ''}`}
            style={{ left: `${selectionLeft}%` }}
            role="slider"
            tabIndex={disabled ? -1 : 0}
            aria-label="Clip start"
            aria-valuemin={0}
            aria-valuemax={Math.round(endMs - MIN_SELECTION_MS)}
            aria-valuenow={Math.round(startMs)}
            aria-valuetext={formatTimecode(startMs, { tenths: true })}
            aria-disabled={disabled}
            onPointerDown={(event) => beginDrag(event, 'start')}
            onKeyDown={(event) => nudge('start', event)}
          >
            <span className="timeline__grip" aria-hidden="true" />
          </div>

          <div
            className={`timeline__handle timeline__handle--end${flipEnd ? ' is-flipped' : ''}`}
            style={{ left: `${selectionLeft + selectionWidth}%` }}
            role="slider"
            tabIndex={disabled ? -1 : 0}
            aria-label="Clip end"
            aria-valuemin={Math.round(startMs + MIN_SELECTION_MS)}
            aria-valuemax={Math.round(durationMs)}
            aria-valuenow={Math.round(endMs)}
            aria-valuetext={formatTimecode(endMs, { tenths: true })}
            aria-disabled={disabled}
            onPointerDown={(event) => beginDrag(event, 'end')}
            onKeyDown={(event) => nudge('end', event)}
          >
            <span className="timeline__grip" aria-hidden="true" />
          </div>

          {playheadVisible && (
            <span className="timeline__playhead" style={{ left: `${playheadLeft}%` }} aria-hidden="true" />
          )}
        </div>
      </div>

      {/* ── Ruler ───────────────────────────────────────────────────────── */}
      <div className="timeline__ruler" aria-hidden="true">
        {ticks.map((tick) => (
          <span key={tick.ms} className="timeline__tick" style={{ left: `${toPercent(tick.ms)}%` }}>
            {tick.label}
          </span>
        ))}
      </div>

      {/* ── Zoom ────────────────────────────────────────────────────────── */}
      <div className="timeline__zoom">
        <span className="timeline__zoom-label">
          {zoomed ? `Showing ${formatTimecode(viewStart)} – ${formatTimecode(viewEnd)}` : 'Whole video'}
        </span>

        <div className="timeline__zoom-buttons">
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={fitSelection}
            disabled={disabled || durationMs === 0}
            title="Zoom to the selection"
          >
            Fit
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--icon btn--sm"
            onClick={() => zoomAround(span * 2, positionMs || selectionCentre)}
            disabled={disabled || !canZoomOut}
            aria-label="Zoom out"
            title="Zoom out"
          >
            −
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--icon btn--sm"
            onClick={() => zoomAround(span / 2, positionMs || selectionCentre)}
            disabled={disabled || !canZoomIn}
            aria-label="Zoom in"
            title="Zoom in"
          >
            +
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => zoomAround(durationMs, durationMs / 2)}
            disabled={disabled || !canZoomOut}
            title="Show the whole video"
          >
            All
          </button>
        </div>
      </div>
    </div>
  );
}
