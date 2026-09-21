/**
 * `/glance` pipeline (spec §7.3 active mode, §9): dictionary match → LLM
 * disambiguation only when needed → registry lookup → Pyth live price →
 * price at publish → one spoken sentence.
 */
import { alsoMentioned, focusOn, matchText, decide, type Candidate, type Verdict } from "../resolver/match.js";
import { COMPANIES } from "../resolver/companies.js";
import { loadRegistry, type MintEntry } from "../config/issuers.js";
import { getMarketQuotes, getReferencePrices, getPriceAtDetailed, type MarketQuote, type RefPrice } from "./prices.js";
import { disambiguate, readScreenshot, type Pick } from "./llm.js";
import { userMessage, GuardCode } from "../lib/errors.js";
import { log } from "../lib/log.js";
import { parseImageDataUrl, sha256Hex } from "../lib/screenshot.js";
import { TtlCache } from "../lib/ttl-cache.js";
import { tokenMarketWithin, type TokenMarket } from "./birdeye.js";

// LLM picks per page text and candidate set, for half an hour: pressing ⌥G twice on one article, or
// two people glancing the same story, costs one call. A failed call is not cached.
const picks = new TtlCache<Pick>(30 * 60_000);

export interface GlanceInput {
  url: string;
  title?: string;
  site?: "x" | "youtube" | "article" | "generic";
  publishedAt?: string | number;
  text: string;
  captions?: string;
  /** The company the user asked about by hovering its underline and pressing "Glance this": it leads the answer. */
  focus?: string;
}

/** The focused company as a candidate: its match on this page, or straight from the dictionary (the user picked it). */
function focusCandidate(cands: Candidate[], id: string): Candidate | null {
  const hit = cands.find((c) => c.company.id === id);
  if (hit) return hit;
  const company = COMPANIES.find((k) => k.id === id);
  return company ? { company, confidence: 1, evidence: [], firstIndex: 0, mentions: 0, inTitle: false } : null;
}

/** One token of a company (spec extension: several issuers can tokenize the same company). */
export interface EntityListing {
  /** The catalog (mainnet) mint; /buy accepts it and, on devnet, trades its mock. */
  mint: string;
  symbol: string;
  issuer: string;
  kind: "stock" | "etf" | "pre-ipo";
  tokenUsd: number | null;
  markUsd: number | null;
  premiumPct: number | null;
  liquidityUsd: number | null;
}

export interface GlanceEntity {
  companyId: string;
  name: string;
  ticker: string;
  confidence: number;
  evidence: string[];
  tokenized: boolean;
  kind?: "stock" | "etf" | "pre-ipo";
  /** Every token of the company, xStocks first; the first one is what `mint` and `priceUsd` describe. */
  listings?: EntityListing[];
  about?: string;
  mint?: string;
  decimals?: number;
  priceUsd?: number | null;
  priceAtPublishUsd?: number | null;
  deltaPct?: number | null;
  /** "estimate" when the publish-time price was scaled from the 24h change rather than observed. */
  deltaQuality?: "exact" | "estimate" | null;
  /** The day's move, from the price feed: what a spoken question about the stock answers with. */
  changeTodayPct?: number | null;
  priceStale?: boolean;
}

export interface GlanceResult {
  verdict: Verdict["kind"];
  entities: GlanceEntity[];
  summary: string;
  publishedAt: string | null;
  amountChips: number[];
  /** "screenshot" when the vision fallback produced this result. */
  source?: "text" | "screenshot";
  /** sha256 of the screenshot that was read; the image itself is gone (spec §7.9). */
  screenshotHash?: string;
}

export interface GlanceVisionInput {
  url: string;
  title?: string;
  site?: GlanceInput["site"];
  publishedAt?: string | number;
  /** `data:image/jpeg;base64,…` from `chrome.tabs.captureVisibleTab`. */
  image: string;
}

const NOTHING_READABLE = "I couldn't read anything on this page yet. Scroll to the story and try again?";

