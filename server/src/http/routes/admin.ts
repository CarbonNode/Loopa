import type { FastifyInstance } from 'fastify';
import { taggerStatus } from '../../ai/index.ts';
import {
  AuthError,
  createInvite,
  deleteUser,
  inviteUrl,
  listInvites,
  revokeInvite,
} from '../../auth/service.ts';
import { getClip, hardDeleteClip, libraryStats, pruneOrphanTags } from '../../clips/repository.ts';
import { db } from '../../db/index.ts';
import { cancelImport, jobStats, pendingImports, recentFailures, retryJob } from '../../jobs/queue.ts';
import { removeDerivedDir, removeStoredFiles } from '../../media/storage.ts';
import { rebuildIndex } from '../../search/index.ts';
import { requireAdmin, requireUser } from '../context.ts';
import { requestOrigin } from '../origin.ts';

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  // ── Invites ───────────────────────────────────────────────────────────────

  app.get('/api/invites', async (request) => {
    requireAdmin(request);
    const origin = requestOrigin(request);
    return {
      invites: listInvites().map((invite) => ({ ...invite, url: inviteUrl(invite.code, origin) })),
    };
  });

  app.post('/api/invites', async (request, reply) => {
    const user = requireAdmin(request);
    const body = (request.body ?? {}) as {
      note?: unknown;
      maxUses?: unknown;
      expiresInDays?: unknown;
      role?: unknown;
    };

    const invite = createInvite({
      createdBy: user.id,
      note: typeof body.note === 'string' ? body.note : undefined,
      maxUses: typeof body.maxUses === 'number' ? body.maxUses : undefined,
      expiresInDays: typeof body.expiresInDays === 'number' ? body.expiresInDays : undefined,
      role: body.role === 'admin' ? 'admin' : 'member',
    });

    reply.status(201);
    return { invite: { ...invite, url: inviteUrl(invite.code, requestOrigin(request)) } };
  });

  app.delete('/api/invites/:code', async (request) => {
    requireAdmin(request);
    const { code } = request.params as { code: string };
    revokeInvite(code);
    return { ok: true };
  });

  app.delete('/api/users/:id', async (request) => {
    const admin = requireAdmin(request);
    const { id } = request.params as { id: string };

    if (id === admin.id) throw new AuthError('You cannot remove your own account.', 409);
    deleteUser(id);
    return { ok: true };
  });

  // ── System status ─────────────────────────────────────────────────────────

  /** Visible to everyone: the header shows processing progress from this. */
  app.get('/api/system/status', async (request) => {
    requireUser(request);
    return {
      jobs: jobStats(),
      stats: libraryStats(),
      tagger: taggerStatus(),
      // Carried on the status poll the client already runs, so the grid can
      // show a placeholder per in-flight download without a second request.
      pendingImports: pendingImports(),
    };
  });

  app.get('/api/system/failures', async (request) => {
    requireAdmin(request);
    return {
      failures: recentFailures().map((job) => ({
        id: job.id,
        type: job.type,
        clipId: job.clip_id,
        attempts: job.attempts,
        error: job.last_error,
        updatedAt: job.updated_at,
        // The source URL is what makes a failed import actionable — it lets
        // someone retry the exact link by hand.
        url: safeUrlFromPayload(job.payload),
      })),
    };
  });

  app.post('/api/system/jobs/:id/retry', async (request) => {
    requireAdmin(request);
    const { id } = request.params as { id: string };

    const jobId = Number.parseInt(id, 10);
    if (!Number.isFinite(jobId)) throw new AuthError('Invalid job id.');

    return { ok: retryJob(jobId) };
  });

  /** Drop a queued download the user changed their mind about. */
  app.delete('/api/imports/:jobId', async (request) => {
    requireUser(request);
    const { jobId } = request.params as { jobId: string };

    const id = Number.parseInt(jobId, 10);
    if (!Number.isFinite(id)) throw new AuthError('Invalid job id.');

    return { ok: cancelImport(id) };
  });

  app.post('/api/system/reindex', async (request) => {
    requireAdmin(request);
    return { ok: true, indexed: rebuildIndex() };
  });

  /**
   * Permanently remove soft-deleted clips and their files.
   *
   * Separate from delete on purpose: soft delete is what makes an accidental
   * removal recoverable, so reclaiming the disk has to be a deliberate act.
   */
  app.post('/api/system/purge', async (request) => {
    requireAdmin(request);
    const body = (request.body ?? {}) as { olderThanDays?: unknown };

    const days = typeof body.olderThanDays === 'number' ? Math.max(0, body.olderThanDays) : 0;
    const cutoff = Date.now() - days * 86_400_000;

    const doomed = db
      .prepare('SELECT id, sha256, original_path, playable_path, poster_path, preview_path FROM clips WHERE deleted_at IS NOT NULL AND deleted_at < ?')
      .all(cutoff) as Array<{
      id: string;
      sha256: string;
      original_path: string;
      playable_path: string | null;
      poster_path: string | null;
      preview_path: string | null;
    }>;

    for (const clip of doomed) {
      await removeStoredFiles([clip.original_path, clip.playable_path, clip.poster_path, clip.preview_path]);
      await removeDerivedDir(clip.sha256);
      hardDeleteClip(clip.id);
    }

    const prunedTags = pruneOrphanTags();
    return { ok: true, purged: doomed.length, prunedTags };
  });

  /** Requeue everything that never got tagged — e.g. after adding an API key. */
  app.post('/api/system/retag-missing', async (request) => {
    requireAdmin(request);
    const { enqueue } = await import('../../jobs/queue.ts');

    const pending = db
      .prepare("SELECT id FROM clips WHERE deleted_at IS NULL AND ai_status IN ('pending', 'failed', 'skipped') LIMIT 500")
      .all() as Array<{ id: string }>;

    for (const clip of pending) {
      const row = getClip(clip.id);
      if (!row) continue;
      enqueue({ type: 'tag', clipId: clip.id, priority: 1, payload: { taggingHints: {} } });
    }

    return { ok: true, queued: pending.length };
  });
}

function safeUrlFromPayload(payload: string): string | null {
  try {
    const parsed = JSON.parse(payload) as { url?: unknown };
    return typeof parsed.url === 'string' ? parsed.url : null;
  } catch {
    return null;
  }
}
