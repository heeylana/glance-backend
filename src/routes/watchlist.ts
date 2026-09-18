import { z } from "zod";
import { auth, body, router } from "./_shared.js";
import * as store from "../services/store.js";
import { COMPANIES } from "../resolver/companies.js";
import { loadRegistry } from "../config/issuers.js";
import { GuardCode, GuardError } from "../lib/errors.js";

const r = router();
r.use("*", auth);

/** "Waiting on the headline" (spec §7.7): glanced companies that are not tokenized yet. */
r.get("/watchlist", async (c) => {
  const rows = await store.listWatch(c.get("owner"));
  const reg = loadRegistry();
  return c.json({
    ok: true,
    watchlist: rows.map((w) => ({
      companyId: w.companyId,
      ticker: w.ticker,
      name: COMPANIES.find((k) => k.id === w.companyId)?.name ?? w.ticker,
      nowTokenized: reg.listingsByTicker.has(w.ticker),
      createdAt: w.createdAt.toISOString(),
    })),
  });
});

r.post("/watchlist", async (c) => {
  const b = await body(c, z.object({ companyId: z.string().min(1).max(32) }));
  const company = COMPANIES.find((k) => k.id === b.companyId);
  if (!company) throw new GuardError(GuardCode.BAD_REQUEST, {}, "unknown company");
  await store.addWatch(c.get("owner"), company.id, company.ticker);
  return c.json({ ok: true, message: `I'll tell you when ${company.name} is available.` });
});

r.delete("/watchlist/:companyId", async (c) => {
  await store.removeWatch(c.get("owner"), c.req.param("companyId"));
  return c.json({ ok: true });
});

export default r;