/**
 * Vision fallback (spec §7.3): when the DOM yielded no text or no entity, read the visible page
 * from a screenshot and run the same pipeline on the transcription. The image is hashed and
 * discarded; the hash goes into the journal if the user buys (§8.4, §7.9).
 */
export async function glanceScreenshot(input: GlanceVisionInput): Promise<GlanceResult> {
  const img = parseImageDataUrl(input.image);
  const screenshotHash = sha256Hex(img.bytes);
  const read = await readScreenshot({ base64: img.base64, mediaType: img.mediaType, url: input.url }).catch((e) => {
    log.warn("screenshot read failed", { err: String(e) });
    return null;
  });
  const text = read ? [read.text, read.companies.length ? `Companies: ${read.companies.join(", ")}` : ""].filter(Boolean).join("\n") : "";
  if (!read || text.length < 10) {
    log.info("glance screenshot", { host: hostOf(input.url), bytes: img.bytes.length, read: false });
    return { verdict: "none", entities: [], summary: NOTHING_READABLE, publishedAt: parsePublishedAt(input.publishedAt)?.toISOString() ?? null, amountChips: [5, 10, 25], source: "screenshot", screenshotHash };
  }
  const result = await glance({ url: input.url, title: read.headline ?? input.title, site: input.site, publishedAt: input.publishedAt, text });
  log.info("glance screenshot", { host: hostOf(input.url), bytes: img.bytes.length, read: true, textLen: text.length, verdict: result.verdict });
  return { ...result, source: "screenshot", screenshotHash };
}

export function parsePublishedAt(v: string | number | undefined): Date | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v === "number") return new Date(v > 1e12 ? v : v * 1000);
  const n = Number(v);
  if (Number.isFinite(n) && v.trim() !== "") return new Date(n > 1e12 ? n : n * 1000);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** How long the spoken answer waits on Birdeye before going out without its numbers. */
const BIRDEYE_BUDGET_MS = 900;

