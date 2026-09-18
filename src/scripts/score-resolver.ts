/**
 * Score the resolver against the captured page set (checklist §1.3; demo metric §4 wants ≥ 95%).
 *
 *   pnpm script:score-resolver                 # offline: dictionary match + decide, no network
 *   pnpm script:score-resolver --llm           # also run LLM disambiguation where the dictionary is unsure
 *   pnpm script:score-resolver --only apple    # substring filter on fixture ids
 *   pnpm script:score-resolver --verbose       # print every candidate
 *
 * Fixtures live in src/resolver/fixtures/pages.json and are appended by `pnpm script:capture-page`.
 * A fixture is what the extension sends to POST /glance (title + ~4k chars of visible text), so the
 * scorer sees exactly what production sees. Expectations:
 *   { tickers: ["AAPL"] }   the page is about this company: the top candidate must be it, or, for a
 *                           "multiple" verdict, every listed ticker must be among the strong candidates.
 *                           Lookalike-token pages (e.g. "Apple Coin") expect the real company: spec §7.8
 *                           offers the real stock, and the issuer guard is what refuses the junk mint.
 *   { none: true }          nothing to buy here: the verdict must not be "confident" (none, ask_user
 *                           or disambiguate all count as declined; with --llm, disambiguate is resolved).
 * Exit code 1 when the company-page score is below 95% or any declined page resolves confidently.
 */
import { readFileSync } from "node:fs";
import { decide, matchText, type Candidate, type Verdict } from "../resolver/match.js";

export interface Fixture {
  id: string;
  site: "x" | "youtube" | "article" | "generic";
  url: string;
  capturedAt: string;
  title?: string;
  publishedAt?: string;
  text: string;
  expect: { tickers: string[] } | { none: true };
  /** Why this page is in the set, or what it once broke. */
  note?: string;
  /** Hand-written rather than captured (X needs a login). */
  synthetic?: boolean;
}

const FIXTURES = new URL("../resolver/fixtures/pages.json", import.meta.url);
const THRESHOLD = 0.95;

function parseArgs(argv: string[]) {
  const a = { llm: false, verbose: false, only: "" };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    if (k === "--llm") a.llm = true;
    else if (k === "--verbose") a.verbose = true;
    else if (k === "--only") a.only = argv[++i] ?? "";
    else throw new Error(`unknown flag ${k}`);
  }
  return a;
}

type LlmPick = { companyId: string | null; confidence: number; reason: string } | null;
/** `llm` is what the model answered when the page went to it (null: no usable answer); absent when it didn't. */
type Row = { fx: Fixture; verdict: Verdict["kind"]; cands: Candidate[]; pass: boolean; auto: boolean; why: string; llm?: LlmPick };

async function score(fx: Fixture, llm: boolean): Promise<Row> {
  const corpus = [fx.title, fx.text].filter(Boolean).join("\n").slice(0, 8000);
  const cands = matchText(corpus, { titleLength: fx.title?.length ?? 0 });
  let verdict = decide(cands);
  let llmPick: LlmPick | undefined;
  if (llm && verdict.kind === "disambiguate") {
    const { disambiguate } = await import("../services/llm.js");
    const pick = await disambiguate({ corpus, candidates: verdict.candidates.map((c) => ({ id: c.company.id, name: c.company.name, ticker: c.company.ticker })) }).catch(() => null);
    llmPick = pick;
    if (pick?.companyId) {
      const chosen = verdict.candidates.find((c) => c.company.id === pick.companyId);
      if (chosen) verdict = { kind: "confident", top: { ...chosen, confidence: Math.max(chosen.confidence, pick.confidence) } };
    } else if (pick && pick.companyId === null && pick.confidence >= 0.8) verdict = { kind: "none" };
  }
  const top = verdict.kind === "confident" ? verdict.top : verdict.kind === "none" ? undefined : verdict.candidates[0];
  const strong = verdict.kind === "multiple" ? verdict.candidates.map((c) => c.company.ticker) : [];
  if ("none" in fx.expect) {
    const pass = verdict.kind !== "confident" && verdict.kind !== "multiple";
    return { fx, verdict: verdict.kind, cands, pass, auto: false, why: pass ? "declined" : `resolved ${top?.company.ticker ?? strong.join("+")} confidently`, llm: llmPick };
  }
  const want = fx.expect.tickers;
  const pass = verdict.kind === "multiple" ? want.every((t) => strong.includes(t)) : !!top && top.company.ticker === want[0];
  return { fx, verdict: verdict.kind, cands, pass, auto: verdict.kind === "confident", why: pass ? "" : `top ${top?.company.ticker ?? "-"}${strong.length ? ` [${strong.join(",")}]` : ""}, wanted ${want.join("/")}`, llm: llmPick };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const all: Fixture[] = JSON.parse(readFileSync(FIXTURES, "utf8"));
  const fixtures = args.only ? all.filter((f) => f.id.includes(args.only)) : all;
  if (fixtures.length === 0) throw new Error("no fixtures matched");
  const rows: Row[] = [];
  for (const fx of fixtures) rows.push(await score(fx, args.llm));

  const w = Math.max(...rows.map((r) => r.fx.id.length));
  for (const r of rows) {
    const expect = "none" in r.fx.expect ? "none" : r.fx.expect.tickers.join("/");
    const top = r.cands[0] ? `${r.cands[0].company.ticker}:${r.cands[0].confidence}` : "-";
    console.log(`${r.pass ? "ok  " : "MISS"} ${r.fx.id.padEnd(w)} ${r.fx.site.padEnd(7)} want=${expect.padEnd(10)} got=${r.verdict.padEnd(12)} ${top.padEnd(12)} ${r.why}`);
    if (args.verbose) for (const c of r.cands) console.log(`       ${c.company.ticker}:${c.confidence} ${[...new Set(c.evidence.map((e) => `${e.kind}=${e.text}`))].join(" ")}`);
    if (args.verbose && r.llm !== undefined)
      console.log(r.llm ? `       llm: ${r.llm.companyId ?? "none"} (confidence ${r.llm.confidence}) ${r.llm.reason}` : "       llm: no usable answer");
  }
  const company = rows.filter((r) => !("none" in r.fx.expect));
  const declined = rows.filter((r) => "none" in r.fx.expect);
  const hit = company.filter((r) => r.pass).length;
  const auto = company.filter((r) => r.auto).length;
  const held = declined.filter((r) => r.pass).length;
  const rate = company.length ? hit / company.length : 1;
  console.log(`\ncompany pages: ${hit}/${company.length} resolved (${(rate * 100).toFixed(0)}%), ${auto} without a prompt · declined pages: ${held}/${declined.length} held${args.llm ? " · with LLM" : " · offline"}`);
  const ok = rate >= THRESHOLD && held === declined.length;
  console.log(ok ? "PASS" : `FAIL (need ≥ ${THRESHOLD * 100}% and every declined page held)`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
