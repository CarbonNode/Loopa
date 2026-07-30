/** `1:07`, or `0:04` for anything under a minute. */
export function formatDuration(ms: number | null): string | null {
  if (!ms || ms < 250) return null;

  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * A timecode for editing, rather than for display on a card.
 *
 * `formatDuration` rounds to the second and gives up below 250ms, which is
 * right for "how long is this clip" and wrong for "where exactly does the cut
 * land" — at second precision a trim handle appears not to move until it
 * jumps a whole second. Tenths are the smallest unit worth showing: finer
 * than that is below the resolution of the drag, and reads as noise.
 */
export function formatTimecode(ms: number, options: { tenths?: boolean } = {}): string {
  const clamped = Math.max(0, ms);
  const totalSeconds = Math.floor(clamped / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const base =
    hours > 0
      ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
      : `${minutes}:${String(seconds).padStart(2, '0')}`;

  if (!options.tenths) return base;
  return `${base}.${Math.floor((clamped % 1000) / 100)}`;
}

/**
 * Read a typed timecode back into milliseconds.
 *
 * Accepts what people actually type into a time field: `72`, `1:12`, `1:12.4`,
 * `1:02:03`. Returns null for anything it cannot make sense of, so the caller
 * can leave the previous value alone rather than snapping the handle to zero
 * halfway through someone typing.
 */
export function parseTimecode(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (!/^\d{1,2}(:\d{1,2}){0,2}(\.\d{1,3})?$/.test(trimmed)) return null;

  const [whole, fraction = ''] = trimmed.split('.');
  const parts = whole!.split(':').map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return null;

  // Right-aligned: the last part is always seconds, whatever the length.
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + part!;

  const millis = fraction ? Number(fraction.padEnd(3, '0').slice(0, 3)) : 0;
  return seconds * 1000 + millis;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // One decimal below 10 keeps "1.4 MB" readable without "1.437 MB" noise.
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

const RELATIVE_UNITS: ReadonlyArray<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 31_536_000_000],
  ['month', 2_592_000_000],
  ['week', 604_800_000],
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
];

const relativeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

export function formatRelativeTime(timestamp: number): string {
  const elapsed = Date.now() - timestamp;
  if (Math.abs(elapsed) < 45_000) return 'just now';

  for (const [unit, unitMs] of RELATIVE_UNITS) {
    if (Math.abs(elapsed) >= unitMs) {
      return relativeFormatter.format(-Math.round(elapsed / unitMs), unit);
    }
  }
  return 'just now';
}

export function formatAbsoluteTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(timestamp);
}

export function formatCount(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}

export function formatUsd(value: number): string {
  if (value === 0) return '$0.00';
  // Sub-cent totals are the normal case early on; "$0.00" would read as broken.
  if (value < 0.01) return `<$0.01`;
  return `$${value.toFixed(2)}`;
}

/**
 * Split text into matched and unmatched runs so search results can highlight
 * what the user actually typed.
 *
 * Returns plain data rather than markup so the caller controls the element —
 * and so nothing user-supplied is ever interpolated as HTML.
 */
export function highlightMatches(text: string, query: string): Array<{ text: string; match: boolean }> {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, ''))
    .filter((term) => term.length >= 2);

  if (terms.length === 0) return [{ text, match: false }];

  const pattern = new RegExp(`(${terms.join('|')})`, 'gi');
  const pieces = text.split(pattern);

  return pieces
    .filter((piece) => piece !== '')
    .map((piece) => ({ text: piece, match: terms.includes(piece.toLowerCase()) }));
}

/** Deterministic hue from a string — used to colour tag chips consistently. */
export function hueFor(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) % 360;
}

export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[words.length - 1]![0]!).toUpperCase();
}

/** Host without `www.`, for showing a clip's origin compactly. */
export function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}
