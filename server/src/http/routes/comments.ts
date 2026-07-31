import type { FastifyInstance } from 'fastify';
import { AuthError } from '../../auth/service.ts';
import {
  MAX_COMMENT_LENGTH,
  addComment,
  deleteComment,
  editComment,
  getComment,
  listComments,
} from '../../clips/comments.ts';
import { getClip } from '../../clips/repository.ts';
import { requireUser } from '../context.ts';

function readBody(value: unknown): string {
  if (typeof value !== 'string') throw new AuthError('A comment body is required.');

  // Collapse runs of blank lines so one person cannot push the rest of the
  // thread off the screen with a wall of newlines.
  const body = value.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

  if (!body) throw new AuthError('Write something first.');
  if (body.length > MAX_COMMENT_LENGTH) {
    throw new AuthError(`Comments are limited to ${MAX_COMMENT_LENGTH} characters.`);
  }
  return body;
}

export async function registerCommentRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/clips/:id/comments', async (request) => {
    const user = requireUser(request);
    const { id } = request.params as { id: string };

    if (!getClip(id)) throw new AuthError('That clip does not exist.', 404);
    return { comments: listComments(id, user) };
  });

  app.post('/api/clips/:id/comments', async (request, reply) => {
    const user = requireUser(request);
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { body?: unknown };

    if (!getClip(id)) throw new AuthError('That clip does not exist.', 404);

    const comment = addComment({ clipId: id, authorId: user.id, body: readBody(body.body) });
    reply.status(201);
    return { comment };
  });

  app.patch('/api/comments/:commentId', async (request) => {
    const user = requireUser(request);
    const { commentId } = request.params as { commentId: string };
    const body = (request.body ?? {}) as { body?: unknown };

    const existing = getComment(commentId);
    if (!existing || existing.deleted_at !== null) throw new AuthError('That comment does not exist.', 404);
    // Editing is the author's alone — an admin can remove a comment but must
    // not be able to put different words in someone else's mouth.
    if (existing.author_id !== user.id) throw new AuthError('You can only edit your own comments.', 403);

    editComment(commentId, readBody(body.body));
    return { comments: listComments(existing.clip_id, user) };
  });

  app.delete('/api/comments/:commentId', async (request) => {
    const user = requireUser(request);
    const { commentId } = request.params as { commentId: string };

    const existing = getComment(commentId);
    if (!existing) throw new AuthError('That comment does not exist.', 404);

    if (existing.author_id !== user.id && user.role !== 'admin') {
      throw new AuthError('Only the author, or an admin, can remove a comment.', 403);
    }

    deleteComment(commentId);
    return { comments: listComments(existing.clip_id, user) };
  });
}
