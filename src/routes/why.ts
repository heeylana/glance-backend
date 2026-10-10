import { z } from "zod";
import { auth, body, router } from "./_shared.js";
import { whyFor } from "../services/why.js";

const r = router();
r.use("*", auth);

/**
 * POST /why — "Why did it move?" (spec §7.6). Cached 10 min per ticker, and `warm: true` (sent while
 * the user is still talking) starts the work without waiting for it. The work lives in services/why.ts.
 */
r.post("/why", async (c) => {
  const b = await body(c, z.object({ ticker: z.string().max(12), warm: z.boolean().optional() }));
  const res = whyFor(b.ticker, { warm: b.warm });
  if ("cached" in res) return c.json({ ok: true, ...res.cached });
  if ("warming" in res) return c.json({ ok: true, warming: true });
  const value = await res.work;
  if (!value) return c.json({ ok: false, code: "NOT_CONFIGURED", message: "I can't check the news right now." }, 503);
  return c.json({ ok: true, ...value });
});

export default r;
