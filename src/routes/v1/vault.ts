/** The bound user's account and trades (§1.5): read from chain, quote then execute with one lock. */
import { z } from "zod";
import { body, TradeContextSchema } from "../_shared.js";
import { botAuth, channelUser, rateLimit, v1Router } from "./_auth.js";
import { ApiError } from "./codes.js";
import { portfolioView } from "../../services/portfolio.js";
import { executePrepared, prepareSwap, quoteOf, resolveBuyMint, resolveSellMint, type TradeContext, type TradeRequest } from "../../services/trade.js";
import { claimQuote, finishQuote, insertQuote, quoteExpiry, quoteStatus, type TradeQuote } from "../../services/quotes.js";
import { newQuoteId } from "../../services/quotes.js";
import { usdToUsdc, usdcToUsd } from "../../lib/amounts.js";
import { GuardCode, GuardError } from "../../lib/errors.js";
import * as store from "../../services/store.js";
import { loadRegistry } from "../../config/issuers.js";
import { env } from "../../config.js";
import { log } from "../../lib/log.js";

const r = v1Router();
r.use("*", botAuth, channelUser({ required: true }), rateLimit(60));

const usd2 = (n: number) => n.toFixed(2);
const explorer = (sig: string) => `https://explorer.solana.com/tx/${sig}${env.SOLANA_CLUSTER === "devnet" ? "?cluster=devnet" : ""}`;

/** Balance, holdings, today's leash, agent expiry. Chain-read on every call. */
r.get("/vault", async (c) => {
  const { session: s, ...p } = await portfolioView(c.get("owner"));
  return c.json({
    ok: true,
    wallet: p.wallet,
    vault: p.vault,
    exists: p.exists,
    paused: s.paused,
    agent_active: s.agentActive,
    agent_expires_at: s.agentExpiresAt,
    needs_renewal: s.needsRenewal,
    cash_usd: usd2(p.cashUsd),
    holdings: p.holdings.map((h) => ({ ticker: h.ticker, name: h.name, mint: h.mint, shares: h.shares, shares_raw: h.sharesRaw, decimals: h.decimals, price_usd: h.priceUsd, value_usd: h.valueUsd !== null ? usd2(h.valueUsd) : null, day_change_pct: h.dayChangePct })),
    total_usd: usd2(p.totalUsd),
    daily_cap_usd: usd2(s.dailyCapUsd),
    spent_today_usd: usd2(s.spentTodayUsd),
    remaining_today_usd: usd2(s.remainingTodayUsd),
    per_trade_cap_usd: usd2(s.perTxCapUsd),
    confirm_each_trade: c.get("binding")?.confirmEachTrade ?? true,
    console_url: s.consoleUrl,
    cluster: s.cluster,
    as_of: new Date().toISOString(),
  });
});

const QuoteSchema = z
  .object({
    side: z.enum(["buy", "sell"]),
    ticker: z.string().max(12).optional(),
    mint: z.string().min(32).max(44).optional(),
    usd: z.number().positive().max(10_000).optional(),
    all: z.boolean().optional(),
    fraction: z.number().gt(0).lte(1).optional(),
    context: TradeContextSchema,
  })
  .refine((x) => !!x.ticker || !!x.mint, { message: "ticker or mint" })
  .refine((x) => (x.side === "buy" ? x.usd !== undefined : x.usd !== undefined || x.all || x.fraction !== undefined), { message: "amount" });

function quoteView(q: TradeQuote, status = quoteStatus(q)) {
  return {
    quote_id: q.id,
    status,
    side: q.side,
    ticker: q.ticker,
    name: q.companyName,
    mint: q.stockMint,
    usd: Number(q.usd).toFixed(2),
    est_shares: Number(q.estAmountOutRaw) / 10 ** (loadRegistry().byMint.get(q.stockMint)?.decimals ?? 0),
    usd_per_share: Number(q.quotedUsdPerShare),
    uses_today_usd: q.side === "buy" ? Number(q.usd).toFixed(2) : "0.00",
    remaining_today_usd: Number(q.remainingTodayUsd).toFixed(2),
    expires_at: q.expiresAt.toISOString(),
  };
}