function fmtUsd(n: number) {
  return n >= 100 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`;
}

function listNames(names: string[]) {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

/** One company as the card shows it: its tokens, the live price, and the move since the page was published. */
async function buildEntity(
  who: { company: { id: string; name: string; ticker: string }; confidence: number; evidence: string[] },
  ctx: { tokens: MintEntry[]; latest: Map<string, RefPrice>; quotes: Map<string, MarketQuote>; publishedAt: Date | null },
): Promise<GlanceEntity> {
  const entry = ctx.tokens[0];
  const base: GlanceEntity = {
    companyId: who.company.id,
    name: who.company.name,
    ticker: who.company.ticker,
    confidence: who.confidence,
    evidence: who.evidence,
    tokenized: !!entry,
  };
  if (!entry) return base;
  const listings: EntityListing[] = ctx.tokens.map((t) => {
    const q = ctx.quotes.get(t.mint);
    return { mint: t.mint, symbol: t.symbol, issuer: t.issuer, kind: t.kind, tokenUsd: q?.tokenUsd ?? null, markUsd: q?.markUsd ?? null, premiumPct: q?.premiumPct ?? null, liquidityUsd: q?.liquidityUsd ?? null };
  });
  const px = ctx.latest.get(entry.mint);
  const priceUsd = px ? px.usd : null;
  let priceAtPublishUsd: number | null = null;
  let deltaQuality: "exact" | "estimate" | null = null;
  if (ctx.publishedAt && priceUsd !== null) {
    const at = await getPriceAtDetailed(entry, Math.floor(ctx.publishedAt.getTime() / 1000), px).catch(() => null);
    priceAtPublishUsd = at?.usd ?? null;
    deltaQuality = at?.quality ?? null;
  }
  const deltaPct = priceUsd !== null && priceAtPublishUsd !== null && priceAtPublishUsd > 0 ? ((priceUsd - priceAtPublishUsd) / priceAtPublishUsd) * 100 : null;
  return {
    ...base,
    kind: entry.kind,
    listings,
    ...(ctx.tokens.find((t) => t.about)?.about ? { about: ctx.tokens.find((t) => t.about)!.about } : {}),
    mint: entry.mint,
    decimals: entry.decimals,
    priceUsd,
    priceAtPublishUsd,
    deltaPct,
    deltaQuality,
    changeTodayPct: px?.change24hPct ?? null,
    priceStale: px ? Math.floor(Date.now() / 1000) - px.publishTime > 300 : undefined,
  };
}

/**
 * A company asked about out loud (voice kind `stock`), with no page involved: "how's Nvidia doing?",
 * "what's Apple trading at?". The same card a glance opens, so Buy works from it, and a line made of
 * the price and the day's move — no model call, because the user is waiting on this one.
 */
export async function lookupCompany(
  key: { companyId?: string; ticker?: string },
): Promise<{ entity: GlanceEntity; summary: string; market: TokenMarket | null } | null> {
  const company = key.companyId
    ? COMPANIES.find((c) => c.id === key.companyId)
    : COMPANIES.find((c) => c.ticker === key.ticker?.toUpperCase());
  if (!company) return null;
  const tokens = loadRegistry().listingsByTicker.get(company.ticker) ?? [];
  const entry = tokens[0];
  // The mainnet mint is what Birdeye knows; on devnet the entry's own mint is a mock (see priceKey).
  // The card's chart is fetched separately (/company/history), so the spoken answer waits for one
  // call at most, and not for long: a slow answer still warms the cache for the next question.
  const detail = entry ? tokenMarketWithin(entry.referenceMint ?? entry.mint, BIRDEYE_BUDGET_MS) : Promise.resolve(null);
  const [latest, quotes] = await Promise.all([
    entry
      ? getReferencePrices([entry]).catch((e) => {
          log.warn("reference prices failed", { err: String(e) });
          return new Map<string, RefPrice>();
        })
      : new Map<string, RefPrice>(),
    tokens.length
      ? getMarketQuotes(tokens).catch((e) => {
          log.warn("market quotes failed", { err: String(e) });
          return new Map<string, MarketQuote>();
        })
      : new Map<string, MarketQuote>(),
  ]);
  const entity = await buildEntity({ company, confidence: 1, evidence: ["asked"] }, { tokens, latest, quotes, publishedAt: null });
  const market = await detail;
  // Birdeye sees the day's move on-chain; the price feed does not always carry one.
  if (entity.tokenized && entity.changeTodayPct === null && market?.change24hPct !== null && market?.change24hPct !== undefined) {
    entity.changeTodayPct = market.change24hPct;
  }
  log.info("company", {
    ticker: company.ticker,
    tokenized: entity.tokenized,
    price: entity.priceUsd ?? null,
    market: market ? { vol24h: Math.round(market.volume24hUsd ?? 0), liq: Math.round(market.liquidityUsd ?? 0), holders: market.holders } : null,
  });
  return { entity, summary: stockLine(entity, market), market };
}

/** What Glance says about a company it was asked about: price, today's move, how it is trading, and nothing it doesn't know. */
export function stockLine(e: GlanceEntity, market?: TokenMarket | null): string {
  if (!e.tokenized) return userMessage(GuardCode.MINT_NOT_TOKENIZED, { companyName: e.name });
  if (e.priceUsd === null || e.priceUsd === undefined) return `I can't get a price for ${e.name} right now.`;
  const price = fmtUsd(e.priceUsd);
  const move = moveToday(e.changeTodayPct ?? market?.change24hPct);
  const head =
    e.kind === "pre-ipo"
      ? `${e.name} is still private. Its pre-IPO token is ${price} on-chain${move ? `, ${move}` : ""}.`
      : `${e.name} is ${price} on-chain${move ? `, ${move}` : ""}.`;
  const trading = tradingSentence(market);
  return trading ? `${head} ${trading}` : head;
}

/**
 * How the token itself is trading, in one spoken sentence: what changed hands today, and a word of
 * warning when the book is thin enough that a buy would move the price. Nothing is said when Birdeye
 * has no key or no answer.
 */
