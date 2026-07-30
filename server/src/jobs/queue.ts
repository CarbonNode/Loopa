import { db } from '../db/index.ts';
import { newToken } from '../util/ids.ts';

export type JobType = 'fetch_url' | 'derive' | 'tag';
export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

export type Job = {
  id: number;
  type: JobType;
  clip_id: string | null;
  payload: string;
  status: JobStatus;
  priority: number;
  attempts: number;
  max_attempts: number;
  run_after: number;
  locked_at: number | null;
  locked_by: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
};

export type JobHandler = (job: Job, payload: Record<string, unknown>) => Promise<void>;

/** Raised by a handler when retrying is pointless — skips remaining attempts. */
export class PermanentJobError extends Error {
  readonly hint: string | undefined;
  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'PermanentJobError';
    this.hint = hint;
  }
}

export function enqueue(input: {
  type: JobType;
  clipId?: string | null;
  payload?: Record<string, unknown>;
  priority?: number;
  runAfter?: number;
  maxAttempts?: number;
}): number {
  const now = Date.now();
  const result = db
    .prepare(
      `INSERT INTO jobs (type, clip_id, payload, status, priority, attempts, max_attempts, run_after, created_at, updated_at)
       VALUES (?, ?, ?, 'queued', ?, 0, ?, ?, ?, ?)`,
    )
    .run(
      input.type,
      input.clipId ?? null,
      JSON.stringify(input.payload ?? {}),
      input.priority ?? 0,
      input.maxAttempts ?? 3,
      input.runAfter ?? now,
      now,
      now,
    );

  return Number(result.lastInsertRowid);
}

/**
 * Claim one runnable job of the given types.
 *
 * The SELECT and the UPDATE run in a single transaction with the row's
 * previous status re-checked in the WHERE clause, so two workers polling at
 * the same instant cannot both take the same job.
 */
const claimJob = db.transaction((types: readonly JobType[], workerId: string, now: number): Job | null => {
  const placeholders = types.map(() => '?').join(', ');
  const candidate = db
    .prepare(
      `SELECT * FROM jobs
        WHERE status = 'queued' AND run_after <= ? AND type IN (${placeholders})
        ORDER BY priority DESC, id ASC
        LIMIT 1`,
    )
    .get(now, ...types) as Job | undefined;

  if (!candidate) return null;

  const claimed = db
    .prepare(
      `UPDATE jobs
          SET status = 'running', attempts = attempts + 1, locked_at = ?, locked_by = ?, updated_at = ?
        WHERE id = ? AND status = 'queued'`,
    )
    .run(now, workerId, now, candidate.id);

  if (claimed.changes === 0) return null;

  return { ...candidate, status: 'running', attempts: candidate.attempts + 1, locked_at: now, locked_by: workerId };
});

function completeJob(id: number): void {
  db.prepare("UPDATE jobs SET status = 'done', last_error = NULL, locked_at = NULL, locked_by = NULL, updated_at = ? WHERE id = ?").run(
    Date.now(),
    id,
  );
}

function failJob(job: Job, error: unknown, permanent: boolean): void {
  const now = Date.now();
  const message = error instanceof Error ? error.message : String(error);
  const exhausted = permanent || job.attempts >= job.max_attempts;

  if (exhausted) {
    db.prepare("UPDATE jobs SET status = 'failed', last_error = ?, locked_at = NULL, locked_by = NULL, updated_at = ? WHERE id = ?").run(
      message.slice(0, 2000),
      now,
      job.id,
    );
    return;
  }

  // Exponential backoff with jitter — a site rate-limiting us should not get
  // a synchronised retry from every queued job at once.
  const backoffMs = Math.min(2 ** job.attempts * 5000, 10 * 60 * 1000);
  const jitter = Math.floor(Math.random() * 3000);

  db.prepare(
    `UPDATE jobs
        SET status = 'queued', last_error = ?, locked_at = NULL, locked_by = NULL,
            run_after = ?, updated_at = ?
      WHERE id = ?`,
  ).run(message.slice(0, 2000), now + backoffMs + jitter, now, job.id);
}

/**
 * A pool of workers polling one class of job.
 *
 * Separate pools per class so a queue of slow transcodes cannot starve AI
 * tagging, and so each can be sized to its own bottleneck — ffmpeg is
 * CPU-bound, tagging is network-bound.
 */
