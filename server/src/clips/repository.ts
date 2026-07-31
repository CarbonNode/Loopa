import { db } from '../db/index.ts';
import { toPublicMediaUrl } from '../media/storage.ts';
import { reindexClip, removeFromIndex, searchClipIds } from '../search/index.ts';
import { newId, slugify } from '../util/ids.ts';

export type ClipRow = {
  id: string;
  sha256: string;
  kind: 'video' | 'gif' | 'image';
  original_filename: string | null;
  source_url: string | null;
  source_site: string | null;
  ext: string;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  fps: number | null;
  has_audio: number;
  title: string;
  description: string;
  transcript: string | null;
  original_path: string;
  playable_path: string | null;
  poster_path: string | null;
  preview_path: string | null;
  status: 'processing' | 'ready' | 'failed';
  error: string | null;
  ai_status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  ai_model: string | null;
  ai_cost_usd: number | null;
  ai_tagged_at: number | null;
  ai_humor: string | null;
  ai_nsfw: number;
  view_count: number;
  uploader_id: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
};

export type Tag = { id: string; name: string; kind: string };
export type Category = {
  id: string;
  name: string;
  slug: string;
  description: string;
  color: string;
  emoji: string;
  position: number;
  is_smart: number;
  smart_query: string | null;
  created_by: string | null;
  created_at: number;
};

export type ClipView = {
  id: string;
  kind: ClipRow['kind'];
  title: string;
  description: string;
  width: number | null;
  height: number | null;
  aspectRatio: number | null;
  durationMs: number | null;
  hasAudio: boolean;
  bytes: number;
  status: ClipRow['status'];
  error: string | null;
  ai: {
    status: ClipRow['ai_status'];
    model: string | null;
    humor: string | null;
    nsfw: boolean;
    taggedAt: number | null;
  };
  source: { url: string | null; site: string | null; filename: string | null };
  media: { play: string | null; poster: string | null; preview: string | null; download: string };
  tags: Tag[];
  categoryIds: string[];
  viewCount: number;
  favorited: boolean;
  uploaderId: string | null;
  createdAt: number;
  updatedAt: number;
};

// ── Serialisation ────────────────────────────────────────────────────────────

const tagsForClipStmt = db.prepare(
  `SELECT t.id, t.name, t.kind
     FROM clip_tags ct JOIN tags t ON t.id = ct.tag_id
    WHERE ct.clip_id = ?
    ORDER BY ct.confidence DESC NULLS LAST, t.name ASC`,
);

const categoryIdsForClipStmt = db.prepare('SELECT category_id FROM clip_categories WHERE clip_id = ?');

