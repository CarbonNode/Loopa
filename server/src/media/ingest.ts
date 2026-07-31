import { rm, stat } from 'node:fs/promises';
import {
  addClipToCategory,
  getClipBySha,
  insertClip,
  reindexClipById,
  reviveClip,
  type ClipRow,
} from '../clips/repository.ts';
import { config } from '../config.ts';
import { enqueue } from '../jobs/queue.ts';
import {
  adoptOriginal,
  extensionOf,
  hashFile,
  isSupportedExtension,
  kindFor,
  mimeFor,
} from './storage.ts';
import { IngestError, detectSite, normaliseUrl } from './urlingest.ts';

export type IngestOutcome = {
  clip: ClipRow;
  /** True when the content already existed — nothing new was stored. */
  duplicate: boolean;
};

/**
 * Take a file already on disk and register it as a clip.
 *
 * Hashing first means re-uploading the same clip (or the same Reel pasted
 * twice) resolves to the existing row instead of a duplicate — which matters a
 * lot in a group library where the same thing gets shared repeatedly.
 */
export async function ingestLocalFile(input: {
  tempPath: string;
  filename: string | null;
  uploaderId: string | null;
  sourceUrl?: string | null;
  sourceSite?: string | null;
  title?: string;
  description?: string;
  categoryIds?: readonly string[];
  /** Kept alongside the clip so the tagger can use it later without a refetch. */
  taggingHints?: { caption?: string | null; uploader?: string | null; hashtags?: readonly string[] };
}): Promise<IngestOutcome> {
  // The downloaded file on disk is authoritative. `filename` carries the
  // platform's title for display, and a title almost never contains a dot —
  // deriving the extension from it fails for nearly every URL import.
  const ext = extensionOf(input.tempPath) || extensionOf(input.filename ?? '');

  if (!ext || !isSupportedExtension(ext)) {
    await rm(input.tempPath, { force: true });
    throw new IngestError(
      ext ? `.${ext} files are not supported.` : 'That file has no recognisable extension.',
      { hint: 'Supported: mp4, mov, webm, mkv, avi, gif, jpg, png, webp.' },
    );
  }

  const info = await stat(input.tempPath);
  if (info.size === 0) {
    await rm(input.tempPath, { force: true });
    throw new IngestError('That file is empty.');
  }
  if (info.size > config.maxUploadBytes) {
    await rm(input.tempPath, { force: true });
    throw new IngestError(
      `That file is ${(info.size / 1024 / 1024).toFixed(0)} MB, over the ${(config.maxUploadBytes / 1024 / 1024).toFixed(0)} MB limit.`,
    );
  }

  const sha256 = await hashFile(input.tempPath);

  const existing = getClipBySha(sha256);
  if (existing) {
    await rm(input.tempPath, { force: true });

    if (existing.deleted_at) {
      // Re-adding something previously deleted should restore it, not fail.
      reviveClip(existing.id);
      enqueueProcessing(existing.id, input.taggingHints);
    }

    return { clip: getClipBySha(sha256)!, duplicate: true };
  }

  const originalPath = await adoptOriginal(input.tempPath, sha256, ext);

  const clip = insertClip({
    sha256,
    kind: kindFor(ext),
    ext,
    mime: mimeFor(ext),
    bytes: info.size,
    originalPath,
    originalFilename: input.filename,
    sourceUrl: input.sourceUrl ?? null,
    sourceSite: input.sourceSite ?? null,
    title: input.title ?? '',
    description: input.description ?? '',
    uploaderId: input.uploaderId,
  });

  for (const categoryId of input.categoryIds ?? []) {
    addClipToCategory(clip.id, categoryId, input.uploaderId);
  }

  reindexClipById(clip.id);
  enqueueProcessing(clip.id, input.taggingHints);

  return { clip, duplicate: false };
}

/**
 * Queue the work that turns a stored file into a browsable clip.
 *
 * Derivation runs first at higher priority — a poster is what makes the card
 * usable — and it chains the tagging job itself once probing has established
 * duration and dimensions.
 */
export function enqueueProcessing(
  clipId: string,
  taggingHints?: { caption?: string | null; uploader?: string | null; hashtags?: readonly string[] },
): void {
  enqueue({
    type: 'derive',
    clipId,
    priority: 10,
    payload: { taggingHints: taggingHints ?? {} },
  });
}

/**
 * Register a URL for download.
 *
 * Returns immediately with a job id rather than blocking: an Instagram or
 * TikTok fetch takes seconds to tens of seconds, and the paste box should feel
 * instant.
 */
export function enqueueUrlIngest(input: {
  url: string;
  uploaderId: string | null;
  categoryIds?: readonly string[];
}): { jobId: number; site: string; url: string } {
  if (!config.enableUrlIngest) {
    throw new IngestError('URL importing is disabled on this server.', { status: 403 });
  }

  const url = normaliseUrl(input.url);
  const site = detectSite(url);

  const jobId = enqueue({
    type: 'fetch_url',
    priority: 20,
    // Remote sites rate-limit, and the retry backoff is what gets a batch of
    // pasted links through, so allow more attempts than the default.
    maxAttempts: 4,
    payload: {
      url: url.toString(),
      uploaderId: input.uploaderId,
      categoryIds: input.categoryIds ?? [],
    },
  });

  return { jobId, site: site.label, url: url.toString() };
}
