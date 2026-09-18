import { Hono } from "hono";
import { COMPANIES } from "../resolver/companies.js";
import { loadRegistry } from "../config/issuers.js";

/**
 * GET /dictionary — the passive-mode dictionary the content script uses for
 * local underlining (spec §7.3). Public: it is the same list a user could read
 * off any finance site, and passive underlining must work before sign-in.
 */
const r = new Hono();

r.get("/dictionary", (c) => {
  const reg = loadRegistry();
  const companies = COMPANIES.map((k) => ({
    id: k.id,
    name: k.name,
    ticker: k.ticker,
    aliases: k.aliases,
    products: k.products,
    execs: k.execs,
    tokenized: reg.listingsByTicker.has(k.ticker),
    ...(k.exchange === "PRIVATE" ? { private: true } : {}),
    ...(k.ambiguousName ? { ambiguousName: true } : {}),
    ...(k.ambiguousTicker ? { ambiguousTicker: true } : {}),
  }));
  c.header("cache-control", "public, max-age=3600");
  return c.json({ ok: true, version: 2, generatedAt: new Date().toISOString(), companies });
});

export default r;