export function toClipView(row: ClipRow, opts: { favorited?: boolean } = {}): ClipView {
  const tags = tagsForClipStmt.all(row.id) as Tag[];
  const categoryIds = (categoryIdsForClipStmt.all(row.id) as Array<{ category_id: string }>).map((r) => r.category_id);

  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    description: row.description,
    width: row.width,
    height: row.height,
    // Precomputed so the grid can reserve the right box before media loads —
    // that's what stops cards from popping and reflowing.
    aspectRatio: row.width && row.height ? Math.round((row.width / row.height) * 1000) / 1000 : null,
    durationMs: row.duration_ms,
    hasAudio: row.has_audio === 1,
    bytes: row.bytes,
    status: row.status,
    error: row.error,
    ai: {
      status: row.ai_status,
      model: row.ai_model,
      humor: row.ai_humor,
      nsfw: row.ai_nsfw === 1,
      taggedAt: row.ai_tagged_at,
    },
    source: { url: row.source_url, site: row.source_site, filename: row.original_filename },
    media: {
      play: toPublicMediaUrl(row.playable_path ?? row.original_path),
      poster: toPublicMediaUrl(row.poster_path),
      preview: toPublicMediaUrl(row.preview_path),
      download: `/api/clips/${row.id}/download`,
    },
    tags,
    categoryIds,
    viewCount: row.view_count,
    favorited: opts.favorited ?? false,
    uploaderId: row.uploader_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── Reads ────────────────────────────────────────────────────────────────────

export function getClip(id: string): ClipRow | undefined {
  return db.prepare('SELECT * FROM clips WHERE id = ? AND deleted_at IS NULL').get(id) as ClipRow | undefined;
}

export function getClipBySha(sha256: string): ClipRow | undefined {
  return db.prepare('SELECT * FROM clips WHERE sha256 = ?').get(sha256) as ClipRow | undefined;
}

export type ListOptions = {
  query?: string;
  categoryId?: string;
  tagId?: string;
  uploaderId?: string;
  favoritesOf?: string;
  kind?: ClipRow['kind'];
  sort?: 'recent' | 'oldest' | 'popular' | 'random' | 'relevance' | 'title';
  limit?: number;
  cursor?: string;
  viewerId?: string;
  includeProcessing?: boolean;
};

export type ListResult = { clips: ClipView[]; nextCursor: string | null; total: number };

/**
 * The one list query behind every browse surface.
 *
 * Cursor pagination rather than OFFSET: with clips arriving continuously,
 * OFFSET both slows down deeper into the list and silently skips or repeats
 * rows when something is inserted mid-scroll.
 */
export function listClips(options: ListOptions = {}): ListResult {
  const limit = Math.min(Math.max(options.limit ?? 60, 1), 200);
  const where: string[] = ['c.deleted_at IS NULL'];
  const params: unknown[] = [];
  const joins: string[] = [];

  if (!options.includeProcessing) {
    where.push("c.status != 'failed'");
  }

  if (options.categoryId) {
    joins.push('JOIN clip_categories cc ON cc.clip_id = c.id');
    where.push('cc.category_id = ?');
    params.push(options.categoryId);
  }

  if (options.tagId) {
    joins.push('JOIN clip_tags ct ON ct.clip_id = c.id');
    where.push('ct.tag_id = ?');
    params.push(options.tagId);
  }

  if (options.favoritesOf) {
    joins.push('JOIN favorites fv ON fv.clip_id = c.id AND fv.user_id = ?');
    params.push(options.favoritesOf);
  }

  if (options.uploaderId) {
    where.push('c.uploader_id = ?');
    params.push(options.uploaderId);
  }

  if (options.kind) {
    where.push('c.kind = ?');
    params.push(options.kind);
  }

  // A text query filters to the FTS hit set and, unless the caller asked for
  // another order, sorts by relevance.
  let relevanceOrder: string | null = null;
  if (options.query?.trim()) {
    const hits = searchClipIds(options.query, { limit: 500 });
    if (hits.length === 0) return { clips: [], nextCursor: null, total: 0 };

    const ids = hits.map((h) => h.clip_id);
    where.push(`c.id IN (${ids.map(() => '?').join(', ')})`);
    params.push(...ids);

    // Rebuild FTS's ranking in SQL — a CASE ladder is verbose but keeps the
    // ordering in one query instead of sorting in JS after pagination.
    relevanceOrder = `CASE c.id ${ids.map((_, i) => `WHEN ? THEN ${i}`).join(' ')} ELSE ${ids.length} END`;
  }

  const sort = options.sort ?? (relevanceOrder ? 'relevance' : 'recent');

  // `id` is ULID-shaped, so it is both unique and creation-ordered — a stable
  // tiebreaker that makes the cursor deterministic.
  let orderBy: string;
  let cursorClause: string | null = null;
  switch (sort) {
    case 'oldest':
      orderBy = 'c.created_at ASC, c.id ASC';
      cursorClause = '(c.created_at, c.id) > (?, ?)';
      break;
    case 'popular':
      orderBy = 'c.view_count DESC, c.id DESC';
      cursorClause = '(c.view_count, c.id) < (?, ?)';
      break;
    case 'title':
      orderBy = 'c.title COLLATE NOCASE ASC, c.id ASC';
      break;
    case 'random':
      orderBy = 'RANDOM()';
      break;
    case 'relevance':
      orderBy = relevanceOrder ? `${relevanceOrder}, c.created_at DESC` : 'c.created_at DESC, c.id DESC';
      break;
    default:
      orderBy = 'c.created_at DESC, c.id DESC';
      cursorClause = '(c.created_at, c.id) < (?, ?)';
      break;
  }

  const orderParams: unknown[] = [];
  if (sort === 'relevance' && relevanceOrder) {
    const hits = searchClipIds(options.query!, { limit: 500 });
    orderParams.push(...hits.map((h) => h.clip_id));
  }

  const cursorParams: unknown[] = [];
  if (options.cursor && cursorClause) {
    const [rawSortKey, cursorId] = options.cursor.split('|');
    const sortKey = Number(rawSortKey);
    if (Number.isFinite(sortKey) && cursorId) {
      where.push(cursorClause);
      cursorParams.push(sortKey, cursorId);
    }
  }

  const joinSql = [...new Set(joins)].join('\n');
  const whereSql = where.join(' AND ');

  const total = (
    db.prepare(`SELECT COUNT(DISTINCT c.id) AS n FROM clips c ${joinSql} WHERE ${whereSql}`).get(
      ...params,
      ...cursorParams,
    ) as { n: number }
  ).n;

  const rows = db
    .prepare(
      `SELECT DISTINCT c.* FROM clips c
       ${joinSql}
       WHERE ${whereSql}
       ORDER BY ${orderBy}
       LIMIT ?`,
    )
    .all(...params, ...cursorParams, ...orderParams, limit + 1) as ClipRow[];

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const favoriteIds = options.viewerId ? favoriteIdsFor(options.viewerId, page.map((r) => r.id)) : new Set<string>();

  let nextCursor: string | null = null;
  if (hasMore && cursorClause) {
    const last = page.at(-1)!;
    const sortKey = sort === 'popular' ? last.view_count : last.created_at;
    nextCursor = `${sortKey}|${last.id}`;
  }

  return {
    clips: page.map((row) => toClipView(row, { favorited: favoriteIds.has(row.id) })),
    nextCursor,
    total,
  };
}

function favoriteIdsFor(userId: string, clipIds: readonly string[]): Set<string> {
  if (clipIds.length === 0) return new Set();
  const rows = db
    .prepare(`SELECT clip_id FROM favorites WHERE user_id = ? AND clip_id IN (${clipIds.map(() => '?').join(', ')})`)
    .all(userId, ...clipIds) as Array<{ clip_id: string }>;
  return new Set(rows.map((r) => r.clip_id));
}

export function isFavorited(userId: string, clipId: string): boolean {
  return db.prepare('SELECT 1 FROM favorites WHERE user_id = ? AND clip_id = ?').get(userId, clipId) !== undefined;
}

// ── Writes ───────────────────────────────────────────────────────────────────

export function insertClip(input: {
  sha256: string;
  kind: ClipRow['kind'];
  ext: string;
  mime: string;
  bytes: number;
  originalPath: string;
  originalFilename?: string | null;
  sourceUrl?: string | null;
  sourceSite?: string | null;
  title?: string;
  description?: string;
  uploaderId: string | null;
}): ClipRow {
  const id = newId();
  const now = Date.now();

  db.prepare(
    `INSERT INTO clips (
       id, sha256, kind, original_filename, source_url, source_site, ext, mime, bytes,
       title, description, original_path, status, ai_status, uploader_id, created_at, updated_at
     ) VALUES (
       @id, @sha256, @kind, @originalFilename, @sourceUrl, @sourceSite, @ext, @mime, @bytes,
       @title, @description, @originalPath, 'processing', 'pending', @uploaderId, @now, @now
     )`,
  ).run({
    id,
    sha256: input.sha256,
    kind: input.kind,
    originalFilename: input.originalFilename ?? null,
    sourceUrl: input.sourceUrl ?? null,
    sourceSite: input.sourceSite ?? null,
    ext: input.ext,
    mime: input.mime,
    bytes: input.bytes,
    title: input.title ?? '',
    description: input.description ?? '',
    originalPath: input.originalPath,
    uploaderId: input.uploaderId,
    now,
  });

  return getClip(id)!;
}

type ClipPatch = Partial<{
  title: string;
  description: string;
  transcript: string | null;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  fps: number | null;
  has_audio: number;
  playable_path: string | null;
  poster_path: string | null;
  preview_path: string | null;
  status: ClipRow['status'];
  error: string | null;
  ai_status: ClipRow['ai_status'];
  ai_model: string | null;
  ai_cost_usd: number | null;
  ai_tagged_at: number | null;
  ai_humor: string | null;
  ai_nsfw: number;
  source_site: string | null;
  source_url: string | null;
}>;

export function updateClip(id: string, patch: ClipPatch): void {
  const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return;

  const assignments = entries.map(([column]) => `${column} = ?`).join(', ');
  const values = entries.map(([, value]) => value as never);

  db.prepare(`UPDATE clips SET ${assignments}, updated_at = ? WHERE id = ?`).run(...values, Date.now(), id);

  // Any change that could touch searchable text reindexes. Cheap enough that
  // being conservative here beats missing an update.
  if (['title', 'description', 'transcript'].some((key) => key in patch)) {
    reindexClipById(id);
  }
}

export function softDeleteClip(id: string): void {
  db.prepare('UPDATE clips SET deleted_at = ?, updated_at = ? WHERE id = ?').run(Date.now(), Date.now(), id);
  removeFromIndex(id);
}

export function hardDeleteClip(id: string): void {
  db.prepare('DELETE FROM clips WHERE id = ?').run(id);
  removeFromIndex(id);
}

/** A clip that has been removed. getClip() deliberately cannot see these. */
export function getDeletedClip(id: string): ClipRow | undefined {
  return db.prepare('SELECT * FROM clips WHERE id = ? AND deleted_at IS NOT NULL').get(id) as ClipRow | undefined;
}

/**
 * Put a removed clip straight back, exactly as it was.
 *
 * Distinct from reviveClip: that one re-runs processing because it exists for
 * re-adding a file whose derivatives may have been purged. An undo happens
 * seconds after the delete, when the poster and preview are still on disk —
 * re-deriving would be a pointless transcode and would flash the card back
 * into the grid as "Processing…".
 *
 * Soft-deleting drops the clip from the search index, so restoring has to put
 * it back or the clip returns invisible to search.
 */
export function undeleteClip(id: string): boolean {
  const result = db
    .prepare('UPDATE clips SET deleted_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL')
    .run(Date.now(), id);

  if (result.changes === 0) return false;
  reindexClipById(id);
  return true;
}

/**
 * Undo a soft delete and send the clip back through processing.
 *
 * Re-adding something that was deleted should restore it rather than fail on
 * the sha256 uniqueness constraint — the file is still on disk, but its
 * derivatives may have been cleaned up.
 */
export function reviveClip(id: string): void {
  const now = Date.now();
  db.prepare("UPDATE clips SET deleted_at = NULL, status = 'processing', error = NULL, updated_at = ? WHERE id = ?").run(
    now,
    id,
  );
  reindexClipById(id);
}

export function recordView(clipId: string, userId: string): void {
  const now = Date.now();
  db.prepare('UPDATE clips SET view_count = view_count + 1 WHERE id = ?').run(clipId);
  db.prepare(
    `INSERT INTO plays (user_id, clip_id, played_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id, clip_id) DO UPDATE SET played_at = excluded.played_at`,
  ).run(userId, clipId, now);
}

export function setFavorite(userId: string, clipId: string, favorited: boolean): void {
  if (favorited) {
    db.prepare('INSERT OR IGNORE INTO favorites (user_id, clip_id, created_at) VALUES (?, ?, ?)').run(
      userId,
      clipId,
      Date.now(),
    );
  } else {
    db.prepare('DELETE FROM favorites WHERE user_id = ? AND clip_id = ?').run(userId, clipId);
  }
}

// ── Tags ─────────────────────────────────────────────────────────────────────

export function normaliseTagName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/^#/, '')
    .replace(/\s+/g, ' ')
    .slice(0, 48);
}

