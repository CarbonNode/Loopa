/*
 * The YouTube IFrame Player API, wrapped in the two things the studio needs:
 * a URL parser and a loader that resolves once.
 *
 * The embedded player is what makes clipping feel instant — the alternative
 * is downloading the video server-side before anything can be shown, which
 * turns a two-second interaction into a two-minute one for a video the user
 * may not even end up clipping.
 */

export type YouTubePlayerState = -1 | 0 | 1 | 2 | 3 | 5;

export const PLAYER_STATE = {
  unstarted: -1,
  ended: 0,
  playing: 1,
  paused: 2,
  buffering: 3,
  cued: 5,
} as const;

export type YouTubePlayer = {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): YouTubePlayerState;
  mute(): void;
  unMute(): void;
  isMuted(): boolean;
  setVolume(volume: number): void;
  getVideoData(): { video_id?: string; title?: string; author?: string };
  destroy(): void;
};

type PlayerOptions = {
  videoId: string;
  playerVars?: Record<string, string | number>;
  events?: {
    onReady?: (event: { target: YouTubePlayer }) => void;
    onStateChange?: (event: { data: YouTubePlayerState; target: YouTubePlayer }) => void;
    onError?: (event: { data: number }) => void;
  };
};

type YouTubeApi = { Player: new (element: HTMLElement | string, options: PlayerOptions) => YouTubePlayer };

declare global {
  interface Window {
    YT?: YouTubeApi;
    onYouTubeIframeAPIReady?: () => void;
  }
}

const SCRIPT_SRC = 'https://www.youtube.com/iframe_api';
const LOAD_TIMEOUT_MS = 15_000;

let apiPromise: Promise<YouTubeApi> | null = null;

/**
 * Load the IFrame API once per page.
 *
 * A rejection clears the cached promise: the usual cause is a network hiccup
 * or a blocker that the user then turns off, and a permanently-poisoned
 * promise would make "Retry" a button that can never work.
 */
export function loadYouTubeApi(): Promise<YouTubeApi> {
  if (apiPromise) return apiPromise;

  apiPromise = new Promise<YouTubeApi>((resolve, reject) => {
    if (window.YT?.Player) {
      resolve(window.YT);
      return;
    }

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('The YouTube player did not load.'));
    }, LOAD_TIMEOUT_MS);

    // The API calls exactly one global hook, so chain rather than replace —
    // clobbering it would strand any other listener waiting on the same load.
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (window.YT?.Player) resolve(window.YT);
      else reject(new Error('The YouTube player loaded without a Player constructor.'));
    };

    if (!document.querySelector(`script[src="${SCRIPT_SRC}"]`)) {
      const script = document.createElement('script');
      script.src = SCRIPT_SRC;
      script.async = true;
      script.addEventListener('error', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error('The YouTube player could not be reached.'));
      });
      document.head.append(script);
    }
  }).catch((error: unknown) => {
    apiPromise = null;
    throw error;
  });

  return apiPromise;
}

export type ParsedYouTubeUrl = { videoId: string; startSeconds: number };

const ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

/** `90`, `1m30s`, `1h2m3s` — every shape YouTube itself puts in a `t` param. */
function parseStartParam(value: string | null): number {
  if (!value) return 0;

  const plain = Number(value.replace(/s$/, ''));
  if (Number.isFinite(plain) && /^\d+s?$/.test(value)) return Math.max(0, plain);

  const match = value.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!match || value === '') return 0;

  const [, hours, minutes, seconds] = match;
  return Number(hours ?? 0) * 3600 + Number(minutes ?? 0) * 60 + Number(seconds ?? 0);
}

/**
 * Pull the video id out of any YouTube link shape.
 *
 * Returns null for anything that is not YouTube, which is how the studio
 * decides whether it can offer a player at all.
 */
export function parseYouTubeUrl(raw: string): ParsedYouTubeUrl | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // A bare id pasted on its own is a reasonable thing to try.
  if (ID_PATTERN.test(trimmed)) return { videoId: trimmed, startSeconds: 0 };

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^(www|m|music)\./, '');
  const startSeconds = parseStartParam(url.searchParams.get('t') ?? url.searchParams.get('start'));

  if (host === 'youtu.be') {
    const id = url.pathname.split('/').filter(Boolean)[0];
    return id && ID_PATTERN.test(id) ? { videoId: id, startSeconds } : null;
  }

  if (host !== 'youtube.com' && host !== 'youtube-nocookie.com') return null;

  const fromQuery = url.searchParams.get('v');
  if (fromQuery && ID_PATTERN.test(fromQuery)) return { videoId: fromQuery, startSeconds };

  // /shorts/<id>, /embed/<id>, /live/<id>, /v/<id>
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length >= 2 && ['shorts', 'embed', 'live', 'v'].includes(segments[0]!)) {
    const id = segments[1]!;
    if (ID_PATTERN.test(id)) return { videoId: id, startSeconds };
  }

  return null;
}

/** The canonical watch URL, which is what the server should be handed. */
export function watchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

/**
 * Why the player refused to play, in words the user can act on.
 *
 * Code 101/150 is the common one and the least self-explanatory: the video
 * exists and is public, but its owner has disabled embedding — so the player
 * is dead while clipping it server-side still works fine.
 */
export function describePlayerError(code: number): string {
  switch (code) {
    case 2:
      return 'YouTube rejected that video id.';
    case 5:
      return 'That video cannot be played in this player.';
    case 100:
      return 'That video is private or has been removed.';
    case 101:
    case 150:
      return 'The uploader has disabled playback on other sites.';
    default:
      return 'The YouTube player could not play that video.';
  }
}
