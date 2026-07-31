import { existsSync } from 'node:fs';
import { join, sep } from 'node:path';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyError } from 'fastify';
import { taggerStatus } from './ai/index.ts';
import { AuthError, bootstrapFromEnv } from './auth/service.ts';
import { getClip } from './clips/repository.ts';
import { config } from './config.ts';
import { closeDatabase, runMaintenance, runMigrations } from './db/index.ts';
import { ensureStarterCategories, jobHandlers } from './jobs/handlers.ts';
import { WorkerPool } from './jobs/queue.ts';
import { absolutePath, assertInsideMediaDir } from './media/storage.ts';
import { IngestError, ytDlpBinary } from './media/urlingest.ts';
import { announceSetupIfNeeded, registerAuthRoutes } from './http/routes/auth.ts';
import { registerAdminRoutes } from './http/routes/admin.ts';
import { registerCategoryRoutes } from './http/routes/categories.ts';
import { registerClipRoutes } from './http/routes/clips.ts';
import { registerShareRoutes } from './http/routes/share.ts';
import { registerStudioRoutes } from './http/routes/studio.ts';
import { registerUploadRoutes } from './http/routes/upload.ts';
import { attachUser, requireUser, sendError } from './http/context.ts';
import { commandExists } from './util/proc.ts';

const WEB_DIST = join(import.meta.dirname, '..', '..', 'web', 'dist');

