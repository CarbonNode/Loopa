import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.ts';

const schemaPath = join(import.meta.dirname, 'schema.sql');

export const db = new Database(config.dbPath);

// WAL lets readers keep reading while a write is in flight — important here
// because ffmpeg workers write clip rows while people are browsing.
db.pragma('journal_mode = WAL');
// NORMAL trades an fsync per commit for one per checkpoint. Safe under WAL:
// the risk is losing the last few commits on a power cut, not corruption.
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
// Wait rather than throw SQLITE_BUSY when a worker holds the write lock.
db.pragma('busy_timeout = 5000');
db.pragma('temp_store = MEMORY');
// Negative = KiB of page cache. 64 MB keeps the hot index pages resident.
db.pragma('cache_size = -65536');

db.exec(readFileSync(schemaPath, 'utf8'));

// ── Meta helpers ─────────────────────────────────────────────────────────────

const readMetaStmt = db.prepare<[string], { value: string }>('SELECT value FROM meta WHERE key = ?');
const writeMetaStmt = db.prepare(
  'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
);

export function getMeta(key: string): string | undefined {
  return readMetaStmt.get(key)?.value;
}

export function setMeta(key: string, value: string): void {
  writeMetaStmt.run(key, value);
}

// ── Migrations ───────────────────────────────────────────────────────────────
//
// schema.sql is idempotent and covers a fresh install. Anything that has to
// change an *existing* database goes here, appended in order and never edited
// once shipped.

type Migration = { readonly id: number; readonly name: string; readonly up: () => void };

const migrations: readonly Migration[] = [
  // Reserved: migration 1 is the initial schema, applied by schema.sql itself.
  {
    id: 2,
    name: 'allow unlimited-use invites (max_uses = 0)',
    up: () => {
      // SQLite cannot alter a CHECK constraint, so relaxing `max_uses > 0` to
      // `>= 0` means rebuilding the table. Skipped entirely when the schema
      // already has the new form — a fresh install gets it from schema.sql,
      // and rebuilding a correct table would be pointless work.
      const current = db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'invites'")
        .get() as { sql: string } | undefined;

      if (!current || !/max_uses\s*>\s*0(?!\s*=)/.test(current.sql)) return;

      db.exec(`
        CREATE TABLE invites_rebuilt (
          code       TEXT    PRIMARY KEY,
          created_by TEXT    REFERENCES users(id) ON DELETE SET NULL,
          role       TEXT    NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
          note       TEXT,
          max_uses   INTEGER NOT NULL DEFAULT 1 CHECK (max_uses >= 0),
          uses       INTEGER NOT NULL DEFAULT 0,
          expires_at INTEGER,
          revoked_at INTEGER,
          created_at INTEGER NOT NULL
        );
        INSERT INTO invites_rebuilt (code, created_by, role, note, max_uses, uses, expires_at, revoked_at, created_at)
          SELECT code, created_by, role, note, max_uses, uses, expires_at, revoked_at, created_at FROM invites;
        DROP TABLE invites;
        ALTER TABLE invites_rebuilt RENAME TO invites;
      `);
    },
  },
];

export function runMigrations(): void {
  const applied = Number.parseInt(getMeta('schema_version') ?? '0', 10);
  const pending = migrations.filter((m) => m.id > applied);
  if (pending.length === 0) {
    if (!getMeta('schema_version')) setMeta('schema_version', String(migrations.at(-1)?.id ?? 0));
    return;
  }

  for (const migration of pending) {
    console.log(`[db] applying migration ${migration.id}: ${migration.name}`);
    db.transaction(() => {
      migration.up();
      setMeta('schema_version', String(migration.id));
    })();
  }
}

// ── Maintenance ──────────────────────────────────────────────────────────────

/**
 * Housekeeping that is cheap enough to run on boot and on a timer: drop dead
 * sessions, retire finished jobs, and release any job whose worker died
 * mid-run so it gets retried instead of sitting locked forever.
 */
export function runMaintenance(): void {
  const now = Date.now();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  db.prepare("DELETE FROM jobs WHERE status = 'done' AND updated_at < ?").run(now - 1000 * 60 * 60 * 24);

  const staleLockCutoff = now - 1000 * 60 * 30;
  const released = db
    .prepare(
      `UPDATE jobs
          SET status = 'queued', locked_at = NULL, locked_by = NULL, updated_at = ?
        WHERE status = 'running' AND locked_at < ?`,
    )
    .run(now, staleLockCutoff);

  if (released.changes > 0) {
    console.warn(`[db] released ${released.changes} job(s) abandoned by a dead worker`);
  }
}

export function closeDatabase(): void {
  try {
    // Fold the WAL back into the main file so a copied .db is complete.
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch {
    // Checkpointing is best-effort; a failure here must not block shutdown.
  }
  db.close();
}
