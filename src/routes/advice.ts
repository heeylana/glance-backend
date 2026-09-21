import { z } from "zod";
import { auth, body, router } from "./_shared.js";
import { lookupCompany } from "../services/glance.js";
import { adviceFor } from "../services/advice.js";
import { log } from "../lib/log.js";

const r = router();
r.use("*", auth);

/**
 * POST /advice {companyId | ticker} — "what do you think of Nvidia?". The price, the premium, the
 * token's own market (Birdeye) and the week's headlines, read back as what is happening and both
 * sides of it, and never as a recommendation (services/advice.ts). The disclaimer is added there,
 * in code, so every answer carries it.
 */
r.post("/advice", async (c) => {
  const b = await body(c, z.object({ companyId: z.string().max(64).optional(), ticker: z.string().max(12).optional() }).refine((x) => !!x.companyId || !!x.ticker, { message: "companyId or ticker" }));
  const found = await lookupCompany(b);
  if (!found) return c.json({ ok: false, code: "UNKNOWN_COMPANY", message: "I don't know that company yet." }, 404);
  if (!found.entity.tokenized) {
    return c.json({ ok: true, entity: found.entity, summary: found.summary, lines: [], spoken: found.summary, disclaimer: null, sources: [] });
  }
  const advice = await adviceFor({ entity: found.entity, market: found.market });
  if (!advice) {
    log.warn("advice unavailable", { ticker: found.entity.ticker });
    return c.json({ ok: false, code: "ADVICE_UNAVAILABLE", message: "I can't read this one right now. Try again in a moment?" }, 503);
  }
  log.info("advice", { ticker: found.entity.ticker, lines: advice.lines.length, sources: advice.sources.length });
  return c.json({ ok: true, entity: found.entity, summary: found.summary, market: found.market, ...advice });
});

export default r;