export function tradingSentence(m?: TokenMarket | null): string {
  if (!m) return "";
  const vol = m.volume24hUsd;
  const liq = m.liquidityUsd;
  if (vol !== null && vol > 0 && THIN_USD > vol) return `It's thinly traded, though — only ${spokenUsd(vol)} changed hands today, so a big buy would move the price.`;
  if (liq !== null && liq > 0 && THIN_USD > liq) return `The pool behind it is small, about ${spokenUsd(liq)}, so a big buy would move the price.`;
  if (vol !== null && vol > 0) return `${spokenUsd(vol)} changed hands today${m.holders !== null && m.holders > 0 ? `, across ${compactCount(m.holders)} holders` : ""}.`;
  if (liq !== null && liq > 0) return `There's ${spokenUsd(liq)} of liquidity behind it.`;
  return "";
}

/** Under this much traded or pooled in a day, one ordinary buy moves the price. */
const THIN_USD = 50_000;

/** Money as a person would say it out loud: "$7.2 million", "$940,000", "$2,300", "$820". */
export function spokenUsd(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1).replace(/\.0$/, "")} billion`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1).replace(/\.0$/, "")} million`;
  if (n >= 1e4) return `$${Math.round(n / 1e3)},000`;
  // Under ten thousand, say the number itself: "two thousand three hundred", not "2.3 thousand".
  if (n >= 1e3) return `$${(Math.round(n / 100) * 100).toLocaleString("en-US")}`;
  return `$${Math.round(n)}`;
}

