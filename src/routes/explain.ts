import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { auth, body, router } from "./_shared.js";
import { env } from "../config.js";
import { GuardCode, GuardError } from "../lib/errors.js";
import { log } from "../lib/log.js";
import { explain, ExplainInputSchema, type ExplainInput } from "../services/explain.js";
import { loadSkills } from "../services/skills.js";

let captureAnnounced = false;

/**
 * Dev only (doc/cost-reduction-todo.md 2.0): with EVAL_CAPTURE_DIR set, keep each request and its answer
 * as one JSON file, so real pages can be replayed later on other models. This stores what the route
 * otherwise discards, the screenshot included, so it is off unless that variable is set.
 */
function captureForEval(input: ExplainInput, answer: unknown, host: string) {
  const dir = env.EVAL_CAPTURE_DIR;
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${host || "page"}.json`);
    writeFileSync(file, JSON.stringify({ capturedAt: new Date().toISOString(), input, answer }));
    if (!captureAnnounced) {
      captureAnnounced = true;
      log.warn("explain capture is on: saving questions, page maps and screenshots for the eval", { dir });
    }
  } catch (e) {
    log.warn("explain capture failed", { err: String(e) });
  }
}

const r = router();
r.use("*", auth);

/**
 * POST /explain {question, url, title, size, image?, elements, history, stepsLeft} — a spoken question
 * about the page, answered as spoken segments with marks to draw while each is said, and at most one
 * scroll or click to take before the extension asks again with a fresh view. Only the host, sizes and counts
 * are logged; the question, the page text and the screenshot are not kept (unless EVAL_CAPTURE_DIR is set
 * on a dev machine, see captureForEval).
 */
r.post("/explain", async (c) => {
  const input = await body(c, ExplainInputSchema);
  const t0 = Date.now();
  const res = await explain(input);
  const host = (() => {
    try {
      return new URL(input.url).hostname;
    } catch {
      return "";
    }
  })();
  log.info("explain", { host, elements: input.elements.length, imageBytes: input.image ? Math.floor((input.image.length * 3) / 4) : 0, segments: res?.segments.length ?? 0, marks: res?.segments.reduce((n, s) => n + s.marks.length, 0) ?? 0, step: input.history.length + 1, action: res?.action.kind ?? null, skills: res?.skills ?? [], chart: !!res?.chart, ms: Date.now() - t0 });
  captureForEval(input, res, host);
  if (!res) throw new GuardError(GuardCode.EXPLAIN_UNAVAILABLE);
  return c.json({ ok: true, segments: res.segments, chart: res.chart, action: res.action, skills: res.skills });
});

/** GET /skills — what Glance knows how to explain; add one by dropping skills/<name>/SKILL.md into the backend. */
r.get("/skills", (c) => c.json({ ok: true, skills: loadSkills().map(({ name, description, when, sites }) => ({ name, description, when, sites })) }));

export default r;
