import type {
  Category,
  Clip,
  ClipPage,
  Filters,
  ImportResult,
  IngestStatus,
  Invite,
  ProbeResult,
  Role,
  StudioClipResult,
  StudioResolve,
  SystemStatus,
  Tag,
  TagWithCount,
  UploadResult,
  User,
} from './types.ts';

/** An API error carrying the server's message and optional actionable hint. */
export class ApiError extends Error {
  readonly status: number;
  readonly hint: string | null;

  constructor(status: number, message: string, hint: string | null = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.hint = hint;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      // Session lives in an httpOnly cookie; it must ride along on every call.
      credentials: 'same-origin',
      ...init,
      headers: {
        ...(init.body && !(init.body instanceof FormData) ? { 'content-type': 'application/json' } : {}),
        ...init.headers,
      },
    });
  } catch {
    // fetch only rejects on a transport failure, so this is genuinely
    // "the server is unreachable" rather than any HTTP error.
    throw new ApiError(0, 'Cannot reach the server.', 'Check your connection and try again.');
  }

  if (response.status === 204) return undefined as T;

  const isJson = response.headers.get('content-type')?.includes('application/json');
  const body = isJson ? await response.json().catch(() => null) : null;

  if (!response.ok) {
    const payload = body as { error?: string; hint?: string | null } | null;
    throw new ApiError(
      response.status,
      payload?.error ?? `Request failed (${response.status})`,
      payload?.hint ?? null,
    );
  }

  return body as T;
}

function query(params: Record<string, string | number | boolean | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '' || value === false) continue;
    search.set(key, String(value));
  }
  const serialised = search.toString();
  return serialised ? `?${serialised}` : '';
}

