import { lookup } from 'node:dns/promises';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from '../config.ts';
import { newId } from '../util/ids.ts';
import { ProcessError, run } from '../util/proc.ts';
// Aliased: this module exports its own ProbeResult (a *link* probe), which is
// a different thing from ffmpeg's (a *file* probe).
import { probe as probeMedia, trimSegment } from './ffmpeg.ts';

export class IngestError extends Error {
  readonly status: number;
  /** Retrying later has a real chance of succeeding (rate limit, transient network). */
  readonly retryable: boolean;
  /** Shown to the user verbatim — must be actionable, not a stack trace. */
  readonly hint: string | undefined;

  constructor(message: string, opts: { status?: number; retryable?: boolean; hint?: string } = {}) {
    super(message);
    this.name = 'IngestError';
    this.status = opts.status ?? 400;
    this.retryable = opts.retryable ?? false;
    this.hint = opts.hint;
  }
}

// ── Site detection ───────────────────────────────────────────────────────────

export type SiteId = 'instagram' | 'tiktok' | 'youtube' | 'reddit' | 'twitter' | 'imgur' | 'direct' | 'other';

const SITE_PATTERNS: ReadonlyArray<{ id: SiteId; label: string; hosts: RegExp }> = [
  { id: 'instagram', label: 'Instagram', hosts: /(^|\.)(instagram\.com|instagr\.am|ddinstagram\.com)$/i },
  { id: 'tiktok', label: 'TikTok', hosts: /(^|\.)(tiktok\.com|vm\.tiktok\.com|vt\.tiktok\.com)$/i },
  { id: 'youtube', label: 'YouTube', hosts: /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i },
  { id: 'reddit', label: 'Reddit', hosts: /(^|\.)(reddit\.com|redd\.it|v\.redd\.it|redgifs\.com)$/i },
  { id: 'twitter', label: 'X / Twitter', hosts: /(^|\.)(twitter\.com|x\.com|t\.co|fxtwitter\.com|vxtwitter\.com)$/i },
  { id: 'imgur', label: 'Imgur', hosts: /(^|\.)(imgur\.com|i\.imgur\.com)$/i },
];

const DIRECT_FILE_EXTENSIONS = /\.(mp4|webm|mov|m4v|gif|gifv|jpg|jpeg|png|webp|avif)$/i;

export function detectSite(url: URL): { id: SiteId; label: string } {
  for (const pattern of SITE_PATTERNS) {
    if (pattern.hosts.test(url.hostname)) return { id: pattern.id, label: pattern.label };
  }
  if (DIRECT_FILE_EXTENSIONS.test(url.pathname)) return { id: 'direct', label: 'Direct file' };
  return { id: 'other', label: url.hostname };
}

/**
 * Instagram and TikTok links arrive in a lot of shapes — share links, mobile
 * short links, tracking params. Strip the noise so the same Reel pasted from
 * two places dedupes and so yt-dlp gets the canonical form.
 */
export function normaliseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new IngestError('That does not look like a valid link.', { hint: 'Paste the full URL, including https://' });
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new IngestError('Only http and https links can be imported.');
  }

  // Tracking parameters change per share and would otherwise defeat dedupe.
  for (const param of [
    'igsh', 'igshid', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
    '_r', '_t', 'is_from_webapp', 'sender_device', 'web_id', 'share_app_id', 'share_link_id',
    'si', 'feature', 'fbclid', 'gclid',
  ]) {
    url.searchParams.delete(param);
  }

  const site = detectSite(url);

  if (site.id === 'instagram') {
    // instagram.com/reels/<id>/ and /tv/<id>/ both resolve to the /reel/ form.
    url.hostname = 'www.instagram.com';
    const match = url.pathname.match(/\/(?:reels?|p|tv)\/([A-Za-z0-9_-]+)/);
    if (match) url.pathname = `/reel/${match[1]}/`;
  }

  if (site.id === 'twitter') {
    // The proxy front-ends exist to embed nicely in chat apps; yt-dlp wants
    // the real host.
    if (/^(fx|vx)twitter\.com$/i.test(url.hostname)) url.hostname = 'x.com';
  }

  return url;
}

// ── SSRF guard ───────────────────────────────────────────────────────────────

const PRIVATE_V4 = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^0\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];

function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return PRIVATE_V4.some((re) => re.test(address));
  if (family === 6) {
    const normalised = address.toLowerCase();
    if (normalised === '::1' || normalised === '::') return true;
    if (/^f[cd]/.test(normalised)) return true; // unique-local
    if (normalised.startsWith('fe80')) return true; // link-local
    // IPv4-mapped (::ffff:10.0.0.1) must be checked against the v4 rules.
    const mapped = normalised.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped?.[1]) return PRIVATE_V4.some((re) => re.test(mapped[1]!));
  }
  return false;
}

/**
 * Refuse to fetch anything on the local network.
 *
 * Any signed-in member can paste a URL, so without this the server is a proxy
 * into the LAN — every other container on super_server, the router admin page,
 * cloud metadata endpoints.
 */
