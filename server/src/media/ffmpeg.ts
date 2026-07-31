import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { run } from '../util/proc.ts';

export type ProbeResult = {
  durationMs: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  hasAudio: boolean;
  videoCodec: string | null;
  audioCodec: string | null;
  pixelFormat: string | null;
  formatNames: string[];
  bitrate: number | null;
  /** True when the file has video frames but only one of them. */
  isStillImage: boolean;
};

type FfprobeStream = {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  duration?: string;
  nb_frames?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  tags?: Record<string, string>;
};

type FfprobeOutput = {
  streams?: FfprobeStream[];
  format?: { duration?: string; format_name?: string; bit_rate?: string };
};

function parseRational(value: string | undefined): number | null {
  if (!value) return null;
  const [numerator, denominator] = value.split('/');
  const n = Number(numerator);
  const d = denominator === undefined ? 1 : Number(denominator);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return null;
  const result = n / d;
  return Number.isFinite(result) && result > 0 ? result : null;
}

export async function probe(path: string): Promise<ProbeResult> {
  const { stdout } = await run(
    'ffprobe',
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path],
    { timeoutMs: 60_000 },
  );

  let parsed: FfprobeOutput;
  try {
    parsed = JSON.parse(stdout) as FfprobeOutput;
  } catch {
    throw new Error('ffprobe returned output that could not be parsed as JSON');
  }

  const streams = parsed.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');

  const durationSeconds = Number(parsed.format?.duration ?? video?.duration ?? NaN);
  const fps = parseRational(video?.avg_frame_rate) ?? parseRational(video?.r_frame_rate);
  const frameCount = Number(video?.nb_frames ?? NaN);

  // A JPEG/PNG still probes as a one-frame video stream. Detect it so we do
  // not try to build a hover-preview loop out of a photo.
  const isStillImage =
    !!video &&
    !audio &&
    (frameCount === 1 ||
      ['mjpeg', 'png', 'bmp', 'webp', 'tiff'].includes(video.codec_name ?? '') ||
      (!Number.isFinite(durationSeconds) && !Number.isFinite(frameCount)));

  return {
    durationMs: Number.isFinite(durationSeconds) && durationSeconds > 0 ? Math.round(durationSeconds * 1000) : null,
    width: video?.width ?? null,
    height: video?.height ?? null,
    fps: fps && fps < 1000 ? Math.round(fps * 100) / 100 : null,
    hasAudio: Boolean(audio),
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    pixelFormat: video?.pix_fmt ?? null,
    formatNames: (parsed.format?.format_name ?? '').split(',').filter(Boolean),
    bitrate: Number.isFinite(Number(parsed.format?.bit_rate)) ? Number(parsed.format?.bit_rate) : null,
    isStillImage,
  };
}

/**
 * Whether the file needs re-encoding to play reliably in a browser.
 *
 * GIFs always do — a 10 MB GIF becomes a ~400 KB MP4 that seeks and loops far
 * better. Otherwise we only re-encode codecs browsers won't take, so the
 * common case (a TikTok or Reel, already H.264/AAC in MP4) is a straight copy.
 */
export function needsTranscode(p: ProbeResult, ext: string): boolean {
  if (ext === 'gif') return true;
  if (p.isStillImage) return false;

  const browserSafeVideo = ['h264', 'vp8', 'vp9', 'av1'];
  const browserSafeAudio = ['aac', 'opus', 'vorbis', 'mp3'];
  const browserSafeContainer = ['mp4', 'mov', 'webm', 'matroska'];

  if (p.videoCodec && !browserSafeVideo.includes(p.videoCodec)) return true;
  if (p.audioCodec && !browserSafeAudio.includes(p.audioCodec)) return true;
  if (!p.formatNames.some((name) => browserSafeContainer.includes(name))) return true;

  // 4:2:2 / 4:4:4 and 10-bit decode in almost nothing. yuv420p or bust.
  if (p.pixelFormat && !['yuv420p', 'yuvj420p'].includes(p.pixelFormat)) return true;

  return false;
}

