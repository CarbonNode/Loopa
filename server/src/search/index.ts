import { db } from '../db/index.ts';

/**
 * Escape a user's query into an FTS5 MATCH expression.
 *
 * FTS5's query language treats `"`, `*`, `:`, `^`, `-`, `AND`, `OR` and `NEAR`
 * as syntax, so raw input can either throw a parse error or silently mean
 * something the user didn't type. Every token is quoted, which makes it a
 * literal, and prefix `*` is re-attached outside the quotes where we want it.
 */
export function buildMatchExpression(rawQuery: string, opts: { prefix?: boolean } = {}): string | null {
  const prefix = opts.prefix ?? true;

  // Keep quoted phrases intact; split everything else on whitespace.
  const tokens: Array<{ text: string; phrase: boolean }> = [];
  const phraseMatcher = /"([^"]+)"|(\S+)/g;

  for (const match of rawQuery.matchAll(phraseMatcher)) {
    const phrase = match[1];
    const word = match[2];
    if (phrase) {
      const cleaned = phrase.replace(/["']/g, ' ').trim();
      if (cleaned) tokens.push({ text: cleaned, phrase: true });
    } else if (word) {
      // Strip characters FTS5 would read as operators.
      const cleaned = word.replace(/["'^*:()-]/g, ' ').trim();
      if (cleaned) tokens.push({ text: cleaned, phrase: false });
    }
  }

  if (tokens.length === 0) return null;

  const parts = tokens.map(({ text, phrase }, index) => {
    const quoted = `"${text.replace(/"/g, '')}"`;
    // Only the final token gets prefix matching — that's the word still being
    // typed. Earlier tokens are complete and should match exactly.
    const isLast = index === tokens.length - 1;
    return prefix && isLast && !phrase && text.length >= 2 ? `${quoted}*` : quoted;
  });

  // Implicit AND: every term must appear somewhere in the row.
  return parts.join(' AND ');
}

type ReindexInput = {
  clipId: string;
  title: string;
  description: string;
  transcript: string | null;
  filename: string | null;
  tags: readonly string[];
};

const deleteFromIndex = db.prepare('DELETE FROM clips_fts WHERE clip_id = ?');
const insertIntoIndex = db.prepare(
  `INSERT INTO clips_fts (clip_id, title, tags, description, transcript, filename)
   VALUES (@clipId, @title, @tags, @description, @transcript, @filename)`,
);

/**
 * Rewrite one clip's search-index row.
 *
 * The index is standalone rather than FTS5 external-content: its text is
 * assembled from clips *plus* their tags, and SQLite triggers can only mirror
 * a single source table. So every write path that changes searchable text
 * calls this.
 */
export const reindexClip = db.transaction((input: ReindexInput) => {
  deleteFromIndex.run(input.clipId);
  insertIntoIndex.run({
    clipId: input.clipId,
    title: input.title,
    // Tags are joined into one column so `dog cat` matches a clip tagged with
    // both, and prefix search hits partial tag names.
    tags: input.tags.join(' '),
    description: input.description,
    transcript: input.transcript ?? '',
    filename: input.filename ?? '',
  });
});

export function removeFromIndex(clipId: string): void {
  deleteFromIndex.run(clipId);
}

export type SearchHit = { clip_id: string; rank: number };

/**
 * Ranked clip ids for a query.
 *
 * bm25() weights the columns: a query word in the title or a tag is a much
 * stronger signal than the same word buried in a transcript.
 */
export function searchClipIds(rawQuery: string, opts: { limit?: number; prefix?: boolean } = {}): SearchHit[] {
  const expression = buildMatchExpression(rawQuery, { prefix: opts.prefix });
  if (!expression) return [];

  try {
    return db
      .prepare(
        `SELECT clip_id, bm25(clips_fts, 0.0, 10.0, 8.0, 3.0, 1.0, 2.0) AS rank
           FROM clips_fts
          WHERE clips_fts MATCH ?
          ORDER BY rank
          LIMIT ?`,
      )
      .all(expression, opts.limit ?? 200) as SearchHit[];
  } catch (error) {
    // A malformed expression is a bug in the escaper, not something the user
    // should see as a 500 — degrade to no results and log it.
    console.warn(`[search] MATCH failed for ${JSON.stringify(expression)}: ${(error as Error).message}`);
    return [];
  }
}

/** Rebuild the whole index. Used after a bulk import or a schema change. */
export function rebuildIndex(): number {
  const rows = db
    .prepare(
      `SELECT c.id, c.title, c.description, c.transcript, c.original_filename,
              COALESCE(GROUP_CONCAT(t.name, ' '), '') AS tags
         FROM clips c
         LEFT JOIN clip_tags ct ON ct.clip_id = c.id
         LEFT JOIN tags t       ON t.id = ct.tag_id
        WHERE c.deleted_at IS NULL
        GROUP BY c.id`,
    )
    .all() as Array<{
    id: string;
    title: string;
    description: string;
    transcript: string | null;
    original_filename: string | null;
    tags: string;
  }>;

  db.transaction(() => {
    db.prepare('DELETE FROM clips_fts').run();
    for (const row of rows) {
      insertIntoIndex.run({
        clipId: row.id,
        title: row.title,
        tags: row.tags,
        description: row.description,
        transcript: row.transcript ?? '',
        filename: row.original_filename ?? '',
      });
    }
  })();

  return rows.length;
}
