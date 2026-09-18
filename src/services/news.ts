/**
 * Recent headlines for a ticker (spec §7.6), from Finnhub's company-news endpoint. Finnhub is
 * keyed by symbol, so the ticker filter is theirs; the company-name filter below drops the
 * aggregator noise ("Amazon could buy from Qualcomm just as Apple…") that a symbol feed carries.
 * `from`/`to` are dates, so we ask for as many days as the window needs and cut to `sinceMinutes` ourselves.
 * Without NEWS_API_KEY this returns [] and /why degrades to "I can't check the news right now."
 */
import { env } from "../config.js";
import { log } from "../lib/log.js";

export interface Headline {
  title: string;
  source: string;
  url: string;
  publishedAt: string;
}

export interface FinnhubItem {
  datetime: number;
  headline: string;
  source: string;
  url: string;
  summary?: string;
  related?: string;
}

const FINNHUB = "https://finnhub.io/api/v1";
const MAX_HEADLINES = 20;
const CACHE_MS = 120_000;
const cache = new Map<string, { at: number; items: FinnhubItem[] }>();

/** Finnhub rows → our shape, newest first, duplicates (syndicated copies) dropped by title. */
export function mapFinnhub(items: FinnhubItem[]): Headline[] {
  const seen = new Set<string>();
  const out: Headline[] = [];
  for (const it of [...items].sort((a, b) => b.datetime - a.datetime)) {
    const title = (it.headline ?? "").trim();
    const key = title.toLowerCase();
    if (!title || !it.url || seen.has(key)) continue;
    seen.add(key);
    out.push({ title, source: (it.source ?? "").trim() || "news", url: it.url, publishedAt: new Date(it.datetime * 1000).toISOString() });
  }
  return out;
}

export function withinWindow(headlines: Headline[], sinceMinutes: number, now = Date.now()): Headline[] {
  const cutoff = now - sinceMinutes * 60_000;
  return headlines.filter((h) => Date.parse(h.publishedAt) >= cutoff);
}

/** True when the headline is about this company, not a neighbour in the same feed. */
export function mentions(h: { title: string; summary?: string }, p: { ticker: string; name: string }): boolean {
  const hay = `${h.title} ${h.summary ?? ""}`.toLowerCase();
  const firstWord = p.name.split(/\s+/)[0]!.toLowerCase().replace(/[^a-z0-9&]/g, "");
  const needles = [p.name.toLowerCase(), firstWord, p.ticker.toLowerCase()].filter((n) => n.length >= 2);
  return needles.some((n) => new RegExp(`(?<![a-z0-9])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9])`, "i").test(hay));
}

async function companyNews(symbol: string, days: number): Promise<FinnhubItem[]> {
  const key = `${symbol}:${days}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.items;
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  const url = `${FINNHUB}/company-news?symbol=${encodeURIComponent(symbol)}&from=${day(from)}&to=${day(to)}`;
  const res = await fetch(url, { headers: { "X-Finnhub-Token": env.NEWS_API_KEY! }, signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`finnhub ${res.status}`);
  const items = (await res.json()) as unknown;
  if (!Array.isArray(items)) throw new Error("finnhub: unexpected body");
  cache.set(key, { at: Date.now(), items: items as FinnhubItem[] });
  return items as FinnhubItem[];
}

/**
 * Headlines about `ticker` from the last `sinceMinutes`, newest first, at most 20. Errors and a
 * missing key both yield [] so the caller degrades instead of failing.
 */
export async function fetchHeadlines(p: { ticker: string; name: string; sinceMinutes: number }): Promise<Headline[]> {
  if (!env.NEWS_API_KEY) return [];
  try {
    const raw = await companyNews(p.ticker, Math.max(1, Math.ceil(p.sinceMinutes / 1440)));
    const about = raw.filter((it) => mentions({ title: it.headline, summary: it.summary }, p));
    // A symbol feed with nothing naming the company is still about the company; keep it rather than go silent.
    const items = about.length ? about : raw;
    return withinWindow(mapFinnhub(items), p.sinceMinutes).slice(0, MAX_HEADLINES);
  } catch (e) {
    log.warn("news fetch failed", { ticker: p.ticker, err: String(e) });
    return [];
  }
}
