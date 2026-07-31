import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AuthError } from '../../auth/service.ts';
import { getClip, type ClipRow } from '../../clips/repository.ts';
import {
  activeShareForClip,
  createShare,
  listSharesForClip,
  recordShareView,
  resolveShare,
  revokeAllSharesForClip,
  revokeShare,
} from '../../clips/shares.ts';
import { config } from '../../config.ts';
import { db } from '../../db/index.ts';
import { absolutePath, assertInsideMediaDir } from '../../media/storage.ts';
import { requireUser, sendError } from '../context.ts';
import { requestOrigin } from '../origin.ts';

/**
 * How long a shared file may sit in a cache.
 *
 * Long enough that a Discord player's range requests aren't all origin hits,
 * short enough that revoking a link actually takes effect within the hour.
 * The content itself is immutable, so this is purely a revocation lever.
 */
const SHARE_CACHE_SECONDS = 3600;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Serve a file from the media directory, with Range support, no auth. */
async function sendMedia(reply: FastifyReply, storedPath: string): Promise<FastifyReply> {
  const absolute = absolutePath(storedPath);
  assertInsideMediaDir(absolute);

  reply.header('Cache-Control', `public, max-age=${SHARE_CACHE_SECONDS}`);
  reply.header('X-Content-Type-Options', 'nosniff');
  // Without this a browser on another origin cannot draw the video into a
  // canvas, and some embedders refuse to load it at all.
  reply.header('Access-Control-Allow-Origin', '*');

  return reply.sendFile(absolute.slice(config.mediaDir.length + 1), config.mediaDir);
}

