import { z } from "zod";
import { auth, body, router } from "./_shared.js";
import { fetchHeadlines, type Headline } from "../services/news.js";
import { counterView } from "../services/llm.js";
import { COMPANIES } from "../resolver/companies.js";

const WEEK_MINUTES = 7 * 1440;
const CACHE_MS = 10 * 60_000;
const cache = new Map<string, { at: number; value: { text: string; source: Headline | null } | null }>();

const r = router();
r.use("*", auth);

/**
 * POST /counter-view — the bear-case line under the amount (spec §7.5): strongest reason not to buy
 * from the last 7 days of headlines, one sentence, or nothing. Off when the user turned it off in
 * settings. Cached ten minutes per ticker so opening the buy card twice costs one LLM call.
 */
r.post("/counter-view", async (c) => {
  const b = await body(c, z.object({ ticker: z.string().max(12) }));
  if (c.get("session")?.counterViewEnabled === false) return c.json({ ok: true, enabled: false, text: null, source: null });
  const ticker = b.ticker.toUpperCase();
  const name = COMPANIES.find((k) => k.ticker === ticker)?.name ?? ticker;
  const hit = cache.get(ticker);
  if (hit && Date.now() - hit.at < CACHE_MS) return c.json({ ok: true, enabled: true, text: hit.value?.text ?? null, source: hit.value?.source ?? null });
  const headlines = await fetchHeadlines({ ticker, name, sinceMinutes: WEEK_MINUTES });
  const pick = await counterView({ name, ticker, headlines });
  const value = pick ? { text: pick.text, source: pick.headlineIndex !== null ? (headlines[pick.headlineIndex] ?? null) : null } : null;
  cache.set(ticker, { at: Date.now(), value });
  return c.json({ ok: true, enabled: true, text: value?.text ?? null, source: value?.source ?? null });
});

export default r;
