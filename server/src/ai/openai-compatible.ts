import { config } from '../config.ts';
import { normaliseTaggingResponse } from './claude.ts';
import { SYSTEM_PROMPT, TAGGING_SCHEMA, buildUserPrompt } from './prompt.ts';
import type { Tagger, TaggingContext, TaggingResult } from './types.ts';

type ChatCompletion = {
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    /** OpenRouter only, when `usage.include` is requested: the real USD charge. */
    cost?: number;
  };
  error?: { message?: string; code?: number | string };
};

/**
 * Strip a markdown fence if the model wrapped its JSON in one.
 *
 * Models behind an OpenAI-compatible endpoint honour a JSON-schema request
 * far less reliably than the first-party API — some ignore `response_format`
 * entirely — so this path has to be tolerant where the Claude path can be
 * strict.
 */
function extractJson(content: string): string {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) return fenced[1].trim();

  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start >= 0 && end > start) return content.slice(start, end + 1);

  return content.trim();
}

type EndpointOptions = {
  name: string;
  baseUrl: string;
  model: string;
  apiKey?: string | undefined;
  /** Extra headers — OpenRouter wants attribution ones. */
  headers?: Record<string, string>;
  /** Ask the endpoint to report what the call actually cost. */
  requestUsageCost?: boolean;
  timeoutMs?: number;
};

/**
 * A tagger backed by any OpenAI-compatible `/chat/completions` endpoint.
 *
 * Covers both a self-hosted server (Ollama, vLLM, LM Studio) and OpenRouter,
 * which differ only in base URL, auth header and whether they can report cost.
 */
function createEndpointTagger(options: EndpointOptions): Tagger {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const { model } = options;

  return {
    name: options.name,
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

      const body: Record<string, unknown> = {
        model,
        max_tokens: 1024,
        temperature: 0.2,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content },
        ],
        // Honoured by OpenRouter (for models that support it), vLLM and
        // llama.cpp; harmlessly ignored elsewhere — which is why extractJson
        // above stays tolerant.
        response_format: { type: 'json_schema', json_schema: { name: 'tagging', schema: TAGGING_SCHEMA, strict: true } },
      };

      if (options.requestUsageCost) body.usage = { include: true };

      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
          ...options.headers,
        },
        signal: AbortSignal.timeout(options.timeoutMs ?? 180_000),
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        // 402 is the one worth naming: it means the account is out of credit,
        // which looks like a code bug otherwise.
        if (response.status === 402) {
          throw new Error(`${options.name} rejected the request: out of credit.`);
        }
        throw new Error(`${options.name} returned ${response.status}: ${text.slice(0, 300)}`);
      }

      const payload = (await response.json()) as ChatCompletion;
      if (payload.error?.message) throw new Error(`${options.name} error: ${payload.error.message}`);

      const text = payload.choices?.[0]?.message?.content;
      if (!text) throw new Error(`${options.name} returned no content.`);

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(extractJson(text)) as Record<string, unknown>;
      } catch {
        throw new Error(`${options.name} returned content that was not valid JSON.`);
      }

      const result = normaliseTaggingResponse(parsed, {
        model,
        inputTokens: payload.usage?.prompt_tokens ?? 0,
        outputTokens: payload.usage?.completion_tokens ?? 0,
      });

      // Prefer the charge the gateway actually reports over our own estimate:
      // it is exact, and it needs no hardcoded price table to drift out of
      // date as models are repriced.
      if (typeof payload.usage?.cost === 'number' && Number.isFinite(payload.usage.cost)) {
        result.costUsd = Math.round(payload.usage.cost * 1_000_000) / 1_000_000;
      }

      return result;
    },
  };
}

/**
 * A self-hosted vision endpoint.
 *
 * Free per clip, which matters at bulk-import scale. The trade is that it
 * depends on a machine being awake with a GPU free.
 */
export function createLocalTagger(): Tagger {
  return createEndpointTagger({
    name: 'local',
    baseUrl: config.tagger.localUrl,
    model: config.tagger.localModel,
  });
}

/**
 * OpenRouter.
 *
 * One key reaches every vendor's vision models, so the cost/quality tradeoff
 * is a config change rather than a code change — and the small Flash-class
 * models are one to two orders of magnitude cheaper than a frontier model for
 * a task that is mostly "describe what is in these frames".
 */
export function createOpenRouterTagger(): Tagger {
  return createEndpointTagger({
    name: 'openrouter',
    baseUrl: config.tagger.openrouterUrl,
    model: config.tagger.openrouterModel,
    apiKey: config.tagger.openrouterApiKey,
    headers: {
      // OpenRouter attributes usage to these; they show up in the dashboard
      // and make Loopa's spend distinguishable from everything else on the key.
      'HTTP-Referer': config.publicUrl,
      'X-Title': 'Loopa',
    },
    requestUsageCost: true,
  });
}
