import { z } from "zod";
import { auth, body, router } from "./_shared.js";
import { GuardCode, GuardError } from "../lib/errors.js";
import { log } from "../lib/log.js";
import { notePage } from "../services/llm.js";
import { parsePublishedAt } from "../services/glance.js";
import { noteCompanies } from "../services/remember.js";

const RememberSchema = z.object({
  url: z.string().max(2048),
  title: z.string().max(1024).optional(),
  site: z.enum(["x", "youtube", "article", "generic"]).optional(),
  publishedAt: z.union([z.string(), z.number()]).optional(),
  text: z.string().max(20_000),
});

const r = router();
r.use("*", auth);

/**
 * POST /remember {url, title, site, publishedAt, text} — "remember this page": a short fact sheet
 * (summary, facts, companies) for the extension to keep in the user's browser and send with questions
 * on other pages. Built once, on request, on LLM_FAST_MODEL. Nothing is stored here, and only the host
 * and counts are logged.
 */
r.post("/remember", async (c) => {
  const input = await body(c, RememberSchema);
  const text = input.text.trim();
  if (text.length < 80) throw new GuardError(GuardCode.REMEMBER_UNAVAILABLE);
  const title = input.title?.trim() || "";
  const published = parsePublishedAt(input.publishedAt);
  const draft = await notePage({ url: input.url, title, site: input.site, publishedAt: published?.toISOString(), text });
  if (!draft) throw new GuardError(GuardCode.REMEMBER_UNAVAILABLE);
  const companies = noteCompanies(draft.companies, title, text);
  const host = (() => {
    try {
      return new URL(input.url).hostname;
    } catch {
      return "";
    }
  })();
  log.info("remember", { host, chars: text.length, facts: draft.facts.length, companies: companies.map((k) => k.ticker) });
  return c.json({
    ok: true,
    note: {
      url: input.url,
      title: title || host || "Untitled page",
      site: input.site ?? null,
      publishedAt: published?.toISOString() ?? null,
      savedAt: new Date().toISOString(),
      summary: draft.summary,
      facts: draft.facts,
      companies,
    },
  });
});

export default r;
