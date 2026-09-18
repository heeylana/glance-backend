/**
 * Reference prices for guard 6 and for everything the user sees.
 *
 *   pyth    → Hermes (bearer key required since 2026-08-26). Equity feeds publish
 *             market hours only; off-hours the feed freezes, so the stale policy
 *             in guards/price.ts matters at 11pm on a Sunday.
 *   jupiter → Jupiter Price v3: 24/7 on-chain token price, keyless. Not independent
 *             of the venue we trade on, but always fresh. Used when no Pyth key.
 *
 * Historical "price at publish": Pyth Benchmarks with a key, else our own hourly
 * samples in price_history (spec §9 indexer), else null.
 */
import { sql } from "drizzle-orm";
import { env } from "../config.js";
import { priceKey, type MintEntry } from "../config/issuers.js";
import type { PythPrice } from "../guards/price.js";
import { getLatestPrices as hermesLatest, getPriceAt as benchmarksAt, usd as pythUsd } from "./pyth.js";
import { db, schema } from "../db/client.js";
import { log } from "../lib/log.js";

export interface RefPrice {
  usd: number;
  publishTime: number; // unix seconds
  source: "pyth" | "jupiter" | "history";
  /** For Pyth: whether the price is per share (equity feed) or per token (xStock token feed). */
  feedKind?: "equity" | "token";
  confUsd?: number;
  /** 24h percent change when the source reports it (Jupiter). Used only as a last-resort estimate. */
  change24hPct?: number;
}

/** When Pyth rejects the key (401/403 "Not entitled"), auto mode stops asking for a while. */
let pythDisabledUntil = 0;
const PYTH_COOLDOWN_MS = 10 * 60_000;

export function priceSource(): "pyth" | "jupiter" {
  if (env.PRICE_SOURCE === "auto") return env.PYTH_API_KEY && Date.now() >= pythDisabledUntil ? "pyth" : "jupiter";
  return env.PRICE_SOURCE;
}

/** The Pyth feed that prices this token, or null (most pre-IPO tokens have none). */
function feedFor(e: MintEntry): { id: string; kind: "equity" | "token" } | null {
  if (e.pythTokenFeedId && (env.PYTH_FEED_PREFERENCE === "token" || !e.pythFeedId)) return { id: e.pythTokenFeedId, kind: "token" };
  return e.pythFeedId ? { id: e.pythFeedId, kind: "equity" } : null;
}

/** Adapter so guards/price.ts keeps its Pyth-shaped input regardless of source. */
export function asPythPrice(r: RefPrice): PythPrice {
  return { price: BigInt(Math.round(r.usd * 1e8)), expo: -8, conf: BigInt(Math.round((r.confUsd ?? 0) * 1e8)), publishTime: r.publishTime };
}

interface JupiterRow {
  usdPrice?: number;
  price?: string | number;
  priceChange24h?: number;
  liquidity?: number;
  /** The issuer's own mark for the underlying (xstocks, prestocks, tessera). */
  stockData?: { id?: string; price?: number };
}