/** Pre-checks and the desk price, kept for two minutes. The reply is what the bot shows before "yes". */
r.post("/trades/quote", async (c) => {
  const b = await body(c, QuoteSchema);
  const owner = c.get("owner");
  const context: TradeContext = { ...(b.context ?? {}), site: b.context?.site ?? c.get("channel") };
  let req: TradeRequest;
  if (b.side === "buy") {
    req = { side: "buy", owner, stockMint: await resolveBuyMint(b.mint, b.ticker), usdcAmount: usdToUsdc(b.usd!), context };
  } else {
    const stockMint = resolveSellMint(b.mint, b.ticker);
    if (b.all || b.fraction !== undefined) {
      const holding = (await portfolioView(owner)).holdings.find((h) => h.mint === stockMint);
      if (!holding || BigInt(holding.sharesRaw) === 0n) throw new ApiError("no_position");
      const raw = BigInt(holding.sharesRaw);
      const part = b.all ? raw : (raw * BigInt(Math.round((b.fraction ?? 1) * 1_000_000))) / 1_000_000n;
      if (part <= 0n) throw new ApiError("no_position");
      req = { side: "sell", owner, stockMint, stockAmountRaw: part, context };
    } else {
      req = { side: "sell", owner, stockMint, usd: b.usd, context };
    }
  }
  const prepared = await prepareSwap(req);
  const q = quoteOf(prepared);
  // For a sell the quote's "amount in" is the stock; the row keeps what execute needs to rebuild the request.
  const amountInRaw = prepared.amountIn;
  const row = await insertQuote({
    id: newQuoteId(),
    owner,
    side: q.side,
    stockMint: q.mint,
    ticker: q.ticker,
    companyName: q.companyName,
    usd: q.usd.toFixed(2),
    amountInRaw,
    estAmountOutRaw: prepared.quote.outAmount,
    quotedUsdPerShare: q.usdPerShare.toFixed(6),
    remainingTodayUsd: q.remainingTodayUsd.toFixed(2),
    maxSlippageBps: q.maxSlippageBps,
    context: JSON.stringify(context),
    expiresAt: quoteExpiry(),
  });
  log.info("quote issued", { owner, side: q.side, ticker: q.ticker, usd: q.usd, id: row.id });
  return c.json({ ok: true, quote: quoteView(row), confirm_each_trade: c.get("binding")?.confirmEachTrade ?? true, price_source: q.priceSource, price_stale: q.priceStale });
});

/** Execute one claimed quote: re-run every check, refuse if the price moved past the slippage, then sign. */
r.post("/trades/:id/execute", async (c) => {
  const owner = c.get("owner");
  const claim = await claimQuote(c.req.param("id"), owner);
  if (claim.status !== "claimed") {
    if (claim.status === "unknown" || !claim.quote) throw new ApiError("quote_expired");
    throw new ApiError(claim.status === "used" ? "quote_used" : "quote_expired", { quote: quoteView(claim.quote) });
  }
  const q: TradeQuote = claim.quote;
  const context = (q.context ? (JSON.parse(q.context) as TradeContext) : {}) ?? {};
  const req: TradeRequest = q.side === "buy" ? { side: "buy", owner, stockMint: q.stockMint, usdcAmount: q.amountInRaw, context } : { side: "sell", owner, stockMint: q.stockMint, stockAmountRaw: q.amountInRaw, context };
  let prepared;
  try {
    prepared = await prepareSwap(req);
    const now = quoteOf(prepared).usdPerShare;
    const quoted = Number(q.quotedUsdPerShare);
    const movedBps = quoted > 0 ? Math.abs(now - quoted) / quoted * 10_000 : 0;
    if (movedBps > q.maxSlippageBps) {
      await finishQuote(q.id, { failureCode: "quote_moved" });
      log.info("quote moved", { id: q.id, quoted, now, movedBps: Math.round(movedBps) });
      throw new ApiError("quote_moved", { quoted_usd_per_share: quoted, usd_per_share_now: now, moved_bps: Math.round(movedBps) });
    }
  } catch (e) {
    if (e instanceof GuardError) await finishQuote(q.id, { failureCode: e.code });
    throw e;
  }
  let result;
  try {
    result = await executePrepared(prepared);
  } catch (e) {
    await finishQuote(q.id, { failureCode: e instanceof GuardError ? e.code : GuardCode.SUBMIT_FAILED });
    throw e;
  }
  await finishQuote(q.id, { ledgerId: result.ledgerId });
  const remaining = Math.max(0, prepared.dailyCapUsd - usdcToUsd(prepared.view.dailySpent) - (q.side === "buy" ? result.usdcValue : 0));
  log.info("quote executed", { id: q.id, owner, side: q.side, ticker: q.ticker, signature: result.signature });
  return c.json({
    ok: true,
    quote_id: q.id,
    side: result.side,
    ticker: result.ticker,
    name: result.companyName,
    signature: result.signature,
    explorer_url: explorer(result.signature),
    usd: usd2(result.usdcValue),
    shares: result.sharesDelta,
    usd_per_share: result.usdPerShare,
    position_shares: result.positionShares,
    position_usd: usd2(result.positionUsd),
    remaining_today_usd: usd2(remaining),
    message: result.message,
    journal_id: result.journalId ?? null,
  });
});

/** Recent trades for the bound user, newest first. */
r.get("/trades", async (c) => {
  const rows = await store.listActivity(c.get("owner"), 20);
  const reg = loadRegistry();
  return c.json({
    ok: true,
    trades: rows.map((x) => {
      const stock = reg.byMint.get(x.side === "buy" ? x.outputMint : x.inputMint);
      return {
        id: x.id,
        side: x.side,
        status: x.status,
        ticker: stock?.ticker ?? null,
        usd: usd2(usdcToUsd(x.usdcValue)),
        amount_in_raw: x.amountIn.toString(),
        amount_out_raw: x.amountOut?.toString() ?? null,
        signature: x.signature,
        explorer_url: x.signature ? explorer(x.signature) : null,
        headline: x.headline,
        failure_code: x.failureCode,
        created_at: x.createdAt.toISOString(),
      };
    }),
  });
});

export default r;
