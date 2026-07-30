import type { FastifyInstance } from 'fastify';
import { AuthError } from '../../auth/service.ts';
import {
  createCategory,
  deleteCategory,
  getCategory,
  libraryStats,
  listCategories,
  reorderCategory,
  updateCategory,
} from '../../clips/repository.ts';
import { requireUser } from '../context.ts';

export async function registerCategoryRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/categories', async (request) => {
    requireUser(request);
    return { categories: listCategories() };
  });

  app.post('/api/categories', async (request, reply) => {
    const user = requireUser(request);
    const body = (request.body ?? {}) as {
      name?: unknown;
      description?: unknown;
      color?: unknown;
      emoji?: unknown;
    };

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) throw new AuthError('A category name is required.');

    try {
      const category = createCategory({
        name,
        description: typeof body.description === 'string' ? body.description : undefined,
        color: typeof body.color === 'string' ? body.color : undefined,
        emoji: typeof body.emoji === 'string' ? body.emoji : undefined,
        createdBy: user.id,
      });
      reply.status(201);
      return { category };
    } catch (error) {
      throw new AuthError((error as Error).message);
    }
  });

  app.patch('/api/categories/:id', async (request) => {
    requireUser(request);
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as {
      name?: unknown;
      description?: unknown;
      color?: unknown;
      emoji?: unknown;
    };

    if (!getCategory(id)) throw new AuthError('That category does not exist.', 404);

    try {
      const category = updateCategory(id, {
        name: typeof body.name === 'string' ? body.name : undefined,
        description: typeof body.description === 'string' ? body.description : undefined,
        color: typeof body.color === 'string' ? body.color : undefined,
        emoji: typeof body.emoji === 'string' ? body.emoji : undefined,
      });
      return { category };
    } catch (error) {
      throw new AuthError((error as Error).message);
    }
  });

  app.delete('/api/categories/:id', async (request) => {
    requireUser(request);
    const { id } = request.params as { id: string };

    if (!getCategory(id)) throw new AuthError('That category does not exist.', 404);

    // Only the shelf goes away — the clips filed under it are untouched.
    deleteCategory(id);
    return { ok: true };
  });

  /** Drag-reorder: the client sends the neighbours the item was dropped between. */
  app.post('/api/categories/:id/reorder', async (request) => {
    requireUser(request);
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { beforeId?: unknown; afterId?: unknown };

    if (!getCategory(id)) throw new AuthError('That category does not exist.', 404);

    reorderCategory(
      id,
      typeof body.beforeId === 'string' ? body.beforeId : null,
      typeof body.afterId === 'string' ? body.afterId : null,
    );

    return { categories: listCategories() };
  });

  app.get('/api/stats', async (request) => {
    requireUser(request);
    return { stats: libraryStats() };
  });
}
