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

type Answer = { text: string; sources: Headline[]; windowMinutes: number };

// One answer in flight per ticker. The extension warms this route while the user is still speaking
// (spec §7.4), so the spoken "why did it move?" that follows joins that work instead of paying for
// a second news fetch and a second model call.
const inFlight = new Map<string, Promise<Answer | null>>();

async function answerFor(ticker: string): Promise<Answer | null> {
  const company = COMPANIES.find((k) => k.ticker === ticker);
  const name = company?.name ?? ticker;
  const entry = loadRegistry().listingsByTicker.get(ticker)?.[0];
  // The news and the price path need each other only at the model call, so they run together.
  const [news, priceNow, priceDayAgo] = await Promise.all([
    (async () => {
      // Spec §7.6 asks for the last 60 minutes; most tickers are quiet in any given hour, so widen to the day.
      const hour = await fetchHeadlines({ ticker, name, sinceMinutes: 60 });
      if (hour.length) return { headlines: hour, windowMinutes: 60 };
      return { headlines: await fetchHeadlines({ ticker, name, sinceMinutes: 1440 }), windowMinutes: 1440 };
    })(),
    entry ? getReferencePrice(entry).catch(() => null) : null,
    entry ? getPriceAt(entry, Math.floor(Date.now() / 1000) - 86_400).catch(() => null) : null,
  ]);
  const answer = await explainMove({ name, ticker, headlines: news.headlines, priceNow: priceNow ? priceNow.usd : null, priceDayAgo, windowMinutes: news.windowMinutes });
  if (!answer) return null;
  const value: Answer = { text: answer.text, sources: news.headlines.slice(0, 5), windowMinutes: news.windowMinutes };
  answers.set(ticker, value);
  return value;
}

/**
 * POST /why — "Why did it move?" (spec §7.6): last-60-min headlines (24 h when quiet) + price path →
 * ≤ 40 spoken words + sources. Cached 10 min per ticker, and `warm: true` (sent while the user is
 * still talking) starts that work without waiting for it.
 */
r.post("/why", async (c) => {
  const b = await body(c, z.object({ ticker: z.string().max(12), warm: z.boolean().optional() }));
  const ticker = b.ticker.toUpperCase();
  const cached = answers.get(ticker);
  if (cached) return c.json({ ok: true, ...cached });
  let work = inFlight.get(ticker);
  if (!work) {
    work = answerFor(ticker).finally(() => inFlight.delete(ticker));
    inFlight.set(ticker, work);
  }
  // A warm-up reply says only that the work started; the question itself arrives a moment later.
  if (b.warm) {
    void work.catch(() => null);
    return c.json({ ok: true, warming: true });
  }
  const value = await work;
  if (!value) return c.json({ ok: false, code: "NOT_CONFIGURED", message: "I can't check the news right now." }, 503);
  return c.json({ ok: true, ...value });
});

export default r;
