import { auth, router } from "./_shared.js";
import { portfolioView } from "../services/portfolio.js";

const r = router();
r.use("*", auth);

/** GET /portfolio — the vault's holdings, curated mints only, valued (spec §7.7). */
r.get("/portfolio", async (c) => {
  const { session: _session, ...view } = await portfolioView(c.get("owner"));
  return c.json({ ok: true, ...view });
});

export default r;