export async function assertPublicHost(url: URL): Promise<void> {
  const host = url.hostname;

  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new IngestError('That host is not allowed.', { status: 403 });
  }

  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new IngestError('That host is not allowed.', { status: 403 });
    return;
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new IngestError(`Could not resolve ${host}.`, { retryable: true });
  }

  if (addresses.length === 0 || addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new IngestError('That host is not allowed.', { status: 403 });
  }
}

// ── yt-dlp ───────────────────────────────────────────────────────────────────

export const COOKIES_DIR = join(config.dataDir, 'cookies');

/**
 * Instagram in particular rejects most anonymous Reel requests. An admin can
 * drop a Netscape-format cookies.txt at data/cookies/instagram.txt (exported
 * from a logged-in browser) and it is picked up automatically.
 */
async function cookieFileFor(site: SiteId): Promise<string | null> {
  for (const candidate of [`${site}.txt`, 'default.txt']) {
    const path = join(COOKIES_DIR, candidate);
    try {
      const info = await stat(path);
      if (info.isFile() && info.size > 0) return path;
    } catch {
      // Not present — fall through to the next candidate.
    }
  }
  return null;
}

export async function cookieStatus(): Promise<Record<string, boolean>> {
  const result: Record<string, boolean> = {};
  for (const site of ['instagram', 'tiktok', 'youtube', 'twitter', 'reddit', 'default'] as const) {
    result[site] = (await cookieFileFor(site as SiteId)) !== null;
  }
  return result;
}

/**
 * Build a Netscape cookie jar from a pasted session token.
 *
 * Exporting a cookies.txt means installing a browser extension and finding a
 * file — enough friction that people give up. Every site here authenticates
 * on a single session cookie, which is two clicks away in DevTools
 * (Application → Cookies) and can be pasted into a text box. We synthesise
 * the file format yt-dlp wants from it.
 *
 * Tab-separated, in yt-dlp's expected column order:
 *   domain  includeSubdomains  path  secure  expiry  name  value
 */
const SESSION_COOKIE_NAMES: Readonly<Record<string, { domain: string; primary: string; extras: readonly string[] }>> = {
  instagram: { domain: '.instagram.com', primary: 'sessionid', extras: ['ds_user_id', 'csrftoken'] },
  tiktok: { domain: '.tiktok.com', primary: 'sessionid', extras: ['sessionid_ss', 'tt-target-idc'] },
  youtube: { domain: '.youtube.com', primary: 'SID', extras: ['HSID', 'SSID', 'APISID', 'SAPISID', '__Secure-1PSID'] },
  twitter: { domain: '.x.com', primary: 'auth_token', extras: ['ct0'] },
  reddit: { domain: '.reddit.com', primary: 'reddit_session', extras: [] },
};

export function supportedCookieSites(): string[] {
  return Object.keys(SESSION_COOKIE_NAMES);
}

export async function writeSessionCookies(
  site: string,
  values: Readonly<Record<string, string>>,
): Promise<{ written: string[] }> {
  const spec = SESSION_COOKIE_NAMES[site];
  if (!spec) throw new IngestError(`No session-cookie mapping is known for "${site}".`);

  // A bare paste has no name attached — it can only be the cookie we asked
  // for, so adopt it as such.
  const resolved: Record<string, string> = { ...values };
  if (resolved.__bare__ && !resolved[spec.primary]) {
    resolved[spec.primary] = resolved.__bare__;
  }
  delete resolved.__bare__;

  const primary = resolved[spec.primary]?.trim();
  if (!primary) {
    const found = Object.keys(resolved).filter((name) => name !== '__bare__');
    throw new IngestError(
      found.length > 0
        ? `That paste had cookies (${found.slice(0, 6).join(', ')}) but not "${spec.primary}".`
        : `Could not find a "${spec.primary}" cookie in what you pasted.`,
      {
        hint:
          found.length > 0
            ? `Make sure you copied a request made while signed in to ${site} — a logged-out session has no "${spec.primary}".`
            : `In ${site}: DevTools → Application → Cookies → copy the value of "${spec.primary}". Or Network tab → right-click any request → Copy as cURL, and paste the whole thing.`,
      },
    );
  }

  // A year out. The cookie itself expires server-side long before this; the
  // date only stops yt-dlp discarding it as already-stale on read.
  const expiry = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60;

  const lines = ['# Netscape HTTP Cookie File', '# Written by Loopa from a pasted session token.', ''];
  const written: string[] = [];

  for (const name of [spec.primary, ...spec.extras]) {
    const value = resolved[name]?.trim();
    if (!value) continue;
    lines.push([spec.domain, 'TRUE', '/', 'TRUE', String(expiry), name, value].join('\t'));
    written.push(name);
  }

  await mkdir(COOKIES_DIR, { recursive: true });
  // 0600 — a session cookie is a bearer credential for the whole account.
  await writeFile(join(COOKIES_DIR, `${site}.txt`), `${lines.join('\n')}\n`, { mode: 0o600 });

  return { written };
}

export type ProbeResult = {
  ok: boolean;
  site: string;
  title?: string;
  uploader?: string;
  durationMs?: number | null;
  error?: string;
  hint?: string;
  usedCookies: boolean;
};

