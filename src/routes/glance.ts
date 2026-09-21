import { z } from "zod";
import { auth, body, router } from "./_shared.js";
import { glance, glanceScreenshot, lookupCompany } from "../services/glance.js";
import { priceSeries, tokenMarket } from "../services/birdeye.js";
import { loadRegistry } from "../config/issuers.js";
import { getReferencePrices } from "../services/prices.js";
import { COMPANIES } from "../resolver/companies.js";

const GlanceSchema = z.object({
  url: z.string().max(2048),
  title: z.string().max(1024).optional(),
  site: z.enum(["x", "youtube", "article", "generic"]).optional(),
  publishedAt: z.union([z.string(), z.number()]).optional(),
  text: z.string().max(20_000),
  captions: z.string().max(20_000).optional(),
  /** A company id from /dictionary: the underline the user asked to glance. */
  focus: z.string().max(64).optional(),
});

/** Vision fallback body: ~1280×900 JPEG at quality 60 is 100–300 KB as base64; 6 MB leaves room for retina captures. */
const VisionSchema = z.object({
  url: z.string().max(2048),
  title: z.string().max(1024).optional(),
  site: z.enum(["x", "youtube", "article", "generic"]).optional(),
  publishedAt: z.union([z.string(), z.number()]).optional(),
  image: z.string().max(6_000_000).regex(/^data:image\/(jpeg|png|webp);base64,/, "image must be a jpeg, png or webp data url"),
});

const r = router();
r.use("*", auth);

/** POST /glance — page context in, entities + prices + spoken sentence out (spec §9). */
r.post("/glance", async (c) => {
  const input = await body(c, GlanceSchema);
  const result = await glance(input);
  return c.json({ ok: true, ...result });
});

/**
 * POST /company — one company asked about out loud, with no page involved (voice kind `stock`):
 * "how's Nvidia doing?". The same entity a glance returns, so the card can offer Buy, plus the
 * spoken line. No model call: the user is holding a key, waiting.
 */
r.post("/company", async (c) => {
  const b = await body(c, z.object({ companyId: z.string().max(64).optional(), ticker: z.string().max(12).optional() }).refine((x) => !!x.companyId || !!x.ticker, { message: "companyId or ticker" }));
  const found = await lookupCompany(b);
  if (!found) return c.json({ ok: false, code: "UNKNOWN_COMPANY", message: "I don't know that company yet." }, 404);
  // `market` is Birdeye's, and null without its key or when it was slow: the card shows the day's
  // numbers when they are there and stays a plain buy card when they are not.
  return c.json({ ok: true, ...found });
});

/**
 * POST /company/history — the day's price path for the little chart on the card, hourly from
 * Birdeye. Asked for after the card is already up, so it draws itself while Glance is still
 * talking; an empty answer just means no chart.
 */
r.post("/company/history", async (c) => {
  const b = await body(c, z.object({ mint: z.string().min(32).max(64) }));
  // The market comes back too: when it was too slow for the spoken line, this is how the card still
  // ends up showing the day's volume and liquidity. By now it is usually the cached copy.
  const [points, market] = await Promise.all([priceSeries(b.mint).catch(() => null), tokenMarket(b.mint).catch(() => null)]);
  return c.json({ ok: true, points: points ?? [], market });
});

/** POST /glance/vision — screenshot in when the page had no readable text (spec §7.3); same result shape out. */
r.post("/glance/vision", async (c) => {
  const input = await body(c, VisionSchema);
  const result = await glanceScreenshot(input);
  return c.json({ ok: true, ...result });
});

/** GET /prices?tickers=AAPL,NVDA — live prices for the passive hover card (spec §7.3). */
r.get("/prices", async (c) => {
  const tickers = (c.req.query("tickers") ?? "")
    .split(",")
    .map((t) => t.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 25);
  const reg = loadRegistry();
  const primary = (t: string) => reg.listingsByTicker.get(t)?.[0];
  const entries = tickers.map(primary).filter((e): e is NonNullable<typeof e> => !!e);
  const prices = entries.length ? await getReferencePrices(entries) : new Map();
  const nowSec = Math.floor(Date.now() / 1000);
  return c.json({
    ok: true,
    prices: tickers.map((t) => {
      const e = primary(t);
      const px = e ? prices.get(e.mint) : undefined;
      return {
        ticker: t,
        name: COMPANIES.find((x) => x.ticker === t)?.name ?? t,
        tokenized: !!e,
        mint: e?.mint,
        priceUsd: px ? px.usd : null,
        stale: px ? nowSec - px.publishTime > 300 : null,
        source: px?.source ?? null,
      };
    }),
  });
});

export default r;
