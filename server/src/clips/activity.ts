import { db } from '../db/index.ts';

export type PersonRef = {
  id: string;
  username: string;
  displayName: string;
  avatarColor: string;
};

export type PersonEvent = PersonRef & { at: number };

export type ShareActivity = {
  token: string;
  createdBy: PersonRef | null;
  createdAt: number;
  expiresAt: number | null;
  viewCount: number;
  lastViewedAt: number | null;
};

export type ClipActivity = {
  addedBy: PersonRef | null;
  addedAt: number;
  /** In-app plays, one entry per member, most recent first. */
  viewers: PersonEvent[];
  favoritedBy: PersonEvent[];
  shares: ShareActivity[];
  /** Total in-app plays, including repeats — `clips.view_count`. */
  playCount: number;
  /** Hits on public share links, which are anonymous by definition. */
  shareViewCount: number;
};

type PersonRow = {
  id: string;
  username: string;
  display_name: string;
  avatar_color: string;
};

function toPerson(row: PersonRow): PersonRef {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    avatarColor: row.avatar_color,
  };
}

const PERSON_COLUMNS = 'u.id, u.username, u.display_name, u.avatar_color';

/**
 * Everything the app knows about who touched a clip.
 *
 * All of this was already being recorded — `clips.uploader_id`, the `plays`
 * and `favorites` tables, and now `share_links.created_by`. None of it was
 * ever surfaced, so a library shared between friends could not answer "who
 * added this?" or "has anyone actually watched it?".
 *
 * Note what is NOT answerable: views through a public share link are
 * anonymous. Whoever opens one has no account, so they are a count and
 * nothing more — that is a property of the feature, not a gap to fill later.
 */
export function clipActivity(clipId: string): ClipActivity | null {
  const clip = db
    .prepare('SELECT uploader_id, created_at, view_count FROM clips WHERE id = ? AND deleted_at IS NULL')
    .get(clipId) as { uploader_id: string | null; created_at: number; view_count: number } | undefined;

  if (!clip) return null;

  const addedBy = clip.uploader_id
    ? ((db
        .prepare(`SELECT ${PERSON_COLUMNS} FROM users u WHERE u.id = ?`)
        .get(clip.uploader_id) as PersonRow | undefined) ?? null)
    : null;

  const viewers = db
    .prepare(
      `SELECT ${PERSON_COLUMNS}, p.played_at AS at
         FROM plays p JOIN users u ON u.id = p.user_id
        WHERE p.clip_id = ?
        ORDER BY p.played_at DESC`,
    )
    .all(clipId) as Array<PersonRow & { at: number }>;

  const favoritedBy = db
    .prepare(
      `SELECT ${PERSON_COLUMNS}, f.created_at AS at
         FROM favorites f JOIN users u ON u.id = f.user_id
        WHERE f.clip_id = ?
        ORDER BY f.created_at DESC`,
    )
    .all(clipId) as Array<PersonRow & { at: number }>;

  const shares = db
    .prepare(
      `SELECT s.token, s.created_at, s.expires_at, s.view_count, s.last_viewed_at,
              u.id AS u_id, u.username AS u_username,
              u.display_name AS u_display_name, u.avatar_color AS u_avatar_color
         FROM share_links s LEFT JOIN users u ON u.id = s.created_by
        WHERE s.clip_id = ? AND s.revoked_at IS NULL
        ORDER BY s.created_at DESC`,
    )
    .all(clipId) as Array<{
    token: string;
    created_at: number;
    expires_at: number | null;
    view_count: number;
    last_viewed_at: number | null;
    u_id: string | null;
    u_username: string | null;
    u_display_name: string | null;
    u_avatar_color: string | null;
  }>;

  return {
    addedBy: addedBy ? toPerson(addedBy) : null,
    addedAt: clip.created_at,
    viewers: viewers.map((row) => ({ ...toPerson(row), at: row.at })),
    favoritedBy: favoritedBy.map((row) => ({ ...toPerson(row), at: row.at })),
    shares: shares.map((row) => ({
      token: row.token,
      createdBy:
        row.u_id && row.u_username && row.u_display_name
          ? {
              id: row.u_id,
              username: row.u_username,
              displayName: row.u_display_name,
              avatarColor: row.u_avatar_color ?? '#7c8cff',
            }
          : null,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      viewCount: row.view_count,
      lastViewedAt: row.last_viewed_at,
    })),
    playCount: clip.view_count,
    shareViewCount: shares.reduce((sum, row) => sum + row.view_count, 0),
  };
}

/**
 * A library-wide feed of what people have been doing.
 *
 * Assembled from the same three sources rather than a dedicated events table:
 * adding an append-only log would double every write path for something this
 * view can derive, and the ordering it needs is a merge of three small
 * indexed queries.
 */
export type FeedEntry = {
  kind: 'added' | 'viewed' | 'favorited' | 'shared';
  at: number;
  person: PersonRef | null;
  clipId: string;
  clipTitle: string;
  posterPath: string | null;
};

export function activityFeed(limit = 40): FeedEntry[] {
  const capped = Math.min(Math.max(limit, 1), 200);

  const rows = db
    .prepare(
      `SELECT * FROM (
         SELECT 'added' AS kind, c.created_at AS at, c.uploader_id AS user_id,
                c.id AS clip_id, c.title AS clip_title, c.poster_path AS poster_path
           FROM clips c
          WHERE c.deleted_at IS NULL AND c.status = 'ready'

          UNION ALL

         SELECT 'viewed', p.played_at, p.user_id, c.id, c.title, c.poster_path
           FROM plays p JOIN clips c ON c.id = p.clip_id
          WHERE c.deleted_at IS NULL

          UNION ALL

         SELECT 'favorited', f.created_at, f.user_id, c.id, c.title, c.poster_path
           FROM favorites f JOIN clips c ON c.id = f.clip_id
          WHERE c.deleted_at IS NULL

          UNION ALL

         SELECT 'shared', s.created_at, s.created_by, c.id, c.title, c.poster_path
           FROM share_links s JOIN clips c ON c.id = s.clip_id
          WHERE c.deleted_at IS NULL AND s.revoked_at IS NULL
       )
       ORDER BY at DESC
       LIMIT ?`,
    )
    .all(capped) as Array<{
    kind: FeedEntry['kind'];
    at: number;
    user_id: string | null;
    clip_id: string;
    clip_title: string;
    poster_path: string | null;
  }>;

  // One lookup for the whole page rather than a join per branch of the union.
  const ids = [...new Set(rows.map((row) => row.user_id).filter((id): id is string => Boolean(id)))];
  const people = new Map<string, PersonRef>();
  if (ids.length > 0) {
    const found = db
      .prepare(`SELECT ${PERSON_COLUMNS} FROM users u WHERE u.id IN (${ids.map(() => '?').join(', ')})`)
      .all(...ids) as PersonRow[];
    for (const row of found) people.set(row.id, toPerson(row));
  }

  return rows.map((row) => ({
    kind: row.kind,
    at: row.at,
    person: row.user_id ? people.get(row.user_id) ?? null : null,
    clipId: row.clip_id,
    clipTitle: row.clip_title,
    posterPath: row.poster_path,
  }));
}