/** Even dimensions, because H.264 4:2:0 cannot encode an odd width or height. */
const EVEN_DIMENSIONS = 'scale=trunc(iw/2)*2:trunc(ih/2)*2';

export async function transcodeToMp4(input: string, output: string, opts: { hasAudio: boolean }): Promise<void> {
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    input,
    '-vf',
    EVEN_DIMENSIONS,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '23',
    '-pix_fmt',
    'yuv420p',
    // Frequent keyframes: viewers scrub short clips constantly and this makes
    // seeking land instantly instead of after a GOP of decode.
    '-g',
    '60',
    // Puts the moov atom first so the browser can start playing before the
    // whole file has arrived. Without it, progressive playback fails.
    '-movflags',
    '+faststart',
  ];

  if (opts.hasAudio) {
    args.push('-c:a', 'aac', '-b:a', '128k', '-ac', '2');
  } else {
    args.push('-an');
  }

  args.push(output);
  await run('ffmpeg', args, { timeoutMs: 30 * 60 * 1000 });
}

/** Remux into MP4 without re-encoding — cheap, just fixes the container. */
export async function remuxToMp4(input: string, output: string): Promise<void> {
  await run(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-c', 'copy', '-movflags', '+faststart', output],
    { timeoutMs: 5 * 60 * 1000 },
  );
}

/**
 * Cut an exact range out of a file.
 *
 * Re-encodes rather than stream-copying, because a copy can only cut on a
 * keyframe — on a YouTube video that is every 2–10 seconds, so "start at
 * 1:04.5" would silently become "start at 1:02", which is the difference
 * between landing the punchline and clipping over it. Seeking before `-i`
 * still keeps it fast: ffmpeg jumps to the preceding keyframe and decodes
 * forward, rather than decoding the whole file from zero.
 */
export async function trimSegment(
  input: string,
  output: string,
  opts: { startMs: number; endMs: number; hasAudio: boolean; mute?: boolean },
): Promise<void> {
  const startSeconds = Math.max(0, opts.startMs / 1000);
  const durationSeconds = Math.max(0.05, (opts.endMs - opts.startMs) / 1000);

  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-ss',
    startSeconds.toFixed(3),
    '-i',
    input,
    '-t',
    durationSeconds.toFixed(3),
    '-vf',
    EVEN_DIMENSIONS,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    // A notch better than the general transcode: this file is the master the
    // library keeps, and derive() will stream it as-is rather than re-encode.
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    '-g',
    '60',
    '-movflags',
    '+faststart',
  ];

  if (opts.hasAudio && !opts.mute) {
    args.push('-c:a', 'aac', '-b:a', '128k', '-ac', '2');
  } else {
    args.push('-an');
  }

  args.push(output);
  await run('ffmpeg', args, { timeoutMs: 20 * 60 * 1000 });
}

/**
 * Grab a poster frame.
 *
 * Seeks ~25% in rather than to 0: the first frame of a Reel or TikTok is very
 * often black, a fade-in, or a platform splash.
 */
export async function makePoster(
  input: string,
  output: string,
  opts: { durationMs: number | null; maxWidth?: number } = { durationMs: null },
): Promise<void> {
  const maxWidth = opts.maxWidth ?? 720;
  const seekSeconds = opts.durationMs && opts.durationMs > 1500 ? (opts.durationMs / 1000) * 0.25 : 0;

  await run(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      // -ss before -i is a fast keyframe seek; accuracy does not matter here.
      ...(seekSeconds > 0 ? ['-ss', seekSeconds.toFixed(3)] : []),
      '-i',
      input,
      '-frames:v',
      '1',
      '-vf',
      `scale='min(${maxWidth},iw)':-2:flags=lanczos`,
      '-q:v',
      '3',
      output,
    ],
    { timeoutMs: 120_000 },
  );
}

/**
 * A short, silent, low-bitrate loop for hover-to-preview in the grid.
 *
 * Muted and small on purpose: this autoplays in a grid where a dozen may be
 * in flight, so it has to be cheap on bandwidth and never make noise.
 */
