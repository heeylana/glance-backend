import { z } from "zod";
import { auth, body, router } from "./_shared.js";
import { counterViewFor } from "../services/counter-view.js";

const r = router();
r.use("*", auth);

/** POST /counter-view — the bear-case line (spec §7.5). Off when the user turned it off in settings. */
r.post("/counter-view", async (c) => {
  const b = await body(c, z.object({ ticker: z.string().max(12) }));
  if (c.get("session")?.counterViewEnabled === false) return c.json({ ok: true, enabled: false, text: null, source: null });
  const value = await counterViewFor(b.ticker);
  return c.json({ ok: true, enabled: true, text: value?.text ?? null, source: value?.source ?? null });
});

export default r;
