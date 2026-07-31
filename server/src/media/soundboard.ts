import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { config } from '../config.ts';

/**
 * Client for the CarbonBoard clip server — the soundboard behind Cortex's
 * Sounds tab and the Discord `play_clip` action.
 *
 * Its API is small and unauthenticated (a LAN utility service): `GET
 * /api/clips` for the library, multipart `POST /api/clips` to add one, and
 * `POST /api/clips/:id/image` for the button art. Everything here is written
 * against that shape rather than a generic uploader, because the failure
 * modes worth handling are all specific to it.
 */

export type Soundbite = {
  id: string;
  name: string;
  category: string | null;
  favorite: boolean;
  duration: number;
  size: number;
  /** Server-relative, e.g. `/clips/<id>.mp3`. */
  file: string;
  image?: string | null;
  addedAt: string;
};

export class SoundboardError extends Error {
  readonly status: number;
  readonly hint: string | null;

  constructor(message: string, options: { status?: number; hint?: string | null } = {}) {
    super(message);
    this.name = 'SoundboardError';
    this.status = options.status ?? 502;
    this.hint = options.hint ?? null;
  }
}

export function soundboardEnabled(): boolean {
  return config.soundboard.enabled;
}

function assertEnabled(): void {
  if (!config.soundboard.enabled) {
    throw new SoundboardError('The CarbonBoard soundboard is not configured on this server.', {
      status: 503,
      hint: 'Set CARBONBOARD_URL to the clip server, e.g. http://192.168.0.35:9601.',
    });
  }
}

/**
 * Turn a transport failure into something actionable.
 *
 * CarbonBoard lives on a different box, so "the clip server is down" and "the
 * clip rejected the upload" are genuinely different problems with different
 * fixes — collapsing both into "upload failed" would send someone debugging
 * ffmpeg when the container is simply stopped.
 */
function asUnreachable(cause: unknown): SoundboardError {
  const reason = cause instanceof Error ? cause.message : String(cause);
  const timedOut = reason.includes('abort') || reason.includes('timed out') || reason.includes('TimeoutError');

  return new SoundboardError(
    timedOut ? 'The CarbonBoard clip server did not answer in time.' : 'Could not reach the CarbonBoard clip server.',
    {
      status: 502,
      hint: `Tried ${config.soundboard.url}. Check that the carbonboard-server container is running on carbonserver.`,
    },
  );
}

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === 'string' && body.error) return body.error;
  } catch {
    // Non-JSON body — the status line is all we have.
  }
  return `CarbonBoard answered ${response.status}.`;
}

/**
 * The existing library, used to offer the categories already in use.
 *
 * Categories on CarbonBoard are free text with no registry of their own, so
 * "what categories exist" is only answerable by reading the clips. Failing
 * this must not block a send — a fresh category typed by hand is valid — so
 * callers treat it as best-effort.
 */
export async function listSoundbites(): Promise<{ clips: Soundbite[]; categories: string[] }> {
  assertEnabled();

  let response: Response;
  try {
    response = await fetch(`${config.soundboard.url}/api/clips`, {
      signal: AbortSignal.timeout(10_000),
    });
  } catch (cause) {
    throw asUnreachable(cause);
  }

  if (!response.ok) throw new SoundboardError(await readError(response), { status: 502 });

  const body = (await response.json()) as { clips?: Soundbite[]; categories?: string[] };
  return { clips: body.clips ?? [], categories: body.categories ?? [] };
}

/**
 * Push an audio file into the library.
 *
 * The file is read into memory rather than streamed: it is a soundbite capped
 * well under CarbonBoard's own 25 MB limit, and a Blob is what `fetch`'s
 * FormData needs to set a filename and content type, which is what the
 * server's extension check reads.
 */
export async function pushSoundbite(input: {
  path: string;
  filename: string;
  name: string;
  category?: string | null;
  durationSeconds?: number;
  source?: string;
}): Promise<Soundbite> {
  assertEnabled();

  const bytes = await readFile(input.path);
  if (bytes.byteLength > config.soundboard.maxUploadBytes) {
    throw new SoundboardError('That soundbite is larger than CarbonBoard accepts.', {
      status: 413,
      hint: 'Trim a shorter range, or lower CARBONBOARD_BITRATE.',
    });
  }

  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'audio/mpeg' }), basename(input.filename));
  form.append('name', input.name);
  if (input.category) form.append('category', input.category);
  if (input.durationSeconds !== undefined) form.append('duration', String(input.durationSeconds));
  form.append('source', input.source ?? 'loopa');

  let response: Response;
  try {
    response = await fetch(`${config.soundboard.url}/api/clips`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
  } catch (cause) {
    throw asUnreachable(cause);
  }

  if (!response.ok) throw new SoundboardError(await readError(response), { status: 502 });

  const body = (await response.json()) as { clip?: Soundbite };
  if (!body.clip) throw new SoundboardError('CarbonBoard accepted the upload but returned no clip.');
  return body.clip;
}

/**
 * Attach button art to a clip that is already stored.
 *
 * Best-effort by design: CarbonBoard's board is visual and a Loopa poster
 * frame makes a far better button than a text label, but a soundbite that
 * landed without its picture is a working soundbite. Losing the audio because
 * the thumbnail failed would be the wrong trade, so this returns null rather
 * than throwing.
 */
export async function pushSoundbiteImage(
  id: string,
  input: { path: string; filename: string; contentType: string },
): Promise<Soundbite | null> {
  if (!config.soundboard.enabled) return null;

  try {
    const bytes = await readFile(input.path);
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: input.contentType }), basename(input.filename));

    const response = await fetch(`${config.soundboard.url}/api/clips/${encodeURIComponent(id)}/image`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) return null;
    const body = (await response.json()) as { clip?: Soundbite };
    return body.clip ?? null;
  } catch (error) {
    console.warn(`[soundboard] could not attach button art to ${id}: ${(error as Error).message}`);
    return null;
  }
}