export function upsertTag(name: string, kind = 'topic'): Tag | null {
  const normalised = normaliseTagName(name);
  if (normalised.length < 2) return null;

  const existing = db.prepare('SELECT id, name, kind FROM tags WHERE name = ?').get(normalised) as Tag | undefined;
  if (existing) return existing;

  const id = newId();
  try {
    db.prepare('INSERT INTO tags (id, name, kind, created_at) VALUES (?, ?, ?, ?)').run(id, normalised, kind, Date.now());
  } catch {
    // Lost a race with a concurrent insert of the same tag.
    return db.prepare('SELECT id, name, kind FROM tags WHERE name = ?').get(normalised) as Tag | undefined ?? null;
  }
  return { id, name: normalised, kind };
}

export const setClipTags = db.transaction(
  (clipId: string, tags: ReadonlyArray<{ name: string; kind?: string; confidence?: number }>, source: 'ai' | 'human') => {
    db.prepare('DELETE FROM clip_tags WHERE clip_id = ? AND source = ?').run(clipId, source);

    const link = db.prepare(
      'INSERT OR REPLACE INTO clip_tags (clip_id, tag_id, source, confidence) VALUES (?, ?, ?, ?)',
    );

    for (const tag of tags) {
      const record = upsertTag(tag.name, tag.kind);
      if (record) link.run(clipId, record.id, source, tag.confidence ?? null);
    }
  },
);

