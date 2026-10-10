import { z } from "zod";
import { auth, body, router, TradeContextSchema } from "./_shared.js";
import { executeDelegatedSwap, resolveBuyMint, resolveSellMint } from "../services/trade.js";
import { usdToUsdc } from "../lib/amounts.js";

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

const r = router();
r.use("*", auth);

/** POST /buy — spec §7.5 step 4/5. Wallet comes from the session token, never the body. */
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
