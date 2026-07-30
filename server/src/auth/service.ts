import { createHash, timingSafeEqual } from 'node:crypto';
import { config } from '../config.ts';
import { db } from '../db/index.ts';
import { newId, newInviteCode, newToken } from '../util/ids.ts';
import { hashPassword, validatePassword, validateUsername, verifyPassword } from './passwords.ts';

export type Role = 'admin' | 'member';

export type User = {
  id: string;
  username: string;
  display_name: string;
  role: Role;
  avatar_color: string;
  created_at: number;
  last_seen_at: number | null;
};

export type Invite = {
  code: string;
  created_by: string | null;
  role: Role;
  note: string | null;
  max_uses: number;
  uses: number;
  expires_at: number | null;
  revoked_at: number | null;
  created_at: number;
};

/** Thrown for conditions the user can fix; surfaced verbatim in the UI. */
export class AuthError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
  }
}

const USER_COLUMNS = 'id, username, display_name, role, avatar_color, created_at, last_seen_at';

// A palette of readable-on-dark accents, assigned round-robin so each member
// gets a distinct avatar colour without anyone picking one.
const AVATAR_COLORS = [
  '#7c8cff',
  '#f4795b',
  '#3ec9a7',
  '#e2a33c',
  '#c77dff',
  '#4cc2f1',
  '#ef6f9c',
  '#8fd14f',
] as const;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// ── Users ────────────────────────────────────────────────────────────────────

export function countUsers(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
}

export function listUsers(): User[] {
  return db.prepare(`SELECT ${USER_COLUMNS} FROM users ORDER BY created_at ASC`).all() as User[];
}

export function getUserById(id: string): User | undefined {
  return db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).get(id) as User | undefined;
}

export function getUserByUsername(username: string): User | undefined {
  return db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE username = ?`).get(username) as User | undefined;
}

export async function createUser(input: {
  username: string;
  password: string;
  displayName?: string;
  role?: Role;
}): Promise<User> {
  const username = input.username.trim();

  const usernameProblem = validateUsername(username);
  if (usernameProblem) throw new AuthError(usernameProblem);

  const passwordProblem = validatePassword(input.password);
  if (passwordProblem) throw new AuthError(passwordProblem);

  if (getUserByUsername(username)) {
    throw new AuthError('That username is taken.', 409);
  }

  const id = newId();
  const now = Date.now();
  const passwordHash = await hashPassword(input.password);
  const color = AVATAR_COLORS[countUsers() % AVATAR_COLORS.length]!;
  const displayName = (input.displayName?.trim() || username).slice(0, 64);

  try {
    db.prepare(
      `INSERT INTO users (id, username, display_name, password_hash, role, avatar_color, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, username, displayName, passwordHash, input.role ?? 'member', color, now);
  } catch (cause) {
    // UNIQUE COLLATE NOCASE can still fire if two signups race past the check
    // above; report it as the conflict it is rather than a 500.
    if (String(cause).includes('UNIQUE')) throw new AuthError('That username is taken.', 409);
    throw cause;
  }

  return getUserById(id)!;
}

export async function verifyCredentials(username: string, password: string): Promise<User | null> {
  const row = db.prepare('SELECT id, password_hash FROM users WHERE username = ?').get(username.trim()) as
    | { id: string; password_hash: string }
    | undefined;

  if (!row) {
    // Hash anyway so a missing account and a wrong password take the same
    // time — otherwise response latency enumerates valid usernames.
    await verifyPassword(password, 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA');
    return null;
  }

  const ok = await verifyPassword(password, row.password_hash);
  return ok ? getUserById(row.id)! : null;
}

export async function changePassword(userId: string, currentPassword: string, nextPassword: string): Promise<void> {
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId) as
    | { password_hash: string }
    | undefined;
  if (!row) throw new AuthError('Account not found.', 404);

  if (!(await verifyPassword(currentPassword, row.password_hash))) {
    throw new AuthError('Current password is incorrect.', 403);
  }

  const problem = validatePassword(nextPassword);
  if (problem) throw new AuthError(problem);

  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(nextPassword), userId);
  // Every other session belonging to this user is now suspect.
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

