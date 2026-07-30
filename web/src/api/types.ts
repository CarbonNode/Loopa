export type Role = 'admin' | 'member';

export type User = {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  avatarColor: string;
  createdAt: number;
};

export type Tag = { id: string; name: string; kind: string };
export type TagWithCount = Tag & { count: number };

export type ClipKind = 'video' | 'gif' | 'image';
export type ClipStatus = 'processing' | 'ready' | 'failed';
export type AiStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export type Clip = {
  id: string;
  kind: ClipKind;
  title: string;
  description: string;
  width: number | null;
  height: number | null;
  aspectRatio: number | null;
  durationMs: number | null;
  hasAudio: boolean;
  bytes: number;
  status: ClipStatus;
  error: string | null;
  ai: {
    status: AiStatus;
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
  count: number;
};

export type ClipPage = { clips: Clip[]; nextCursor: string | null; total: number };

export type LibraryStats = {
  clips: number;
  processing: number;
  failed: number;
  untagged: number;
  categories: number;
  tags: number;
  bytes: number;
  aiSpendUsd: number;
};

export type JobStats = { queued: number; running: number; done: number; failed: number };

/** A download that is queued, running, or waiting to retry. */
export type PendingImport = {
  jobId: number;
  url: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  runAfter: number;
  createdAt: number;
  /** Set for studio cuts, e.g. "0:30 – 0:38". Null for a whole-post import. */
  label: string | null;
};

export type SystemStatus = {
  jobs: JobStats;
  stats: LibraryStats;
  tagger: { enabled: boolean; provider: string; model: string | null };
  pendingImports: PendingImport[];
};

export type ProbeResult = {
  ok: boolean;
  site: string;
  title?: string;
  uploader?: string;
  durationMs?: number | null;
  error?: string;
  hint?: string;
  usedCookies: boolean;
};

export type IngestStatus = {
  enabled: boolean;
  ytDlpVersion: string | null;
  cookies: Record<string, boolean>;
  maxUrlBytes: number;
  maxUploadBytes: number;
};

export type Invite = {
  code: string;
  created_by: string | null;
  role: Role;
  note: string | null;
  max_uses: number;
  uses: number;
  expires_at: number | null;
  revoked_at: number | null;
  created_at: number;
  url: string;
};

export type UploadResult = {
  clips: Clip[];
  duplicates: string[];
  failures: Array<{ filename: string; error: string; hint?: string }>;
};

export type ImportResult = {
  queued: Array<{ jobId: number; url: string; site: string }>;
  rejected: Array<{ url: string; error: string; hint?: string }>;
};

// ── Clip studio ────────────────────────────────────────────────────────────

export type VideoChapter = { title: string; startMs: number; endMs: number };

/** A "most replayed" sample, normalised to 0–1. YouTube only. */
export type HeatPoint = { atMs: number; value: number };

export type ResolvedVideo = {
  siteId: string;
  siteLabel: string;
  videoId: string | null;
  canonicalUrl: string;
  title: string | null;
  description: string | null;
  uploader: string | null;
  uploaderUrl: string | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  thumbnail: string | null;
  isLive: boolean;
  ageLimit: number;
  viewCount: number | null;
  chapters: VideoChapter[];
  heatmap: HeatPoint[];
  hashtags: string[];
};

export type StudioResolve = {
  video: ResolvedVideo;
  limits: { maxClipSeconds: number; maxClipHeight: number };
};

export type StudioClipResult = {
  jobId: number;
  site: string;
  url: string;
  startMs: number;
  endMs: number;
  lengthMs: number;
};

export type SortKey = 'recent' | 'oldest' | 'popular' | 'random' | 'title';

export type Filters = {
  query: string;
  categoryId: string | null;
  tagId: string | null;
  favorites: boolean;
  kind: ClipKind | null;
  sort: SortKey;
};
