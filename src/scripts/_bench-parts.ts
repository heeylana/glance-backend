import { fetchHeadlines } from "../services/news.js";
import { explainMove } from "../services/llm.js";
import { loadRegistry } from "../config/issuers.js";
import { getReferencePrice, getPriceAt } from "../services/prices.js";
const t = async <T,>(label: string, f: () => Promise<T>): Promise<T> => { const t0 = Date.now(); const v = await f(); console.log(`${label.padEnd(24)} ${String(Date.now()-t0).padStart(5)} ms`); return v; };
for (const [ticker, name] of [["NVDA","Nvidia"],["TSLA","Tesla"]] as const) {
  console.log(`--- ${ticker}`);
  await t("finnhub (cold)", () => fetchHeadlines({ ticker, name, sinceMinutes: 60 }));
  await t("finnhub (2nd window)", () => fetchHeadlines({ ticker, name, sinceMinutes: 1440 }));
  const entry = loadRegistry().listingsByTicker.get(ticker)?.[0];
  const [now] = await t("prices (2, parallel)", () => Promise.all([getReferencePrice(entry!).catch(()=>null), getPriceAt(entry!, Math.floor(Date.now()/1000)-86400).catch(()=>null)]));
  const day = await fetchHeadlines({ ticker, name, sinceMinutes: 1440 });
  await t(`llm explainMove (${day.length} heads)`, () => explainMove({ name, ticker, headlines: day, priceNow: now ? now.usd : null, priceDayAgo: null, windowMinutes: 1440 }));
}
