import { db } from '../db/index.ts';
import { newId } from '../util/ids.ts';

/** How long after posting the author can still edit or delete their own. */
export const EDIT_WINDOW_MS = 15 * 60 * 1000;

export const MAX_COMMENT_LENGTH = 2000;

export type CommentRow = {
  id: string;
  clip_id: string;
  author_id: string | null;
  body: string;
  created_at: number;
  edited_at: number | null;
  deleted_at: number | null;
};

export type CommentView = {
  id: string;
  clipId: string;
  body: string;
  createdAt: number;
  editedAt: number | null;
  /** True once removed. The row stays so the thread keeps its shape. */
  deleted: boolean;
  author: { id: string; username: string; displayName: string; avatarColor: string } | null;
  /** Whether the *requesting* user may still edit or delete this one. */
  canEdit: boolean;
};

type JoinedRow = CommentRow & {
  username: string | null;
  display_name: string | null;
  avatar_color: string | null;
};

const SELECT = `
  SELECT c.*, u.username, u.display_name, u.avatar_color
    FROM comments c
    LEFT JOIN users u ON u.id = c.author_id`;

function toView(row: JoinedRow, viewer: { id: string; role: string } | null): CommentView {
  const deleted = row.deleted_at !== null;
  const isAuthor = viewer !== null && row.author_id === viewer.id;
  const isAdmin = viewer?.role === 'admin';

  return {
    id: row.id,
    clipId: row.clip_id,
    // A tombstone must not leak what was said — the body never leaves the
    // server once the comment is deleted.
    body: deleted ? '' : row.body,
    createdAt: row.created_at,
    editedAt: row.edited_at,
    deleted,
    author:
      row.author_id && row.username
        ? {
            id: row.author_id,
            username: row.username,
            displayName: row.display_name ?? row.username,
            avatarColor: row.avatar_color ?? '#7c8cff',
          }
        : null,
    // Admins can always remove; an author only within the edit window, so a
    // conversation cannot be quietly rewritten days later.
    canEdit:
      !deleted && (isAdmin || (isAuthor && Date.now() - row.created_at < EDIT_WINDOW_MS)),
  };
}

export function listComments(clipId: string, viewer: { id: string; role: string } | null): CommentView[] {
  const rows = db
    .prepare(`${SELECT} WHERE c.clip_id = ? ORDER BY c.created_at ASC, c.id ASC LIMIT 500`)
    .all(clipId) as JoinedRow[];

  return rows.map((row) => toView(row, viewer));
}

export function getComment(id: string): CommentRow | undefined {
  return db.prepare('SELECT * FROM comments WHERE id = ?').get(id) as CommentRow | undefined;
}

export function addComment(input: { clipId: string; authorId: string; body: string }): CommentView {
  const id = newId();
  const now = Date.now();

  db.prepare(
    'INSERT INTO comments (id, clip_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, input.clipId, input.authorId, input.body, now);

  const row = db.prepare(`${SELECT} WHERE c.id = ?`).get(id) as JoinedRow;
  return toView(row, { id: input.authorId, role: 'member' });
}

export function editComment(id: string, body: string): void {
  db.prepare('UPDATE comments SET body = ?, edited_at = ? WHERE id = ? AND deleted_at IS NULL').run(
    body,
    Date.now(),
    id,
  );
}

/**
 * Soft delete.
 *
 * The body is cleared at the same time: keeping it would mean a "deleted"
 * comment still sitting in the database in full, which is not what anyone
 * means by deleting it.
 */
export function deleteComment(id: string): void {
  db.prepare("UPDATE comments SET deleted_at = ?, body = '' WHERE id = ?").run(Date.now(), id);
}

/** Live comment counts for a set of clips, for the badge on each card. */
export function commentCounts(clipIds: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  if (clipIds.length === 0) return counts;

  const placeholders = clipIds.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT clip_id, COUNT(*) AS n
         FROM comments
        WHERE deleted_at IS NULL AND clip_id IN (${placeholders})
        GROUP BY clip_id`,
    )
    .all(...clipIds) as Array<{ clip_id: string; n: number }>;

  for (const row of rows) counts.set(row.clip_id, row.n);
  return counts;
}
