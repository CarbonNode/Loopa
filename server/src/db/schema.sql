-- Loopa schema.
--
-- Applied idempotently on every boot; every statement is CREATE ... IF NOT
-- EXISTS so this doubles as the migration path for a fresh install. Changes
-- that alter existing tables go in migrations.ts.
--
-- All timestamps are integer epoch milliseconds (UTC).

PRAGMA foreign_keys = ON;

-- ── People ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS users (
  id            TEXT    PRIMARY KEY,
  username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT    NOT NULL,
  password_hash TEXT    NOT NULL,
  role          TEXT    NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  avatar_color  TEXT    NOT NULL DEFAULT '#7c8cff',
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER
);

CREATE TABLE IF NOT EXISTS invites (
  code       TEXT    PRIMARY KEY,
  created_by TEXT    REFERENCES users(id) ON DELETE SET NULL,
  role       TEXT    NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  note       TEXT,
  -- 0 means unlimited; see UNLIMITED_USES in auth/service.ts.
  max_uses   INTEGER NOT NULL DEFAULT 1 CHECK (max_uses >= 0),
  uses       INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);

-- `id` is sha256(token), never the token itself — a database leak should not
-- hand out live sessions.
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT    PRIMARY KEY,
  user_id    TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_agent TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);

-- ── The library ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS clips (
  id                TEXT    PRIMARY KEY,
  -- Content address. UNIQUE is what makes re-uploading the same clip a no-op
  -- instead of a duplicate.
  sha256            TEXT    NOT NULL UNIQUE,
  kind              TEXT    NOT NULL CHECK (kind IN ('video', 'gif', 'image')),

  original_filename TEXT,
  source_url        TEXT,
  source_site       TEXT,
  ext               TEXT    NOT NULL,
  mime              TEXT    NOT NULL,
  bytes             INTEGER NOT NULL,

  width             INTEGER,
  height            INTEGER,
  duration_ms       INTEGER,
  fps               REAL,
  has_audio         INTEGER NOT NULL DEFAULT 0,

  title             TEXT    NOT NULL DEFAULT '',
  description       TEXT    NOT NULL DEFAULT '',
  transcript        TEXT,

  -- Paths are relative to MEDIA_DIR so the library stays portable across hosts.
  original_path     TEXT    NOT NULL,
  playable_path     TEXT,
  poster_path       TEXT,
  preview_path      TEXT,

  status            TEXT    NOT NULL DEFAULT 'processing'
                            CHECK (status IN ('processing', 'ready', 'failed')),
  error             TEXT,

  ai_status         TEXT    NOT NULL DEFAULT 'pending'
                            CHECK (ai_status IN ('pending', 'running', 'done', 'failed', 'skipped')),
  ai_model          TEXT,
  ai_cost_usd       REAL,
  ai_tagged_at      INTEGER,
  ai_humor          TEXT,
  ai_nsfw           INTEGER NOT NULL DEFAULT 0,

  view_count        INTEGER NOT NULL DEFAULT 0,
  uploader_id       TEXT    REFERENCES users(id) ON DELETE SET NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  deleted_at        INTEGER
);

