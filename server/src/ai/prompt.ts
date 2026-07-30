import { HUMOR_STYLES, type TaggingContext } from './types.ts';

/**
 * The JSON schema the model must fill.
 *
 * Structured outputs reject numeric/length constraints (minItems, maxLength,
 * minimum), so counts and limits are expressed in the prompt instead and
 * enforced when parsing. `additionalProperties: false` and a full `required`
 * list are mandatory.
 */
export const TAGGING_SCHEMA = {
  type: 'object',
  properties: {
    title: {
      type: 'string',
      description: 'A short, punchy title in plain sentence case — how a friend would label this in a chat. No quotes, no trailing period.',
    },
    description: {
      type: 'string',
      description: 'One or two sentences describing what literally happens, concretely enough that someone searching later would recognise it.',
    },
    tags: {
      type: 'array',
      description: 'Six to twelve lowercase search keywords: what is visible, who or what is in it, the setting, and the kind of joke.',
      items: { type: 'string' },
    },
    subjects: {
      type: 'array',
      description: 'The people, animals, characters, or objects the clip is actually about. Lowercase. Empty if unclear.',
      items: { type: 'string' },
    },
    humor_style: {
      type: 'string',
      description: 'The single closest match for why this is funny.',
      enum: [...HUMOR_STYLES],
    },
    suggested_categories: {
      type: 'array',
      description: 'One to three collection names this belongs in. Reuse an existing category name verbatim when one fits.',
      items: { type: 'string' },
    },
    on_screen_text: {
      type: 'string',
      description: 'Any caption, subtitle or sign text visible in the frames, transcribed verbatim. Empty string if there is none.',
    },
    is_nsfw: {
      type: 'boolean',
      description: 'True only for sexual content, graphic gore, or real violence. Ordinary swearing and crude jokes are not NSFW.',
    },
  },
  required: ['title', 'description', 'tags', 'subjects', 'humor_style', 'suggested_categories', 'on_screen_text', 'is_nsfw'],
  additionalProperties: false,
} as const;

export const SYSTEM_PROMPT = `You catalogue short funny videos for a private library that a group of friends shares.

Your job is to make each clip findable months later, when someone half-remembers it and searches for the wrong words. Write what you actually see, in the words a person would reach for — not gallery-caption prose.

How to write each field:

TITLE — how a friend would label it when sending it to the group. Concrete and specific: name the thing that happens. "Cat knocks over the entire christmas tree" beats "Funny cat video". Never start with "A video of" or "This clip shows".

DESCRIPTION — one or two sentences on what literally happens, start to finish, including the punchline. Someone who watched it a year ago should read this and go "oh, that one". Do not analyse why it is funny; describe what occurs.

TAGS — six to twelve lowercase keywords, each one to three words, covering:
  - what is visible: objects, animals, places, actions
  - who is in it: named people, character types, groups
  - the setting: kitchen, gym, wedding, street
  - the type of joke: fail, prank, misheard, timing
Include the obvious ones. Someone will type "dog" before they type "golden retriever mid-air fail", so include both. Skip anything you cannot actually see.

SUBJECTS — the specific people, animals, characters or objects the clip is about. Use real names only when you genuinely recognise them; never guess at a name.

SUGGESTED_CATEGORIES — where this belongs in a shelf of collections. Reuse an existing category name exactly as written when one fits; only invent a name when nothing does.

ON_SCREEN_TEXT — transcribe captions, subtitles, signs and overlays verbatim. This is often where the joke actually lives, especially on TikTok and Reels. Empty string if there is genuinely no text.

IS_NSFW — true only for sexual content, graphic gore, or real violence. Swearing, crude humour and slapstick injury are not NSFW.

Ground everything in the frames and the supplied metadata. When a detail is unclear, leave it out rather than inventing it — a wrong tag is worse than a missing one, because it surfaces the clip on searches it has nothing to do with.`;

/** The text block that accompanies the frames. */
export function buildUserPrompt(context: TaggingContext): string {
  const lines: string[] = [];

  const frameCount = context.keyframes.length;
  if (context.kind === 'image') {
    lines.push('Below is a single still image.');
  } else {
    const duration = context.durationMs ? `${(context.durationMs / 1000).toFixed(1)}s` : 'unknown length';
    lines.push(
      `Below ${frameCount === 1 ? 'is 1 frame' : `are ${frameCount} frames`} sampled evenly through a ${duration} ${context.kind === 'gif' ? 'GIF' : 'video'}, in chronological order.`,
    );
    if (!context.hasAudio && context.kind === 'video') {
      lines.push('The video has no audio track, so everything must be inferred visually.');
    }
  }

  // Platform metadata materially improves tags — the caption on a Reel or
  // TikTok is frequently the entire joke and is invisible in the frames.
  const metadata: string[] = [];
  if (context.siteLabel && context.siteLabel !== 'Direct file') metadata.push(`Source: ${context.siteLabel}`);
  if (context.uploader) metadata.push(`Posted by: ${context.uploader}`);
  if (context.caption) metadata.push(`Caption: ${truncate(context.caption, 1200)}`);
  if (context.hashtags.length > 0) metadata.push(`Hashtags: ${context.hashtags.slice(0, 20).map((h) => `#${h}`).join(' ')}`);
  if (context.filename && !/^(video|download|clip|untitled|img|vid)[-_.\d]*$/i.test(context.filename)) {
    metadata.push(`Filename: ${truncate(context.filename, 120)}`);
  }
  if (context.transcript) metadata.push(`Spoken audio (auto-transcribed, may contain errors): ${truncate(context.transcript, 2000)}`);

  if (metadata.length > 0) {
    lines.push('', 'Context from where this came from:', ...metadata.map((line) => `- ${line}`));
    lines.push(
      '',
      'Treat that context as a strong hint but not as truth — captions are often jokes, sarcasm, or unrelated. If the frames contradict the caption, trust the frames.',
    );
  }

  if (context.existingCategories.length > 0) {
    lines.push(
      '',
      `Categories that already exist in this library: ${context.existingCategories.slice(0, 60).join(', ')}.`,
      'Reuse one of those names verbatim if it fits, rather than inventing a near-duplicate.',
    );
  }

  return lines.join('\n');
}

function truncate(value: string, max: number): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max)}…`;
}
