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
