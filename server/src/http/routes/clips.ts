import { stat } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { AuthError } from '../../auth/service.ts';
import { activityFeed, clipActivity } from '../../clips/activity.ts';
import {
  addClipTag,
  addClipToCategory,
  getClip,
  getDeletedClip,
  isFavorited,
  listClips,
  listTags,
  recordView,
  removeClipFromCategory,
  removeClipTag,
  setClipCategories,
  setFavorite,
  softDeleteClip,
  toClipView,
  undeleteClip,
  updateClip,
  type ListOptions,
} from '../../clips/repository.ts';
import { enqueue, jobsForClip } from '../../jobs/queue.ts';
import { absolutePath, assertInsideMediaDir, toPublicMediaUrl } from '../../media/storage.ts';
import { ZIP_MAX_BYTES, createZipStream, uniqueEntryName, type ZipEntry } from '../../media/zip.ts';
import { canDeleteClip, requireUser } from '../context.ts';

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

const SORTS = ['recent', 'oldest', 'popular', 'random', 'relevance', 'title'] as const;
const KINDS = ['video', 'gif', 'image'] as const;

/** A bulk save is "grab these few", not "export the library". */
const MAX_ZIP_CLIPS = 60;

export async function registerClipRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/clips', async (request) => {
    const user = requireUser(request);
    const query = request.query as Record<string, string | undefined>;

    const sortParam = readString(query.sort);
    const kindParam = readString(query.kind);

    const options: ListOptions = {
      query: readString(query.q),
      categoryId: readString(query.category),
      tagId: readString(query.tag),
      uploaderId: readString(query.uploader),
      favoritesOf: query.favorites === 'true' ? user.id : undefined,
      kind: (KINDS as readonly string[]).includes(kindParam ?? '') ? (kindParam as (typeof KINDS)[number]) : undefined,
      sort: (SORTS as readonly string[]).includes(sortParam ?? '') ? (sortParam as (typeof SORTS)[number]) : undefined,
      limit: query.limit ? Number.parseInt(query.limit, 10) : undefined,
      cursor: readString(query.cursor),
      viewerId: user.id,
      includeProcessing: query.includeProcessing === 'true',
    };

    return listClips(options);
  });

  app.get('/api/clips/:id', async (request) => {
    const user = requireUser(request);
    const { id } = request.params as { id: string };

    const clip = getClip(id);
    if (!clip) throw new AuthError('That clip does not exist.', 404);

    return {
      clip: toClipView(clip, { favorited: isFavorited(user.id, id) }),
      jobs: jobsForClip(id).map((job) => ({
        id: job.id,
        type: job.type,
        status: job.status,
        attempts: job.attempts,
        error: job.last_error,
        updatedAt: job.updated_at,
      })),
    };
  });

  app.patch('/api/clips/:id', async (request) => {
    const user = requireUser(request);
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { title?: unknown; description?: unknown; categoryIds?: unknown };

    const clip = getClip(id);
    if (!clip) throw new AuthError('That clip does not exist.', 404);

    updateClip(id, {
      title: typeof body.title === 'string' ? body.title.trim().slice(0, 140) : undefined,
      description: typeof body.description === 'string' ? body.description.trim().slice(0, 2000) : undefined,
    });

    if (Array.isArray(body.categoryIds)) {
      setClipCategories(id, body.categoryIds.filter((v): v is string => typeof v === 'string'), user.id);
    }

    return { clip: toClipView(getClip(id)!, { favorited: isFavorited(user.id, id) }) };
  });

  app.delete('/api/clips/:id', async (request) => {
    const user = requireUser(request);
    const { id } = request.params as { id: string };

    const clip = getClip(id);
    if (!clip) throw new AuthError('That clip does not exist.', 404);
    if (!canDeleteClip(user, clip.uploader_id)) {
      throw new AuthError('Only the person who added this clip, or an admin, can remove it.', 403);
    }

    // Soft delete: the file stays on disk, so an accidental removal is
    // recoverable and re-adding the same clip restores it instead of failing
    // on the content hash.
    softDeleteClip(id);
    return { ok: true };
  });

  /**
   * Undo a removal.
   *
   * Deleting from the grid is one right-click and one menu item away, which
   * is close enough to a misclick that it needs a way back. The row is only
   * soft-deleted, so this is just clearing the flag — but without an endpoint
   * for it the "Undo" on the toast would have nothing to call.
   */
  app.post('/api/clips/:id/restore', async (request) => {
    const user = requireUser(request);
    const { id } = request.params as { id: string };

    // getClip() filters deleted rows out, so the lookup has to be the one
    // that can still see them.
    const clip = getDeletedClip(id);
    if (!clip) throw new AuthError('That clip is not in the bin.', 404);
    if (!canDeleteClip(user, clip.uploader_id)) {
      throw new AuthError('Only the person who added this clip, or an admin, can restore it.', 403);
    }

    undeleteClip(id);
    return { clip: toClipView(getClip(id)!, { favorited: isFavorited(user.id, id) }) };
  });

  /**
   * Save a selection as a single ZIP.
   *
   * A GET so the browser downloads it natively — streamed straight through,
   * rather than assembled into a blob in the page, which for a few hundred
   * megabytes of video would be a lot of memory for no benefit. Ids ride in
   * the query string: 60 ULIDs is well under any URL length limit.
   *
   * Under `bulk/` rather than at `/api/clips/download.zip`, which collides
   * with `/api/clips/:id` — the parametric route wins and the request comes
   * back as "That clip does not exist."
   */
  app.get('/api/clips/bulk/download.zip', async (request, reply) => {
    requireUser(request);
    const query = request.query as { ids?: string };

    const ids = (query.ids ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
      .slice(0, MAX_ZIP_CLIPS);

    if (ids.length === 0) throw new AuthError('Select at least one clip to save.');

    const entries: ZipEntry[] = [];
    const taken = new Set<string>();
    let total = 0;

    for (const id of ids) {
      const clip = getClip(id);
      if (!clip) continue;

      const relative = clip.playable_path ?? clip.original_path;
      const absolute = absolutePath(relative);
      assertInsideMediaDir(absolute);

      const info = await stat(absolute).catch(() => null);
      if (!info?.isFile()) continue;

      total += info.size;
      if (total > ZIP_MAX_BYTES) {
        throw new AuthError(
          'That selection is over the 4 GB a single ZIP can hold. Pick fewer clips.',
          413,
        );
      }

      entries.push({
        name: uniqueEntryName(
          clip.title || clip.original_filename || 'clip',
          relative.split('.').pop() ?? clip.ext,
          taken,
        ),
        path: absolute,
        modifiedAt: new Date(clip.created_at),
      });
    }

    if (entries.length === 0) throw new AuthError('None of those clips have a file to save.', 404);

    const stamp = new Date().toISOString().slice(0, 10);
    const filename = entries.length === 1 ? entries[0]!.name : `loopa-${stamp}-${entries.length}-clips.zip`;

    reply.header('Content-Type', 'application/zip');
    reply.header('Content-Disposition', `attachment; filename="${filename.replace(/"/g, '')}"`);
    // The length is unknown until the last byte is written, so it must not be
    // cached or range-requested.
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');

    return reply.send(createZipStream(entries));
  });

  /** Who added this, who has watched it, who favourited it, who shared it. */
  app.get('/api/clips/:id/activity', async (request) => {
    requireUser(request);
    const { id } = request.params as { id: string };

    const activity = clipActivity(id);
    if (!activity) throw new AuthError('That clip does not exist.', 404);

    return { activity };
  });

  /** A library-wide feed: what everyone has been adding and watching. */
  app.get('/api/activity', async (request) => {
    requireUser(request);
    const query = request.query as Record<string, string | undefined>;
    const limit = query.limit ? Number.parseInt(query.limit, 10) : undefined;

    return {
      entries: activityFeed(Number.isFinite(limit) ? limit : undefined).map((entry) => ({
        ...entry,
        poster: toPublicMediaUrl(entry.posterPath),
        posterPath: undefined,
      })),
    };
  });

  app.post('/api/clips/:id/view', async (request) => {
    const user = requireUser(request);
    const { id } = request.params as { id: string };
    if (!getClip(id)) throw new AuthError('That clip does not exist.', 404);

    recordView(id, user.id);
    return { ok: true };
  });

  app.put('/api/clips/:id/favorite', async (request) => {
    const user = requireUser(request);
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { favorited?: unknown };

    if (!getClip(id)) throw new AuthError('That clip does not exist.', 404);

    const favorited = body.favorited !== false;
    setFavorite(user.id, id, favorited);
    return { favorited };
  });

  // ── Categories on a clip (the drag-and-drop target) ───────────────────────

  app.put('/api/clips/:id/categories/:categoryId', async (request) => {
    const user = requireUser(request);
    const { id, categoryId } = request.params as { id: string; categoryId: string };
    if (!getClip(id)) throw new AuthError('That clip does not exist.', 404);

    addClipToCategory(id, categoryId, user.id);
    return { clip: toClipView(getClip(id)!, { favorited: isFavorited(user.id, id) }) };
  });

  app.delete('/api/clips/:id/categories/:categoryId', async (request) => {
    const user = requireUser(request);
    const { id, categoryId } = request.params as { id: string; categoryId: string };
    if (!getClip(id)) throw new AuthError('That clip does not exist.', 404);

    removeClipFromCategory(id, categoryId);
    return { clip: toClipView(getClip(id)!, { favorited: isFavorited(user.id, id) }) };
  });

  /** Drop a multi-selection onto a category in one request. */
  app.post('/api/clips/bulk/categories', async (request) => {
    const user = requireUser(request);
    const body = (request.body ?? {}) as { clipIds?: unknown; categoryId?: unknown; action?: unknown };

    const clipIds = Array.isArray(body.clipIds) ? body.clipIds.filter((v): v is string => typeof v === 'string') : [];
    const categoryId = readString(body.categoryId);
    if (!categoryId || clipIds.length === 0) throw new AuthError('A category and at least one clip are required.');

    const remove = body.action === 'remove';
    for (const clipId of clipIds) {
      if (!getClip(clipId)) continue;
      if (remove) removeClipFromCategory(clipId, categoryId);
      else addClipToCategory(clipId, categoryId, user.id);
    }

    return { ok: true, count: clipIds.length };
  });

  // ── Tags ──────────────────────────────────────────────────────────────────

  app.get('/api/tags', async (request) => {
    requireUser(request);
    const query = request.query as Record<string, string | undefined>;
    return {
      tags: listTags({
        query: readString(query.q),
        limit: query.limit ? Number.parseInt(query.limit, 10) : undefined,
      }),
    };
  });

  app.post('/api/clips/:id/tags', async (request) => {
    requireUser(request);
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { name?: unknown };

    const name = readString(body.name);
    if (!name) throw new AuthError('A tag name is required.');
    if (!getClip(id)) throw new AuthError('That clip does not exist.', 404);

    const tag = addClipTag(id, name);
    if (!tag) throw new AuthError('That tag name is too short.');

    return { tag };
  });

  app.delete('/api/clips/:id/tags/:tagId', async (request) => {
    requireUser(request);
    const { id, tagId } = request.params as { id: string; tagId: string };
    removeClipTag(id, tagId);
    return { ok: true };
  });

  /** Re-run AI tagging, e.g. after switching to a better model. */
  app.post('/api/clips/:id/retag', async (request) => {
    requireUser(request);
    const { id } = request.params as { id: string };

    const clip = getClip(id);
    if (!clip) throw new AuthError('That clip does not exist.', 404);

    updateClip(id, { ai_status: 'pending' });
    enqueue({
      type: 'tag',
      clipId: id,
      priority: 15,
      payload: { taggingHints: { caption: clip.description, hashtags: [] } },
    });

    return { ok: true };
  });
}
