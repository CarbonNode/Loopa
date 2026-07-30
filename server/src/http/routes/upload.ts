import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import { AuthError } from '../../auth/service.ts';
import { isFavorited, toClipView } from '../../clips/repository.ts';
import { config } from '../../config.ts';
import { enqueueUrlIngest, ingestLocalFile } from '../../media/ingest.ts';
import { extensionOf } from '../../media/storage.ts';
import {
  IngestError,
  cookieStatus,
  detectSite,
  normaliseUrl,
  probeUrl,
  supportedCookieSites,
  updateYtDlp,
  writeSessionCookies,
  ytDlpVersion,
} from '../../media/urlingest.ts';
import { newId } from '../../util/ids.ts';
import { requireAdmin, requireUser } from '../context.ts';

export async function registerUploadRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Drag-and-drop upload.
   *
   * Streamed straight to a temp file rather than buffered — a 2 GB upload
   * held in memory would take the process down.
   */
  app.post('/api/upload', async (request, reply) => {
    const user = requireUser(request);

    if (!request.isMultipart()) {
      throw new AuthError('Send the file as multipart/form-data.', 415);
    }

    const uploaded: Array<ReturnType<typeof toClipView>> = [];
    const duplicates: string[] = [];
    const failures: Array<{ filename: string; error: string; hint?: string }> = [];
    const categoryIds: string[] = [];

    await mkdir(config.tmpDir, { recursive: true });

    for await (const part of request.parts()) {
      if (part.type === 'field') {
        // Category assignment travels alongside the files so a drop onto a
        // category shelf files the clip immediately.
        if (part.fieldname === 'categoryId' && typeof part.value === 'string' && part.value.trim()) {
          categoryIds.push(part.value.trim());
        }
        continue;
      }

      const filename = part.filename || 'upload';
      const ext = extensionOf(filename) || 'bin';
      const tempPath = join(config.tmpDir, `upload-${newId()}.${ext}`);

      try {
        await pipeline(part.file, createWriteStream(tempPath));

        // @fastify/multipart flags rather than throws when the limit is hit,
        // so the truncated file has to be caught explicitly.
        if (part.file.truncated) {
          await rm(tempPath, { force: true });
          failures.push({
            filename,
            error: `Larger than the ${(config.maxUploadBytes / 1024 / 1024).toFixed(0)} MB limit.`,
          });
          continue;
        }

        const outcome = await ingestLocalFile({
          tempPath,
          filename,
          uploaderId: user.id,
          categoryIds,
        });

        if (outcome.duplicate) duplicates.push(filename);
        uploaded.push(toClipView(outcome.clip, { favorited: isFavorited(user.id, outcome.clip.id) }));
      } catch (error) {
        await rm(tempPath, { force: true });
        if (error instanceof IngestError) {
          failures.push({ filename, error: error.message, ...(error.hint ? { hint: error.hint } : {}) });
        } else {
          request.log.error({ err: error, filename }, 'upload failed');
          failures.push({ filename, error: 'Something went wrong while storing this file.' });
        }
      }
    }

    if (uploaded.length === 0 && failures.length > 0) reply.status(400);
    return { clips: uploaded, duplicates, failures };
  });

  /**
   * Import from a link.
   *
   * Queued rather than awaited: an Instagram or TikTok fetch takes seconds to
   * tens of seconds, and the paste box should return immediately so someone
   * can paste ten links in a row.
   */
  app.post('/api/import', async (request, reply) => {
    const user = requireUser(request);
    const body = (request.body ?? {}) as { urls?: unknown; url?: unknown; categoryId?: unknown };

    const rawUrls: string[] = [];
    if (typeof body.url === 'string') rawUrls.push(body.url);
    if (Array.isArray(body.urls)) rawUrls.push(...body.urls.filter((v): v is string => typeof v === 'string'));

    // Accept a pasted block of newline- or space-separated links, which is how
    // people actually share a batch.
    const urls = [...new Set(rawUrls.flatMap((entry) => entry.split(/[\s,]+/)).filter(Boolean))].slice(0, 50);
    if (urls.length === 0) throw new AuthError('Paste at least one link.');

    const categoryIds = typeof body.categoryId === 'string' && body.categoryId ? [body.categoryId] : [];

    const queued: Array<{ jobId: number; url: string; site: string }> = [];
    const rejected: Array<{ url: string; error: string; hint?: string }> = [];

    for (const url of urls) {
      try {
        queued.push(enqueueUrlIngest({ url, uploaderId: user.id, categoryIds }));
      } catch (error) {
        if (error instanceof IngestError) {
          rejected.push({ url, error: error.message, ...(error.hint ? { hint: error.hint } : {}) });
        } else {
          rejected.push({ url, error: 'Could not queue that link.' });
        }
      }
    }

    if (queued.length === 0) reply.status(400);
    return { queued, rejected };
  });

  /** Preview what a pasted link will do, before committing to the import. */
  app.get('/api/import/inspect', async (request) => {
    requireUser(request);
    const query = request.query as { url?: string };
    if (!query.url) throw new AuthError('A url query parameter is required.');

    try {
      const url = normaliseUrl(query.url);
      const site = detectSite(url);
      const cookies = await cookieStatus();

      // Instagram in particular rejects most anonymous requests, so warn
      // before the user queues twenty links that will all fail.
      const needsCookies = site.id === 'instagram' && !cookies.instagram && !cookies.default;

      return {
        ok: true,
        url: url.toString(),
        site: site.label,
        siteId: site.id,
        warning: needsCookies
          ? 'Instagram usually refuses downloads without a signed-in session. Add an Instagram cookies.txt in Settings if this fails.'
          : null,
      };
    } catch (error) {
      if (error instanceof IngestError) {
        return { ok: false, error: error.message, hint: error.hint ?? null };
      }
      throw error;
    }
  });

  // ── Ingest configuration (admin) ──────────────────────────────────────────

  app.get('/api/ingest/status', async (request) => {
    requireUser(request);
    return {
      enabled: config.enableUrlIngest,
      ytDlpVersion: await ytDlpVersion(),
      cookies: await cookieStatus(),
      maxUrlBytes: config.maxUrlBytes,
      maxUploadBytes: config.maxUploadBytes,
    };
  });

  /**
   * Update yt-dlp without rebuilding the image.
   *
   * Instagram and TikTok change their internals often enough that a working
   * extractor can break within weeks; this is what keeps Reel import alive
   * between deploys.
   */
  app.post('/api/ingest/update-ytdlp', async (request) => {
    requireAdmin(request);
    const result = await updateYtDlp();
    return { ok: result.ok, version: result.version, output: result.output.slice(-4000) };
  });

  /** Upload a Netscape-format cookies.txt for a site. */
  app.post('/api/ingest/cookies/:site', async (request) => {
    requireAdmin(request);
    const { site } = request.params as { site: string };

    if (!/^[a-z]{2,20}$/.test(site)) throw new AuthError('Invalid site name.');
    if (!request.isMultipart()) throw new AuthError('Send the cookies file as multipart/form-data.', 415);

    const file = await request.file();
    if (!file) throw new AuthError('No file was included.');

    const cookiesDir = join(config.dataDir, 'cookies');
    await mkdir(cookiesDir, { recursive: true });
    const target = join(cookiesDir, `${site}.txt`);

    await pipeline(file.file, createWriteStream(target, { mode: 0o600 }));

    if (file.file.truncated) {
      await rm(target, { force: true });
      throw new AuthError('That cookies file is too large.');
    }

    return { ok: true, site, cookies: await cookieStatus() };
  });

  /**
   * Save a pasted session token instead of an exported cookies.txt.
   *
   * Instagram will not serve most Reels anonymously, and exporting a cookie
   * file means installing a browser extension. Copying one `sessionid` value
   * out of DevTools is a ten-second job, and the file format is synthesised
   * server-side from it.
   */
  app.post('/api/ingest/session/:site', async (request) => {
    requireAdmin(request);
    const { site } = request.params as { site: string };
    const body = (request.body ?? {}) as Record<string, unknown>;

    if (!supportedCookieSites().includes(site)) {
      throw new AuthError(`Session tokens are not supported for "${site}".`);
    }

    const values: Record<string, string> = {};
    for (const [key, value] of Object.entries(body)) {
      if (typeof value === 'string' && value.trim()) {
        // People paste `sessionid=abc; Path=/` straight out of DevTools as
        // often as they paste the bare value. Accept both.
        values[key] = value.trim().replace(/^[^=]+=/, '').replace(/;.*$/, '').trim();
      }
    }

    const { written } = await writeSessionCookies(site, values);
    return { ok: true, site, cookies: await cookieStatus(), written };
  });

  /**
   * Dry-run a link through the real downloader.
   *
   * Answers the only question that matters after configuring cookies — would
   * importing this actually work right now — rather than checking some proxy
   * endpoint that may not reflect the extractor's own auth path.
   */
  app.post('/api/ingest/probe', async (request) => {
    requireUser(request);
    const body = (request.body ?? {}) as { url?: unknown };

    const url = typeof body.url === 'string' ? body.url.trim() : '';
    if (!url) throw new AuthError('A URL to test is required.');

    return probeUrl(url);
  });

  app.delete('/api/ingest/cookies/:site', async (request) => {
    requireAdmin(request);
    const { site } = request.params as { site: string };
    if (!/^[a-z]{2,20}$/.test(site)) throw new AuthError('Invalid site name.');

    await rm(join(config.dataDir, 'cookies', `${site}.txt`), { force: true });
    return { ok: true, cookies: await cookieStatus() };
  });
}