export function addClipTag(clipId: string, name: string, kind = 'topic'): Tag | null {
  const tag = upsertTag(name, kind);
  if (!tag) return null;
  db.prepare("INSERT OR REPLACE INTO clip_tags (clip_id, tag_id, source, confidence) VALUES (?, ?, 'human', 1.0)").run(
    clipId,
    tag.id,
  );
  reindexClipById(clipId);
  return tag;
}

export function removeClipTag(clipId: string, tagId: string): void {
  db.prepare('DELETE FROM clip_tags WHERE clip_id = ? AND tag_id = ?').run(clipId, tagId);
  reindexClipById(clipId);
}

export type TagWithCount = Tag & { count: number };

export function listTags(opts: { limit?: number; query?: string } = {}): TagWithCount[] {
  const limit = Math.min(opts.limit ?? 200, 1000);
  const filter = opts.query?.trim();

  if (filter) {
    return db
      .prepare(
        `SELECT t.id, t.name, t.kind, COUNT(ct.clip_id) AS count
           FROM tags t
           JOIN clip_tags ct ON ct.tag_id = t.id
           JOIN clips c      ON c.id = ct.clip_id AND c.deleted_at IS NULL
          WHERE t.name LIKE ? ESCAPE '\\'
          GROUP BY t.id
          ORDER BY count DESC, t.name ASC
          LIMIT ?`,
      )
      .all(`%${filter.replace(/[\\%_]/g, '\\$&').toLowerCase()}%`, limit) as TagWithCount[];
  }

  return db
    .prepare(
      `SELECT t.id, t.name, t.kind, COUNT(ct.clip_id) AS count
         FROM tags t
         JOIN clip_tags ct ON ct.tag_id = t.id
         JOIN clips c      ON c.id = ct.clip_id AND c.deleted_at IS NULL
        GROUP BY t.id
        ORDER BY count DESC, t.name ASC
        LIMIT ?`,
    )
    .all(limit) as TagWithCount[];
}

