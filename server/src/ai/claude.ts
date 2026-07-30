import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.ts';
import { SYSTEM_PROMPT, TAGGING_SCHEMA, buildUserPrompt } from './prompt.ts';
import { HUMOR_STYLES, TaggingUnavailableError, type HumorStyle, type Tagger, type TaggingContext, type TaggingResult, type TagSuggestion } from './types.ts';

/**
 * Published per-MTok rates, used only to attribute a cost to each clip in the
 * UI. Wrong numbers here mean a wrong dashboard, never a wrong bill.
 */
const PRICING_PER_MTOK: Readonly<Record<string, { input: number; output: number }>> = {
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
};

function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const rates = PRICING_PER_MTOK[model];
  if (!rates) return 0;
  const cost = (inputTokens / 1_000_000) * rates.input + (outputTokens / 1_000_000) * rates.output;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

type RawTagging = {
  title?: unknown;
  description?: unknown;
  tags?: unknown;
  subjects?: unknown;
  humor_style?: unknown;
  suggested_categories?: unknown;
  on_screen_text?: unknown;
  is_nsfw?: unknown;
};

function asStringArray(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];

  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const cleaned = entry.trim().replace(/^#/, '').replace(/\s+/g, ' ').slice(0, 48);
    if (cleaned.length < 2) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
    if (out.length >= limit) break;
  }

  return out;
}

function asString(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, limit) : '';
}

/**
 * Turn the model's JSON into our shape.
 *
 * Structured outputs guarantee the schema is satisfied, not that the values
 * are sane — so bounds, deduplication and the humour-style fallback are
 * enforced here rather than assumed.
 */
export function normaliseTaggingResponse(
  raw: RawTagging,
  meta: { model: string; inputTokens: number; outputTokens: number },
): TaggingResult {
  const humorRaw = asString(raw.humor_style, 32).toLowerCase();
  const humorStyle: HumorStyle = (HUMOR_STYLES as readonly string[]).includes(humorRaw)
    ? (humorRaw as HumorStyle)
    : 'unclear';

  const topics = asStringArray(raw.tags, 14);
  const subjects = asStringArray(raw.subjects, 8);

  const tags: TagSuggestion[] = [
    ...topics.map((name): TagSuggestion => ({ name, kind: 'topic' })),
    ...subjects.map((name): TagSuggestion => ({ name, kind: 'subject' })),
  ];
  if (humorStyle !== 'unclear') tags.push({ name: humorStyle, kind: 'humor' });

  // Drop duplicates that arise when a subject repeats a topic.
  const deduped: TagSuggestion[] = [];
  const seen = new Set<string>();
  for (const tag of tags) {
    const key = tag.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(tag);
  }

  const onScreenText = asString(raw.on_screen_text, 1000);

  return {
    // A blank title would leave an unlabelled card in the grid, so fall back
    // to the description's first clause.
    title: asString(raw.title, 140) || asString(raw.description, 80) || 'Untitled clip',
    description: asString(raw.description, 600),
    tags: deduped,
    humorStyle,
    suggestedCategories: asStringArray(raw.suggested_categories, 3),
    onScreenText: onScreenText.length > 1 ? onScreenText : null,
    isNsfw: raw.is_nsfw === true,
    model: meta.model,
    costUsd: estimateCostUsd(meta.model, meta.inputTokens, meta.outputTokens),
    inputTokens: meta.inputTokens,
    outputTokens: meta.outputTokens,
  };
}

export function createClaudeTagger(): Tagger {
  if (!config.tagger.anthropicApiKey) {
    throw new TaggingUnavailableError('ANTHROPIC_API_KEY is not configured.');
  }

  const client = new Anthropic({
    apiKey: config.tagger.anthropicApiKey,
    // The SDK retries 429 and 5xx with backoff; tagging is a background job,
    // so let it try harder than the default before we burn a job attempt.
    maxRetries: 4,
    timeout: 120_000,
  });

  const model = config.tagger.model;

  return {
    name: 'claude',
    model,

    async tag(context: TaggingContext): Promise<TaggingResult> {
      if (context.keyframes.length === 0) {
        throw new Error('No frames could be extracted from this clip.');
      }

      const imageBlocks = context.keyframes.map((frame) => ({
        type: 'image' as const,
        source: {
          type: 'base64' as const,
          media_type: 'image/jpeg' as const,
          data: frame.data.toString('base64'),
        },
      }));

      const response = await client.messages.create({
        model,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        // Constrains the response to the schema, so there is no prose to strip
        // and no JSON-in-a-code-fence to unwrap.
        output_config: { format: { type: 'json_schema', schema: TAGGING_SCHEMA } },
        messages: [
          {
            role: 'user',
            // Frames first, then the instruction: with images leading, the
            // model has seen the evidence before it reads what to do with it.
            content: [...imageBlocks, { type: 'text', text: buildUserPrompt(context) }],
          },
        ],
      });

      if (response.stop_reason === 'refusal') {
        throw new Error('The model declined to describe this clip.');
      }

      const textBlock = response.content.find((block) => block.type === 'text');
      if (!textBlock || textBlock.type !== 'text') {
        throw new Error('The model returned no text content.');
      }

      let parsed: RawTagging;
      try {
        parsed = JSON.parse(textBlock.text) as RawTagging;
      } catch {
        // With structured outputs this should be unreachable; a max_tokens cut
        // is the one way it happens, so name that explicitly.
        throw new Error(
          response.stop_reason === 'max_tokens'
            ? 'The response was cut off before the JSON was complete.'
            : 'The model returned content that was not valid JSON.',
        );
      }

      return normaliseTaggingResponse(parsed, {
        model,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      });
    },
  };
}
