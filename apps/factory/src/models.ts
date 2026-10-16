// Each role's model and effort, and the prices the meter charges (plan §M.6). Opus 5.5 always
// thinks; effort sets how much.
import type Anthropic from '@anthropic-ai/sdk';

export const ROLES = {
  scout: { model: 'claude-opus-5-5', effort: 'low' },
  supervisor: { model: 'claude-opus-5-5', effort: 'high' },
  // The Supervisor writing the lessons: the only calls that may spend the reserve.
  lessons: { model: 'claude-opus-5-5', effort: 'high' },
} as const;

export type Role = keyof typeof ROLES;
export const isRole = (r: string): r is Role => Object.hasOwn(ROLES, r);

/** US dollars per million tokens. A model with no price here is refused. */
export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

// Cache writes are charged at the one-hour rate, the dearer of the two, so the meter never
// counts low.
export const PRICES: Readonly<Record<string, Price>> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 8 },
};

export const priceOf = (model: unknown): Price | undefined =>
  typeof model === 'string' && Object.hasOwn(PRICES, model) ? PRICES[model] : undefined;

export function costUsd(price: Price, usage: Anthropic.Usage): number {
  const millionths =
    usage.input_tokens * price.input +
    (usage.cache_creation_input_tokens ?? 0) * price.cacheWrite +
    (usage.cache_read_input_tokens ?? 0) * price.cacheRead +
    usage.output_tokens * price.output;
  return millionths / 1e6;
}