/** Collapse whitespace and cut on a word boundary. */
function truncate(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * The one-line summary under the title.
 *
 * Capped: a clip imported from YouTube carries that video's entire
 * description — several hundred words of links and contact addresses — which
 * would bury the clip on the page and is truncated by every crawler regardless.
 */
function shareDescription(clip: ClipRow): string {
  if (clip.description?.trim()) return truncate(clip.description, 200);

  const tags = (
    db
      .prepare(
        `SELECT t.name FROM clip_tags ct JOIN tags t ON t.id = ct.tag_id
          WHERE ct.clip_id = ? ORDER BY ct.confidence DESC NULLS LAST LIMIT 6`,
      )
      .all(clip.id) as Array<{ name: string }>
  ).map((row) => row.name);

  return tags.length > 0 ? tags.join(' · ') : 'Shared from Loopa';
}

/**
 * The page a share link points at.
 *
 * Server-rendered rather than handed to the SPA, because the entire job of
 * this page is to be read by a crawler: Discord, Slack and iMessage fetch the
 * URL and parse meta tags out of the HTML without ever running JavaScript. A
 * client-rendered page unfurls as a blank card.
 */
function sharePage(opts: {
  clip: ClipRow;
  origin: string;
  token: string;
  isVideo: boolean;
}): string {
  const { clip, origin, token, isVideo } = opts;

  const pageUrl = `${origin}/s/${token}`;
  const videoUrl = `${pageUrl}/v.mp4`;
  const posterUrl = `${pageUrl}/poster.jpg`;
  const downloadUrl = `${pageUrl}/download`;

  const title = clip.title?.trim() || 'A clip on Loopa';
  const description = shareDescription(clip);
  const width = clip.width ?? 1280;
  const height = clip.height ?? 720;

  const e = escapeHtml;
  const hasPoster = Boolean(clip.poster_path) || clip.kind === 'image';

  // Discord plays og:video inline only for a video og:type, and needs the
  // dimensions to size the player — without them it falls back to a thumbnail.
  const videoTags = isVideo
    ? `
  <meta property="og:type" content="video.other" />
  <meta property="og:video" content="${e(videoUrl)}" />
  <meta property="og:video:secure_url" content="${e(videoUrl)}" />
  <meta property="og:video:type" content="video/mp4" />
  <meta property="og:video:width" content="${width}" />
  <meta property="og:video:height" content="${height}" />
  <meta name="twitter:card" content="player" />
  <meta name="twitter:player:stream" content="${e(videoUrl)}" />
  <meta name="twitter:player:stream:content_type" content="video/mp4" />
  <meta name="twitter:player:width" content="${width}" />
  <meta name="twitter:player:height" content="${height}" />`
    : `
  <meta property="og:type" content="website" />
  <meta name="twitter:card" content="summary_large_image" />`;

  const media = isVideo
    ? `<video
        class="player"
        src="${e(videoUrl)}"
        ${hasPoster ? `poster="${e(posterUrl)}"` : ''}
        controls
        autoplay
        muted
        loop
        playsinline
        preload="metadata"
      ></video>`
    : `<img class="player" src="${e(posterUrl)}" alt="${e(title)}" />`;

  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>${e(title)} · Loopa</title>
  <meta name="description" content="${e(description)}" />
  <meta name="theme-color" content="#0c0d12" />
  <link rel="icon" href="/favicon.svg" type="image/svg+xml" />

  <meta property="og:site_name" content="Loopa" />
  <meta property="og:url" content="${e(pageUrl)}" />
  <meta property="og:title" content="${e(title)}" />
  <meta property="og:description" content="${e(description)}" />${
    hasPoster
      ? `
  <meta property="og:image" content="${e(posterUrl)}" />
  <meta property="og:image:width" content="${width}" />
  <meta property="og:image:height" content="${height}" />
  <meta name="twitter:image" content="${e(posterUrl)}" />`
      : ''
  }
  <meta name="twitter:title" content="${e(title)}" />
  <meta name="twitter:description" content="${e(description)}" />${videoTags}

  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100dvh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 16px;
      padding: 24px 16px;
      background: #0c0d12;
      color: #e8e9f0;
      font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    }
    .frame {
      width: min(100%, 720px);
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .player {
      width: 100%;
      max-height: 78dvh;
      border-radius: 14px;
      background: #14161d;
      display: block;
      object-fit: contain;
      box-shadow: 0 18px 48px rgb(0 0 0 / 0.55);
    }
    h1 {
      margin: 0;
      font-size: 1.0625rem;
      font-weight: 600;
      line-height: 1.35;
      overflow-wrap: anywhere;
    }
    .meta {
      margin: 0;
      color: #9599ad;
      font-size: 0.875rem;
      overflow-wrap: anywhere;
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
    .actions { display: flex; gap: 8px; flex-shrink: 0; }
    a.btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 8px 14px;
      border-radius: 9px;
      border: 1px solid #262a37;
      background: #171a23;
      color: #e8e9f0;
      text-decoration: none;
      font-size: 0.875rem;
      font-weight: 500;
      transition: background 140ms ease, border-color 140ms ease;
    }
    a.btn:hover { background: #1e222d; border-color: #333849; }
    a.btn:focus-visible { outline: 2px solid #7c5cff; outline-offset: 2px; }
    .brand { color: #6f7488; font-size: 0.8125rem; text-decoration: none; }
    .brand:hover { color: #9599ad; }
    @media (max-width: 480px) {
      .row { flex-direction: column; align-items: stretch; }
      .actions { justify-content: stretch; }
      a.btn { flex: 1; justify-content: center; }
    }
  </style>
</head>
<body>
  <div class="frame">
    ${media}
    <div class="row">
      <div>
        <h1>${e(title)}</h1>
        <p class="meta">${e(description)}</p>
      </div>
      <div class="actions">
        <a class="btn" href="${e(downloadUrl)}" download>Download</a>
      </div>
    </div>
    <a class="brand" href="${e(origin)}/">Shared from Loopa</a>
  </div>
</body>
</html>
`;
}

/**
 * What a revoked or expired link renders.
 *
 * These get clicked long after they were posted, by people with no account
 * here — so the dead case needs to be a page that explains itself, not the
 * JSON error body the API hands to the app.
 */
function deadLinkPage(origin: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Link expired · Loopa</title>
  <meta name="robots" content="noindex" />
  <meta name="theme-color" content="#0c0d12" />
  <style>
    :root { color-scheme: dark; }
    body {
      margin: 0; min-height: 100dvh; display: flex; flex-direction: column;
      align-items: center; justify-content: center; gap: 10px; padding: 24px;
      background: #0c0d12; color: #e8e9f0; text-align: center;
      font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    }
    h1 { margin: 0; font-size: 1.125rem; font-weight: 600; }
    p { margin: 0; color: #9599ad; max-width: 34ch; }
    a { color: #9d86ff; text-decoration: none; margin-top: 6px; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <h1>This link is no longer available</h1>
  <p>It was revoked or has expired. Ask whoever sent it for a new one.</p>
  <a href="${escapeHtml(origin)}/">Go to Loopa</a>
</body>
</html>
`;
}

/** A clip whose playable file is a browser-native video. */
function playableVideo(clip: ClipRow): string | null {
  if (clip.kind === 'image') return null;
  return clip.playable_path ?? clip.original_path;
}

export async function registerShareRoutes(app: FastifyInstance): Promise<void> {
  // ── Public: no session required, this is the whole point ──────────────────

  app.get('/s/:token', async (request, reply) => {
    const { token } = request.params as { token: string };
    const resolved = resolveShare(token);
    if (!resolved) {
      reply.status(404).header('Cache-Control', 'no-store').type('text/html; charset=utf-8');
      return deadLinkPage(requestOrigin(request));
    }

    const { clip } = resolved;
    recordShareView(token);

    // Never cached: revoking a link has to stop working promptly, and the
    // crawler should re-read the tags if the title changes.
    reply.header('Cache-Control', 'no-store');
    reply.type('text/html; charset=utf-8');

    return sharePage({
      clip,
      origin: requestOrigin(request),
      token,
      isVideo: playableVideo(clip) !== null,
    });
  });

  /**
   * The raw video.
   *
   * The path ends in `.mp4` deliberately: pasted on its own, Discord and most
   * chat clients embed a native player off the extension alone, without ever
   * parsing an OpenGraph tag.
   */
  app.get('/s/:token/v.mp4', async (request, reply) => {
    const { token } = request.params as { token: string };
    const resolved = resolveShare(token);
    if (!resolved) return sendError(reply, 404, 'That link has expired or been revoked.');

    const path = playableVideo(resolved.clip);
    if (!path) return sendError(reply, 404, 'That clip is not a video.');

    return sendMedia(reply, path);
  });

  app.get('/s/:token/poster.jpg', async (request, reply) => {
    const { token } = request.params as { token: string };
    const resolved = resolveShare(token);
    if (!resolved) return sendError(reply, 404, 'That link has expired or been revoked.');

    const { clip } = resolved;
    const path = clip.poster_path ?? (clip.kind === 'image' ? clip.playable_path ?? clip.original_path : null);
    if (!path) return sendError(reply, 404, 'No preview image for that clip.');

    return sendMedia(reply, path);
  });

  app.get('/s/:token/download', async (request, reply) => {
    const { token } = request.params as { token: string };
    const resolved = resolveShare(token);
    if (!resolved) return sendError(reply, 404, 'That link has expired or been revoked.');

    const { clip } = resolved;
    const stored = clip.playable_path ?? clip.original_path;

    const suggested =
      (clip.title || clip.original_filename || 'clip').replace(/[^\w\s.-]/g, '').trim().slice(0, 80) || 'clip';
    const ext = stored.split('.').pop() ?? clip.ext;

    reply.header('Content-Disposition', `attachment; filename="${suggested}.${ext}"`);
    return sendMedia(reply, stored);
  });

  // ── Authenticated: managing the links ─────────────────────────────────────

  /**
   * Get the clip's share link, creating one only if it has none.
   *
   * Idempotent on purpose — see activeShareForClip().
   */
  app.post('/api/clips/:id/share', async (request, reply) => {
    const user = requireUser(request);
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { expiresInDays?: unknown; fresh?: unknown };

    const clip = getClip(id);
    if (!clip) throw new AuthError('That clip does not exist.', 404);
    if (clip.status !== 'ready') {
      throw new AuthError('That clip is still processing — try again in a moment.', 409);
    }

    const wantsFresh = body.fresh === true;
    const existing = wantsFresh ? null : activeShareForClip(id);
    const share =
      existing ??
      createShare({
        clipId: id,
        createdBy: user.id,
        expiresInDays: typeof body.expiresInDays === 'number' ? body.expiresInDays : null,
      });

    if (!existing) reply.status(201);
    const origin = requestOrigin(request);

    return {
      share: {
        token: share.token,
        url: `${origin}/s/${share.token}`,
        directUrl: `${origin}/s/${share.token}/v.mp4`,
        expiresAt: share.expires_at,
        viewCount: share.view_count,
        lastViewedAt: share.last_viewed_at,
        createdAt: share.created_at,
        reused: Boolean(existing),
      },
    };
  });

  app.get('/api/clips/:id/shares', async (request) => {
    requireUser(request);
    const { id } = request.params as { id: string };
    const origin = requestOrigin(request);

    return {
      shares: listSharesForClip(id).map((share) => ({
        token: share.token,
        url: `${origin}/s/${share.token}`,
        directUrl: `${origin}/s/${share.token}/v.mp4`,
        expiresAt: share.expires_at,
        viewCount: share.view_count,
        lastViewedAt: share.last_viewed_at,
        createdAt: share.created_at,
      })),
    };
  });

  app.delete('/api/shares/:token', async (request) => {
    requireUser(request);
    const { token } = request.params as { token: string };
    return { ok: revokeShare(token) };
  });

  /** Stop sharing a clip entirely, however many links are out there. */
  app.delete('/api/clips/:id/shares', async (request) => {
    requireUser(request);
    const { id } = request.params as { id: string };
    return { ok: true, revoked: revokeAllSharesForClip(id) };
  });
}
