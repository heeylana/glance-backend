/**
 * The bear-case line under the amount (spec §7.5): the strongest reason not to buy from the last 7 days
 * of headlines, one sentence, or nothing. Cached ten minutes per ticker. Lifted out of routes/counter-view.ts
 * for the /v1 API; the caller decides whether the user turned it off.
 */
import { fetchHeadlines, type Headline } from "./news.js";
import { counterView } from "./llm.js";
import { COMPANIES } from "../resolver/companies.js";
import { TtlCache } from "../lib/ttl-cache.js";

export type CounterViewAnswer = { text: string; source: Headline | null } | null;

const WEEK_MINUTES = 7 * 1440;
const cache = new TtlCache<{ value: CounterViewAnswer }>(10 * 60_000);

export async function counterViewFor(tickerRaw: string): Promise<CounterViewAnswer> {
  const ticker = tickerRaw.toUpperCase();
  const hit = cache.get(ticker);
  if (hit) return hit.value;
  const name = COMPANIES.find((k) => k.ticker === ticker)?.name ?? ticker;
  const headlines = await fetchHeadlines({ ticker, name, sinceMinutes: WEEK_MINUTES });
  const pick = await counterView({ name, ticker, headlines });
  const value: CounterViewAnswer = pick ? { text: pick.text, source: pick.headlineIndex !== null ? (headlines[pick.headlineIndex] ?? null) : null } : null;
  cache.set(ticker, { value });
  return value;
}