export class WorkerPool {
  readonly #name: string;
  readonly #types: readonly JobType[];
  readonly #handlers: Readonly<Record<string, JobHandler>>;
  readonly #concurrency: number;
  readonly #pollIntervalMs: number;

  #running = 0;
  #stopped = false;
  #timer: NodeJS.Timeout | null = null;
  /** Resolves once every in-flight job has finished, for graceful shutdown. */
  #idleWaiters: Array<() => void> = [];

  constructor(opts: {
    name: string;
    types: readonly JobType[];
    handlers: Readonly<Record<string, JobHandler>>;
    concurrency: number;
    pollIntervalMs?: number;
  }) {
    this.#name = opts.name;
    this.#types = opts.types;
    this.#handlers = opts.handlers;
    this.#concurrency = Math.max(1, opts.concurrency);
    this.#pollIntervalMs = opts.pollIntervalMs ?? 750;
  }

  start(): void {
    if (this.#timer) return;
    this.#stopped = false;
    this.#timer = setInterval(() => this.#tick(), this.#pollIntervalMs);
    // Don't hold the event loop open purely to poll an empty queue.
    this.#timer.unref();
    this.#tick();
  }

  /** Poll immediately — call after enqueueing so work starts without waiting. */
  kick(): void {
    if (!this.#stopped) queueMicrotask(() => this.#tick());
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    if (this.#running === 0) return;
    await new Promise<void>((resolvePromise) => this.#idleWaiters.push(resolvePromise));
  }

  #tick(): void {
    if (this.#stopped) return;

    while (this.#running < this.#concurrency) {
      let job: Job | null;
      try {
        job = claimJob(this.#types, `${this.#name}-${newToken(4)}`, Date.now());
      } catch (error) {
        console.error(`[jobs:${this.#name}] failed to claim a job:`, error);
        return;
      }
      if (!job) return;

      this.#running += 1;
      void this.#execute(job);
    }
  }

  async #execute(job: Job): Promise<void> {
    const handler = this.#handlers[job.type];
    const startedAt = Date.now();

    try {
      if (!handler) throw new PermanentJobError(`No handler registered for job type "${job.type}"`);

      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(job.payload) as Record<string, unknown>;
      } catch {
        throw new PermanentJobError('Job payload is not valid JSON');
      }

      await handler(job, payload);
      completeJob(job.id);

      const elapsed = Date.now() - startedAt;
      if (elapsed > 5000) {
        console.log(`[jobs:${this.#name}] ${job.type}#${job.id} finished in ${(elapsed / 1000).toFixed(1)}s`);
      }
    } catch (error) {
      const permanent = error instanceof PermanentJobError;
      failJob(job, error, permanent);
      console.warn(
        `[jobs:${this.#name}] ${job.type}#${job.id} ${permanent ? 'failed permanently' : `attempt ${job.attempts}/${job.max_attempts} failed`}:`,
        error instanceof Error ? error.message : error,
      );
    } finally {
      this.#running -= 1;
      if (this.#running === 0 && this.#idleWaiters.length > 0) {
        for (const wake of this.#idleWaiters.splice(0)) wake();
      }
      if (!this.#stopped) this.#tick();
    }
  }
}

// ── Introspection, for the admin/status surfaces ─────────────────────────────

export function jobStats(): Record<JobStatus, number> {
  const rows = db.prepare('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status').all() as Array<{
    status: JobStatus;
    n: number;
  }>;
  const stats: Record<JobStatus, number> = { queued: 0, running: 0, done: 0, failed: 0 };
  for (const row of rows) stats[row.status] = row.n;
  return stats;
}

export function jobsForClip(clipId: string): Job[] {
  return db.prepare('SELECT * FROM jobs WHERE clip_id = ? ORDER BY id DESC LIMIT 20').all(clipId) as Job[];
}

export function recentFailures(limit = 25): Job[] {
  return db
    .prepare("SELECT * FROM jobs WHERE status = 'failed' ORDER BY updated_at DESC LIMIT ?")
    .all(limit) as Job[];
}

/** Re-queue a failed job, resetting its attempt counter. */
export function retryJob(id: number): boolean {
  const result = db
    .prepare(
      `UPDATE jobs
          SET status = 'queued', attempts = 0, last_error = NULL,
              run_after = ?, locked_at = NULL, locked_by = NULL, updated_at = ?
        WHERE id = ? AND status = 'failed'`,
    )
    .run(Date.now(), Date.now(), id);
  return result.changes > 0;
}
