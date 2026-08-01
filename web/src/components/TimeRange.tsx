import { useCallback, useEffect, useState } from 'react';
import { formatTimecode, parseTimecode } from '../utils/format.ts';
import './TimeRange.css';

/**
 * A timecode field that only commits when it parses.
 *
 * Rewriting the value on every keystroke would fight the user: clearing the
 * field to retype "1:30" momentarily reads as "", which would otherwise snap
 * the handle to zero and lose their place.
 */
export function TimeField({
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
    <div className="time-field">
      <label className="time-field__label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className={`input time-field__input${invalid ? ' input--invalid' : ''}`}
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
 * From here, to here, this long — one enclosure, because it is one reading.
 *
 * Spread out as separate fields these read as three unrelated settings, and
 * the length reads as an unrelated statistic rather than the consequence of
 * the two values beside it.
 *
 * Shared between the clip studio and the soundbite dialog on purpose: both are
 * "pick a range out of a video", and a second copy of the commit-on-parse
 * behaviour is exactly the kind of drift that ends with two fields that
 * accept different input.
 */
export function TimeRange({
  idPrefix,
  startMs,
  endMs,
  lengthMs,
  onCommitStart,
  onCommitEnd,
  disabled = false,
  over = false,
}: {
  idPrefix: string;
  startMs: number;
  endMs: number;
  lengthMs: number;
  onCommitStart: (ms: number) => void;
  onCommitEnd: (ms: number) => void;
  disabled?: boolean;
  /** Past the server's per-clip ceiling — colours the length, nothing more. */
  over?: boolean;
}) {
  return (
    <div className="time-range">
      <TimeField
        id={`${idPrefix}-start`}
        label="Start"
        valueMs={startMs}
        onCommit={onCommitStart}
        disabled={disabled}
      />

      <span className="time-range__arrow" aria-hidden="true">
        →
      </span>

      <TimeField id={`${idPrefix}-end`} label="End" valueMs={endMs} onCommit={onCommitEnd} disabled={disabled} />

      <div className="time-range__length">
        <span className="time-field__label">Length</span>
        <span className={`time-range__length-value${over ? ' is-over' : ''}`}>
          {formatTimecode(Math.max(0, lengthMs), { tenths: true })}
        </span>
      </div>
    </div>
  );
}
