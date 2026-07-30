import type { FastifyInstance } from 'fastify';
import {
  AuthError,
  changePassword,
  consumeSetupToken,
  createSession,
  createUser,
  destroySession,
  ensureSetupToken,
  isSetupPending,
  listUsers,
  redeemInvite,
  updateProfile,
  verifyCredentials,
} from '../../auth/service.ts';
import { config } from '../../config.ts';
import { ensureStarterCategories } from '../../jobs/handlers.ts';
import { SESSION_COOKIE, cookieOptions, publicUser, requireUser } from '../context.ts';

type Credentials = { username?: unknown; password?: unknown; displayName?: unknown };

function readCredentials(body: unknown): { username: string; password: string; displayName?: string } {
  const input = (body ?? {}) as Credentials;
  const username = typeof input.username === 'string' ? input.username.trim() : '';
  const password = typeof input.password === 'string' ? input.password : '';
  const displayName = typeof input.displayName === 'string' ? input.displayName.trim() : undefined;

  if (!username || !password) throw new AuthError('Username and password are both required.');
  return { username, password, displayName };
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  /** Whether the instance still needs its first account. Unauthenticated by design. */
  app.get('/api/auth/state', async (request) => ({
    setupPending: isSetupPending(),
    user: request.user ? publicUser(request.user) : null,
    publicUrl: config.publicUrl,
  }));

  /**
   * Claim a fresh instance.
   *
   * Gated on a token printed to the server log rather than left open: whoever
   * can read the logs is the person entitled to own the instance.
   */
  app.post('/api/auth/setup', async (request, reply) => {
    if (!isSetupPending()) throw new AuthError('Setup has already been completed.', 409);

    const body = (request.body ?? {}) as { token?: unknown };
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    if (!token) throw new AuthError('The setup token is required.');

    consumeSetupToken(token);

    const credentials = readCredentials(request.body);
    const user = await createUser({ ...credentials, role: 'admin' });
    ensureStarterCategories(user.id);

    const session = createSession(user.id, request.headers['user-agent']);
    reply.setCookie(SESSION_COOKIE, session.token, cookieOptions(config.sessionTtlMs));

    return { user: publicUser(user) };
  });

  app.post('/api/auth/login', async (request, reply) => {
    const credentials = readCredentials(request.body);

    const user = await verifyCredentials(credentials.username, credentials.password);
    if (!user) {
      // One message for a bad username and a bad password alike — separate
      // messages would confirm which usernames exist.
      throw new AuthError('Incorrect username or password.', 401);
    }

    const session = createSession(user.id, request.headers['user-agent']);
    reply.setCookie(SESSION_COOKIE, session.token, cookieOptions(config.sessionTtlMs));

    return { user: publicUser(user) };
  });

  app.post('/api/auth/join', async (request, reply) => {
    const body = (request.body ?? {}) as { code?: unknown };
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    if (!code) throw new AuthError('An invite code is required.');

    const credentials = readCredentials(request.body);
    const user = await redeemInvite({ ...credentials, code });

    const session = createSession(user.id, request.headers['user-agent']);
    reply.setCookie(SESSION_COOKIE, session.token, cookieOptions(config.sessionTtlMs));

    return { user: publicUser(user) };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    destroySession(request.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (request) => ({ user: publicUser(requireUser(request)) }));

  app.patch('/api/auth/me', async (request) => {
    const user = requireUser(request);
    const body = (request.body ?? {}) as { displayName?: unknown; avatarColor?: unknown };

    const updated = updateProfile(user.id, {
      displayName: typeof body.displayName === 'string' ? body.displayName : undefined,
      avatarColor: typeof body.avatarColor === 'string' ? body.avatarColor : undefined,
    });

    return { user: publicUser(updated) };
  });

  app.post('/api/auth/password', async (request, reply) => {
    const user = requireUser(request);
    const body = (request.body ?? {}) as { currentPassword?: unknown; newPassword?: unknown };

    const current = typeof body.currentPassword === 'string' ? body.currentPassword : '';
    const next = typeof body.newPassword === 'string' ? body.newPassword : '';
    if (!current || !next) throw new AuthError('Both the current and new password are required.');

    await changePassword(user.id, current, next);

    // changePassword drops every session for this user, including this one —
    // issue a fresh cookie so the person who just changed it stays signed in.
    const session = createSession(user.id, request.headers['user-agent']);
    reply.setCookie(SESSION_COOKIE, session.token, cookieOptions(config.sessionTtlMs));

    return { ok: true };
  });

  /** The member list — everyone can see who else is in the library. */
  app.get('/api/users', async (request) => {
    requireUser(request);
    return { users: listUsers().map(publicUser) };
  });
}

/** Log the setup URL on boot when the instance has no accounts yet. */
export function announceSetupIfNeeded(): void {
  const token = ensureSetupToken();
  if (!token) return;

  const url = `${config.publicUrl}/setup?token=${encodeURIComponent(token)}`;
  console.log(
    [
      '',
      '  ┌─ Loopa is not set up yet ─────────────────────────────────────',
      '  │  Open this once to create the first (admin) account:',
      `  │  ${url}`,
      '  │',
      '  │  The token is regenerated on every restart until an account exists.',
      '  └───────────────────────────────────────────────────────────────',
      '',
    ].join('\n'),
  );
}
