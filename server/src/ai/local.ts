import { config } from '../config.ts';
import { normaliseTaggingResponse } from './claude.ts';
import { SYSTEM_PROMPT, TAGGING_SCHEMA, buildUserPrompt } from './prompt.ts';
import type { Tagger, TaggingContext, TaggingResult } from './types.ts';

type ChatCompletion = {
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
};

/**
 * Strip a markdown fence if the model wrapped its JSON in one.
 *
 * Local models honour a JSON-schema request far less reliably than the hosted
 * API, so this path has to be tolerant where the Claude path can be strict.
 */
function extractJson(content: string): string {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) return fenced[1].trim();

  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start >= 0 && end > start) return content.slice(start, end + 1);

  return content.trim();
}

/**
 * Tag against a self-hosted, OpenAI-compatible vision endpoint — Ollama,
 * vLLM, LM Studio.
 *
 * Free per clip, which matters at bulk-import scale. The trade is that it
 * depends on a machine being awake with a GPU free.
 */
export function createLocalTagger(): Tagger {
  const baseUrl = config.tagger.localUrl.replace(/\/+$/, '');
  const model = config.tagger.localModel;

  return {
    name: 'local',
    model,

    async tag(context: TaggingContext): Promise<TaggingResult> {
      if (context.keyframes.length === 0) {
        throw new Error('No frames could be extracted from this clip.');
      }

      const content = [
        ...context.keyframes.map((frame) => ({
          type: 'image_url' as const,
          image_url: { url: `data:image/jpeg;base64,${frame.data.toString('base64')}` },
        })),
        { type: 'text' as const, text: buildUserPrompt(context) },
      ];

      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(180_000),
        body: JSON.stringify({
          model,
          max_tokens: 1024,
          temperature: 0.2,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content },
          ],
          // Honoured by vLLM and llama.cpp; harmlessly ignored elsewhere, which
          // is why extractJson above stays tolerant.
          response_format: { type: 'json_schema', json_schema: { name: 'tagging', schema: TAGGING_SCHEMA, strict: true } },
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Local tagger returned ${response.status}: ${body.slice(0, 300)}`);
      }

      const payload = (await response.json()) as ChatCompletion;
      if (payload.error?.message) throw new Error(`Local tagger error: ${payload.error.message}`);

      const text = payload.choices?.[0]?.message?.content;
      if (!text) throw new Error('Local tagger returned no content.');

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(extractJson(text)) as Record<string, unknown>;
      } catch {
        throw new Error('Local tagger returned content that was not valid JSON.');
      }

      return normaliseTaggingResponse(parsed, {
        model,
        inputTokens: payload.usage?.prompt_tokens ?? 0,
        outputTokens: payload.usage?.completion_tokens ?? 0,
      });
    },
  };
}