/** "98,880" as "99,000", the way a person says a holder count. */
function compactCount(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, "")} million`;
  if (n >= 1e4) return `${Math.round(n / 1e3)},000`;
  return n.toLocaleString("en-US");
}

/** "up 3.1% today", "about flat today", or nothing when the day's move is unknown. */
function moveToday(pct: number | null | undefined): string {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return "";
  if (Math.abs(pct) < 0.05) return "about flat today";
  return `${pct >= 0 ? "up" : "down"} ${Math.abs(pct).toFixed(1)}% today`;
}

export async function glance(input: GlanceInput): Promise<GlanceResult> {
  const corpus = [input.title, input.text, input.captions].filter(Boolean).join("\n").slice(0, 8000);
  const cands = matchText(corpus, { titleLength: input.title?.length ?? 0 });
  let verdict = decide(cands);
  const focus = input.focus ? focusCandidate(cands, input.focus) : null;

  // No need to ask the model which company the page means when the user already said.
  if (verdict.kind === "disambiguate" && !focus) {
    const candidates = verdict.candidates.map((c) => ({ id: c.company.id, name: c.company.name, ticker: c.company.ticker }));
    const key = sha256Hex(Buffer.from(`${candidates.map((c) => c.id).sort().join(",")}\n${corpus}`));
    const cached = picks.get(key);
    const pick =
      cached ??
      (await disambiguate({ corpus, candidates }).catch((e) => {
        log.warn("llm disambiguation failed", { err: String(e) });
        return null;
      }));
    if (pick && !cached) picks.set(key, pick);
    if (pick?.companyId) {
      const chosen = verdict.candidates.find((c) => c.company.id === pick.companyId);
      if (chosen) verdict = { kind: "confident", top: { ...chosen, confidence: Math.max(chosen.confidence, pick.confidence) } };
    } else if (pick && pick.companyId === null && pick.confidence >= 0.8) {
      verdict = { kind: "none" };
    }
  }

  // The page's subject first (or the company the user focused on); for a confident answer, then the other
  // companies it names strongly, which the card offers as "also on this page" and "what else is here?" lists.
  let also = alsoMentioned(cands, verdict);
  if (focus) ({ verdict, also } = focusOn(cands, verdict, focus));
  const picked: Candidate[] = verdict.kind === "confident" ? [verdict.top, ...also] : verdict.kind === "none" ? [] : verdict.candidates.slice(0, 3);

  const reg = loadRegistry();
  const publishedAt = parsePublishedAt(input.publishedAt);
  const tokensOf = (ticker: string) => reg.listingsByTicker.get(ticker) ?? [];
  const entries = picked.map((c) => tokensOf(c.company.ticker)[0]).filter((x): x is NonNullable<typeof x> => !!x);
  const allTokens = picked.flatMap((c) => tokensOf(c.company.ticker));
  const [latest, quotes] = await Promise.all([
    entries.length
      ? getReferencePrices(entries).catch((e) => {
          log.warn("reference prices failed", { err: String(e) });
          return new Map<string, RefPrice>();
        })
      : new Map<string, RefPrice>(),
    allTokens.length
      ? getMarketQuotes(allTokens).catch((e) => {
          log.warn("market quotes failed", { err: String(e) });
          return new Map<string, MarketQuote>();
        })
      : new Map<string, MarketQuote>(),
  ]);
  const entities: GlanceEntity[] = await Promise.all(
    picked.map((c) =>
      buildEntity(
        { company: c.company, confidence: c.confidence, evidence: [...new Set(c.evidence.map((e) => e.kind))] },
        { tokens: tokensOf(c.company.ticker), latest, quotes, publishedAt },
      ),
    ),
  );

  const summary = summarize(verdict.kind, entities, !!publishedAt, input.site);
  // One line per glance so resolver misses are visible in the `pnpm dev` terminal (checklist §3.3).
  // Host and a truncated title only: the page text never reaches the log.
  log.info("glance", {
    site: input.site ?? "generic",
    host: hostOf(input.url),
    title: (input.title ?? "").slice(0, 80),
    textLen: input.text.length,
    verdict: verdict.kind,
    top: entities[0] ? `${entities[0].ticker}:${entities[0].confidence}` : null,
    also: entities.slice(1).map((e) => e.ticker),
    focus: input.focus ?? null,
    candidates: cands.length,
  });
  return { verdict: verdict.kind, entities, summary, publishedAt: publishedAt?.toISOString() ?? null, amountChips: [5, 10, 25], source: "text" };
}

function summarize(kind: Verdict["kind"], entities: GlanceEntity[], hasPublish: boolean, site?: string): string {
  const line = summaryLine(kind, entities, hasPublish, site);
  const also = kind === "confident" ? entities.slice(1).map((e) => e.name) : [];
  return also.length ? `${line} It also mentions ${listNames(also)}.` : line;
}

function summaryLine(kind: Verdict["kind"], entities: GlanceEntity[], hasPublish: boolean, site?: string): string {
  const since = site === "youtube" ? "since this video went up" : site === "x" ? "since this was posted" : "since this was published";
  if (kind === "none" || entities.length === 0) return "I couldn't find a company on this page.";
  if (kind === "multiple") return `I see ${listNames(entities.map((e) => e.name))} here. Which one?`;
  const e = entities[0]!;
  if (kind === "ask_user" || kind === "disambiguate") return `I think this is about ${e.name} — is that right?`;
  if (!e.tokenized) return userMessage(GuardCode.MINT_NOT_TOKENIZED, { companyName: e.name });
  if (e.priceUsd === null || e.priceUsd === undefined) return `That's ${e.name}. I can't get a price right now.`;
  const price = fmtUsd(e.priceUsd);
  const n = e.listings?.length ?? 1;
  if (e.kind === "pre-ipo") {
    const lowest = Math.min(...(e.listings ?? []).map((l) => l.tokenUsd ?? Infinity), e.priceUsd);
    return `That's ${e.name}, a private company. ${n > 1 ? `${n} pre-IPO tokens track it, from about ${fmtUsd(lowest)}` : `Its pre-IPO token trades at ${price}`} on-chain.`;
  }
  if (hasPublish && e.deltaPct !== null && e.deltaPct !== undefined) {
    const dir = e.deltaPct >= 0 ? "up" : "down";
    return `That's ${e.name}. ${e.ticker} is ${price} on-chain, ${dir} ${Math.abs(e.deltaPct).toFixed(1)}% ${since}.`;
  }
  return `That's ${e.name}. ${e.ticker} is ${price} on-chain.`;
}