export function updateProfile(userId: string, patch: { displayName?: string; avatarColor?: string }): User {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (patch.displayName !== undefined) {
    const name = patch.displayName.trim();
    if (name.length < 1 || name.length > 64) throw new AuthError('Display name must be 1–64 characters.');
    fields.push('display_name = ?');
    values.push(name);
  }
  if (patch.avatarColor !== undefined) {
    if (!/^#[0-9a-fA-F]{6}$/.test(patch.avatarColor)) throw new AuthError('Avatar colour must be a #rrggbb hex value.');
    fields.push('avatar_color = ?');
    values.push(patch.avatarColor);
  }

  if (fields.length > 0) {
    values.push(userId);
    db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  const user = getUserById(userId);
  if (!user) throw new AuthError('Account not found.', 404);
  return user;
}

export function deleteUser(userId: string): void {
  const user = getUserById(userId);
  if (!user) throw new AuthError('Account not found.', 404);

  if (user.role === 'admin') {
    const admins = (db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get() as { n: number }).n;
    if (admins <= 1) throw new AuthError('Cannot remove the last admin.', 409);
  }

  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
}

// ── Sessions ─────────────────────────────────────────────────────────────────

/** Returns the raw token to set as a cookie. Only its hash is persisted. */
export function createSession(userId: string, userAgent?: string): { token: string; expiresAt: number } {
  const token = newToken(32);
  const now = Date.now();
  const expiresAt = now + config.sessionTtlMs;

  db.prepare('INSERT INTO sessions (id, user_id, user_agent, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').run(
    hashToken(token),
    userId,
    userAgent?.slice(0, 256) ?? null,
    now,
    expiresAt,
  );

  return { token, expiresAt };
}

export function resolveSession(token: string | undefined): User | null {
  if (!token) return null;

  const row = db
    .prepare('SELECT user_id, expires_at FROM sessions WHERE id = ?')
    .get(hashToken(token)) as { user_id: string; expires_at: number } | undefined;

  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(hashToken(token));
    return null;
  }

  const user = getUserById(row.user_id);
  if (!user) return null;

  // Throttle the write: a `last_seen` update on every request would mean a
  // disk write per page view for no real benefit.
  const now = Date.now();
  if (!user.last_seen_at || now - user.last_seen_at > 60_000) {
    db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(now, user.id);
  }

  return user;
}

export function destroySession(token: string | undefined): void {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE id = ?').run(hashToken(token));
}

// ── Invites ──────────────────────────────────────────────────────────────────

export function createInvite(input: {
  createdBy: string;
  role?: Role;
  note?: string;
  maxUses?: number;
  expiresInDays?: number;
}): Invite {
  const code = newInviteCode();
  const now = Date.now();
  const maxUses = Math.min(Math.max(input.maxUses ?? 1, 1), 100);
  const expiresAt = input.expiresInDays ? now + input.expiresInDays * 86_400_000 : null;

  db.prepare(
    `INSERT INTO invites (code, created_by, role, note, max_uses, uses, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(code, input.createdBy, input.role ?? 'member', input.note?.slice(0, 200) ?? null, maxUses, expiresAt, now);

  return db.prepare('SELECT * FROM invites WHERE code = ?').get(code) as Invite;
}

export function listInvites(): Invite[] {
  return db.prepare('SELECT * FROM invites ORDER BY created_at DESC').all() as Invite[];
}

export function revokeInvite(code: string): void {
  db.prepare('UPDATE invites SET revoked_at = ? WHERE code = ? AND revoked_at IS NULL').run(Date.now(), code);
}

function normaliseInviteCode(code: string): string {
  return code.trim().toUpperCase().replace(/\s+/g, '');
}

function findUsableInvite(code: string): Invite {
  const normalised = normaliseInviteCode(code);
  const invite = db.prepare('SELECT * FROM invites WHERE code = ?').get(normalised) as Invite | undefined;

  // One generic message for every failure mode: a distinct "expired" vs
  // "already used" vs "no such code" would let someone probe for live codes.
  const rejection = new AuthError('That invite code is not valid.', 403);
  if (!invite) throw rejection;
  if (invite.revoked_at) throw rejection;
  if (invite.expires_at && invite.expires_at < Date.now()) throw rejection;
  if (invite.uses >= invite.max_uses) throw rejection;

  return invite;
}

/**
 * Redeem an invite and create the account it grants.
 *
 * The use-count increment is conditional inside a transaction, so two people
 * racing on the last use of a code cannot both get in.
 */
export async function redeemInvite(input: {
  code: string;
  username: string;
  password: string;
  displayName?: string;
}): Promise<User> {
  const invite = findUsableInvite(input.code);

  // Hashing is async and cannot happen inside a better-sqlite3 transaction,
  // so do it first and let the transaction below settle the race.
  const user = await createUser({
    username: input.username,
    password: input.password,
    displayName: input.displayName,
    role: invite.role,
  });

  const claimed = db
    .prepare('UPDATE invites SET uses = uses + 1 WHERE code = ? AND uses < max_uses AND revoked_at IS NULL')
    .run(invite.code);

  if (claimed.changes === 0) {
    // Someone took the last use between our check and our claim. Roll the
    // account back so a spent code never yields an account.
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    throw new AuthError('That invite code was just used up.', 403);
  }

  return user;
}

export function inviteUrl(code: string): string {
  return `${config.publicUrl}/join?code=${encodeURIComponent(code)}`;
}

// ── First-run bootstrap ──────────────────────────────────────────────────────

/**
 * With no accounts yet, hand out a one-off setup token instead of leaving
 * signup wide open. It is printed to the server log — whoever can read the
 * logs is the person entitled to claim the instance.
 */
let setupToken: string | null = null;

export function ensureSetupToken(): string | null {
  if (countUsers() > 0) {
    setupToken = null;
    return null;
  }
  setupToken ??= newToken(24);
  return setupToken;
}

export function consumeSetupToken(candidate: string): void {
  const expected = setupToken;
  if (!expected) throw new AuthError('Setup has already been completed.', 409);

  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new AuthError('Invalid setup token.', 403);
  }
  setupToken = null;
}

export function isSetupPending(): boolean {
  return countUsers() === 0;
}
