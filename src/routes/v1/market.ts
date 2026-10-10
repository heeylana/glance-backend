/** Resolve, the card, catalog search and command interpretation (§1.4). Open to any client user; a binding only adds the session's settings. */
import { z } from "zod";
import { body } from "../_shared.js";
import { botAuth, channelUser, rateLimit, v1Router } from "./_auth.js";
import { ApiError } from "./codes.js";
import { glance, lookupCompany } from "../../services/glance.js";
import { matchText } from "../../resolver/match.js";
import { whyAnswer } from "../../services/why.js";
import { counterViewFor } from "../../services/counter-view.js";
import { interpret, VoiceContextSchema } from "../../services/voice.js";
import { COMPANIES } from "../../resolver/companies.js";
import { loadRegistry } from "../../config/issuers.js";
import { readImageRecord } from "../../services/images.js";

const r = v1Router();
r.use("*", botAuth, channelUser({ required: false }), rateLimit(120));

const AMOUNT_CHIPS = [5, 10, 25];

/** The companies a text or an image names, with where in the text each was found. */
r.post("/resolve", async (c) => {
  const b = await body(c, z.object({ text: z.string().max(12_000).optional(), image_id: z.string().max(64).optional(), title: z.string().max(512).optional() }).refine((x) => !!x.text || !!x.image_id, { message: "text or image_id" }));
  let text = b.text ?? "";
  let title = b.title;
  let screenshotHash: string | undefined;
  let imageRead: Awaited<ReturnType<typeof readImageRecord>> | null = null;
  if (b.image_id) {
    const owner = c.get("binding")?.owner ?? null;
    imageRead = await readImageRecord(b.image_id, owner);
    if (!imageRead) throw new ApiError("image_expired");
    if (!imageRead.read) throw new ApiError("image_unreadable");
    text = [imageRead.read.text, imageRead.read.companies.length ? `Companies: ${imageRead.read.companies.map((x) => x.name).join(", ")}` : ""].filter(Boolean).join("\n");
    title = imageRead.read.headline ?? title;
    screenshotHash = imageRead.sha256;
  }
  const result = await glance({ url: b.image_id ? `whatsapp://image/${b.image_id}` : "whatsapp://message", title, text, site: "generic" });
  const spans = new Map(matchText([title, text].filter(Boolean).join("\n"), { titleLength: title?.length ?? 0 }).map((cand) => [cand.company.id, cand.firstIndex]));
  const boxes = new Map((imageRead?.read?.companies ?? []).map((x) => [x.name.toLowerCase(), x.box]));
  return c.json({
    ok: true,
    verdict: result.verdict,
    summary: result.summary,
    source: b.image_id ? "image" : "text",
    screenshot_hash: screenshotHash,
    read: imageRead?.read ? { kind: imageRead.read.kind, headline: imageRead.read.headline, chart: imageRead.read.chart } : undefined,
    companies: result.entities.slice(0, 3).map((e) => ({
      company_id: e.companyId,
      name: e.name,
      ticker: e.ticker,
      mint: e.mint ?? null,
      tokenized: e.tokenized,
      kind: e.kind ?? null,
      confidence: e.confidence,
      price_usd: e.priceUsd ?? null,
      change_today_pct: e.changeTodayPct ?? null,
      span: spans.get(e.companyId) ?? null,
      box: boxes.get(e.name.toLowerCase()) ?? null,
      listings: e.listings?.map((l) => ({ mint: l.mint, symbol: l.symbol, issuer: l.issuer, token_usd: l.tokenUsd, premium_pct: l.premiumPct })) ?? [],
    })),
    amount_chips: AMOUNT_CHIPS,
  });
});

/**
 * The card for one company, in the spec's order: price and today's move, why it moved, the reason not to
 * buy, and the buy prompt. `?parts=price` answers in under a second from the cache; `?parts=why,counter`
 * is the slow pair, so the bot can send the price first and the rest when it lands.
 */