/**
 * Dry-run a URL through the real downloader.
 *
 * A synthetic "are these cookies valid" check would test an endpoint that is
 * not the one that matters. Running the actual extractor in --simulate mode
 * answers the only useful question: would importing this link work right now?
 */
export async function probeUrl(rawUrl: string): Promise<ProbeResult> {
  const url = normaliseUrl(rawUrl);
  await assertPublicHost(url);

  const site = detectSite(url);
  const cookies = await cookieFileFor(site.id);

  const binary = await requireYtDlp();

  const args = [
    '--no-playlist',
    '--no-warnings',
    '--no-progress',
    '--simulate',
    '--socket-timeout', '20',
    '--retries', '1',
    '--print', '%(title)s\x1f%(uploader)s\x1f%(duration)s',
  ];
  if (cookies) args.push('--cookies', cookies);
  if (config.ytDlpProxy) args.push('--proxy', config.ytDlpProxy);
  if (site.id === 'instagram') args.push('--extractor-args', 'instagram:api_version=v1');
  args.push(url.toString());

  try {
    const { stdout } = await run(binary, args, { timeoutMs: 90_000 });
    const [title, uploader, duration] = (stdout.trim().split('\n').at(-1) ?? '').split('\x1f');
    const seconds = Number(duration);

    return {
      ok: true,
      site: site.label,
      title: title && title !== 'NA' ? title : undefined,
      uploader: uploader && uploader !== 'NA' ? uploader : undefined,
      durationMs: Number.isFinite(seconds) ? Math.round(seconds * 1000) : null,
      usedCookies: cookies !== null,
    };
  } catch (error) {
    const failure =
      error instanceof ProcessError
        ? interpretYtDlpFailure(site.id, error.stderr || error.message)
        : new IngestError((error as Error).message);

    return {
      ok: false,
      site: site.label,
      error: failure.message,
      hint: failure.hint,
      usedCookies: cookies !== null,
    };
  }
}

/**
 * Locate the yt-dlp binary.
 *
 * A bare `yt-dlp` only works if it is on the PATH the *server process*
 * inherits — which is not the same PATH as an interactive shell. `pip install
 * --user` puts it in ~/.local/bin, absent from the minimal PATH a service or
 * container gets, so relying on the bare name silently disables URL import on
 * an otherwise correct install.
 *
 * Resolved once and cached; call resetYtDlpPath() after an update.
 */
let resolvedYtDlp: string | null | undefined;
let lastFailedProbeAt = 0;

/** Re-probe at most this often after a failure. */
const NEGATIVE_RETRY_MS = 30_000;

async function isRunnable(candidate: string): Promise<boolean> {
  try {
    // Generous: yt-dlp is a Python script, and interpreter startup on a busy
    // or cold machine can take several seconds. A tight timeout here reads as
    // "not installed" for something that is merely slow.
    const result = await run(candidate, ['--version'], { timeoutMs: 45_000, allowFailure: true });
    return result.code === 0;
  } catch {
    return false;
  }
}

export async function ytDlpBinary(): Promise<string | null> {
  // Only a *successful* resolution is cached permanently.
  //
  // Caching the failure was a real bug: the boot probe runs while the machine
  // is still busy starting up, and one slow spawn there would mark yt-dlp
  // missing for the entire life of the process — URL import silently dead
  // until someone restarted it, on a host where the binary was present and
  // working the whole time.
  if (resolvedYtDlp) return resolvedYtDlp;
  if (resolvedYtDlp === null && Date.now() - lastFailedProbeAt < NEGATIVE_RETRY_MS) return null;

  const home = process.env.HOME ?? '/root';
  const candidates = [
    config.ytDlpPath,
    // A vendored copy inside the project, before anything else discovered.
    // Some hosts run the app in a sandbox that can read the project directory
    // but not the user's home — dropping the standalone zipapp here is the
    // one location guaranteed to be visible, since the server's own code is
    // loaded from it.
    join(import.meta.dirname, '..', '..', '..', 'vendor', 'yt-dlp'),
    'yt-dlp',
    join(home, '.local', 'bin', 'yt-dlp'),
    '/usr/local/bin/yt-dlp',
    '/usr/bin/yt-dlp',
    '/opt/homebrew/bin/yt-dlp',
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (await isRunnable(candidate)) {
      resolvedYtDlp = candidate;
      if (candidate !== 'yt-dlp') console.log(`[ingest] using yt-dlp at ${candidate}`);
      return candidate;
    }
  }

  resolvedYtDlp = null;
  lastFailedProbeAt = Date.now();
  return null;
}

export function resetYtDlpPath(): void {
  resolvedYtDlp = undefined;
  lastFailedProbeAt = 0;
}

/** The resolved binary, or a clear error if there is none. */
async function requireYtDlp(): Promise<string> {
  const binary = await ytDlpBinary();
  if (!binary) {
    throw new IngestError('The downloader (yt-dlp) is not installed on this server.', {
      hint: 'Install it with: pip install yt-dlp — or set YTDLP_PATH to its location.',
    });
  }
  return binary;
}

