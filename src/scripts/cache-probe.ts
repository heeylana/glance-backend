/**
 * Prompt-cache probe for "show me" (doc/cost-reduction-todo.md, item 1.3). Sends one small explain
 * request twice through the real code path, with the same instructions and skill, prints both usage
 * lines, and exits 1 when the second one read nothing from the cache.
 *
 * Costs two short calls on LLM_VISION_MODEL ?? LLM_MODEL (about a cent on Sonnet 5); no screenshot is sent.
 * The probe includes one skill, like most real questions. First run, 18 Sep 2026 on Sonnet 5: 4,632
 * tokens read from the cache on each call, about half a cent per call.
 *
 *   pnpm script:cache-probe
 */
import { explainPage, lastUsage } from "../services/llm.js";
import { loadSkills, SKILLS_DIR, skillsPrompt } from "../services/skills.js";

const skills = skillsPrompt(loadSkills(SKILLS_DIR).filter((s) => s.name === "candlestick-charts"));
const input = {
  question: "what is this chart showing?",
  skills,
  pageHeader: "Page: https://example.com/quote/AAPL (Apple Inc. stock price), screenshot 1280x800",
  elementMap: ["e1 | heading | 40,20,600,40 | Apple Inc. (AAPL)", "e2 | text | 40,80,300,24 | $231.40 +1.2% today", "e3 | tab | 40,120,40,24 | 1D", "e4 | tab | 90,120,40,24 | 1Y"].join("\n"),
  earlier: "",
  image: null,
};

for (const n of [1, 2]) {
  const before = lastUsage("explainPage");
  await explainPage(input);
  const u = lastUsage("explainPage");
  if (!u || u === before) {
    console.error(`request ${n} got no response: check ANTHROPIC_API_KEY and the log above`);
    process.exit(2);
  }
  console.log(`request ${n}: model ${u.model}, input ${u.input}, cache write ${u.cacheWrite}, cache read ${u.cacheRead}, output ${u.output}, $${u.usd}`);
}

const second = lastUsage("explainPage")!;
if (second.cacheRead === 0) {
  console.error("the second request read nothing from the cache: something in the system blocks changes between requests, or the prefix is under the model's minimum");
  process.exit(1);
}
console.log(`ok: ${second.cacheRead} tokens read from the cache`);
