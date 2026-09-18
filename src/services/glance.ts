/**
 * `/glance` pipeline (spec §7.3 active mode, §9): dictionary match → LLM
 * disambiguation only when needed → registry lookup → Pyth live price →
 * price at publish → one spoken sentence.
 */
import { matchText, decide, type Candidate, type Verdict } from "../resolver/match.js";
import { loadRegistry } from "../config/issuers.js";
import { getMarketQuotes, getReferencePrices, getPriceAtDetailed, type MarketQuote, type RefPrice } from "./prices.js";
import { disambiguate, readScreenshot, type Pick } from "./llm.js";
import { userMessage, GuardCode } from "../lib/errors.js";
import { log } from "../lib/log.js";
import { parseImageDataUrl, sha256Hex } from "../lib/screenshot.js";
import { TtlCache } from "../lib/ttl-cache.js";

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

function fmtUsd(n: number) {
  return n >= 100 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`;
}

function listNames(names: string[]) {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

export async function glance(input: GlanceInput): Promise<GlanceResult> {
  const corpus = [input.title, input.text, input.captions].filter(Boolean).join("\n").slice(0, 8000);
  const cands = matchText(corpus, { titleLength: input.title?.length ?? 0 });
  let verdict = decide(cands);

  if (verdict.kind === "disambiguate") {
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

  const picked: Candidate[] =
    verdict.kind === "confident" ? [verdict.top] : verdict.kind === "none" ? [] : verdict.candidates.slice(0, 3);

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
  const nowSec = Math.floor(Date.now() / 1000);

  const entities: GlanceEntity[] = await Promise.all(
    picked.map(async (c) => {
      const tokens = tokensOf(c.company.ticker);
      const entry = tokens[0];
      const base: GlanceEntity = {
        companyId: c.company.id,
        name: c.company.name,
        ticker: c.company.ticker,
        confidence: c.confidence,
        evidence: [...new Set(c.evidence.map((e) => e.kind))],
        tokenized: !!entry,
      };
      if (!entry) return base;
      const listings: EntityListing[] = tokens.map((t) => {
        const q = quotes.get(t.mint);
        return { mint: t.mint, symbol: t.symbol, issuer: t.issuer, kind: t.kind, tokenUsd: q?.tokenUsd ?? null, markUsd: q?.markUsd ?? null, premiumPct: q?.premiumPct ?? null, liquidityUsd: q?.liquidityUsd ?? null };
      });
      const px = latest.get(entry.mint);
      const priceUsd = px ? px.usd : null;
      let priceAtPublishUsd: number | null = null;
      let deltaQuality: "exact" | "estimate" | null = null;
      if (publishedAt && priceUsd !== null) {
        const at = await getPriceAtDetailed(entry, Math.floor(publishedAt.getTime() / 1000), px).catch(() => null);
        priceAtPublishUsd = at?.usd ?? null;
        deltaQuality = at?.quality ?? null;
      }
      const deltaPct =
        priceUsd !== null && priceAtPublishUsd !== null && priceAtPublishUsd > 0 ? ((priceUsd - priceAtPublishUsd) / priceAtPublishUsd) * 100 : null;
      return {
        ...base,
        kind: entry.kind,
        listings,
        ...(tokens.find((t) => t.about)?.about ? { about: tokens.find((t) => t.about)!.about } : {}),
        mint: entry.mint,
        decimals: entry.decimals,
        priceUsd,
        priceAtPublishUsd,
        deltaPct,
        deltaQuality,
        priceStale: px ? nowSec - px.publishTime > 300 : undefined,
      };
    }),
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
    candidates: cands.length,
  });
  return { verdict: verdict.kind, entities, summary, publishedAt: publishedAt?.toISOString() ?? null, amountChips: [5, 10, 25], source: "text" };
}

function summarize(kind: Verdict["kind"], entities: GlanceEntity[], hasPublish: boolean, site?: string): string {
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
