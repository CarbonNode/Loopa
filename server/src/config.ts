import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

export type TaggerProvider = 'claude' | 'local' | 'disabled';

function env(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

function envInt(name: string, fallback: number, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}): number {
  const raw = env(name);
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be an integer, got ${JSON.stringify(raw)}`);
  }
  if (parsed < min || parsed > max) {
    throw new Error(`${name} must be between ${min} and ${max}, got ${parsed}`);
  }
  return parsed;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = env(name)?.toLowerCase();
  if (raw === undefined) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  throw new Error(`${name} must be a boolean-ish value, got ${JSON.stringify(raw)}`);
}

function absolutise(value: string, label: string): string {
  const path = isAbsolute(value) ? value : resolve(process.cwd(), value);
  try {
    mkdirSync(path, { recursive: true });
  } catch (cause) {
    throw new Error(`Could not create ${label} at ${path}: ${(cause as Error).message}`, { cause });
  }
  return path;
}

/**
 * A session secret that survives restarts.
 *
 * Explicitly configuring SESSION_SECRET is correct for production. But an
 * unset secret must not silently regenerate on every boot — that logs every
 * user out on each restart and reads as a mysterious auth bug. So we persist a
 * generated one to disk and warn loudly instead.
 */
function resolveSessionSecret(dataDir: string): { secret: string; generated: boolean } {
  const configured = env('SESSION_SECRET');
  if (configured) {
    if (configured.length < 32) {
      throw new Error('SESSION_SECRET must be at least 32 characters. Generate one with: openssl rand -hex 32');
    }
    return { secret: configured, generated: false };
  }

  const secretFile = join(dataDir, '.session-secret');
  if (existsSync(secretFile)) {
    const stored = readFileSync(secretFile, 'utf8').trim();
    if (stored.length >= 32) return { secret: stored, generated: true };
  }

  const generated = randomBytes(32).toString('hex');
  writeFileSync(secretFile, generated, { mode: 0o600 });
  return { secret: generated, generated: true };
}

function buildConfig() {
  const dataDir = absolutise(env('DATA_DIR') ?? './data', 'DATA_DIR');
  const mediaDir = absolutise(env('MEDIA_DIR') ?? './media', 'MEDIA_DIR');
  const { secret: sessionSecret, generated: sessionSecretGenerated } = resolveSessionSecret(dataDir);

  const taggerProviderRaw = (env('TAGGER_PROVIDER') ?? 'claude').toLowerCase();
  if (!['claude', 'local', 'disabled'].includes(taggerProviderRaw)) {
    throw new Error(`TAGGER_PROVIDER must be one of claude|local|disabled, got ${JSON.stringify(taggerProviderRaw)}`);
  }
  const taggerProvider = taggerProviderRaw as TaggerProvider;

  const anthropicApiKey = env('ANTHROPIC_API_KEY');
  if (taggerProvider === 'claude' && !anthropicApiKey) {
    // Degrade rather than refuse to boot: an unusable tagger shouldn't stop
    // people watching the clips they already have.
    console.warn(
      '[config] TAGGER_PROVIDER=claude but ANTHROPIC_API_KEY is unset — AI tagging is disabled. ' +
        'Clips will still ingest, and you can re-tag them once a key is configured.',
    );
  }

  const publicUrl = (env('PUBLIC_URL') ?? `http://localhost:${envInt('PORT', 8080, { max: 65535 })}`).replace(/\/+$/, '');

  return {
    env: env('NODE_ENV') ?? 'development',
    isProduction: (env('NODE_ENV') ?? 'development') === 'production',

    port: envInt('PORT', 8080, { max: 65535 }),
    host: env('HOST') ?? '0.0.0.0',
    publicUrl,
    /** Cookies get the Secure flag only when we're actually served over TLS. */
    secureCookies: publicUrl.startsWith('https://'),

    dataDir,
    mediaDir,
    dbPath: join(dataDir, 'loopa.db'),
    originalsDir: join(mediaDir, 'originals'),
    derivedDir: join(mediaDir, 'derived'),
    tmpDir: join(mediaDir, 'tmp'),

    sessionSecret,
    sessionSecretGenerated,
    sessionTtlMs: 1000 * 60 * 60 * 24 * 30,

    maxUploadBytes: envInt('MAX_UPLOAD_BYTES', 2 * 1024 * 1024 * 1024),
    maxUrlBytes: envInt('MAX_URL_BYTES', 1024 * 1024 * 1024),
    enableUrlIngest: envBool('ENABLE_URL_INGEST', true),
    /**
     * Optional proxy for yt-dlp.
     *
     * TikTok blocks datacenter IP ranges outright ("Your IP address is
     * blocked from accessing this post") regardless of cookies. From a
     * residential connection this is unnecessary; from a VPS or a cloud
     * container it is the only way through.
     */
    ytDlpProxy: env('YTDLP_PROXY'),
    /**
     * Explicit path to the yt-dlp binary.
     *
     * `pip install --user yt-dlp` puts it in ~/.local/bin, which is on an
     * interactive shell's PATH but not on the minimal PATH a service or
     * container process inherits. Leave unset to auto-detect.
     */
    ytDlpPath: env('YTDLP_PATH'),

    tagger: {
      provider: anthropicApiKey || taggerProvider !== 'claude' ? taggerProvider : ('disabled' as TaggerProvider),
      model: env('TAGGER_MODEL') ?? 'claude-haiku-4-5',
      keyframes: envInt('TAGGER_KEYFRAMES', 6, { min: 1, max: 20 }),
      frameWidth: envInt('TAGGER_FRAME_WIDTH', 512, { min: 128, max: 2048 }),
      anthropicApiKey,
      localUrl: env('LOCAL_TAGGER_URL') ?? 'http://host.docker.internal:11434/v1',
      localModel: env('LOCAL_TAGGER_MODEL') ?? 'qwen2.5-vl:7b',
    },

    workers: {
      transcodeConcurrency: envInt('TRANSCODE_CONCURRENCY', 3, { max: 32 }),
      taggingConcurrency: envInt('TAGGING_CONCURRENCY', 4, { max: 32 }),
    },
  };
}

export const config = buildConfig();
export type Config = typeof config;

// Derived media directories are created eagerly so the first upload never
// races on mkdir.
for (const dir of [config.originalsDir, config.derivedDir, config.tmpDir]) {
  mkdirSync(dir, { recursive: true });
}