/** Drop tags that no longer belong to any clip. */
export function pruneOrphanTags(): number {
  return db.prepare('DELETE FROM tags WHERE id NOT IN (SELECT DISTINCT tag_id FROM clip_tags)').run().changes;
}

// ── Categories ───────────────────────────────────────────────────────────────

export type CategoryWithCount = Category & { count: number };

export function listCategories(): CategoryWithCount[] {
  return db
    .prepare(
      /*
       * COUNT(c.id), not COUNT(cc.clip_id).
       *
       * The joins have to stay LEFT so a category with no clips still appears
       * with a count of 0 — but that means a deleted clip's membership row
       * survives the join with every `c.*` column NULL. Counting the
       * membership column therefore counts deleted clips too, and the sidebar
       * said "4" beside a category holding one clip. Counting a column from
       * the *clips* side only counts rows where that join actually matched.
       */
      `SELECT cat.*, COUNT(c.id) AS count
         FROM categories cat
         LEFT JOIN clip_categories cc ON cc.category_id = cat.id
         LEFT JOIN clips c            ON c.id = cc.clip_id AND c.deleted_at IS NULL
        GROUP BY cat.id
        ORDER BY cat.position ASC, cat.name COLLATE NOCASE ASC`,
    )
    .all() as CategoryWithCount[];
}

