/**
 * Tessera's own numbers for its pre-IPO tokens (T-OpenAI, T-Kalshi, T-SpaceX).
 *
 * Why this exists: the buy card shows each token's premium against "the issuer's mark", but every mark came from one
 * generic source, Jupiter's `stockData.price` (services/prices.ts). Jupiter carries that for xStocks, which track a
 * listed share. It does not carry it for a private company, so a Tessera token showed "no mark" and its premium could
 * not be computed at all. Tessera publishes the mark itself, so we ask the issuer.
 *
 * The endpoint is public and takes no key: GET https://rest-api.tessera.pe/v1/public/token-details returns one row per
 * token with its mint, markPrice, holders, sector and markValuation. The whole catalog comes back in one small
 * response, so it is fetched as a unit and cached. A failure is never fatal: the caller keeps whatever mark it already
 * had, which is the behaviour before this file existed.
 */
import { TtlCache } from "../lib/ttl-cache.js";
import { log } from "../lib/log.js";

const TESSERA_TOKENS = "https://rest-api.tessera.pe/v1/public/token-details";
/** The mark moves with the company's valuation, not with the market, so it is slow. Five minutes is plenty. */
const TTL_MS = 5 * 60_000;
const KEY = "tessera:tokens";

export interface TesseraToken {
  /** Mainnet mint of the T-token. */
  mint: string;
  symbol: string;
  /** Tessera's own mark for the underlying, per token, in USD. */
  markPrice: number;
  /** How many wallets hold it. The card shows this: it is the one number that says whether anyone is there. */
  holders: number | null;
  /** The company's valuation behind the mark, in USD. */
  markValuation: number | null;
  sector: string | null;
}

const cache = new TtlCache<Map<string, TesseraToken>>(TTL_MS, 4);
/** In-flight fetch, so a burst of cards asks Tessera once rather than once each. */
let inFlight: Promise<Map<string, TesseraToken>> | null = null;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Tessera's tokens keyed by mainnet mint. Empty when the issuer cannot be reached: never throws. */
export async function tesseraTokens(): Promise<Map<string, TesseraToken>> {
  const hit = cache.get(KEY);
  if (hit) return hit;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const res = await fetch(TESSERA_TOKENS, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(6_000) });
      if (!res.ok) {
        log.warn("tessera token-details failed", { status: res.status });
        return new Map<string, TesseraToken>();
      }
      const rows = (await res.json()) as unknown;
      if (!Array.isArray(rows)) {
        log.warn("tessera token-details was not a list");
        return new Map<string, TesseraToken>();
      }
      const out = new Map<string, TesseraToken>();
      for (const row of rows as Record<string, unknown>[]) {
        const mint = typeof row.mint === "string" ? row.mint : null;
        const markPrice = num(row.markPrice);
        // A row with no mint or no mark tells us nothing the card can use.
        if (!mint || markPrice === null || markPrice <= 0) continue;
        out.set(mint, {
          mint,
          symbol: typeof row.symbol === "string" ? row.symbol : (typeof row.code === "string" ? row.code : mint.slice(0, 4)),
          markPrice,
          holders: num(row.holders),
          markValuation: num(row.markValuation),
          sector: typeof row.sector === "string" ? row.sector : null,
        });
      }
      if (out.size) cache.set(KEY, out);
      log.info("tessera token-details", { tokens: out.size });
      return out;
    } catch (e) {
      log.warn("tessera token-details failed", { err: String(e) });
      return new Map<string, TesseraToken>();
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}
