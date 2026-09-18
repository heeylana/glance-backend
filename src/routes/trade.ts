import { z } from "zod";
import { auth, body, router, TradeContextSchema } from "./_shared.js";
import { executeDelegatedSwap } from "../services/trade.js";
import { loadRegistry, tradableFor } from "../config/issuers.js";
import { ensureTradable } from "../services/mocks.js";
import { GuardCode, GuardError } from "../lib/errors.js";
import { usdToUsdc } from "../lib/amounts.js";
import { COMPANIES } from "../resolver/companies.js";

const BuySchema = z.object({
  /** A tradable mint, or a catalog listing's mainnet mint (on devnet its mock is created on first buy). */
  outputMint: z.string().min(32).max(44).optional(),
  ticker: z.string().max(12).optional(),
  usdcAmount: z.number().positive().max(10_000),
  context: TradeContextSchema,
});

const SellSchema = z.object({
  inputMint: z.string().min(32).max(44).optional(),
  ticker: z.string().max(12).optional(),
  stockAmountRaw: z.string().regex(/^\d+$/).optional(),
  usd: z.number().positive().max(10_000).optional(),
  context: TradeContextSchema,
});

/**
 * The mint that trades on this cluster for a buy: an entry already tradable, a catalog listing (on
 * devnet its mock is created the first time), or a company ticker (its first listing).
 */
async function resolveBuyMint(mint: string | undefined, ticker: string | undefined): Promise<string> {
  const reg = loadRegistry();
  if (mint && reg.byMint.has(mint)) return mint;
  const listing = mint ? reg.listings.get(mint) : ticker ? reg.listingsByTicker.get(ticker.toUpperCase())?.[0] : undefined;
  if (listing) return (await ensureTradable(listing)).mint;
  if (mint) throw new GuardError(GuardCode.OUTPUT_MINT_NOT_ISSUER, {}, "mint is not in the catalog");
  if (ticker) throw new GuardError(GuardCode.MINT_NOT_TOKENIZED, { companyName: COMPANIES.find((c) => c.ticker === ticker.toUpperCase())?.name ?? ticker });
  throw new GuardError(GuardCode.BAD_REQUEST, {}, "outputMint or ticker required");
}

/** A sell needs a mint the vault can hold: an entry tradable here (never creates anything). */
function resolveSellMint(mint: string | undefined, ticker: string | undefined): string {
  const reg = loadRegistry();
  if (mint && reg.byMint.has(mint)) return mint;
  if (mint) {
    const tradable = tradableFor(mint);
    if (tradable) return tradable.mint;
  }
  const byTicker = ticker ? reg.byTicker.get(ticker.toUpperCase()) : undefined;
  if (byTicker) return byTicker.mint;
  throw new GuardError(GuardCode.BAD_REQUEST, {}, "no position to sell for that mint or ticker");
}

const r = router();
r.use("*", auth);

/** POST /buy — spec §7.5 step 4/5. Wallet comes from the Privy token, never the body. */
r.post("/buy", async (c) => {
  const b = await body(c, BuySchema);
  const result = await executeDelegatedSwap({
    side: "buy",
    owner: c.get("owner"),
    stockMint: await resolveBuyMint(b.outputMint, b.ticker),
    usdcAmount: usdToUsdc(b.usdcAmount),
    context: b.context,
  });
  return c.json(result);
});

/** POST /sell — same delegated path with USDC as output (spec §7.7). */
r.post("/sell", async (c) => {
  const b = await body(c, SellSchema);
  const result = await executeDelegatedSwap({
    side: "sell",
    owner: c.get("owner"),
    stockMint: resolveSellMint(b.inputMint, b.ticker),
    stockAmountRaw: b.stockAmountRaw ? BigInt(b.stockAmountRaw) : undefined,
    usd: b.usd,
    context: b.context,
  });
  return c.json(result);
});

export default r;