CREATE INDEX IF NOT EXISTS idx_clips_created   ON clips (deleted_at, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_clips_status    ON clips (status);
CREATE INDEX IF NOT EXISTS idx_clips_ai_status ON clips (ai_status);
CREATE INDEX IF NOT EXISTS idx_clips_uploader  ON clips (uploader_id);
CREATE INDEX IF NOT EXISTS idx_clips_views     ON clips (deleted_at, view_count DESC);

-- ── Categories ───────────────────────────────────────────────────────────────
-- `position` is a fractional index: to drop an item between two neighbours we
-- assign the midpoint of their positions, so a reorder is one UPDATE rather
-- than rewriting every row.

CREATE TABLE IF NOT EXISTS categories (
  id          TEXT    PRIMARY KEY,
  name        TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  slug        TEXT    NOT NULL UNIQUE,
  description TEXT    NOT NULL DEFAULT '',
  color       TEXT    NOT NULL DEFAULT '#7c8cff',
  emoji       TEXT    NOT NULL DEFAULT '',
  position    REAL    NOT NULL,
  is_smart    INTEGER NOT NULL DEFAULT 0,
  smart_query TEXT,
  created_by  TEXT    REFERENCES users(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_categories_position ON categories (position);

CREATE TABLE IF NOT EXISTS clip_categories (
  clip_id     TEXT    NOT NULL REFERENCES clips(id)      ON DELETE CASCADE,
  category_id TEXT    NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  position    REAL    NOT NULL,
  added_by    TEXT    REFERENCES users(id) ON DELETE SET NULL,
  added_at    INTEGER NOT NULL,
  PRIMARY KEY (clip_id, category_id)
);

CREATE INDEX IF NOT EXISTS idx_clip_categories_cat ON clip_categories (category_id, position);

-- ── Tags ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tags (
  id         TEXT    PRIMARY KEY,
  name       TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  kind       TEXT    NOT NULL DEFAULT 'topic'
                     CHECK (kind IN ('topic', 'subject', 'humor', 'mood', 'source', 'text')),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS clip_tags (
  clip_id    TEXT NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
  tag_id     TEXT NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
  source     TEXT NOT NULL DEFAULT 'ai' CHECK (source IN ('ai', 'human')),
  confidence REAL,
  PRIMARY KEY (clip_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_clip_tags_tag ON clip_tags (tag_id);

-- ── Per-user state ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS favorites (
  user_id    TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  clip_id    TEXT    NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, clip_id)
);

CREATE INDEX IF NOT EXISTS idx_favorites_clip ON favorites (clip_id);

CREATE TABLE IF NOT EXISTS plays (
  user_id   TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  clip_id   TEXT    NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
  played_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, clip_id)
);

CREATE INDEX IF NOT EXISTS idx_plays_recent ON plays (user_id, played_at DESC);

-- ── Job queue ────────────────────────────────────────────────────────────────
-- Durable so an in-flight transcode or tagging run survives a restart.

CREATE TABLE IF NOT EXISTS jobs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  type         TEXT    NOT NULL,
  clip_id      TEXT    REFERENCES clips(id) ON DELETE CASCADE,
  payload      TEXT    NOT NULL DEFAULT '{}',
  status       TEXT    NOT NULL DEFAULT 'queued'
                       CHECK (status IN ('queued', 'running', 'done', 'failed')),
  priority     INTEGER NOT NULL DEFAULT 0,
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  run_after    INTEGER NOT NULL,
  locked_at    INTEGER,
  locked_by    TEXT,
  last_error   TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_claim ON jobs (status, run_after, priority DESC, id);
CREATE INDEX IF NOT EXISTS idx_jobs_clip  ON jobs (clip_id);

-- ── Full-text search ─────────────────────────────────────────────────────────
-- A standalone (not external-content) FTS5 table: searchable text is stitched
-- together from clips plus their tags, so there is no single source table for
-- SQLite triggers to mirror. search/index.ts owns keeping it in sync.
--
-- prefix='2 3 4' precomputes 2-, 3- and 4-character prefix indexes, which is
-- what makes search-as-you-type fast from the second keystroke.

CREATE VIRTUAL TABLE IF NOT EXISTS clips_fts USING fts5(
  clip_id UNINDEXED,
  title,
  tags,
  description,
  transcript,
  filename,
  tokenize = 'unicode61 remove_diacritics 2',
  prefix = '2 3 4'
);

-- ── Public share links ───────────────────────────────────────────────────────
-- A clip handed out to people who have no account: the token IS the
-- credential, so it is long and random rather than guessable.
--
-- Unlike sessions, the token is stored in the clear. It has to be: the whole
-- point is handing the same URL back out from the UI after the fact, and a
-- share link grants read access to one already-shareable clip rather than to
-- an account.

CREATE TABLE IF NOT EXISTS share_links (
  token          TEXT    PRIMARY KEY,
  clip_id        TEXT    NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
  created_by     TEXT    REFERENCES users(id) ON DELETE SET NULL,
  expires_at     INTEGER,
  revoked_at     INTEGER,
  view_count     INTEGER NOT NULL DEFAULT 0,
  last_viewed_at INTEGER,
  created_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_share_links_clip ON share_links (clip_id);

-- ── Comments ─────────────────────────────────────────────────────────────────
--
-- Half the point of a shared clip library is arguing about the clips, so a
-- comment is a first-class row rather than a note field on the clip.
--
-- Deletes are soft. A thread with holes punched in it reads as broken, so a
-- removed comment keeps its place in the order and renders as a tombstone.
-- The author survives the user being deleted (ON DELETE SET NULL) for the same
-- reason: losing the row would silently rewrite a conversation.

CREATE TABLE IF NOT EXISTS comments (
  id         TEXT    PRIMARY KEY,
  clip_id    TEXT    NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
  author_id  TEXT    REFERENCES users(id) ON DELETE SET NULL,
  body       TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  edited_at  INTEGER,
  deleted_at INTEGER
);

-- The only read that matters: one clip's thread, oldest first.
CREATE INDEX IF NOT EXISTS idx_comments_clip ON comments (clip_id, created_at);

-- ── Meta ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
