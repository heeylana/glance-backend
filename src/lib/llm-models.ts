/**
 * Per-model facts the LLM layer needs: list prices, for the `llm usage` log line, and which request
 * options each model accepts, so a route can move to a cheaper model by env alone
 * (doc/cost-reduction-todo.md). Prices are USD per million tokens from
 * platform.claude.com/docs/en/about-claude/pricing, checked 18 Sep 2026; update them here when they change.
 */
export interface Rates {
  input: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
}

const OPUS: Rates = { input: 5, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5, output: 25 };

const PRICES: Record<string, Rates> = {
  "claude-fable-5-1": { input: 10, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 0.25, output: 50 },
  "claude-fable-5": { input: 10, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 1, output: 50 },
  "claude-opus-5": OPUS,
  // Where Opus 5's refusal fallbacks usually land.
  "claude-opus-4-8": OPUS,
  "claude-sonnet-5": { input: 2, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2, output: 10 },
  "claude-haiku-4-5": { input: 1, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1, output: 5 },
};

/** Rates for a model id, including dated ids the API may answer with ("claude-haiku-4-5-20251001"). */
export function ratesFor(model: string): Rates | null {
  let best: string | null = null;
  for (const id of Object.keys(PRICES)) if (model.startsWith(id) && (!best || id.length > best.length)) best = id;
  return best ? PRICES[best]! : null;
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation?: { ephemeral_5m_input_tokens: number; ephemeral_1h_input_tokens: number } | null;
}

/**
 * What one response cost, in USD, or null for a model without a price here. `input_tokens` is only
 * the uncached part; cache writes and reads are billed at their own rates. The usage covers the
 * attempt that answered: a refused attempt before a fallback is not billed.
 */
export function usageCostUsd(model: string, u: TokenUsage): number | null {
  const r = ratesFor(model);
  if (!r) return null;
  const write1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const write5m = u.cache_creation ? u.cache_creation.ephemeral_5m_input_tokens : (u.cache_creation_input_tokens ?? 0);
  const read = u.cache_read_input_tokens ?? 0;
  return (u.input_tokens * r.input + write5m * r.cacheWrite5m + write1h * r.cacheWrite1h + read * r.cacheRead + u.output_tokens * r.output) / 1e6;
}

/**
 * Server-side refusal fallbacks (`fallbacks: "default"` behind its beta header) are documented for
 * Opus 5 and Fable 5.x only, so other models get neither.
 */
export function fallbackParams(model: string): { betas?: string[]; fallbacks?: "default" } {
  return /^claude-(opus-5|fable-5)/.test(model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {};
}

/**
 * `output_config.effort`, only for models that take it: Opus 4.5 and later, Sonnet 4.6 and later,
 * Fable and Mythos. Haiku 4.5 and Sonnet 4.5 reject it with a 400.
 */
export function effortParam(model: string, effort: "low" | "medium" | "high"): { effort?: "low" | "medium" | "high" } {
  return /^claude-(opus-(4-[5-9]|5)|sonnet-(4-6|5)|fable|mythos)/.test(model) ? { effort } : {};
}