async function jupiterRows(mints: string[]): Promise<Map<string, JupiterRow>> {
  const out = new Map<string, JupiterRow>();
  const headers: Record<string, string> = { accept: "application/json" };
  if (env.JUPITER_API_KEY) headers["x-api-key"] = env.JUPITER_API_KEY;
  for (let i = 0; i < mints.length; i += 50) {
    const batch = mints.slice(i, i + 50);
    const res = await fetch(`${env.JUPITER_PRICE_URL}?ids=${batch.join(",")}`, { headers, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`jupiter price ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as Record<string, JupiterRow | null>;
    for (const [mint, v] of Object.entries(body)) if (v) out.set(mint, v);
  }
  return out;
}

async function jupiterPrices(mints: string[]): Promise<Map<string, RefPrice>> {
  const out = new Map<string, RefPrice>();
  if (mints.length === 0) return out;
  const rows = await jupiterRows(mints);
  const now = Math.floor(Date.now() / 1000);
  for (const [mint, v] of rows) {
    // An illiquid token has no pool price yet; the issuer's mark is then the best reference there is.
    const usd = v.usdPrice ?? (v.price !== undefined ? Number(v.price) : undefined) ?? v.stockData?.price;
    if (usd !== undefined && Number.isFinite(usd) && usd > 0) {
      out.set(mint, {
        usd,
        publishTime: now,
        source: "jupiter",
        ...(typeof v.priceChange24h === "number" && Number.isFinite(v.priceChange24h) ? { change24hPct: v.priceChange24h } : {}),
      });
    }
  }
  return out;
}

/** What a token trades at against what its issuer marks the underlying at, for the buy card's comparison. */
export interface MarketQuote {
  /** On-chain price of the token (Jupiter, from pools). */
  tokenUsd: number | null;
  /** The issuer's mark for what the token tracks (xStocks: the share; PreStocks and Tessera: their valuation). */
  markUsd: number | null;
  /** tokenUsd / markUsd − 1, in percent: positive is a premium. */
  premiumPct: number | null;
  liquidityUsd: number | null;
  change24hPct: number | null;
}

export function premium(tokenUsd: number | null, markUsd: number | null): number | null {
  return tokenUsd !== null && markUsd !== null && markUsd > 0 ? (tokenUsd / markUsd - 1) * 100 : null;
}

/** Market quotes keyed by each entry's own mint (looked up by its mainnet mint). */
export async function getMarketQuotes(entries: MintEntry[]): Promise<Map<string, MarketQuote>> {
  const out = new Map<string, MarketQuote>();
  if (entries.length === 0) return out;
  const lookup = entries.map((e) => e.referenceMint ?? e.mint);
  const rows = await jupiterRows([...new Set(lookup)]);
  entries.forEach((e, i) => {
    const r = rows.get(lookup[i]!);
    const tokenUsd = r?.usdPrice ?? null;
    const markUsd = r?.stockData?.price ?? null;
    out.set(e.mint, {
      tokenUsd,
      markUsd,
      premiumPct: premium(tokenUsd, markUsd),
      liquidityUsd: r?.liquidity ?? null,
      change24hPct: typeof r?.priceChange24h === "number" ? r.priceChange24h : null,
    });
  });
  return out;
}

/** Latest reference price per entry, keyed by the entry's own mint. */
export async function getReferencePrices(entries: MintEntry[]): Promise<Map<string, RefPrice>> {
  const out = new Map<string, RefPrice>();
  if (entries.length === 0) return out;
  const withFeed = entries.filter((e) => feedFor(e));
  if (priceSource() === "pyth" && withFeed.length) {
    try {
      const feeds = withFeed.map((e) => feedFor(e)!);
      const byFeed = await hermesLatest(feeds.map((f) => f.id));
      withFeed.forEach((e, i) => {
        const f = feeds[i]!;
        const p = byFeed.get(f.id);
        if (p) out.set(e.mint, { usd: pythUsd(p), publishTime: p.publishTime, source: "pyth", feedKind: f.kind, confUsd: Number(p.conf) * 10 ** p.expo });
      });
      // Tokens with no Pyth feed (most pre-IPO) are priced from Jupiter below either way.
      if (out.size === entries.length || (env.PRICE_SOURCE === "pyth" && out.size > 0)) return out;
      log.warn("pyth returned no prices; falling back to jupiter for this call");
    } catch (e) {
      const msg = String(e);
      if (env.PRICE_SOURCE === "pyth") throw e;
      if (/\b(401|403)\b|unauthorized|not entitled/i.test(msg)) {
        pythDisabledUntil = Date.now() + PYTH_COOLDOWN_MS;
        log.warn("pyth key not entitled for these feeds; using jupiter prices for 10 minutes", { err: msg.slice(0, 160) });
      } else {
        log.warn("pyth request failed; using jupiter prices for this call", { err: msg.slice(0, 160) });
      }
    }
  }
  const rest = entries.filter((e) => !out.has(e.mint));
  const lookup = rest.map((e) => e.referenceMint ?? e.mint);
  const byMint = await jupiterPrices([...new Set(lookup)]);
  rest.forEach((e, i) => {
    const p = byMint.get(lookup[i]!);
    if (p) out.set(e.mint, p);
  });
  return out;
}

export async function getReferencePrice(entry: MintEntry): Promise<RefPrice | null> {
  return (await getReferencePrices([entry])).get(entry.mint) ?? null;
}

export interface PriceAt {
  usd: number;
  /** exact = Benchmarks or an hourly sample within range; estimate = scaled from the 24h change. */
  quality: "exact" | "estimate";
}

/** Price at a past timestamp: Benchmarks (keyed) → our hourly samples → 24h-change estimate → null. */
export async function getPriceAtDetailed(entry: MintEntry, unixSec: number, latest?: RefPrice): Promise<PriceAt | null> {
  const exact = await getPriceAt(entry, unixSec);
  if (exact !== null) return { usd: exact, quality: "exact" };
  const ageSec = Math.floor(Date.now() / 1000) - unixSec;
  if (latest?.change24hPct !== undefined && ageSec > 0 && ageSec <= 36 * 3600) {
    // Assume the day's move accrued linearly; good enough for "since this was posted" on a fresh tweet.
    const frac = Math.min(1, ageSec / 86_400);
    const then = latest.usd / (1 + (latest.change24hPct / 100) * frac);
    if (Number.isFinite(then) && then > 0) return { usd: then, quality: "estimate" };
  }
  return null;
}

/** Price at a past timestamp: Benchmarks (keyed) → our hourly samples → null. */
export async function getPriceAt(entry: MintEntry, unixSec: number): Promise<number | null> {
  if (env.PYTH_API_KEY && entry.pythFeedId) {
    try {
      const p = await benchmarksAt(entry.pythFeedId, unixSec);
      if (p) return pythUsd(p);
    } catch (e) {
      log.debug("benchmarks lookup failed; falling back to history", { err: String(e) });
    }
  }
  try {
    const ts = new Date(unixSec * 1000);
    const rows = await db()
      .select({ ts: schema.priceHistory.ts, priceUsd: schema.priceHistory.priceUsd })
      .from(schema.priceHistory)
      .where(sql`${schema.priceHistory.feedId} = ${priceKey(entry)} and ${schema.priceHistory.ts} between ${new Date(ts.getTime() - 2 * 3_600_000)} and ${new Date(ts.getTime() + 2 * 3_600_000)}`)
      .orderBy(sql`abs(extract(epoch from ${schema.priceHistory.ts} - ${ts}::timestamptz))`)
      .limit(2);
    if (rows.length === 0) return null;
    if (rows.length === 1) return Number(rows[0]!.priceUsd);
    // linear interpolation between the two nearest samples
    const [a, b] = rows.map((r) => ({ t: r.ts.getTime(), p: Number(r.priceUsd) })).sort((x, y) => x.t - y.t) as [{ t: number; p: number }, { t: number; p: number }];
    if (b.t === a.t) return a.p;
    const w = Math.min(1, Math.max(0, (ts.getTime() - a.t) / (b.t - a.t)));
    return a.p + (b.p - a.p) * w;
  } catch (e) {
    log.debug("price history lookup failed", { err: String(e) });
    return null;
  }
}

/** Hourly sampler (spec §9 price-at-timestamp indexer). Call from a scheduler; idempotent per hour. */
export async function sampleAllPrices(entries: MintEntry[]): Promise<number> {
  const prices = await getReferencePrices(entries).catch((e) => {
    log.warn("price sampling skipped", { err: String(e).slice(0, 160) });
    return new Map<string, RefPrice>();
  });
  const hour = new Date();
  hour.setMinutes(0, 0, 0);
  let n = 0;
  for (const e of entries) {
    const p = prices.get(e.mint);
    if (!p) continue;
    await db()
      .insert(schema.priceHistory)
      .values({ feedId: priceKey(e), ts: hour, priceUsd: p.usd.toFixed(6) })
      .onConflictDoNothing();
    n++;
  }
  return n;
}