export async function ytDlpVersion(): Promise<string | null> {
  const binary = await ytDlpBinary();
  if (!binary) return null;
  try {
    const { stdout } = await run(binary, ['--version'], { timeoutMs: 20_000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Update yt-dlp in place.
 *
 * Not a nicety: Instagram and TikTok change their internals often enough that
 * an extractor which works today can break within weeks. Being able to update
 * without rebuilding the image is what keeps Reel ingest working.
 */
export async function updateYtDlp(): Promise<{ ok: boolean; output: string; version: string | null }> {
  // Update the binary we actually run, not whatever a bare `yt-dlp` might
  // resolve to — those can be different installs.
  const existing = await ytDlpBinary();

  const attempts: ReadonlyArray<{ command: string; args: string[] }> = [
    ...(existing ? [{ command: existing, args: ['-U'] }] : []),
    { command: 'pip3', args: ['install', '--no-cache-dir', '--break-system-packages', '--upgrade', 'yt-dlp'] },
    // --user is the path that works when the process cannot write to the
    // system site-packages, which is the common container case.
    { command: 'pip3', args: ['install', '--no-cache-dir', '--user', '--upgrade', 'yt-dlp'] },
  ];

  let output = '';
  for (const attempt of attempts) {
    try {
      const result = await run(attempt.command, attempt.args, { timeoutMs: 5 * 60 * 1000, allowFailure: true });
      output += `$ ${attempt.command} ${attempt.args.join(' ')}\n${result.stdout}${result.stderr}\n`;
      if (result.code === 0) {
        // A pip upgrade can move the binary, so re-detect before reporting.
        resetYtDlpPath();
        return { ok: true, output, version: await ytDlpVersion() };
      }
    } catch (error) {
      output += `$ ${attempt.command}: ${(error as Error).message}\n`;
    }
  }

  return { ok: false, output, version: await ytDlpVersion() };
}

export type RemoteMetadata = {
  siteId: SiteId;
  siteLabel: string;
  canonicalUrl: string;
  /** The platform's own title, where it has one distinct from the caption. */
  title: string | null;
  /** The caption. On Reels and TikToks this is frequently the joke itself. */
  caption: string | null;
  uploader: string | null;
  uploaderUrl: string | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  uploadedAt: number | null;
  viewCount: number | null;
  likeCount: number | null;
  hashtags: string[];
};

type YtDlpJson = {
  id?: string;
  title?: string;
  description?: string;
  uploader?: string;
  uploader_id?: string;
  channel?: string;
  uploader_url?: string;
  channel_url?: string;
  webpage_url?: string;
  duration?: number;
  width?: number;
  height?: number;
  upload_date?: string;
  timestamp?: number;
  view_count?: number;
  like_count?: number;
  ext?: string;
  extractor_key?: string;
  requested_downloads?: Array<{ filepath?: string; ext?: string }>;
  _filename?: string;
  entries?: unknown[];
};

function extractHashtags(...texts: Array<string | null | undefined>): string[] {
  const found = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    for (const match of text.matchAll(/#([\p{L}\p{N}_]{2,40})/gu)) {
      found.add(match[1]!.toLowerCase());
    }
  }
  return [...found].slice(0, 30);
}

/**
 * Map yt-dlp's stderr onto something a person can act on.
 *
 * Instagram and TikTok fail in specific, recurring ways, and "yt-dlp exited 1"
 * tells the user nothing about which one they hit.
 */
function interpretYtDlpFailure(site: SiteId, stderr: string): IngestError {
  const text = stderr.toLowerCase();

  if (text.includes('login required') || text.includes('requested content is not available') || text.includes('rate-limit reached') || text.includes('empty media response')) {
    const platform = site === 'instagram' ? 'Instagram' : site === 'tiktok' ? 'TikTok' : 'That site';
    const cookie = site === 'twitter' ? 'auth_token' : site === 'youtube' ? 'SID' : 'sessionid';
    return new IngestError(`${platform} refused the download without a signed-in session.`, {
      retryable: false,
      // Point at the two-click path, not the browser-extension one.
      hint:
        `Settings → Ingest → ${platform} → Sign in, then paste the "${cookie}" cookie ` +
        `(in ${platform}: DevTools → Application → Cookies).`,
    });
  }

  if (text.includes('http error 429') || text.includes('too many requests')) {
    return new IngestError('The site is rate-limiting us right now.', {
      retryable: true,
      hint: 'Loopa will retry automatically with a longer delay.',
    });
  }

  if (text.includes('private') || text.includes('http error 401') || text.includes('http error 403')) {
    return new IngestError('That post is private or age-restricted.', {
      hint: 'Adding cookies for an account that can see it usually fixes this.',
    });
  }

  if (text.includes('video unavailable') || text.includes('http error 404') || text.includes('has been removed')) {
    return new IngestError('That post no longer exists or was removed.');
  }

  if (text.includes('unsupported url')) {
    return new IngestError('No downloader knows how to handle that link.', {
      hint: 'Direct links to a video file always work as a fallback.',
    });
  }

  if (text.includes('file is larger than max-filesize')) {
    return new IngestError('That video is larger than the configured limit.', {
      hint: `Raise MAX_URL_BYTES (currently ${Math.round(config.maxUrlBytes / 1024 / 1024)} MB) to allow it.`,
    });
  }

  if (text.includes('unable to extract') || text.includes('extractor')) {
    return new IngestError('The downloader could not read that page — the site probably changed.', {
      retryable: true,
      hint: 'Try Settings → Ingest → Update yt-dlp; extractor fixes ship within days of a site change.',
    });
  }

  return new IngestError('The download failed.', {
    retryable: true,
    hint: stderr.trim().split('\n').slice(-2).join(' ').slice(0, 300) || undefined,
  });
}

export type FetchedRemote = { path: string; workDir: string; metadata: RemoteMetadata };

/**
 * Download a remote post into a temp directory.
 *
 * Caller owns the returned workDir and must remove it.
 */
export async function fetchRemote(rawUrl: string, opts: { signal?: AbortSignal } = {}): Promise<FetchedRemote> {
  if (!config.enableUrlIngest) {
    throw new IngestError('URL importing is disabled on this server.', { status: 403 });
  }

  const url = normaliseUrl(rawUrl);
  await assertPublicHost(url);

  const site = detectSite(url);
  const workDir = join(config.tmpDir, `fetch-${newId()}`);
  await mkdir(workDir, { recursive: true });

  try {
    const binary = await requireYtDlp();
    const cookies = await cookieFileFor(site.id);

    const args = [
      '--no-playlist',
      '--no-warnings',
      '--no-progress',
      '--no-part',
      '--no-mtime',
      // Restrict filenames to ASCII: the output path is handled programmatically
      // and emoji-laden TikTok titles make for fragile paths.
      '--restrict-filenames',
      '--socket-timeout', '30',
      '--retries', '3',
      '--fragment-retries', '10',
      '--max-filesize', String(config.maxUrlBytes),
      // Prefer an H.264/AAC MP4 so the common case needs no re-encode at all.
      '-f', 'bv*[ext=mp4][vcodec^=avc1]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b',
      '--merge-output-format', 'mp4',
      '-o', join(workDir, '%(id).80s.%(ext)s'),
      // Download AND emit the metadata JSON in a single pass.
      '--dump-single-json',
      '--no-simulate',
    ];

    if (cookies) args.push('--cookies', cookies);
    // Must match probeUrl, or a link that tests fine through the proxy would
    // then fail on the real download.
    if (config.ytDlpProxy) args.push('--proxy', config.ytDlpProxy);

    // Instagram serves different (and more complete) responses to a mobile UA.
    if (site.id === 'instagram') {
      args.push('--extractor-args', 'instagram:api_version=v1');
    }

    args.push(url.toString());

    let stdout: string;
    try {
      const result = await run(binary, args, { timeoutMs: 15 * 60 * 1000, signal: opts.signal });
      stdout = result.stdout;
    } catch (error) {
      if (error instanceof ProcessError) throw interpretYtDlpFailure(site.id, error.stderr || error.message);
      throw error;
    }

    // --dump-single-json emits one JSON object, but progress lines can share
    // stdout; take the last complete object.
    const jsonLine = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('{') && line.endsWith('}'))
      .at(-1);

    if (!jsonLine) throw new IngestError('The downloader returned no metadata.', { retryable: true });

    let info: YtDlpJson;
    try {
      info = JSON.parse(jsonLine) as YtDlpJson;
    } catch {
      throw new IngestError('The downloader returned metadata that could not be parsed.', { retryable: true });
    }

    // Resolve the downloaded file: trust yt-dlp's reported path, then fall
    // back to whatever landed in the work directory.
    let path = info.requested_downloads?.[0]?.filepath ?? info._filename ?? null;
    if (!path || !(await stat(path).catch(() => null))) {
      const entries = await readdir(workDir);
      const candidate = entries.find((name) => !name.endsWith('.json') && !name.endsWith('.part'));
      if (!candidate) throw new IngestError('The download produced no file.', { retryable: true });
      path = join(workDir, candidate);
    }

    const info_ = info;
    const uploadedAt = info_.timestamp
      ? info_.timestamp * 1000
      : info_.upload_date && /^\d{8}$/.test(info_.upload_date)
        ? Date.UTC(
            Number(info_.upload_date.slice(0, 4)),
            Number(info_.upload_date.slice(4, 6)) - 1,
            Number(info_.upload_date.slice(6, 8)),
          )
        : null;

    // Instagram and TikTok put the caption in `description`, and mirror it
    // into `title` when there is no separate title. Avoid storing it twice.
    const rawTitle = info_.title?.trim() || null;
    const rawCaption = info_.description?.trim() || null;
    const titleIsCaption = !!rawTitle && !!rawCaption && rawCaption.startsWith(rawTitle.replace(/\.\.\.$/, ''));

    const metadata: RemoteMetadata = {
      siteId: site.id,
      siteLabel: site.label,
      canonicalUrl: info_.webpage_url ?? url.toString(),
      title: titleIsCaption ? null : rawTitle,
      caption: rawCaption,
      uploader: info_.uploader ?? info_.channel ?? info_.uploader_id ?? null,
      uploaderUrl: info_.uploader_url ?? info_.channel_url ?? null,
      durationMs: info_.duration ? Math.round(info_.duration * 1000) : null,
      width: info_.width ?? null,
      height: info_.height ?? null,
      uploadedAt,
      viewCount: info_.view_count ?? null,
      likeCount: info_.like_count ?? null,
      hashtags: extractHashtags(rawCaption, rawTitle),
    };

    return { path, workDir, metadata };
  } catch (error) {
    await rm(workDir, { recursive: true, force: true });
    throw error;
  }
}

// ── Clip studio: resolve, then cut ───────────────────────────────────────────

export type VideoChapter = { title: string; startMs: number; endMs: number };
/** A "most replayed" sample, 0–1. YouTube exposes this; nothing else does. */
export type HeatPoint = { atMs: number; value: number };

export type ResolvedVideo = {
  siteId: SiteId;
  siteLabel: string;
  videoId: string | null;
  canonicalUrl: string;
  title: string | null;
  description: string | null;
  uploader: string | null;
  uploaderUrl: string | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  thumbnail: string | null;
  isLive: boolean;
  ageLimit: number;
  viewCount: number | null;
  chapters: VideoChapter[];
  heatmap: HeatPoint[];
  hashtags: string[];
};

/**
 * Read a video's metadata without downloading it.
 *
 * The studio needs the real duration before it can draw a timeline, and the
 * embedded player only reports one once it has loaded — which it may never
 * do if the video forbids embedding. Resolving server-side means the timeline
 * works either way.
 */
export async function resolveVideo(rawUrl: string): Promise<ResolvedVideo> {
  const url = normaliseUrl(rawUrl);
  await assertPublicHost(url);

  const site = detectSite(url);
  const binary = await requireYtDlp();
  const cookies = await cookieFileFor(site.id);

  const args = [
    '--no-playlist',
    '--no-warnings',
    '--no-progress',
    '--skip-download',
    '--dump-single-json',
    '--socket-timeout', '20',
    '--retries', '1',
  ];
  if (cookies) args.push('--cookies', cookies);
  if (config.ytDlpProxy) args.push('--proxy', config.ytDlpProxy);
  if (site.id === 'instagram') args.push('--extractor-args', 'instagram:api_version=v1');
  args.push(url.toString());

  let stdout: string;
  try {
    ({ stdout } = await run(binary, args, { timeoutMs: 120_000 }));
  } catch (error) {
    if (error instanceof ProcessError) throw interpretYtDlpFailure(site.id, error.stderr || error.message);
    throw error;
  }

  const jsonLine = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{') && line.endsWith('}'))
    .at(-1);

  if (!jsonLine) throw new IngestError('The downloader returned no metadata for that link.', { retryable: true });

  let info: YtDlpJson & {
    thumbnail?: string;
    thumbnails?: Array<{ url?: string; preference?: number; width?: number }>;
    is_live?: boolean;
    live_status?: string;
    age_limit?: number;
    chapters?: Array<{ title?: string; start_time?: number; end_time?: number }> | null;
    heatmap?: Array<{ start_time?: number; end_time?: number; value?: number }> | null;
  };
  try {
    info = JSON.parse(jsonLine) as typeof info;
  } catch {
    throw new IngestError('The downloader returned metadata that could not be parsed.', { retryable: true });
  }

  if (Array.isArray(info.entries) && info.entries.length > 0) {
    throw new IngestError('That link is a playlist, not a single video.', {
      hint: 'Open the specific video and paste its own link.',
    });
  }

  const live = info.is_live === true || info.live_status === 'is_live';
  if (live) {
    throw new IngestError('That video is still live.', {
      hint: 'Wait until the stream ends — a live video has no fixed timeline to clip from.',
    });
  }

  // Prefer a wide thumbnail; the studio shows it at full player width, and
  // yt-dlp's list runs smallest-first.
  const thumbnail =
    info.thumbnail ??
    [...(info.thumbnails ?? [])]
      .filter((entry) => typeof entry.url === 'string')
      .sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]?.url ??
    null;

  const durationMs = info.duration ? Math.round(info.duration * 1000) : null;

  const chapters: VideoChapter[] = (info.chapters ?? [])
    .filter((chapter) => Number.isFinite(chapter.start_time))
    .map((chapter) => ({
      title: (chapter.title ?? '').trim() || 'Chapter',
      startMs: Math.round((chapter.start_time ?? 0) * 1000),
      endMs: Math.round((chapter.end_time ?? chapter.start_time ?? 0) * 1000),
    }))
    .slice(0, 200);

  // Normalise "most replayed" to 0–1 so the client can draw it without
  // knowing YouTube's arbitrary scale.
  const rawHeat = (info.heatmap ?? []).filter((point) => Number.isFinite(point.value));
  const peak = rawHeat.reduce((max, point) => Math.max(max, point.value ?? 0), 0);
  const heatmap: HeatPoint[] =
    peak > 0
      ? rawHeat
          .map((point) => ({
            atMs: Math.round(((point.start_time ?? 0) + (point.end_time ?? point.start_time ?? 0)) / 2 * 1000),
            value: Math.min(1, Math.max(0, (point.value ?? 0) / peak)),
          }))
          .slice(0, 200)
      : [];

  return {
    siteId: site.id,
    siteLabel: site.label,
    videoId: info.id ?? null,
    canonicalUrl: info.webpage_url ?? url.toString(),
    title: info.title?.trim() || null,
    description: info.description?.trim() || null,
    uploader: info.uploader ?? info.channel ?? info.uploader_id ?? null,
    uploaderUrl: info.uploader_url ?? info.channel_url ?? null,
    durationMs,
    width: info.width ?? null,
    height: info.height ?? null,
    thumbnail,
    isLive: live,
    ageLimit: info.age_limit ?? 0,
    viewCount: info.view_count ?? null,
    chapters,
    heatmap,
    hashtags: extractHashtags(info.description, info.title),
  };
}

/** How far the delivered cut may drift from the request before we re-cut it. */
const CUT_TOLERANCE_MS = 900;

/**
 * Download only a range of a remote video.
 *
 * `--download-sections` makes yt-dlp fetch just the byte ranges covering the
 * requested window, so grabbing 20 seconds out of a three-hour stream costs
 * 20 seconds of bandwidth rather than three hours of it. `--force-keyframes-
 * at-cuts` is what makes the boundaries land where they were asked to; without
 * it the cut snaps to the nearest keyframe.
 *
 * The result is verified rather than trusted: some extractors quietly ignore
 * the section and hand back the whole video, and shipping that into the
 * library as "your 12-second clip" would be a silent, baffling failure. When
 * the duration does not match, this falls back to a full fetch and an exact
 * local trim.
 */
export async function fetchSection(
  rawUrl: string,
  opts: { startMs: number; endMs: number; mute?: boolean; signal?: AbortSignal },
): Promise<FetchedRemote> {
  if (!config.enableUrlIngest) {
    throw new IngestError('URL importing is disabled on this server.', { status: 403 });
  }

  const url = normaliseUrl(rawUrl);
  await assertPublicHost(url);

  const startMs = Math.max(0, Math.round(opts.startMs));
  const endMs = Math.round(opts.endMs);
  const requestedMs = endMs - startMs;

  if (requestedMs < 250) throw new IngestError('That selection is too short to clip.');
  if (requestedMs > config.maxClipSeconds * 1000) {
    throw new IngestError(
      `That selection is ${Math.round(requestedMs / 1000)}s, over the ${config.maxClipSeconds}s limit for one clip.`,
      { hint: 'Raise MAX_CLIP_SECONDS to allow longer cuts.' },
    );
  }

  const site = detectSite(url);
  const workDir = join(config.tmpDir, `clip-${newId()}`);
  await mkdir(workDir, { recursive: true });

  try {
    const binary = await requireYtDlp();
    const cookies = await cookieFileFor(site.id);

    const section = `*${(startMs / 1000).toFixed(3)}-${(endMs / 1000).toFixed(3)}`;
    const height = config.maxClipHeight;

    const args = [
      '--no-playlist',
      '--no-warnings',
      '--no-progress',
      '--no-part',
      '--no-mtime',
      '--restrict-filenames',
      '--socket-timeout', '30',
      '--retries', '3',
      '--fragment-retries', '10',
      '--download-sections', section,
      '--force-keyframes-at-cuts',
      // Deliberately no --max-filesize: it is compared against the *whole*
      // video's size, so a long source would be refused even though only a
      // few seconds of it are being fetched. The produced file is size-checked
      // below instead.
      //
      // `<=?` is a soft cap: it prefers something at or below the limit but
      // still resolves if a video only exists at a higher resolution.
      '-f',
      `bv*[ext=mp4][vcodec^=avc1][height<=?${height}]+ba[ext=m4a]/b[ext=mp4][height<=?${height}]/bv*[height<=?${height}]+ba/b`,
      '--merge-output-format', 'mp4',
      '-o', join(workDir, '%(id).80s.%(ext)s'),
      '--dump-single-json',
      '--no-simulate',
    ];

    if (cookies) args.push('--cookies', cookies);
    if (config.ytDlpProxy) args.push('--proxy', config.ytDlpProxy);
    args.push(url.toString());

    let stdout: string;
    try {
      const result = await run(binary, args, { timeoutMs: 15 * 60 * 1000, signal: opts.signal });
      stdout = result.stdout;
    } catch (error) {
      if (error instanceof ProcessError) throw interpretYtDlpFailure(site.id, error.stderr || error.message);
      throw error;
    }

    const jsonLine = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('{') && line.endsWith('}'))
      .at(-1);

    const info: YtDlpJson = jsonLine ? (JSON.parse(jsonLine) as YtDlpJson) : {};

    let path = info.requested_downloads?.[0]?.filepath ?? info._filename ?? null;
    if (!path || !(await stat(path).catch(() => null))) {
      const entries = await readdir(workDir);
      const candidate = entries.find((name) => !name.endsWith('.json') && !name.endsWith('.part'));
      if (!candidate) throw new IngestError('The download produced no file.', { retryable: true });
      path = join(workDir, candidate);
    }

    // Verify the cut actually happened, and re-cut locally if it did not.
    const probed = await probeMedia(path).catch(() => null);
    const deliveredMs = probed?.durationMs ?? null;
    const drifted = deliveredMs !== null && Math.abs(deliveredMs - requestedMs) > CUT_TOLERANCE_MS;

    if (drifted || opts.mute) {
      // Whatever arrived, cut the exact window out of it. When yt-dlp ignored
      // the section it handed back the whole video, so the offset within that
      // file is the original start; when it honoured it, the file already
      // starts at zero.
      const gotWholeVideo = deliveredMs !== null && deliveredMs > requestedMs + CUT_TOLERANCE_MS;
      const trimmed = join(workDir, 'clip.mp4');

      await trimSegment(path, trimmed, {
        startMs: gotWholeVideo ? startMs : 0,
        endMs: gotWholeVideo ? endMs : Math.min(deliveredMs ?? requestedMs, requestedMs),
        hasAudio: probed?.hasAudio ?? true,
        mute: opts.mute ?? false,
      });

      await rm(path, { force: true });
      path = trimmed;
    }

    const finalInfo = await stat(path);
    if (finalInfo.size === 0) throw new IngestError('The cut produced an empty file.', { retryable: true });
    if (finalInfo.size > config.maxUploadBytes) {
      throw new IngestError(
        `That clip came out at ${(finalInfo.size / 1024 / 1024).toFixed(0)} MB, over the ${(config.maxUploadBytes / 1024 / 1024).toFixed(0)} MB limit.`,
        { hint: 'Pick a shorter range, or lower MAX_CLIP_HEIGHT.' },
      );
    }

    const rawTitle = info.title?.trim() || null;
    const rawCaption = info.description?.trim() || null;

    return {
      path,
      workDir,
      metadata: {
        siteId: site.id,
        siteLabel: site.label,
        canonicalUrl: info.webpage_url ?? url.toString(),
        title: rawTitle,
        caption: rawCaption,
        uploader: info.uploader ?? info.channel ?? info.uploader_id ?? null,
        uploaderUrl: info.uploader_url ?? info.channel_url ?? null,
        // The source video's duration is not this clip's — report the range.
        durationMs: requestedMs,
        width: info.width ?? null,
        height: info.height ?? null,
        uploadedAt: null,
        viewCount: null,
        likeCount: null,
        hashtags: extractHashtags(rawCaption, rawTitle),
      },
    };
  } catch (error) {
    await rm(workDir, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Fetch a plain file URL without yt-dlp.
 *
 * Used when the link already points at a .mp4/.gif — no extractor needed, and
 * it keeps working for direct links even when a site extractor is broken.
 */
export async function fetchDirectFile(rawUrl: string): Promise<FetchedRemote> {
  const url = normaliseUrl(rawUrl);
  await assertPublicHost(url);

  const workDir = join(config.tmpDir, `fetch-${newId()}`);
  await mkdir(workDir, { recursive: true });

  try {
    const response = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': 'Loopa/0.1 (+self-hosted clip catalog)' },
      signal: AbortSignal.timeout(10 * 60 * 1000),
    });

    if (!response.ok) {
      throw new IngestError(`The server returned ${response.status} ${response.statusText}.`, {
        retryable: response.status >= 500 || response.status === 429,
      });
    }

    const declaredLength = Number(response.headers.get('content-length') ?? NaN);
    if (Number.isFinite(declaredLength) && declaredLength > config.maxUrlBytes) {
      throw new IngestError('That file is larger than the configured limit.');
    }
    if (!response.body) throw new IngestError('The server sent an empty response.');

    // Imgur serves .gifv as an HTML page; the real asset is the .mp4 sibling.
    const pathname = url.pathname.replace(/\.gifv$/i, '.mp4');
    const ext = pathname.match(DIRECT_FILE_EXTENSIONS)?.[1]?.toLowerCase() ?? 'bin';
    const filePath = join(workDir, `download.${ext}`);

    // Enforce the size cap during the stream too — content-length can lie or
    // be absent on a chunked response.
    let received = 0;
    const guarded = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
    guarded.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > config.maxUrlBytes) guarded.destroy(new IngestError('That file is larger than the configured limit.'));
    });

    await pipeline(guarded, createWriteStream(filePath));

    const site = detectSite(url);
    return {
      path: filePath,
      workDir,
      metadata: {
        siteId: site.id,
        siteLabel: site.label,
        canonicalUrl: url.toString(),
        title: null,
        caption: null,
        uploader: null,
        uploaderUrl: null,
        durationMs: null,
        width: null,
        height: null,
        uploadedAt: null,
        viewCount: null,
        likeCount: null,
        hashtags: [],
      },
    };
  } catch (error) {
    await rm(workDir, { recursive: true, force: true });
    throw error;
  }
}

/** Pick the cheaper path when the link is already a plain media file. */
export async function fetchAny(rawUrl: string, opts: { signal?: AbortSignal } = {}): Promise<FetchedRemote> {
  const url = normaliseUrl(rawUrl);
  if (detectSite(url).id === 'direct') {
    try {
      return await fetchDirectFile(rawUrl);
    } catch (error) {
      // A "direct" link that turns out to be an HTML page still has a chance
      // through yt-dlp.
      if (error instanceof IngestError && error.status === 403) throw error;
    }
  }
  return fetchRemote(rawUrl, opts);
}
