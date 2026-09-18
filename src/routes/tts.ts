import { z } from "zod";
import { auth, body, router } from "./_shared.js";
import { synthesize, TTS_MAX_CHARS } from "../services/tts.js";

const r = router();
r.use("*", auth);

/** POST /tts {text} — the bubble's spoken line as MP3 (spec §7.1). 503 when no voice is configured; the extension then speaks locally. */
r.post("/tts", async (c) => {
  const b = await body(c, z.object({ text: z.string().min(1).max(TTS_MAX_CHARS) }));
  const out = await synthesize(b.text);
  if (!out) return c.json({ ok: false, code: "TTS_UNAVAILABLE", message: "Voice is unavailable right now." }, 503);
  return c.body(new Uint8Array(out.bytes), 200, { "content-type": out.mime, "cache-control": "private, max-age=86400", "x-glance-tts": out.cached ? "cache" : "fish" });
});

export default r;
