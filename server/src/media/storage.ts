import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { config } from '../config.ts';

export type ClipKind = 'video' | 'gif' | 'image';

const EXTENSION_TO_MIME: Readonly<Record<string, string>> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  wmv: 'video/x-ms-wmv',
  flv: 'video/x-flv',
  mpg: 'video/mpeg',
  mpeg: 'video/mpeg',
  ts: 'video/mp2t',
  gif: 'image/gif',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
};

const VIDEO_EXTENSIONS = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', 'ts']);
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'avif']);

export function isSupportedExtension(ext: string): boolean {
  return VIDEO_EXTENSIONS.has(ext) || IMAGE_EXTENSIONS.has(ext) || ext === 'gif';
}

export function mimeFor(ext: string): string {
  return EXTENSION_TO_MIME[ext] ?? 'application/octet-stream';
}

export function kindFor(ext: string): ClipKind {
  if (ext === 'gif') return 'gif';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  return 'video';
}

/**
 * Extension from a filename or URL path, lowercased and stripped of anything
 * that is not a plain alphanumeric run.
 *
 * This value ends up in a filesystem path, so it must never carry `.`, `/` or
 * a null byte out of an attacker-supplied filename.
 */
export function extensionOf(nameOrPath: string): string {
  const withoutQuery = nameOrPath.split(/[?#]/)[0] ?? '';
  const base = withoutQuery.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot < 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
}

export async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolvePromise());
  });
  return hash.digest('hex');
}

/**
 * Two levels of hex fan-out.
 *
 * A flat directory of tens of thousands of files makes `ls` and directory
 * lookups slow on most filesystems; ab/cd/ keeps any one directory small.
 */
function shardOf(sha256: string): string {
  return join(sha256.slice(0, 2), sha256.slice(2, 4));
}

export function originalRelativePath(sha256: string, ext: string): string {
  return join('originals', shardOf(sha256), `${sha256}.${ext}`);
}

export function derivedRelativePath(sha256: string, filename: string): string {
  return join('derived', shardOf(sha256), sha256, filename);
}

/** Resolve a MEDIA_DIR-relative path to an absolute one. */
export function absolutePath(relativePathValue: string): string {
  return join(config.mediaDir, relativePathValue);
}

/**
 * Reject any path that escapes MEDIA_DIR.
 *
 * Relative paths come out of the database, but the streaming route resolves
 * them against user-supplied clip ids, so this stays as a hard invariant
 * rather than an assumption.
 */
export function assertInsideMediaDir(absolute: string): void {
  const root = resolve(config.mediaDir);
  const target = resolve(absolute);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`Refusing to touch a path outside MEDIA_DIR: ${target}`);
  }
}

export async function ensureDirFor(absoluteFilePath: string): Promise<void> {
  assertInsideMediaDir(absoluteFilePath);
  await mkdir(dirname(absoluteFilePath), { recursive: true });
}

export async function fileExists(absolute: string): Promise<boolean> {
  try {
    const info = await stat(absolute);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

/**
 * Move a temp file into its content-addressed home.
 *
 * A rename across devices fails with EXDEV — the temp dir and the media dir
 * can be different mounts — so fall back to a copy. Returns the
 * MEDIA_DIR-relative path.
 */
export async function adoptOriginal(tempPath: string, sha256: string, ext: string): Promise<string> {
  const relativePathValue = originalRelativePath(sha256, ext);
  const absolute = absolutePath(relativePathValue);

  if (await fileExists(absolute)) {
    // Same content already stored — the temp copy is redundant.
    await rm(tempPath, { force: true });
    return relativePathValue;
  }

  await ensureDirFor(absolute);
  try {
    await rename(tempPath, absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    const { copyFile } = await import('node:fs/promises');
    await copyFile(tempPath, absolute);
    await rm(tempPath, { force: true });
  }

  return relativePathValue;
}

/** Remove every stored artefact for a clip. Best-effort: never throws. */
export async function removeStoredFiles(paths: ReadonlyArray<string | null | undefined>): Promise<void> {
  for (const relativePathValue of paths) {
    if (!relativePathValue) continue;
    try {
      const absolute = absolutePath(relativePathValue);
      assertInsideMediaDir(absolute);
      await rm(absolute, { force: true });
    } catch (error) {
      console.warn(`[storage] could not remove ${relativePathValue}: ${(error as Error).message}`);
    }
  }
}

export async function removeDerivedDir(sha256: string): Promise<void> {
  try {
    const absolute = absolutePath(join('derived', shardOf(sha256), sha256));
    assertInsideMediaDir(absolute);
    await rm(absolute, { recursive: true, force: true });
  } catch (error) {
    console.warn(`[storage] could not remove derived dir for ${sha256}: ${(error as Error).message}`);
  }
}

export function toPublicMediaUrl(relativePathValue: string | null | undefined): string | null {
  if (!relativePathValue) return null;
  const normalised = relative(config.mediaDir, absolutePath(relativePathValue)).split(sep).join('/');
  return `/media/${normalised}`;
}
