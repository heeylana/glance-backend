/**
 * Birdeye (data.birdeye.so): what the on-chain market for a token looks like, for the card Glance
 * shows when it is asked about a stock. Prices still come from Pyth or Jupiter (`prices.ts`); this
 * adds what those cannot say — the day's volume, how deep the liquidity is, how many people hold it,
 * and the price path behind the little chart on the card.
 *
 * Everything here is best-effort: no key, a rate limit or a bad answer returns null and the card
 * simply shows less. The key is read per call so a restart is all it takes to add one.
 *
 * The plan the project is on rate-limits bursts (429 on two calls in the same second), so every
 * request goes through one queue with a gap between calls, identical requests in flight share one
 * answer, and both kinds of answer are cached.
 */
import { env } from "../config.js";
import { log } from "../lib/log.js";
import { TtlCache } from "../lib/ttl-cache.js";

const BASE = "https://public-api.birdeye.so";
/** Solana only: every mint in the catalog is a Solana mint. */
const CHAIN = "solana";
const TIMEOUT_MS = 6_000;
/** Birdeye 429s on bursts; one call at a time with this gap between them stays inside the plan. */
const MIN_GAP_MS = 400;

/** The market as Birdeye sees it, in the units the card and the spoken line use. */
export interface TokenMarket {
  priceUsd: number | null;
  change24hPct: number | null;
  volume24hUsd: number | null;
  liquidityUsd: number | null;
  marketCapUsd: number | null;
  holders: number | null;
  trades24h: number | null;
  /** How many markets quote this token: one venue is thin, many is not. */
  markets: number | null;
}

/** One point of the sparkline: seconds since the epoch, and the price then. */
export interface PricePoint {
  t: number;
  usd: number;
}

const markets = new TtlCache<TokenMarket>(2 * 60_000);
const series = new TtlCache<PricePoint[]>(5 * 60_000);
const inFlight = new Map<string, Promise<unknown>>();

export function birdeyeEnabled(): boolean {
  return !!env.BIRD_EYE_API_KEY;
}

/** One queue for every Birdeye call, so two cards opening at once cannot trip the rate limit. */
let queue: Promise<unknown> = Promise.resolve();
function queued<T>(run: () => Promise<T>): Promise<T> {
  const next = queue.then(run, run);
  queue = next.then(() => new Promise((r) => setTimeout(r, MIN_GAP_MS))).catch(() => undefined);
  return next;
}

async function get(path: string): Promise<Record<string, unknown> | null> {
  if (!env.BIRD_EYE_API_KEY) return null;
  const call = () =>
    fetch(`${BASE}/${path}`, {
      headers: { "X-API-KEY": env.BIRD_EYE_API_KEY!, "x-chain": CHAIN, accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  try {
    let res = await queued(call);
    // One retry on a rate limit, far enough back to clear the window the plan counts in.
    if (res.status === 429) {
      log.debug("birdeye rate limited", { path: path.split("?")[0] });
      await new Promise((r) => setTimeout(r, 1_100));
      res = await queued(call);
    }
    if (!res.ok) {
      log.warn("birdeye failed", { path: path.split("?")[0], status: res.status });
      return null;
    }
    const json = (await res.json()) as { success?: boolean; data?: unknown };
    if (!json?.success || typeof json.data !== "object" || json.data === null) return null;
    return json.data as Record<string, unknown>;
  } catch (e) {
    log.warn("birdeye failed", { path: path.split("?")[0], err: String(e) });
    return null;
  }
}

/** A finite number, or null: Birdeye leaves a field out for a token nothing has traded. */
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** `/defi/token_overview` → the fields the card uses. Exported for the test; the network stays outside. */
export function readOverview(d: Record<string, unknown>): TokenMarket {
  return {
    priceUsd: num(d.price),
    change24hPct: num(d.priceChange24hPercent),
    volume24hUsd: num(d.v24hUSD),
    liquidityUsd: num(d.liquidity),
    marketCapUsd: num(d.marketCap),
    holders: num(d.holder),
    trades24h: num(d.trade24h),
    markets: num(d.numberMarkets),
  };
}

/** `/defi/history_price` → points in time order, oldest first, only the ones that carry a price. */
export function readSeries(d: Record<string, unknown>): PricePoint[] {
  const items = Array.isArray(d.items) ? d.items : [];
  return items
    .map((it) => {
      const row = it as { unixTime?: unknown; value?: unknown };
      const t = num(row.unixTime);
      const usd = num(row.value);
      return t !== null && usd !== null && usd > 0 ? { t, usd } : null;
    })
    .filter((p): p is PricePoint => p !== null)
    .sort((a, b) => a.t - b.t);
}

/** Share one request between everyone asking for the same thing while it is in flight. */
function once<T>(key: string, run: () => Promise<T>): Promise<T> {
  const running = inFlight.get(key) as Promise<T> | undefined;
  if (running) return running;
  const p = run().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

/** The day's market for one mainnet mint. Null when there is no key, no answer, or nothing traded. */
export async function tokenMarket(mint: string): Promise<TokenMarket | null> {
  if (!birdeyeEnabled()) return null;
  const hit = markets.get(mint);
  if (hit) return hit;
  return once(`market:${mint}`, async () => {
    const data = await get(`defi/token_overview?address=${encodeURIComponent(mint)}`);
    if (!data) return null;
    const market = readOverview(data);
    markets.set(mint, market);
    return market;
  });
}

/**
 * The price path behind the card's chart: hourly points over the last day, which is the shape a
 * glance wants ("how's it doing?") without asking for thousands of candles.
 */
export async function priceSeries(mint: string, hours = 24): Promise<PricePoint[] | null> {
  if (!birdeyeEnabled()) return null;
  const key = `${mint}:${hours}`;
  const hit = series.get(key);
  if (hit) return hit;
  return once(`series:${key}`, async () => {
    const to = Math.floor(Date.now() / 1000);
    const from = to - hours * 3_600;
    const data = await get(
      `defi/history_price?address=${encodeURIComponent(mint)}&address_type=token&type=1H&time_from=${from}&time_to=${to}`,
    );
    if (!data) return null;
    const points = readSeries(data);
    if (points.length < 2) return null;
    series.set(key, points);
    return points;
  });
}

/**
 * The market, but only if it arrives before the user would notice the wait. A late answer still
 * lands in the cache, so the same question a moment later has it. Used by the spoken line, which
 * cannot hold a card open while a third-party API thinks.
 */
export async function tokenMarketWithin(mint: string, ms: number): Promise<TokenMarket | null> {
  const asked = tokenMarket(mint).catch(() => null);
  const late = new Promise<null>((r) => setTimeout(() => r(null), ms).unref?.());
  return Promise.race([asked, late]);
}
