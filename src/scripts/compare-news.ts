/**
 * Compare "why did it move" and the counter-view across models on the same frozen headlines
 * (doc/cost-reduction-todo.md 2.0). There is no automatic grade for these: the report puts each
 * model's answer side by side with the headlines, plus the checks that can be automated (word limits,
 * a valid headline index, failures, cost).
 *
 *   pnpm script:compare-news --capture                     # save today's headlines (Finnhub, free) as the set
 *   pnpm script:compare-news --out report.md               # run the set on LLM_FAST_MODEL
 *   pnpm script:compare-news --models claude-haiku-4-5,claude-opus-5 --out report.md
 *
 * Prices are left out ("moved an unknown amount") so the answers rest on the headlines alone.
 * The set lives in src/services/fixtures/news-sets.json.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { env } from "../config.js";
import { COMPANIES } from "../resolver/companies.js";
import { fetchHeadlines, type Headline } from "../services/news.js";
import { counterView, explainMove, lastUsage } from "../services/llm.js";

const SET = new URL("../services/fixtures/news-sets.json", import.meta.url);
const TICKERS = ["AAPL", "NVDA", "TSLA", "MSFT", "AMZN", "META", "NVO", "GOOGL"];

type NewsSet = { ticker: string; name: string; capturedAt: string; day: Headline[]; week: Headline[] };

function parseArgs(argv: string[]) {
  const a = { capture: false, out: "", models: [] as string[] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    if (k === "--capture") a.capture = true;
    else if (k === "--out") a.out = argv[++i] ?? "";
    else if (k === "--models") a.models = (argv[++i] ?? "").split(",").filter(Boolean);
    else throw new Error(`unknown flag ${k}`);
  }
  return a;
}

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

async function capture() {
  const sets: NewsSet[] = [];
  for (const ticker of TICKERS) {
    const name = COMPANIES.find((c) => c.ticker === ticker)?.name ?? ticker;
    const [day, week] = await Promise.all([fetchHeadlines({ ticker, name, sinceMinutes: 1440 }), fetchHeadlines({ ticker, name, sinceMinutes: 7 * 1440 })]);
    sets.push({ ticker, name, capturedAt: new Date().toISOString(), day, week });
    console.log(`${ticker}: ${day.length} headlines in 24 h, ${week.length} in 7 days`);
  }
  writeFileSync(SET, JSON.stringify(sets, null, 2) + "\n");
  console.log(`saved ${sets.length} sets to ${SET.pathname}`);
}

async function run(models: string[], out: string) {
  const sets: NewsSet[] = JSON.parse(readFileSync(SET, "utf8"));
  const md: string[] = [`# "Why" and counter-view: ${models.join(" vs ")}`, "", `Headlines captured ${sets[0]?.capturedAt ?? "?"}. Prices left out. Limits: "why" ≤ 40 words, counter-view ≤ 25 words.`, ""];
  const cost: Record<string, number> = Object.fromEntries(models.map((m) => [m, 0]));
  const flags: string[] = [];
  const track = (m: string, route: "explainMove" | "counterView", before: ReturnType<typeof lastUsage>) => {
    const u = lastUsage(route);
    if (u && u !== before) cost[m]! += u.usd ?? 0;
  };
  for (const s of sets) {
    md.push(`## ${s.name} (${s.ticker})`, "", `<details><summary>${s.day.length} headlines in 24 h, ${s.week.length} in 7 days</summary>`, "");
    s.week.slice(0, 20).forEach((h, i) => md.push(`${i}. [${h.source}] ${h.title} (${h.publishedAt})`));
    md.push("", "</details>", "", "| Model | Why did it move? | Counter-view |", "|---|---|---|");
    for (const m of models) {
      env.LLM_FAST_MODEL = m;
      let before = lastUsage("explainMove");
      const why = s.day.length ? await explainMove({ name: s.name, ticker: s.ticker, headlines: s.day, priceNow: null, priceDayAgo: null, windowMinutes: 1440 }) : null;
      track(m, "explainMove", before);
      before = lastUsage("counterView");
      const cv = s.week.length ? await counterView({ name: s.name, ticker: s.ticker, headlines: s.week }) : null;
      track(m, "counterView", before);
      if (why && words(why.text) > 40) flags.push(`${m} ${s.ticker}: "why" has ${words(why.text)} words`);
      if (cv && words(cv.text) > 25) flags.push(`${m} ${s.ticker}: counter-view has ${words(cv.text)} words`);
      if (s.day.length && !why) flags.push(`${m} ${s.ticker}: no "why" answer`);
      const whyCell = why ? why.text : s.day.length ? "**failed**" : "(no headlines)";
      const cvCell = cv ? `${cv.text}${cv.headlineIndex !== null ? ` _(rests on #${cv.headlineIndex})_` : ""}` : s.week.length ? "(nothing against)" : "(no headlines)";
      md.push(`| ${m} | ${whyCell.replace(/\|/g, "\\|")} | ${cvCell.replace(/\|/g, "\\|")} |`);
    }
    md.push("");
  }
  md.push("## Automatic checks", "", ...(flags.length ? flags.map((f) => `- ${f}`) : ["- none flagged"]), "", "## Cost", "", ...models.map((m) => `- ${m}: $${cost[m]!.toFixed(4)}`), "");
  writeFileSync(out, md.join("\n"));
  console.log(`report written to ${out}`);
  for (const m of models) console.log(`${m}: $${cost[m]!.toFixed(4)}`);
  for (const f of flags) console.log(`flag: ${f}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.capture) return capture();
  if (!args.out) throw new Error("--out <file.md> is required");
  await run(args.models.length ? args.models : [env.LLM_FAST_MODEL], args.out);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
