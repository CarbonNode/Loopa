import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.ts';
import { AuthError, resolveSession, type User } from '../auth/service.ts';

export const SESSION_COOKIE = 'loopa_session';

declare module 'fastify' {
  interface FastifyRequest {
    /** Populated by the auth hook; null for anonymous requests. */
    user: User | null;
  }
}

export function cookieOptions(maxAgeMs: number) {
  return {
    path: '/',
    httpOnly: true,
    // Lax still sends the cookie on a top-level navigation, so invite links
    // and shared clip URLs land signed in.
    sameSite: 'lax' as const,
    secure: config.secureCookies,
    maxAge: Math.floor(maxAgeMs / 1000),
  };
}

export function attachUser(request: FastifyRequest): void {
  const token = request.cookies[SESSION_COOKIE];
  request.user = resolveSession(token);
}

/** Throws a 401 unless the request is authenticated. */
export function requireUser(request: FastifyRequest): User {
  if (!request.user) throw new AuthError('You need to sign in.', 401);
  return request.user;
}

export function requireAdmin(request: FastifyRequest): User {
  const user = requireUser(request);
  if (user.role !== 'admin') throw new AuthError('That action is restricted to admins.', 403);
  return user;
}

/**
 * Can this user modify this clip?
 *
 * Deliberately permissive: this is a shared library among friends, not a
 * multi-tenant service. Anyone can retitle or recategorise anything —
 * curation is collaborative. Deletion is the one thing narrowed to the
 * uploader or an admin.
 */
export function canDeleteClip(user: User, uploaderId: string | null): boolean {
  return user.role === 'admin' || uploaderId === user.id;
}

export function publicUser(user: User) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    role: user.role,
    avatarColor: user.avatar_color,
    createdAt: user.created_at,
  };
}

/** Consistent error shape so the client can render a message rather than a stack. */
export function sendError(reply: FastifyReply, status: number, message: string, hint?: string): FastifyReply {
  return reply.status(status).send({ error: message, hint: hint ?? null });
}