export async function makePreview(
  input: string,
  output: string,
  opts: { durationMs: number | null; maxWidth?: number } = { durationMs: null },
): Promise<void> {
  const maxWidth = opts.maxWidth ?? 480;
  const total = (opts.durationMs ?? 0) / 1000;
  const previewSeconds = Math.min(total > 0 ? total : 4, 4);
  const start = total > 6 ? total * 0.2 : 0;

  await run(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      ...(start > 0 ? ['-ss', start.toFixed(3)] : []),
      '-i',
      input,
      '-t',
      previewSeconds.toFixed(3),
      '-an',
      '-vf',
      `scale='min(${maxWidth},iw)':-2:flags=lanczos,fps=20`,
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '30',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      output,
    ],
    { timeoutMs: 10 * 60 * 1000 },
  );
}

export type Keyframe = { index: number; atMs: number; data: Buffer };

/**
 * Sample frames across the clip for the AI tagger.
 *
 * Sampling is spread over the middle 90% so we skip fade-ins and end cards,
 * and each frame is scaled down before it ever leaves ffmpeg — image tokens
 * are (width x height) / 750, so this is the main lever on tagging cost.
 */
export async function extractKeyframes(
  input: string,
  opts: { count: number; width: number; durationMs: number | null; workDir: string },
): Promise<Keyframe[]> {
  const { count, width, durationMs, workDir } = opts;
  await mkdir(workDir, { recursive: true });

  try {
    const totalSeconds = durationMs ? durationMs / 1000 : 0;

    // A still image or a clip too short to sample meaningfully: one frame.
    if (totalSeconds < 0.5) {
      const out = join(workDir, 'kf-0.jpg');
      await run(
        'ffmpeg',
        [
          '-hide_banner', '-loglevel', 'error', '-y',
          '-i', input,
          '-frames:v', '1',
          '-vf', `scale='min(${width},iw)':-2:flags=lanczos`,
          '-q:v', '4',
          out,
        ],
        { timeoutMs: 60_000 },
      );
      return [{ index: 0, atMs: 0, data: await readFile(out) }];
    }

    const first = totalSeconds * 0.05;
    const last = totalSeconds * 0.95;
    const span = last - first;
    const effectiveCount = Math.max(1, Math.min(count, Math.ceil(totalSeconds * 2)));

    const frames: Keyframe[] = [];
    for (let i = 0; i < effectiveCount; i += 1) {
      // Sample at interval midpoints so the frames are evenly distributed
      // rather than clustered at either end.
      const at = first + (span * (i + 0.5)) / effectiveCount;
      const out = join(workDir, `kf-${i}.jpg`);

      try {
        await run(
          'ffmpeg',
          [
            '-hide_banner', '-loglevel', 'error', '-y',
            '-ss', at.toFixed(3),
            '-i', input,
            '-frames:v', '1',
            '-vf', `scale='min(${width},iw)':-2:flags=lanczos`,
            '-q:v', '4',
            out,
          ],
          { timeoutMs: 60_000 },
        );
        frames.push({ index: i, atMs: Math.round(at * 1000), data: await readFile(out) });
      } catch {
        // A seek past a truncated stream fails for that frame only. Better to
        // tag from five frames than to fail the whole clip.
      }
    }

    return frames;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/**
 * Transcribe speech using ffmpeg's Whisper filter when the build has it.
 *
 * Optional by design: it materially improves tags on talking-head clips, but
 * plenty of ffmpeg builds ship without the filter and a missing transcript is
 * not worth failing an ingest over.
 */
export async function tryTranscribe(input: string, opts: { durationMs: number | null }): Promise<string | null> {
  if (!opts.durationMs || opts.durationMs < 1000) return null;

  try {
    const { stdout } = await run(
      'ffmpeg',
      [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-i', input,
        '-vn',
        '-af', 'whisper=model=/models/ggml-base.en.bin:format=text',
        '-f', 'null', '-',
      ],
      { timeoutMs: 5 * 60 * 1000, allowFailure: true },
    );

    const text = stdout.trim();
    return text.length > 2 ? text.slice(0, 8000) : null;
  } catch {
    return null;
  }
}
