import { config } from '../config.ts';
import { createClaudeTagger } from './claude.ts';
import { createLocalTagger } from './local.ts';
import type { Tagger } from './types.ts';

let cached: Tagger | null | undefined;

/**
 * The configured tagger, or null when tagging is switched off or unusable.
 *
 * Returning null rather than throwing is deliberate: a missing API key should
 * degrade to "clips ingest untagged" — which is recoverable with a re-tag
 * later — not to "uploads fail".
 */
export function getTagger(): Tagger | null {
  if (cached !== undefined) return cached;

  try {
    switch (config.tagger.provider) {
      case 'claude':
        cached = createClaudeTagger();
        break;
      case 'local':
        cached = createLocalTagger();
        break;
      default:
        cached = null;
        break;
    }
  } catch (error) {
    console.warn(`[ai] tagging disabled: ${(error as Error).message}`);
    cached = null;
  }

  return cached;
}

export function taggerStatus(): { enabled: boolean; provider: string; model: string | null } {
  const tagger = getTagger();
  return {
    enabled: tagger !== null,
    provider: config.tagger.provider,
    model: tagger?.model ?? null,
  };
}

export * from './types.ts';
