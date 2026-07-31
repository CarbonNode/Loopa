import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { AuthError } from '../../auth/service.ts';
import { getClip } from '../../clips/repository.ts';
import { config } from '../../config.ts';
import { extractAudioMp3 } from '../../media/ffmpeg.ts';
import {
  SoundboardError,
  listSoundbites,
  pushSoundbite,
  pushSoundbiteImage,
} from '../../media/soundboard.ts';
import { absolutePath, extensionOf, fileExists, mimeFor } from '../../media/storage.ts';
import { newId } from '../../util/ids.ts';
import { requireAdmin } from '../context.ts';

/** Everything CarbonBoard rejects in a filename, plus anything that could escape a path. */
function safeFilename(name: string, fallback: string): string {
  const cleaned = name
    .normalize('NFKD')
    .replace(/[^\w \-.]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return cleaned || fallback;
}

export async function registerSoundboardRoutes(app: FastifyInstance): Promise<void> {
  /**
   * What the "Send to CarbonBoard" dialog needs before it can open.
   *
   * The category list is best-effort: CarbonBoard keeps no registry of them,
   * so they are read back off the existing clips, and a clip server that is
   * down should still let the dialog open and say so rather than fail closed
   * on a field that accepts free text anyway.
   */
  app.get('/api/soundboard/status', async (request) => {
    requireAdmin(request);

    if (!config.soundboard.enabled) {
      return { enabled: false, url: null, maxSeconds: config.soundboard.maxSeconds, categories: [], reachable: false, error: null };
    }

    try {
      const { categories, clips } = await listSoundbites();
      return {
        enabled: true,
        url: config.soundboard.url,
        maxSeconds: config.soundboard.maxSeconds,
        categories,
        count: clips.length,
        reachable: true,
        error: null,
      };
    } catch (error) {
      return {
        enabled: true,
        url: config.soundboard.url,
        maxSeconds: config.soundboard.maxSeconds,
        categories: [],
        count: 0,
        reachable: false,
        error: error instanceof SoundboardError ? error.message : 'Could not read the CarbonBoard library.',
      };
    }
  });

  /**
   * Cut a range of a clip's audio and push it to CarbonBoard as a soundbite.
   *
   * Synchronous rather than queued, unlike every other media job here: the
   * source is already on local disk, so this is one short ffmpeg pass and one
   * LAN POST — a couple of seconds. A job id the caller then has to poll would
   * be more machinery for a worse interaction, and the person who pressed the
   * button wants to know it landed.
   */
  app.post('/api/clips/:id/soundboard', async (request) => {
    requireAdmin(request);

    if (!config.soundboard.enabled) {
      throw new SoundboardError('The CarbonBoard soundboard is not configured on this server.', {
        status: 503,
        hint: 'Set CARBONBOARD_URL to the clip server, e.g. http://192.168.0.35:9601.',
      });
    }

    const { id } = request.params as { id: string };
    const clip = getClip(id);
    if (!clip) throw new AuthError('That clip does not exist.', 404);
    if (clip.kind === 'image') throw new AuthError('A still image has no audio to send.');
    if (clip.has_audio !== 1) throw new AuthError('That clip has no audio track.');

    const body = (request.body ?? {}) as {
      startMs?: unknown;
      endMs?: unknown;
      name?: unknown;
      category?: unknown;
      normalise?: unknown;
      includeArt?: unknown;
    };

    const startMs = Math.round(Number(body.startMs));
    const endMs = Math.round(Number(body.endMs));

    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      throw new AuthError('The selection start and end must be numbers of milliseconds.');
    }
    if (startMs < 0) throw new AuthError('The selection cannot start before the clip does.');
    if (endMs <= startMs) throw new AuthError('The selection has to end after it starts.');

    // The duration is what the timeline was drawn from, so a range past it is
    // a stale client rather than a user mistake — clamping silently would ship
    // a shorter soundbite than the one that was selected.
    if (clip.duration_ms && startMs >= clip.duration_ms) {
      throw new AuthError('The selection starts past the end of the clip.');
    }

    const lengthMs = Math.min(endMs, clip.duration_ms ?? endMs) - startMs;
    if (lengthMs < 250) throw new AuthError('That selection is too short to be a soundbite.');
    if (lengthMs > config.soundboard.maxSeconds * 1000) {
      throw new AuthError(
        `That selection is ${Math.round(lengthMs / 1000)}s — the limit is ${config.soundboard.maxSeconds}s per soundbite.`,
      );
    }

    // The playable derivative when there is one: it is the file the person was
    // listening to while they set the range, so its timeline is the one the
    // start and end refer to.
    const sourcePath = absolutePath(clip.playable_path ?? clip.original_path);
    if (!(await fileExists(sourcePath))) {
      throw new AuthError('That clip is still processing — its media is not on disk yet.', 409);
    }

    const name =
      (typeof body.name === 'string' ? body.name.trim() : '').slice(0, 120) ||
      clip.title.trim().slice(0, 120) ||
      'Untitled soundbite';
    const category = typeof body.category === 'string' ? body.category.trim().slice(0, 60) : '';

    const workPath = join(config.tmpDir, `soundbite-${newId()}.mp3`);

    try {
      await extractAudioMp3(sourcePath, workPath, {
        startMs,
        endMs: startMs + lengthMs,
        bitrate: config.soundboard.bitrate,
        normalise: body.normalise !== false,
      });

      const soundbite = await pushSoundbite({
        path: workPath,
        filename: `${safeFilename(name, 'soundbite')}.mp3`,
        name,
        category: category || null,
        durationSeconds: Math.round((lengthMs / 1000) * 100) / 100,
        source: 'loopa',
      });

      // Button art, if the clip has a poster and the caller wants it. Never
      // fatal — see pushSoundbiteImage.
      let withArt = soundbite;
      if (body.includeArt !== false && clip.poster_path) {
        const posterPath = absolutePath(clip.poster_path);
        if (await fileExists(posterPath)) {
          const ext = extensionOf(clip.poster_path) || 'jpg';
          const updated = await pushSoundbiteImage(soundbite.id, {
            path: posterPath,
            filename: `${soundbite.id}.${ext}`,
            contentType: mimeFor(ext),
          });
          if (updated) withArt = updated;
        }
      }

      return {
        soundbite: withArt,
        /** Absolute, so the toast can link straight at the audio. */
        url: `${config.soundboard.url}${withArt.file}`,
      };
    } finally {
      await rm(workPath, { force: true });
    }
  });
}
