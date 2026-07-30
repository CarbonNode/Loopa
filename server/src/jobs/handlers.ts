import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { getTagger } from '../ai/index.ts';
import {
  addClipToCategory,
  createCategory,
  getClip,
  listCategories,
  reindexClipById,
  setClipTags,
  updateClip,
} from '../clips/repository.ts';
import { config } from '../config.ts';
import {
  extractKeyframes,
  makePoster,
  makePreview,
  needsTranscode,
  probe,
  remuxToMp4,
  transcodeToMp4,
  tryTranscribe,
} from '../media/ffmpeg.ts';
import { ingestLocalFile } from '../media/ingest.ts';
import {
  absolutePath,
  derivedRelativePath,
  ensureDirFor,
  fileExists,
} from '../media/storage.ts';
import { IngestError, fetchAny } from '../media/urlingest.ts';
import { newId } from '../util/ids.ts';
import { enqueue, PermanentJobError, type Job } from './queue.ts';

// ── fetch_url ────────────────────────────────────────────────────────────────

/**
 * Download a remote post and hand it to the normal ingest path.
 *
 * The platform metadata yt-dlp returns is carried forward as tagging hints —
 * on a Reel or TikTok the caption usually *is* the joke, and the frames alone
 * would never recover it.
 */
export async function handleFetchUrl(job: Job, payload: Record<string, unknown>): Promise<void> {
  const url = typeof payload.url === 'string' ? payload.url : null;
  if (!url) throw new PermanentJobError('fetch_url job has no url');

  const uploaderId = typeof payload.uploaderId === 'string' ? payload.uploaderId : null;
  const categoryIds = Array.isArray(payload.categoryIds) ? (payload.categoryIds as string[]) : [];

  let fetched: Awaited<ReturnType<typeof fetchAny>>;
  try {
    fetched = await fetchAny(url);
  } catch (error) {
    // A private post or an unsupported link will fail identically on every
    // retry — burn the job rather than the rate limit.
    if (error instanceof IngestError && !error.retryable) {
      throw new PermanentJobError(error.hint ? `${error.message} ${error.hint}` : error.message);
    }
    throw error;
  }

  try {
    const { metadata } = fetched;

    // Prefer the platform's own title; fall back to the caption's first line,
    // which reads far better in the grid than "video_1234.mp4".
    const captionFirstLine = metadata.caption?.split('\n').find((line) => line.trim().length > 0)?.trim();
    const title = (metadata.title ?? captionFirstLine ?? '').slice(0, 140);

    const { clip, duplicate } = await ingestLocalFile({
      tempPath: fetched.path,
      filename: metadata.title ?? `${metadata.siteId}-clip`,
      uploaderId,
      sourceUrl: metadata.canonicalUrl,
      sourceSite: metadata.siteLabel,
      title,
      description: metadata.caption?.slice(0, 600) ?? '',
      categoryIds,
      taggingHints: {
        caption: metadata.caption,
        uploader: metadata.uploader,
        hashtags: metadata.hashtags,
      },
    });

    // Hashtags carry real signal and cost nothing, so seed them immediately
    // rather than waiting for the AI pass.
    if (!duplicate && metadata.hashtags.length > 0) {
      setClipTags(
        clip.id,
        metadata.hashtags.map((name) => ({ name, kind: 'source' as const })),
        'human',
      );
      reindexClipById(clip.id);
    }
  } finally {
    await rm(fetched.workDir, { recursive: true, force: true });
  }
}

// ── derive ───────────────────────────────────────────────────────────────────

/**
 * Probe the file and build everything the UI needs to show it: a playable
 * version, a poster, and a hover-preview loop.
 */
