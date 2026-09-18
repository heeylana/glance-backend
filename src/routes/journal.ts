import { z } from "zod";
import { auth, body, router } from "./_shared.js";
import * as store from "../services/store.js";
import { loadRegistry } from "../config/issuers.js";
import { getReferencePrices } from "../services/prices.js";
import { usdcToUsd } from "../lib/amounts.js";
import { COMPANIES } from "../resolver/companies.js";
import { GuardCode, GuardError } from "../lib/errors.js";

const r = router();
r.use("*", auth);

/** GET /journal — "Headlines you own" (spec §7.7): one card per buy, valued against the live price. */
r.get("/journal", async (c) => {
  const rows = await store.listJournal(c.get("owner"));
  const reg = loadRegistry();
  const mintEntries = [...new Map(rows.map((x) => [x.mint, reg.byMint.get(x.mint)])).values()].filter((x): x is NonNullable<typeof x> => !!x);
  const prices = mintEntries.length ? await getReferencePrices(mintEntries) : new Map();
  const entries = rows.map((x) => {
    const px = prices.get(x.mint);
    const nowUsd = px ? px.usd : null;
    const buyUsd = Number(x.priceUsd);
    const changePct = nowUsd !== null && buyUsd > 0 ? ((nowUsd - buyUsd) / buyUsd) * 100 : null;
    const amountUsd = usdcToUsd(x.amountUsdc);
    const sign = changePct !== null && changePct >= 0 ? "+" : "";
    return {
      id: x.id,
      companyId: x.companyId,
      name: COMPANIES.find((k) => k.ticker === x.ticker)?.name ?? x.ticker,
      ticker: x.ticker,
      mint: x.mint,
      url: x.url,
      title: x.title,
      site: x.site,
      screenshotHash: x.screenshotHash,
      amountUsd,
      buyPriceUsd: buyUsd,
      nowPriceUsd: nowUsd,
      changePct,
      note: x.note,
      createdAt: x.createdAt.toISOString(),
      line:
        nowUsd !== null && changePct !== null
          ? `bought $${amountUsd.toFixed(0)} at $${buyUsd.toFixed(0)}, now $${nowUsd.toFixed(0)} (${sign}${changePct.toFixed(0)}%)`
          : `bought $${amountUsd.toFixed(0)} at $${buyUsd.toFixed(0)}`,
    };
  });
  return c.json({ ok: true, entries });
});

r.patch("/journal/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) throw new GuardError(GuardCode.BAD_REQUEST);
  const b = await body(c, z.object({ note: z.string().max(1000).nullable() }));
  const row = await store.updateJournalNote(c.get("owner"), id, b.note);
  if (!row) throw new GuardError(GuardCode.BAD_REQUEST, {}, "not found");
  return c.json({ ok: true, id: row.id, note: row.note });
});

/** Privacy (spec §7.9): journal is deletable, one entry or all. */
r.delete("/journal/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) throw new GuardError(GuardCode.BAD_REQUEST);
  await store.deleteJournal(c.get("owner"), id);
  return c.json({ ok: true });
});
r.delete("/journal", async (c) => {
  await store.deleteJournal(c.get("owner"));
  return c.json({ ok: true });
});

export default r;