export function getCategory(id: string): Category | undefined {
  return db.prepare('SELECT * FROM categories WHERE id = ?').get(id) as Category | undefined;
}

export function getCategoryBySlug(slug: string): Category | undefined {
  return db.prepare('SELECT * FROM categories WHERE slug = ?').get(slug) as Category | undefined;
}

function nextCategoryPosition(): number {
  const row = db.prepare('SELECT MAX(position) AS maxPosition FROM categories').get() as { maxPosition: number | null };
  return (row.maxPosition ?? 0) + 1000;
}

function uniqueSlug(name: string): string {
  const base = slugify(name);
  let candidate = base;
  let suffix = 2;
  while (getCategoryBySlug(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

export function createCategory(input: {
  name: string;
  description?: string;
  color?: string;
  emoji?: string;
  createdBy: string | null;
}): Category {
  const name = input.name.trim();
  if (name.length < 1 || name.length > 60) throw new Error('Category name must be 1–60 characters.');

  const existing = db.prepare('SELECT * FROM categories WHERE name = ?').get(name) as Category | undefined;
  if (existing) return existing;

  const id = newId();
  db.prepare(
    `INSERT INTO categories (id, name, slug, description, color, emoji, position, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    name,
    uniqueSlug(name),
    input.description?.slice(0, 300) ?? '',
    input.color ?? '#7c8cff',
    input.emoji?.slice(0, 8) ?? '',
    nextCategoryPosition(),
    input.createdBy,
    Date.now(),
  );

  return getCategory(id)!;
}

export function updateCategory(
  id: string,
  patch: Partial<{ name: string; description: string; color: string; emoji: string }>,
): Category | undefined {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (name.length < 1 || name.length > 60) throw new Error('Category name must be 1–60 characters.');
    fields.push('name = ?');
    values.push(name);
  }
  if (patch.description !== undefined) {
    fields.push('description = ?');
    values.push(patch.description.slice(0, 300));
  }
  if (patch.color !== undefined) {
    if (!/^#[0-9a-fA-F]{6}$/.test(patch.color)) throw new Error('Colour must be a #rrggbb hex value.');
    fields.push('color = ?');
    values.push(patch.color);
  }
  if (patch.emoji !== undefined) {
    fields.push('emoji = ?');
    values.push(patch.emoji.slice(0, 8));
  }

  if (fields.length > 0) {
    values.push(id);
    db.prepare(`UPDATE categories SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }
  return getCategory(id);
}

export function deleteCategory(id: string): void {
  db.prepare('DELETE FROM categories WHERE id = ?').run(id);
}

/**
 * Move a category between two neighbours.
 *
 * Fractional indexing: we store the midpoint of the surrounding positions, so
 * a drag is one UPDATE instead of renumbering the whole list. Repeated
 * midpoints eventually exhaust float precision, so renormalise when the gap
 * gets too small to halve again.
 */
export const reorderCategory = db.transaction((id: string, beforeId: string | null, afterId: string | null) => {
  const before = beforeId ? getCategory(beforeId) : null;
  const after = afterId ? getCategory(afterId) : null;

  let position: number;
  if (before && after) position = (before.position + after.position) / 2;
  else if (before) position = before.position + 1000;
  else if (after) position = after.position - 1000;
  else position = 1000;

  db.prepare('UPDATE categories SET position = ? WHERE id = ?').run(position, id);

  if (before && after && Math.abs(before.position - after.position) < 0.001) {
    const all = db.prepare('SELECT id FROM categories ORDER BY position ASC').all() as Array<{ id: string }>;
    const renumber = db.prepare('UPDATE categories SET position = ? WHERE id = ?');
    all.forEach((row, index) => renumber.run((index + 1) * 1000, row.id));
  }
});

export function addClipToCategory(clipId: string, categoryId: string, userId: string | null): void {
  const row = db
    .prepare('SELECT MIN(position) AS minPosition FROM clip_categories WHERE category_id = ?')
    .get(categoryId) as { minPosition: number | null };

  // New assignments land at the top of the category, where the person who
  // just dropped them is looking.
  db.prepare(
    `INSERT INTO clip_categories (clip_id, category_id, position, added_by, added_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(clip_id, category_id) DO NOTHING`,
  ).run(clipId, categoryId, (row.minPosition ?? 1000) - 1000, userId, Date.now());
}

export function removeClipFromCategory(clipId: string, categoryId: string): void {
  db.prepare('DELETE FROM clip_categories WHERE clip_id = ? AND category_id = ?').run(clipId, categoryId);
}

export const setClipCategories = db.transaction((clipId: string, categoryIds: readonly string[], userId: string | null) => {
  db.prepare('DELETE FROM clip_categories WHERE clip_id = ?').run(clipId);
  for (const categoryId of categoryIds) addClipToCategory(clipId, categoryId, userId);
});

// ── Index maintenance ────────────────────────────────────────────────────────

export function reindexClipById(clipId: string): void {
  const row = getClip(clipId);
  if (!row) {
    removeFromIndex(clipId);
    return;
  }

  const tags = (tagsForClipStmt.all(clipId) as Tag[]).map((t) => t.name);
  reindexClip({
    clipId,
    title: row.title,
    description: row.description,
    transcript: row.transcript,
    filename: row.original_filename,
    tags,
  });
}

// ── Aggregates for the home screen ───────────────────────────────────────────

export function libraryStats(): {
  clips: number;
  processing: number;
  failed: number;
  untagged: number;
  categories: number;
  tags: number;
  bytes: number;
  aiSpendUsd: number;
} {
  const row = db
    .prepare(
      `SELECT
         COUNT(*)                                                        AS clips,
         SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END)          AS processing,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END)              AS failed,
         SUM(CASE WHEN ai_status IN ('pending','failed') THEN 1 ELSE 0 END) AS untagged,
         COALESCE(SUM(bytes), 0)                                         AS bytes,
         COALESCE(SUM(ai_cost_usd), 0)                                   AS aiSpendUsd
       FROM clips WHERE deleted_at IS NULL`,
    )
    .get() as {
    clips: number;
    processing: number | null;
    failed: number | null;
    untagged: number | null;
    bytes: number;
    aiSpendUsd: number;
  };

  const categories = (db.prepare('SELECT COUNT(*) AS n FROM categories').get() as { n: number }).n;
  const tags = (db.prepare('SELECT COUNT(*) AS n FROM tags').get() as { n: number }).n;

  return {
    clips: row.clips,
    processing: row.processing ?? 0,
    failed: row.failed ?? 0,
    untagged: row.untagged ?? 0,
    categories,
    tags,
    bytes: row.bytes,
    aiSpendUsd: Math.round(row.aiSpendUsd * 10000) / 10000,
  };
}