r.get("/quote/:ticker", async (c) => {
  const ticker = c.req.param("ticker").toUpperCase();
  const parts = new Set((c.req.query("parts") ?? "price,why,counter").split(",").map((s) => s.trim()));
  const found = await lookupCompany({ ticker });
  if (!found) throw new ApiError("unknown_company");
  const counterOn = c.get("binding") ? c.get("session")?.counterViewEnabled !== false : true;
  const [why, counter] = await Promise.all([
    parts.has("why") && found.entity.tokenized ? whyAnswer(ticker).catch(() => null) : null,
    parts.has("counter") && found.entity.tokenized && counterOn ? counterViewFor(ticker).catch(() => null) : null,
  ]);
  const e = found.entity;
  return c.json({
    ok: true,
    company: { company_id: e.companyId, name: e.name, ticker: e.ticker, mint: e.mint ?? null, tokenized: e.tokenized, kind: e.kind ?? null, private: e.private ?? false },
    price_usd: e.priceUsd ?? null,
    change_today_pct: e.changeTodayPct ?? null,
    price_stale: e.priceStale ?? false,
    line: found.summary,
    market: found.market ? { volume_24h_usd: found.market.volume24hUsd, liquidity_usd: found.market.liquidityUsd, holders: found.market.holders, change_24h_pct: found.market.change24hPct } : null,
    listings: e.listings?.map((l) => ({ mint: l.mint, symbol: l.symbol, issuer: l.issuer, token_usd: l.tokenUsd, mark_usd: l.markUsd, premium_pct: l.premiumPct })) ?? [],
    why: why ? { text: why.text, sources: why.sources.slice(0, 3).map((s) => ({ title: s.title, url: s.url, source: s.source })) } : null,
    counter_view: counter ? { text: counter.text, source: counter.source ? { title: counter.source.title, url: counter.source.url } : null } : null,
    counter_view_enabled: counterOn,
    amount_chips: AMOUNT_CHIPS,
    as_of: new Date().toISOString(),
  });
});

/** Ticker, name and alias search across the catalog. Top five. */
r.get("/catalog/search", (c) => {
  const q = (c.req.query("q") ?? "").trim().toLowerCase().replace(/[^a-z0-9 .&-]/g, "");
  if (q.length < 1) return c.json({ ok: true, results: [] });
  const reg = loadRegistry();
  const scored = COMPANIES.map((k) => {
    const name = k.name.toLowerCase();
    const ticker = k.ticker.toLowerCase();
    let score = 0;
    if (ticker === q || k.id === q) score = 100;
    else if (name === q) score = 95;
    else if (name.startsWith(q)) score = 80;
    else if (ticker.startsWith(q)) score = 70;
    else if (k.aliases.some((a) => a === q)) score = 65;
    else if (k.aliases.some((a) => a.startsWith(q))) score = 50;
    else if (name.includes(q)) score = 30;
    return { k, score };
  })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.k.name.localeCompare(b.k.name))
    .slice(0, 5)
    .map(({ k }) => {
      const tokens = reg.listingsByTicker.get(k.ticker) ?? [];
      return { company_id: k.id, name: k.name, ticker: k.ticker, exchange: k.exchange, tokenized: tokens.length > 0, listings: tokens.map((t) => ({ mint: t.mint, symbol: t.symbol, issuer: t.issuer, kind: t.kind })) };
    });
  return c.json({ ok: true, results: scored });
});

/** What a message asks for, read against what the thread last showed. Same grammar and fallback as the bubble. */
r.post("/interpret", async (c) => {
  const b = await body(c, z.object({ text: z.string().min(1).max(500), context: VoiceContextSchema.partial().optional() }));
  const ctx = {
    view: b.context?.view ?? (b.context?.entities?.length ? ("company" as const) : ("none" as const)),
    entities: b.context?.entities ?? [],
    current: b.context?.current ?? b.context?.entities?.[0] ?? null,
    amountUsd: b.context?.amountUsd ?? null,
  };
  const { command, via } = await interpret(b.text, ctx);
  return c.json({ ok: true, command, via });
});

export default r;
