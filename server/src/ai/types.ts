import type { Keyframe } from '../media/ffmpeg.ts';

/** Coarse buckets, kept short so the model picks decisively. */
export const HUMOR_STYLES = [
  'slapstick',
  'fail',
  'wholesome',
  'absurd',
  'deadpan',
  'reaction',
  'wordplay',
  'cringe',
  'satire',
  'animal',
  'meme-format',
  'unclear',
] as const;

export type HumorStyle = (typeof HUMOR_STYLES)[number];

export type TagSuggestion = { name: string; kind: 'topic' | 'subject' | 'humor' | 'mood' | 'source' | 'text' };

export type TaggingResult = {
  title: string;
  description: string;
  tags: TagSuggestion[];
  humorStyle: HumorStyle;
  suggestedCategories: string[];
  onScreenText: string | null;
  isNsfw: boolean;
  model: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
};

/**
 * Everything the tagger gets to look at.
 *
 * `caption`, `uploader` and `hashtags` come from the source platform and carry
 * real signal — on a Reel or TikTok the caption is often the joke, and the
 * frames alone would miss it entirely.
 */
export type TaggingContext = {
  keyframes: readonly Keyframe[];
  durationMs: number | null;
  hasAudio: boolean;
  kind: 'video' | 'gif' | 'image';
  filename: string | null;
  caption: string | null;
  uploader: string | null;
  siteLabel: string | null;
  hashtags: readonly string[];
  transcript: string | null;
  /** Existing category names, so suggestions reuse them instead of inventing near-duplicates. */
  existingCategories: readonly string[];
};

export type Tagger = {
  readonly name: string;
  readonly model: string;
  tag(context: TaggingContext): Promise<TaggingResult>;
};

export class TaggingUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaggingUnavailableError';
  }
}
