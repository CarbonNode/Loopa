import { db } from '../db/index.ts';
import { newToken } from '../util/ids.ts';
import type { ClipRow } from './repository.ts';

export type ShareLink = {
  token: string;
  clip_id: string;
  created_by: string | null;
  expires_at: number | null;
  revoked_at: number | null;
  view_count: number;
  last_viewed_at: number | null;
  created_at: number;
};

/**
 * 18 bytes -> a 24-character base64url token.
 *
 * Shorter than a session token on purpose: this one gets pasted into chat and
 * read by humans, and 144 bits of entropy is far past any brute-force worth
 * defending against on a link to one funny video.
 */
const SHARE_TOKEN_BYTES = 18;

export function createShare(input: {
  clipId: string;
  createdBy: string | null;
  expiresInDays?: number | null;
}): ShareLink {
  const token = newToken(SHARE_TOKEN_BYTES);
  const now = Date.now();
  const expiresAt =
    typeof input.expiresInDays === 'number' && input.expiresInDays > 0
      ? now + input.expiresInDays * 86_400_000
      : null;

  db.prepare(
    `INSERT INTO share_links (token, clip_id, created_by, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(token, input.clipId, input.createdBy, expiresAt, now);

  return db.prepare('SELECT * FROM share_links WHERE token = ?').get(token) as ShareLink;
}

/**
 * The newest usable link for a clip, or null.
 *
 * "Copy share link" should hand back the same URL every time rather than
 * minting a new one per click — otherwise re-sharing a clip in a second
 * channel silently orphans links that are already out there, and revoking
 * becomes a game of whack-a-mole.
 */
export function activeShareForClip(clipId: string): ShareLink | null {
  return (
    (db
      .prepare(
        `SELECT * FROM share_links
          WHERE clip_id = ?
            AND revoked_at IS NULL
            AND (expires_at IS NULL OR expires_at > ?)
          ORDER BY created_at DESC
          LIMIT 1`,
      )
      .get(clipId, Date.now()) as ShareLink | undefined) ?? null
  );
}

export function listSharesForClip(clipId: string): ShareLink[] {
  return db
    .prepare('SELECT * FROM share_links WHERE clip_id = ? AND revoked_at IS NULL ORDER BY created_at DESC')
    .all(clipId) as ShareLink[];
}

export function revokeShare(token: string): boolean {
  const result = db
    .prepare('UPDATE share_links SET revoked_at = ? WHERE token = ? AND revoked_at IS NULL')
    .run(Date.now(), token);
  return result.changes > 0;
}

export function revokeAllSharesForClip(clipId: string): number {
  return db
    .prepare('UPDATE share_links SET revoked_at = ? WHERE clip_id = ? AND revoked_at IS NULL')
    .run(Date.now(), clipId).changes;
}

/**
 * Resolve a token to the clip it points at, or null.
 *
 * Every reason a link can be dead — revoked, expired, clip deleted, clip
 * still processing or failed — collapses to the same null here, and the route
 * turns that into one 404. Distinguishing them in the response would let
 * anyone holding a dead link probe for which clips exist.
 */
export function resolveShare(token: string): { share: ShareLink; clip: ClipRow } | null {
  if (!token || token.length > 128) return null;

  const row = db
    .prepare(
      `SELECT s.*, c.id AS c_id
         FROM share_links s
         JOIN clips c ON c.id = s.clip_id
        WHERE s.token = ?
          AND s.revoked_at IS NULL
          AND (s.expires_at IS NULL OR s.expires_at > ?)
          AND c.deleted_at IS NULL
          AND c.status = 'ready'`,
    )
    .get(token, Date.now()) as (ShareLink & { c_id: string }) | undefined;

  if (!row) return null;

  const clip = db.prepare('SELECT * FROM clips WHERE id = ?').get(row.clip_id) as ClipRow | undefined;
  if (!clip) return null;

  return { share: row, clip };
}

/**
 * Count a view.
 *
 * Deliberately not in the request's critical path for the video itself: a
 * player issuing a dozen range requests would otherwise inflate the count
 * twelve-fold and take a write lock on each one.
 */
export function recordShareView(token: string): void {
  db.prepare('UPDATE share_links SET view_count = view_count + 1, last_viewed_at = ? WHERE token = ?').run(
    Date.now(),
    token,
  );
}