export async function handleDerive(job: Job, payload: Record<string, unknown>): Promise<void> {
  const clipId = job.clip_id;
  if (!clipId) throw new PermanentJobError('derive job has no clip_id');

  const clip = getClip(clipId);
  if (!clip) throw new PermanentJobError(`clip ${clipId} no longer exists`);

  const originalAbsolute = absolutePath(clip.original_path);
  if (!(await fileExists(originalAbsolute))) {
    updateClip(clipId, { status: 'failed', error: 'The stored file is missing from disk.' });
    throw new PermanentJobError(`original file missing for clip ${clipId}`);
  }

  const info = await probe(originalAbsolute);

  updateClip(clipId, {
    width: info.width,
    height: info.height,
    duration_ms: info.durationMs,
    fps: info.fps,
    has_audio: info.hasAudio ? 1 : 0,
  });

  // A still image needs no playable variant or preview loop — the poster is
  // the whole asset.
  if (clip.kind === 'image' || info.isStillImage) {
    const posterRelative = derivedRelativePath(clip.sha256, 'poster.jpg');
    const posterAbsolute = absolutePath(posterRelative);
    await ensureDirFor(posterAbsolute);
    await makePoster(originalAbsolute, posterAbsolute, { durationMs: null });

    updateClip(clipId, {
      poster_path: posterRelative,
      playable_path: clip.original_path,
      preview_path: null,
      status: 'ready',
      error: null,
    });

    enqueueTagging(clipId, payload);
    return;
  }

  // Playable variant. The common case — a TikTok or Reel already in H.264/AAC
  // MP4 — skips this entirely and streams the original.
  let playableRelative = clip.original_path;
  if (needsTranscode(info, clip.ext)) {
    playableRelative = derivedRelativePath(clip.sha256, 'play.mp4');
    const playableAbsolute = absolutePath(playableRelative);
    await ensureDirFor(playableAbsolute);

    if (!(await fileExists(playableAbsolute))) {
      const containerOnly =
        clip.ext !== 'gif' &&
        info.videoCodec === 'h264' &&
        (!info.audioCodec || info.audioCodec === 'aac') &&
        ['yuv420p', 'yuvj420p'].includes(info.pixelFormat ?? 'yuv420p');

      // Only the container is wrong — a remux is seconds instead of minutes
      // and is visually lossless.
      if (containerOnly) {
        await remuxToMp4(originalAbsolute, playableAbsolute);
      } else {
        await transcodeToMp4(originalAbsolute, playableAbsolute, { hasAudio: info.hasAudio });
      }
    }
  }

  const playableAbsolute = absolutePath(playableRelative);

  // Poster and preview are generated from the playable file: GIFs have no
  // usable timeline until they are MP4s.
  const posterRelative = derivedRelativePath(clip.sha256, 'poster.jpg');
  const posterAbsolute = absolutePath(posterRelative);
  await ensureDirFor(posterAbsolute);
  if (!(await fileExists(posterAbsolute))) {
    await makePoster(playableAbsolute, posterAbsolute, { durationMs: info.durationMs });
  }

  let previewRelative: string | null = derivedRelativePath(clip.sha256, 'preview.mp4');
  const previewAbsolute = absolutePath(previewRelative);
  await ensureDirFor(previewAbsolute);
  try {
    if (!(await fileExists(previewAbsolute))) {
      await makePreview(playableAbsolute, previewAbsolute, { durationMs: info.durationMs });
    }
  } catch (error) {
    // The hover loop is a nicety. Losing it should not fail the clip — the
    // poster still gives a usable card.
    console.warn(`[derive] preview failed for ${clipId}: ${(error as Error).message}`);
    previewRelative = null;
  }

  // Transcription is opportunistic: most ffmpeg builds lack the whisper
  // filter, and it returns null rather than throwing when unavailable.
  const transcript = info.hasAudio ? await tryTranscribe(playableAbsolute, { durationMs: info.durationMs }) : null;

  updateClip(clipId, {
    playable_path: playableRelative,
    poster_path: posterRelative,
    preview_path: previewRelative,
    transcript,
    status: 'ready',
    error: null,
  });

  enqueueTagging(clipId, payload);
}

function enqueueTagging(clipId: string, payload: Record<string, unknown>): void {
  const tagger = getTagger();
  if (!tagger) {
    updateClip(clipId, { ai_status: 'skipped' });
    return;
  }

  enqueue({
    type: 'tag',
    clipId,
    priority: 5,
    payload: { taggingHints: payload.taggingHints ?? {} },
  });
}

// ── tag ──────────────────────────────────────────────────────────────────────

