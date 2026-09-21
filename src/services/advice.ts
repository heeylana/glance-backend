/**
 * "What do you think of Nvidia?" — the read Glance gives when someone asks for one, out of what it
 * already knows: the price and the day's move, the premium against the issuer's own mark, how the
 * token itself trades (Birdeye: volume, liquidity, holders), and the week's headlines.
 *
 * It is deliberately not advice. The model is given no field to put a verdict in (`StockRead` is
 * what is going on, the case for, the case against, what to watch), the prompt forbids buy/sell
 * words, and `DISCLAIMER` below is added here in code, after the model has spoken, so no answer can
 * arrive without it. Glance is not an analyst and says so.
 */
import type { GlanceEntity } from "./glance.js";
import { stockRead, type StockRead } from "./llm.js";
import { fetchHeadlines, type Headline } from "./news.js";
import { spokenUsd } from "./glance.js";
import type { TokenMarket } from "./birdeye.js";
import { TtlCache } from "../lib/ttl-cache.js";

/** Said at the end of every read, and shown under it. Never written by the model. */
export const DISCLAIMER = "I'm not an analyst and this isn't financial advice — take it to someone who is, and do your own research before you buy.";

/** The same thought in the few words a spoken answer can carry. */
export const SPOKEN_DISCLAIMER = "That's not advice, though — I'm not an analyst, so do your own research before you buy.";

export interface AdviceResult {
  read: StockRead;
  /** The sentences in the order they are said and shown. */
  lines: string[];
  /** The same, plus the spoken disclaimer: one clip each, because a whole read is too long for one. */
  spokenLines: string[];
  spoken: string;
  disclaimer: string;
  sources: Headline[];
}

// One read per ticker for ten minutes, like "why" and the counter-view: a second person asking about
// the same company in that window shares the news fetch and the model call.
const reads = new TtlCache<AdviceResult>(10 * 60_000);

/** Facts in the order they matter to someone about to spend $10, as plain lines for the prompt. */
export function factsFor(e: GlanceEntity, market: TokenMarket | null): string[] {
  const facts: string[] = [];
  if (e.priceUsd !== null && e.priceUsd !== undefined) facts.push(`Price on-chain: $${e.priceUsd.toFixed(2)}`);
  const day = e.changeTodayPct ?? market?.change24hPct ?? null;
  if (day !== null) facts.push(`Move today: ${day >= 0 ? "up" : "down"} ${Math.abs(day).toFixed(1)}%`);
  if (e.kind === "pre-ipo") facts.push("This is a pre-IPO token for a private company, not a listed share.");
  const listing = e.listings?.[0];
  if (listing?.premiumPct !== null && listing?.premiumPct !== undefined) {
    const p = listing.premiumPct;
    facts.push(
      Math.abs(p) < 0.1
        ? "The token trades at the issuer's own mark."
        : `The token trades ${Math.abs(p).toFixed(1)}% ${p > 0 ? "above" : "below"} the issuer's own mark for the share.`,
    );
  }
  if ((e.listings?.length ?? 0) > 1) facts.push(`${e.listings!.length} different issuers tokenize this company.`);
  if (market?.volume24hUsd !== null && market?.volume24hUsd !== undefined) facts.push(`Traded in the last day: ${spokenUsd(market.volume24hUsd)}`);
  if (market?.liquidityUsd !== null && market?.liquidityUsd !== undefined) facts.push(`Liquidity in the pools behind it: ${spokenUsd(market.liquidityUsd)}`);
  if (market?.holders) facts.push(`Holders: ${market.holders.toLocaleString("en-US")}`);
  if (market?.volume24hUsd !== null && market?.volume24hUsd !== undefined && market.volume24hUsd < 50_000) {
    facts.push("This token is thinly traded, so a large order would move its price.");
  }
  return facts;
}

/** The read as it is said: what is happening, both sides, what to watch, then the disclaimer. */
export function linesOf(read: StockRead): string[] {
  return [read.now, read.forIt, read.against, read.watch].map((l) => (l ?? "").trim()).filter(Boolean);
}

/**
 * The whole answer for one company. Null when the model has nothing (no key, a refusal): the route
 * turns that into the plain failure line rather than an empty card.
 */
export async function adviceFor(p: { entity: GlanceEntity; market: TokenMarket | null }): Promise<AdviceResult | null> {
  const e = p.entity;
  const cached = reads.get(e.ticker);
  if (cached) return cached;
  const headlines = await fetchHeadlines({ ticker: e.ticker, name: e.name, sinceMinutes: 7 * 1440 }).catch(() => []);
  const read = await stockRead({ name: e.name, ticker: e.ticker, facts: factsFor(e, p.market), headlines });
  if (!read || !read.now.trim()) return null;
  const lines = linesOf(read);
  const result: AdviceResult = {
    read,
    lines,
    spokenLines: [...lines, SPOKEN_DISCLAIMER],
    // Spoken, the disclaimer is the last thing heard, so nobody walks away without it.
    spoken: `${lines.join(" ")} ${SPOKEN_DISCLAIMER}`,
    disclaimer: DISCLAIMER,
    sources: headlines.slice(0, 5),
  };
  reads.set(e.ticker, result);
  return result;
}