export const api = {
  // ── Auth ─────────────────────────────────────────────────────────────────
  authState: () =>
    request<{ setupPending: boolean; user: User | null; publicUrl: string }>('/api/auth/state'),

  setup: (input: { token: string; username: string; password: string; displayName?: string }) =>
    request<{ user: User }>('/api/auth/setup', { method: 'POST', body: JSON.stringify(input) }),

  login: (input: { username: string; password: string }) =>
    request<{ user: User }>('/api/auth/login', { method: 'POST', body: JSON.stringify(input) }),

  join: (input: { code: string; username: string; password: string; displayName?: string }) =>
    request<{ user: User }>('/api/auth/join', { method: 'POST', body: JSON.stringify(input) }),

  logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),

  updateProfile: (input: { displayName?: string; avatarColor?: string }) =>
    request<{ user: User }>('/api/auth/me', { method: 'PATCH', body: JSON.stringify(input) }),

  changePassword: (input: { currentPassword: string; newPassword: string }) =>
    request<{ ok: boolean }>('/api/auth/password', { method: 'POST', body: JSON.stringify(input) }),

  users: () => request<{ users: User[] }>('/api/users'),

  // ── Clips ────────────────────────────────────────────────────────────────
  clips: (filters: Partial<Filters> & { cursor?: string; limit?: number; includeProcessing?: boolean }) =>
    request<ClipPage>(
      `/api/clips${query({
        q: filters.query,
        category: filters.categoryId,
        tag: filters.tagId,
        favorites: filters.favorites,
        kind: filters.kind,
        sort: filters.sort,
        cursor: filters.cursor,
        limit: filters.limit,
        includeProcessing: filters.includeProcessing,
      })}`,
    ),

  clip: (id: string) =>
    request<{
      clip: Clip;
      jobs: Array<{ id: number; type: string; status: string; attempts: number; error: string | null; updatedAt: number }>;
    }>(`/api/clips/${id}`),

  updateClip: (id: string, patch: { title?: string; description?: string; categoryIds?: string[] }) =>
    request<{ clip: Clip }>(`/api/clips/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),

  deleteClip: (id: string) => request<{ ok: boolean }>(`/api/clips/${id}`, { method: 'DELETE' }),

  recordView: (id: string) => request<{ ok: boolean }>(`/api/clips/${id}/view`, { method: 'POST' }),

  setFavorite: (id: string, favorited: boolean) =>
    request<{ favorited: boolean }>(`/api/clips/${id}/favorite`, {
      method: 'PUT',
      body: JSON.stringify({ favorited }),
    }),

  addClipToCategory: (clipId: string, categoryId: string) =>
    request<{ clip: Clip }>(`/api/clips/${clipId}/categories/${categoryId}`, { method: 'PUT' }),

  removeClipFromCategory: (clipId: string, categoryId: string) =>
    request<{ clip: Clip }>(`/api/clips/${clipId}/categories/${categoryId}`, { method: 'DELETE' }),

  bulkCategorise: (clipIds: string[], categoryId: string, action: 'add' | 'remove' = 'add') =>
    request<{ ok: boolean; count: number }>('/api/clips/bulk/categories', {
      method: 'POST',
      body: JSON.stringify({ clipIds, categoryId, action }),
    }),

  addTag: (clipId: string, name: string) =>
    request<{ tag: Tag }>(`/api/clips/${clipId}/tags`, { method: 'POST', body: JSON.stringify({ name }) }),

  removeTag: (clipId: string, tagId: string) =>
    request<{ ok: boolean }>(`/api/clips/${clipId}/tags/${tagId}`, { method: 'DELETE' }),

  retag: (clipId: string) => request<{ ok: boolean }>(`/api/clips/${clipId}/retag`, { method: 'POST' }),

  tags: (options: { q?: string; limit?: number } = {}) =>
    request<{ tags: TagWithCount[] }>(`/api/tags${query(options)}`),

  // ── Categories ───────────────────────────────────────────────────────────
  categories: () => request<{ categories: Category[] }>('/api/categories'),

  createCategory: (input: { name: string; description?: string; color?: string; emoji?: string }) =>
    request<{ category: Category }>('/api/categories', { method: 'POST', body: JSON.stringify(input) }),

  updateCategory: (id: string, patch: { name?: string; description?: string; color?: string; emoji?: string }) =>
    request<{ category: Category }>(`/api/categories/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),

  deleteCategory: (id: string) => request<{ ok: boolean }>(`/api/categories/${id}`, { method: 'DELETE' }),

  reorderCategory: (id: string, beforeId: string | null, afterId: string | null) =>
    request<{ categories: Category[] }>(`/api/categories/${id}/reorder`, {
      method: 'POST',
      body: JSON.stringify({ beforeId, afterId }),
    }),

  // ── Ingest ───────────────────────────────────────────────────────────────
  /**
   * Upload with progress.
   *
   * XMLHttpRequest rather than fetch: fetch still has no upload-progress
   * event, and a multi-hundred-megabyte upload with no progress bar feels
   * broken.
   */
  upload: (
    files: File[],
    options: { categoryId?: string | null; onProgress?: (fraction: number) => void; signal?: AbortSignal } = {},
  ): Promise<UploadResult> =>
    new Promise((resolve, reject) => {
      const form = new FormData();
      for (const file of files) form.append('file', file, file.name);
      if (options.categoryId) form.append('categoryId', options.categoryId);

      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/upload');
      xhr.withCredentials = true;

      xhr.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable) options.onProgress?.(event.loaded / event.total);
      });

      xhr.addEventListener('load', () => {
        let payload: unknown = null;
        try {
          payload = JSON.parse(xhr.responseText);
        } catch {
          // Fall through to the status check below.
        }

        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(payload as UploadResult);
        } else {
          const error = payload as { error?: string; hint?: string } | null;
          reject(new ApiError(xhr.status, error?.error ?? `Upload failed (${xhr.status})`, error?.hint ?? null));
        }
      });

      xhr.addEventListener('error', () => reject(new ApiError(0, 'The upload could not reach the server.')));
      xhr.addEventListener('abort', () => reject(new ApiError(0, 'Upload cancelled.')));

      options.signal?.addEventListener('abort', () => xhr.abort(), { once: true });
      xhr.send(form);
    }),

  importUrls: (urls: string[], categoryId?: string | null) =>
    request<ImportResult>('/api/import', { method: 'POST', body: JSON.stringify({ urls, categoryId }) }),

  inspectUrl: (url: string) =>
    request<{ ok: boolean; url?: string; site?: string; siteId?: string; warning?: string | null; error?: string; hint?: string | null }>(
      `/api/import/inspect${query({ url })}`,
    ),

  ingestStatus: () => request<IngestStatus>('/api/ingest/status'),

  updateYtDlp: () =>
    request<{ ok: boolean; version: string | null; output: string }>('/api/ingest/update-ytdlp', { method: 'POST' }),

  uploadCookies: (site: string, file: File) => {
    const form = new FormData();
    form.append('file', file, file.name);
    return request<{ ok: boolean; site: string; cookies: Record<string, boolean> }>(
      `/api/ingest/cookies/${site}`,
      { method: 'POST', body: form },
    );
  },

  deleteCookies: (site: string) =>
    request<{ ok: boolean; cookies: Record<string, boolean> }>(`/api/ingest/cookies/${site}`, { method: 'DELETE' }),

  /**
   * Save a session from whatever the user managed to copy — a cURL command,
   * a cookie header, a cookies.txt, an extension's JSON export, or the bare
   * value. The server detects the format.
   */
  saveSession: (site: string, blob: string) =>
    request<{
      ok: boolean;
      site: string;
      format: string;
      written: string[];
      cookies: Record<string, boolean>;
    }>(`/api/ingest/session/${site}`, { method: 'POST', body: JSON.stringify({ blob }) }),

  /** Dry-run a link through the real downloader. */
  probe: (url: string) =>
    request<ProbeResult>('/api/ingest/probe', { method: 'POST', body: JSON.stringify({ url }) }),

  cancelImport: (jobId: number) => request<{ ok: boolean }>(`/api/imports/${jobId}`, { method: 'DELETE' }),

  // ── Clip studio ──────────────────────────────────────────────────────────
  /**
   * Read a video's timeline without downloading it.
   *
   * POST, not GET: this spawns a yt-dlp process per call, which is not
   * something a browser or proxy should feel free to prefetch.
   */
  resolveVideo: (url: string) =>
    request<StudioResolve>('/api/studio/resolve', { method: 'POST', body: JSON.stringify({ url }) }),

  /** Queue a range for download. Returns as soon as the job is enqueued. */
  createStudioClip: (input: {
    url: string;
    startMs: number;
    endMs: number;
    title?: string;
    categoryId?: string | null;
    mute?: boolean;
  }) => request<StudioClipResult>('/api/studio/clip', { method: 'POST', body: JSON.stringify(input) }),

  // ── System / admin ───────────────────────────────────────────────────────
  systemStatus: () => request<SystemStatus>('/api/system/status'),

  failures: () =>
    request<{
      failures: Array<{
        id: number;
        type: string;
        clipId: string | null;
        attempts: number;
        error: string | null;
        updatedAt: number;
        url: string | null;
      }>;
    }>('/api/system/failures'),

  retryJob: (id: number) => request<{ ok: boolean }>(`/api/system/jobs/${id}/retry`, { method: 'POST' }),

  reindex: () => request<{ ok: boolean; indexed: number }>('/api/system/reindex', { method: 'POST' }),

  retagMissing: () => request<{ ok: boolean; queued: number }>('/api/system/retag-missing', { method: 'POST' }),

  purge: (olderThanDays = 0) =>
    request<{ ok: boolean; purged: number; prunedTags: number }>('/api/system/purge', {
      method: 'POST',
      body: JSON.stringify({ olderThanDays }),
    }),

  invites: () => request<{ invites: Invite[] }>('/api/invites'),

  createInvite: (input: { note?: string; maxUses?: number; expiresInDays?: number; role?: Role } = {}) =>
    request<{ invite: Invite }>('/api/invites', { method: 'POST', body: JSON.stringify(input) }),

  revokeInvite: (code: string) => request<{ ok: boolean }>(`/api/invites/${code}`, { method: 'DELETE' }),

  deleteUser: (id: string) => request<{ ok: boolean }>(`/api/users/${id}`, { method: 'DELETE' }),
};