export async function handleTag(job: Job, payload: Record<string, unknown>): Promise<void> {
  const clipId = job.clip_id;
  if (!clipId) throw new PermanentJobError('tag job has no clip_id');

  const clip = getClip(clipId);
  if (!clip) throw new PermanentJobError(`clip ${clipId} no longer exists`);

  const tagger = getTagger();
  if (!tagger) {
    updateClip(clipId, { ai_status: 'skipped' });
    return;
  }

  const source = absolutePath(clip.playable_path ?? clip.original_path);
  if (!(await fileExists(source))) throw new PermanentJobError(`media missing for clip ${clipId}`);

  updateClip(clipId, { ai_status: 'running' });

  const hints = (payload.taggingHints ?? {}) as { caption?: string | null; uploader?: string | null; hashtags?: string[] };
  const workDir = join(config.tmpDir, `frames-${newId()}`);

  try {
    const keyframes = await extractKeyframes(source, {
      count: config.tagger.keyframes,
      width: config.tagger.frameWidth,
      durationMs: clip.duration_ms,
      workDir,
    });

    if (keyframes.length === 0) {
      updateClip(clipId, { ai_status: 'failed' });
      throw new PermanentJobError('no frames could be extracted');
    }

    const existingCategories = listCategories().map((category) => category.name);

    const result = await tagger.tag({
      keyframes,
      durationMs: clip.duration_ms,
      hasAudio: clip.has_audio === 1,
      kind: clip.kind,
      filename: clip.original_filename,
      caption: hints.caption ?? (clip.description || null),
      uploader: hints.uploader ?? null,
      siteLabel: clip.source_site,
      hashtags: hints.hashtags ?? [],
      transcript: clip.transcript,
      existingCategories,
    });

    // Never overwrite a title or description a person wrote. The AI fills
    // gaps; it does not get to edit human work.
    const humanTitled = clip.title.trim().length > 0 && clip.ai_tagged_at === null && clip.source_url === null;

    updateClip(clipId, {
      title: humanTitled ? clip.title : result.title,
      description: result.description || clip.description,
      ai_status: 'done',
      ai_model: result.model,
      ai_cost_usd: result.costUsd,
      ai_tagged_at: Date.now(),
      ai_humor: result.humorStyle === 'unclear' ? null : result.humorStyle,
      ai_nsfw: result.isNsfw ? 1 : 0,
    });

    const tags = [...result.tags];
    if (result.onScreenText) {
      // Indexed as text so on-screen captions are searchable, without
      // polluting the tag chips shown on the card.
      tags.push({ name: result.onScreenText.slice(0, 48), kind: 'text' });
    }
    setClipTags(clipId, tags, 'ai');

    // Only ever *add* to categories the model recognised. Creating new ones
    // automatically would fill the sidebar with near-duplicates.
    const byName = new Map(listCategories().map((category) => [category.name.toLowerCase(), category]));
    for (const suggestion of result.suggestedCategories) {
      const match = byName.get(suggestion.trim().toLowerCase());
      if (match) addClipToCategory(clipId, match.id, null);
    }

    reindexClipById(clipId);
  } catch (error) {
    updateClip(clipId, { ai_status: 'failed' });
    throw error;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/**
 * Seed the library with a starter shelf on first run.
 *
 * An empty sidebar with an "add category" button is a worse first impression
 * than a few obvious shelves to drag things into.
 */
export function ensureStarterCategories(createdBy: string | null): void {
  if (listCategories().length > 0) return;

  const starters: ReadonlyArray<{ name: string; emoji: string; color: string; description: string }> = [
    { name: 'Bangers', emoji: '🔥', color: '#f4795b', description: 'The all-timers. The ones you send first.' },
    { name: 'Animals', emoji: '🐕', color: '#3ec9a7', description: 'Pets doing pet things.' },
    { name: 'Fails', emoji: '💥', color: '#e2a33c', description: 'It did not go to plan.' },
    { name: 'Reaction', emoji: '😐', color: '#7c8cff', description: 'Clips you send instead of typing a reply.' },
    { name: 'Cursed', emoji: '🌀', color: '#c77dff', description: 'You will not be able to explain this one.' },
  ];

  for (const starter of starters) createCategory({ ...starter, createdBy });
}

export const jobHandlers = {
  fetch_url: handleFetchUrl,
  derive: handleDerive,
  tag: handleTag,
} as const;
