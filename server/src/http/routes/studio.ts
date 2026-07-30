import type { FastifyInstance } from 'fastify';
import { AuthError } from '../../auth/service.ts';
import { config } from '../../config.ts';
import { enqueue } from '../../jobs/queue.ts';
import {
  IngestError,
  detectSite,
  normaliseUrl,
  resolveVideo,
} from '../../media/urlingest.ts';
import { requireUser } from '../context.ts';

/** m:ss, or h:mm:ss past an hour. Matches the label the job handler writes. */
function timecode(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export async function registerStudioRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Resolve a link into everything the studio needs to draw a timeline.
   *
   * POST rather than GET: this spawns a yt-dlp process, so it should not be
   * something a browser or proxy feels free to prefetch or cache.
   */
  app.post('/api/studio/resolve', async (request) => {
    requireUser(request);

    if (!config.enableUrlIngest) {
      throw new IngestError('URL importing is disabled on this server.', { status: 403 });
    }

    const body = (request.body ?? {}) as { url?: unknown };
    const raw = typeof body.url === 'string' ? body.url.trim() : '';
    if (!raw) throw new AuthError('Paste a link first.');

    const video = await resolveVideo(raw);

    if (video.durationMs === null) {
      throw new IngestError('That video has no duration, so there is nothing to clip.', {
        hint: 'Live streams and image posts cannot be trimmed. Use "Add link" to import the whole thing.',
      });
    }

    return {
      video,
      limits: {
        maxClipSeconds: config.maxClipSeconds,
        maxClipHeight: config.maxClipHeight,
      },
    };
  });

  /**
   * Queue a range for download.
   *
   * Returns immediately with a job id: even a partial fetch takes seconds,
   * and the studio should be ready for the next clip straight away rather
   * than holding a spinner.
   */
  app.post('/api/studio/clip', async (request) => {
    const user = requireUser(request);

    if (!config.enableUrlIngest) {
      throw new IngestError('URL importing is disabled on this server.', { status: 403 });
    }

    const body = (request.body ?? {}) as {
      url?: unknown;
      startMs?: unknown;
      endMs?: unknown;
      title?: unknown;
      categoryId?: unknown;
      mute?: unknown;
    };

    const raw = typeof body.url === 'string' ? body.url.trim() : '';
    if (!raw) throw new AuthError('A url is required.');

    // Validate and normalise here rather than in the worker: a bad range
    // should be a 400 the user sees immediately, not a job that fails
    // silently thirty seconds later.
    const url = normaliseUrl(raw);
    const site = detectSite(url);

    const startMs = Math.round(Number(body.startMs));
    const endMs = Math.round(Number(body.endMs));

    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      throw new AuthError('The selection start and end must be numbers of milliseconds.');
    }
    if (startMs < 0) throw new AuthError('The selection cannot start before the video does.');
    if (endMs <= startMs) throw new AuthError('The selection has to end after it starts.');

    const lengthMs = endMs - startMs;
    if (lengthMs < 250) throw new AuthError('That selection is too short to clip.');
    if (lengthMs > config.maxClipSeconds * 1000) {
      throw new AuthError(
        `That selection is ${Math.round(lengthMs / 1000)}s — the limit is ${config.maxClipSeconds}s per clip.`,
      );
    }

    const title = typeof body.title === 'string' ? body.title.trim().slice(0, 140) : '';
    const categoryIds = typeof body.categoryId === 'string' && body.categoryId ? [body.categoryId] : [];

    const jobId = enqueue({
      type: 'clip_url',
      priority: 20,
      // Same reasoning as a whole-post import: remote sites rate-limit, and
      // the backoff is what gets a run of clips through.
      maxAttempts: 4,
      payload: {
        url: url.toString(),
        startMs,
        endMs,
        title,
        mute: body.mute === true,
        uploaderId: user.id,
        categoryIds,
        // Read back by pendingImports() so the placeholder card in the grid
        // says which cut is downloading.
        label: `${timecode(startMs)} – ${timecode(endMs)}`,
      },
    });

    return {
      jobId,
      site: site.label,
      url: url.toString(),
      startMs,
      endMs,
      lengthMs,
    };
  });
}
