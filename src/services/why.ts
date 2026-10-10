/**
 * "Why did it move?" (spec §7.6): last-60-minute headlines (24 h when quiet) and the day's price path
 * → the LLM's ≤ 40-word line with sources. One answer per ticker for ten minutes, and one in flight per
 * ticker, so the extension's warm-up and the chat bot's card share the same work. Lifted out of
 * routes/why.ts for the /v1 API.
 */
import { fetchHeadlines, type Headline } from "./news.js";
import { explainMove } from "./llm.js";
import { COMPANIES } from "../resolver/companies.js";
import { loadRegistry } from "../config/issuers.js";
import { getReferencePrice, getPriceAt } from "./prices.js";
import { TtlCache } from "../lib/ttl-cache.js";

export type WhyAnswer = { text: string; sources: Headline[]; windowMinutes: number };

const answers = new TtlCache<WhyAnswer>(10 * 60_000);
const inFlight = new Map<string, Promise<WhyAnswer | null>>();

async function answerFor(ticker: string): Promise<WhyAnswer | null> {
  const company = COMPANIES.find((k) => k.ticker === ticker);
  const name = company?.name ?? ticker;
  const entry = loadRegistry().listingsByTicker.get(ticker)?.[0];
  const [news, priceNow, priceDayAgo] = await Promise.all([
    (async () => {
      const hour = await fetchHeadlines({ ticker, name, sinceMinutes: 60 });
      if (hour.length) return { headlines: hour, windowMinutes: 60 };
      return { headlines: await fetchHeadlines({ ticker, name, sinceMinutes: 1440 }), windowMinutes: 1440 };
    })(),
    entry ? getReferencePrice(entry).catch(() => null) : null,
    entry ? getPriceAt(entry, Math.floor(Date.now() / 1000) - 86_400).catch(() => null) : null,
  ]);
  const answer = await explainMove({ name, ticker, headlines: news.headlines, priceNow: priceNow ? priceNow.usd : null, priceDayAgo, windowMinutes: news.windowMinutes });
  if (!answer) return null;
  const value: WhyAnswer = { text: answer.text, sources: news.headlines.slice(0, 5), windowMinutes: news.windowMinutes };
  answers.set(ticker, value);
  return value;
}

/** The cached answer, or the one in flight, or new work. `warm` returns at once with `warming: true`. */
export function whyFor(tickerRaw: string, opts: { warm?: boolean } = {}): { cached: WhyAnswer } | { warming: true } | { work: Promise<WhyAnswer | null> } {
  const ticker = tickerRaw.toUpperCase();
  const cached = answers.get(ticker);
  if (cached) return { cached };
  let work = inFlight.get(ticker);
  if (!work) {
    work = answerFor(ticker).finally(() => inFlight.delete(ticker));
    inFlight.set(ticker, work);
  }
  if (opts.warm) {
    void work.catch(() => null);
    return { warming: true };
  }
  return { work };
}

/** The answer, waiting for it; null when news or the model is unavailable. */
export async function whyAnswer(ticker: string): Promise<WhyAnswer | null> {
  const r = whyFor(ticker);
  if ("cached" in r) return r.cached;
  if ("work" in r) return r.work;
  return null;
}
