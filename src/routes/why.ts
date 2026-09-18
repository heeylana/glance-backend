import { z } from "zod";
import { auth, body, router } from "./_shared.js";
import { fetchHeadlines, type Headline } from "../services/news.js";
import { explainMove } from "../services/llm.js";
import { COMPANIES } from "../resolver/companies.js";
import { loadRegistry } from "../config/issuers.js";
import { getReferencePrice, getPriceAt } from "../services/prices.js";
import { TtlCache } from "../lib/ttl-cache.js";

// One answer per ticker for ten minutes, like the counter-view: everyone asking why Nvidia moved in
// that window shares one news fetch and one LLM call. Only answers are cached, never the failure line.
const answers = new TtlCache<{ text: string; sources: Headline[]; windowMinutes: number }>(10 * 60_000);

const r = router();
r.use("*", auth);

/** POST /why — "Why did it move?" (spec §7.6): last-60-min headlines (24 h when quiet) + price path → ≤ 40 spoken words + sources. Cached 10 min per ticker. */
r.post("/why", async (c) => {
  const b = await body(c, z.object({ ticker: z.string().max(12) }));
  const ticker = b.ticker.toUpperCase();
  const cached = answers.get(ticker);
  if (cached) return c.json({ ok: true, ...cached });
  const company = COMPANIES.find((k) => k.ticker === ticker);
  const name = company?.name ?? ticker;
  // Spec §7.6 asks for the last 60 minutes; most tickers are quiet in any given hour, so widen to the day.
  let windowMinutes = 60;
  let headlines = await fetchHeadlines({ ticker, name, sinceMinutes: windowMinutes });
  if (headlines.length === 0) {
    windowMinutes = 1440;
    headlines = await fetchHeadlines({ ticker, name, sinceMinutes: windowMinutes });
  }
  const entry = loadRegistry().listingsByTicker.get(ticker)?.[0];
  let priceNow: number | null = null;
  let priceDayAgo: number | null = null;
  if (entry) {
    const [now, prev] = await Promise.all([
      getReferencePrice(entry).catch(() => null),
      getPriceAt(entry, Math.floor(Date.now() / 1000) - 86_400).catch(() => null),
    ]);
    priceNow = now ? now.usd : null;
    priceDayAgo = prev;
  }
  const answer = await explainMove({ name, ticker, headlines, priceNow, priceDayAgo, windowMinutes });
  if (!answer) {
    return c.json({ ok: false, code: "NOT_CONFIGURED", message: "I can't check the news right now." }, 503);
  }
  const value = { text: answer.text, sources: headlines.slice(0, 5), windowMinutes };
  answers.set(ticker, value);
  return c.json({ ok: true, ...value });
});

export default r;