async function main(): Promise<void> {
  runMigrations();
  runMaintenance();

  const app = Fastify({
    logger: {
      level: config.isProduction ? 'info' : 'debug',
      transport: config.isProduction ? undefined : { target: 'pino-pretty', options: { colorize: true } },
    },
    // Behind the Cloudflare tunnel, so honour X-Forwarded-* for client IPs.
    trustProxy: true,
    // Uploads are streamed to disk rather than buffered, so this only needs
    // to cover JSON bodies.
    bodyLimit: 2 * 1024 * 1024,
  });

  await app.register(cookie, { secret: config.sessionSecret });

  await app.register(multipart, {
    limits: {
      fileSize: config.maxUploadBytes,
      files: 40,
      fieldSize: 1024 * 64,
    },
  });

  // Resolve the session once per request so every handler can read
  // `request.user` without repeating the lookup.
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (request) => {
    attachUser(request);
  });

  // ── Error handling ────────────────────────────────────────────────────────
  // One place that turns internal errors into the { error, hint } shape the
  // client renders, so no handler has to remember to.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof AuthError) {
      return sendError(reply, error.status, error.message);
    }
    if (error instanceof IngestError) {
      return sendError(reply, error.status, error.message, error.hint);
    }
    if (error.statusCode === 413 || error.code === 'FST_REQ_FILE_TOO_LARGE') {
      return sendError(
        reply,
        413,
        `That file is over the ${(config.maxUploadBytes / 1024 / 1024).toFixed(0)} MB limit.`,
      );
    }
    if (error.statusCode && error.statusCode < 500) {
      return sendError(reply, error.statusCode, error.message);
    }

    request.log.error({ err: error }, 'unhandled error');
    return sendError(reply, 500, 'Something went wrong on the server.');
  });

  // ── Health ────────────────────────────────────────────────────────────────
  app.get('/api/health', async () => ({ ok: true, version: '0.1.0', tagger: taggerStatus() }));

  // ── Media streaming ───────────────────────────────────────────────────────
  // @fastify/static handles Range requests, which is what makes scrubbing a
  // video work at all — without 206 responses the browser has to download the
  // whole file before it can seek.
  await app.register(fastifyStatic, {
    root: config.mediaDir,
    prefix: '/media/',
    decorateReply: false,
    index: false,
    // Own Cache-Control entirely. With the plugin's own cacheControl left on,
    // its maxAge wins over anything setHeaders writes.
    cacheControl: false,
    setHeaders(res) {
      // Content-addressed paths never change meaning, so cache them hard —
      // the path itself is the cache key.
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.setHeader('X-Content-Type-Options', 'nosniff');
    },
  });

  // The library is private: gate media the same way as the API.
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/media/')) return;
    if (!request.user) {
      return sendError(reply, 401, 'You need to sign in to view this.');
    }
  });

  // ── API ───────────────────────────────────────────────────────────────────
  await registerAuthRoutes(app);
  await registerClipRoutes(app);
  await registerCategoryRoutes(app);
  await registerUploadRoutes(app);
  await registerStudioRoutes(app);
  await registerAdminRoutes(app);
  // Public share links (/s/:token). Registered like any other route, so it
  // takes precedence over the SPA fallback below — which would otherwise hand
  // a crawler index.html and unfurl as an empty card.
  await registerShareRoutes(app);

  /** Download with the original filename, rather than the content hash. */
  app.get('/api/clips/:id/download', async (request, reply) => {
    requireUser(request);
    const { id } = request.params as { id: string };

    const clip = getClip(id);
    if (!clip) return sendError(reply, 404, 'That clip does not exist.');

    const absolute = absolutePath(clip.playable_path ?? clip.original_path);
    assertInsideMediaDir(absolute);

    const suggested = (clip.title || clip.original_filename || 'clip')
      .replace(/[^\w\s.-]/g, '')
      .trim()
      .slice(0, 80) || 'clip';
    const ext = (clip.playable_path ?? clip.original_path).split('.').pop() ?? clip.ext;

    reply.header('Content-Disposition', `attachment; filename="${suggested}.${ext}"`);
    return reply.sendFile(absolute.slice(config.mediaDir.length + 1), config.mediaDir);
  });

  // ── Static front-end ──────────────────────────────────────────────────────
  if (existsSync(WEB_DIST)) {
    await app.register(fastifyStatic, {
      root: WEB_DIST,
      prefix: '/',
      decorateReply: true,
      index: ['index.html'],
      // Own Cache-Control entirely — the plugin's built-in cacheControl would
      // otherwise overwrite whatever setHeaders sets below.
      cacheControl: false,
      setHeaders(res, filePath) {
        // Vite fingerprints everything under /assets, so those are safe to
        // cache forever. index.html must NOT be: it is the file that points
        // at the current hashes, and a cached copy would keep asking for
        // asset filenames that no longer exist after a deploy.
        if (filePath.endsWith('.html')) {
          res.setHeader('Cache-Control', 'no-cache, must-revalidate');
        } else if (filePath.includes(`${sep}assets${sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else {
          // Icons and the manifest: revalidate daily.
          res.setHeader('Cache-Control', 'public, max-age=86400');
        }
      },
    });

    // SPA fallback: any non-API path that isn't a real file renders the app,
    // so deep links like /category/bangers work on a hard refresh.
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/') || request.url.startsWith('/media/')) {
        return sendError(reply, 404, 'Not found.');
      }
      return reply.sendFile('index.html');
    });
  } else {
    app.log.warn(`web/dist not found at ${WEB_DIST} — API only. Run: npm run build:web`);
  }

  // ── Workers ───────────────────────────────────────────────────────────────
  // Separate pools so a backlog of slow transcodes cannot starve tagging, and
  // each can be sized to its own bottleneck: ffmpeg is CPU-bound, tagging and
  // downloading are network-bound.
  const mediaPool = new WorkerPool({
    name: 'media',
    types: ['derive'],
    handlers: jobHandlers,
    concurrency: config.workers.transcodeConcurrency,
  });

  const networkPool = new WorkerPool({
    name: 'network',
    types: ['fetch_url', 'clip_url', 'tag'],
    handlers: jobHandlers,
    concurrency: config.workers.taggingConcurrency,
  });

  mediaPool.start();
  networkPool.start();

  const maintenanceTimer = setInterval(runMaintenance, 15 * 60 * 1000);
  maintenanceTimer.unref();

  // ── Preflight ─────────────────────────────────────────────────────────────
  // Check the external tools at boot rather than at first use: a missing
  // ffmpeg should be an obvious startup warning, not a mystifying failure on
  // someone's first upload.
  const [hasFfmpeg, hasFfprobe, ytDlp] = await Promise.all([
    commandExists('ffmpeg', '-version'),
    commandExists('ffprobe', '-version'),
    // Not commandExists: yt-dlp is frequently outside the PATH a service
    // inherits, so this resolves it the same way the ingest code does.
    ytDlpBinary(),
  ]);

  if (!hasFfmpeg || !hasFfprobe) {
    app.log.error('ffmpeg/ffprobe not found on PATH — clips cannot be processed. Install ffmpeg.');
  }
  if (!ytDlp && config.enableUrlIngest) {
    app.log.warn(
      'yt-dlp not found — importing from links is disabled. Install it (pip install yt-dlp) or set YTDLP_PATH.',
    );
  }
  if (config.sessionSecretGenerated) {
    app.log.warn('SESSION_SECRET is unset; using a generated one from data/.session-secret. Set it explicitly in .env.');
  }

  // Before listening, so the instance is never briefly reachable unclaimed.
  const bootstrapped = await bootstrapFromEnv();
  if (bootstrapped) {
    ensureStarterCategories(null);
    app.log.info(`Created the admin account "${bootstrapped}" from LOOPA_BOOTSTRAP_USER.`);
  }

  await app.listen({ port: config.port, host: config.host });

  const tagger = taggerStatus();
  app.log.info(
    `Loopa ready on ${config.publicUrl} · tagging: ${tagger.enabled ? `${tagger.provider}/${tagger.model}` : 'disabled'}`,
  );
  announceSetupIfNeeded();

  // ── Shutdown ──────────────────────────────────────────────────────────────
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;

    app.log.info(`${signal} received — finishing in-flight work`);
    clearInterval(maintenanceTimer);

    // Stop accepting requests first, then let running jobs finish so a
    // half-written transcode doesn't survive as a corrupt derivative.
    await app.close().catch((error) => app.log.error({ err: error }, 'error closing server'));
    await Promise.all([mediaPool.stop(), networkPool.stop()]);
    closeDatabase();

    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error) => {
  console.error('[loopa] failed to start:', error);
  process.exit(1);
});
