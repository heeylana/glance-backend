/**
 * Replay captured "show me" requests (EVAL_CAPTURE_DIR, doc/cost-reduction-todo.md 2.0) on other
 * configurations and compare them side by side. Each capture already holds the answer production gave,
 * which is the baseline column at no cost.
 *
 *   pnpm script:replay-explain --tokens                                  # free: where each capture's input tokens go
 *   pnpm script:replay-explain --configs sonnet,sonnet+full,sonnet+nothink,sonnet:medium --out report.html
 *   pnpm script:replay-explain --configs opus --only birdeye --out report.html
 *
 * A config is `<model>[:<effort>][+full][+nothink]`: model sonnet | opus | haiku | a full id; effort low |
 * medium | high (default low); +full sends the uncut element map instead of production's `compactElements`;
 * +nothink turns thinking off (LLM_VISION_THINKING=off) to see what it saves in output tokens and costs in answers.
 * Captures from before 19 Sep 2026 were answered with the full map. The report draws every answer's
 * marks on the capture's screenshot; judge them by eye. It embeds the screenshots, so keep it local.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { env } from "../config.js";
import { compactElements, ExplainInputSchema, explainRequest, sanitizeExplanation, type ExplainParsed as ExplainInput } from "../services/explain.js";
import { explainPage, explainPrompt, lastUsage, type Explanation, type Mark } from "../services/llm.js";

type Capture = { file: string; capturedAt: string; input: ExplainInput; answer: (Explanation & { skills?: string[] }) | null };
type Config = { label: string; model: string; effort: "low" | "medium" | "high"; full: boolean; nothink: boolean };
type Run = { config: string; answer: Explanation | null; ms: number | null; usd: number | null; proposed: number; kept: number; tokens: string };

const MODELS: Record<string, string> = { sonnet: "claude-sonnet-5", opus: "claude-opus-5", haiku: "claude-haiku-4-5" };

function parseArgs(argv: string[]) {
  const a = { tokens: false, configs: [] as Config[], out: "", only: "", dir: env.EVAL_CAPTURE_DIR ?? "eval-captures" };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    if (k === "--tokens") a.tokens = true;
    else if (k === "--out") a.out = argv[++i] ?? "";
    else if (k === "--only") a.only = argv[++i] ?? "";
    else if (k === "--dir") a.dir = argv[++i] ?? a.dir;
    else if (k === "--configs") a.configs = (argv[++i] ?? "").split(",").filter(Boolean).map(parseConfig);
    else throw new Error(`unknown flag ${k}`);
  }
  return a;
}

function parseConfig(label: string): Config {
  const m = /^([a-z0-9.-]+)(?::(low|medium|high))?((?:\+(?:full|nothink))*)$/.exec(label);
  if (!m) throw new Error(`bad config "${label}": use <model>[:<effort>][+full][+nothink]`);
  const flags = m[3]!.split("+").filter(Boolean);
  return { label, model: MODELS[m[1]!] ?? m[1]!, effort: (m[2] as Config["effort"]) ?? "low", full: flags.includes("full"), nothink: flags.includes("nothink") };
}

function loadCaptures(dir: string, only: string): Capture[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json") && f.includes(only))
    .sort()
    .map((f) => {
      const raw = JSON.parse(readFileSync(join(dir, f), "utf8")) as { capturedAt: string; input: unknown; answer: Capture["answer"] };
      return { file: f, capturedAt: raw.capturedAt, input: ExplainInputSchema.parse(raw.input), answer: raw.answer };
    });
}

const countMarks = (a: Explanation | null) => a?.segments.reduce((n, s) => n + s.marks.length, 0) ?? 0;

async function tokens(captures: Capture[]) {
  const c = env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }) : new Anthropic();
  const model = env.LLM_VISION_MODEL ?? env.LLM_MODEL;
  const count = async (input: ExplainInput, fullMap = true) => {
    const { args } = explainRequest(input, { fullMap });
    const p = explainPrompt(args);
    return (await c.messages.countTokens({ model, system: p.system, messages: p.messages })).input_tokens;
  };
  console.log(`Input tokens on ${model}, full map (the answer schema, ~3,000 cached tokens, is not counted by this endpoint)\n`);
  for (const cap of captures) {
    const full = await count(cap.input);
    const noImage = await count({ ...cap.input, image: undefined });
    const noMap = await count({ ...cap.input, elements: [] });
    const compact = await count(cap.input, false);
    const { args } = explainRequest(cap.input);
    const system = await c.messages.countTokens({ model, system: explainPrompt(args).system, messages: [{ role: "user", content: "x" }] });
    console.log(`${cap.file}\n  total ${full} · screenshot ${full - noImage} · element map ${full - noMap} (${cap.input.elements.length} elements) · instructions + skills ${system.input_tokens} (cached)`);
    console.log(`  production map (compactElements): ${compactElements(cap.input).length} elements, ${full - compact} tokens fewer (${Math.round(((full - compact) / full) * 100)}% of the input)\n`);
  }
}

async function replay(captures: Capture[], configs: Config[]): Promise<Map<string, Run[]>> {
  const out = new Map<string, Run[]>();
  for (const cap of captures) {
    const runs: Run[] = [{ config: "captured", answer: cap.answer, ms: null, usd: null, proposed: countMarks(cap.answer), kept: countMarks(cap.answer), tokens: "" }];
    for (const cfg of configs) {
      env.LLM_VISION_MODEL = cfg.model;
      env.LLM_VISION_EFFORT = cfg.effort;
      env.LLM_VISION_THINKING = cfg.nothink ? "off" : "on";
      const input = cap.input;
      const before = lastUsage("explainPage");
      const t0 = Date.now();
      const raw = await explainPage(explainRequest(input, { fullMap: cfg.full }).args);
      const ms = Date.now() - t0;
      const u = lastUsage("explainPage");
      const fresh = u && u !== before ? u : null;
      const clean = raw ? sanitizeExplanation(raw, input) : null;
      runs.push({
        config: cfg.label,
        answer: clean,
        ms,
        usd: fresh?.usd ?? null,
        proposed: countMarks(raw),
        kept: countMarks(clean),
        tokens: fresh ? `${fresh.input} in, ${fresh.cacheRead} cached, ${fresh.output} out` : "no usage",
      });
      console.log(`${cap.file} · ${cfg.label}: ${clean ? `${clean.segments.length} segments, ${countMarks(clean)}/${countMarks(raw)} marks kept` : "FAILED"} · ${ms} ms · $${fresh?.usd?.toFixed(4) ?? "?"}`);
    }
    out.set(cap.file, runs);
  }
  return out;
}

// ---- The report: each answer's marks drawn on the capture's screenshot ----

const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);

function svgMarks(a: Explanation | null, input: ExplainInput): string {
  if (!a) return "";
  const byId = new Map(input.elements.map((e) => [e.id, e.box]));
  const chart = a.chart;
  const yAt = (price: number) => {
    const [t0, t1] = chart!.ticks;
    return t0!.y + ((price - t0!.price) * (t1!.y - t0!.y)) / (t1!.price - t0!.price || 1);
  };
  const shapes: string[] = [];
  a.segments.forEach((seg, i) => {
    for (const m of seg.marks as Mark[]) {
      const b = m.element ? byId.get(m.element) : m.box ? [m.box.x, m.box.y, m.box.w, m.box.h] : null;
      const tag = `<text x="${(b?.[0] ?? m.points?.[0]?.x ?? chart?.plot.x ?? 0) + 2}" y="${(b?.[1] ?? m.points?.[0]?.y ?? 0) - 3}" class="n">${i + 1}</text>`;
      if ((m.kind === "level" || m.kind === "zone") && chart && m.price !== null) {
        const y1 = yAt(m.price);
        const y2 = m.kind === "zone" && m.price2 !== null ? yAt(m.price2) : y1;
        shapes.push(
          m.kind === "zone"
            ? `<rect x="${chart.plot.x}" y="${Math.min(y1, y2)}" width="${chart.plot.w}" height="${Math.abs(y2 - y1)}" class="fill"/>`
            : `<line x1="${chart.plot.x}" x2="${chart.plot.x + chart.plot.w}" y1="${y1}" y2="${y1}" class="stroke dash"/>`,
          `<text x="${chart.plot.x + chart.plot.w + 4}" y="${y1 + 4}" class="n">${i + 1} ${esc(String(m.price))}</text>`,
        );
        continue;
      }
      if (m.points?.length) {
        shapes.push(`<polyline points="${m.points.map((p) => `${p.x},${p.y}`).join(" ")}" class="stroke"/>`, tag);
        continue;
      }
      if (!b) continue;
      const [x, y, w, h] = b;
      if (m.kind === "circle") shapes.push(`<ellipse cx="${x! + w! / 2}" cy="${y! + h! / 2}" rx="${w! / 2 + 6}" ry="${h! / 2 + 6}" class="stroke"/>`);
      else if (m.kind === "underline") shapes.push(`<line x1="${x}" x2="${x! + w!}" y1="${y! + h! + 2}" y2="${y! + h! + 2}" class="stroke"/>`);
      else if (m.kind === "highlight") shapes.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" class="fill"/>`);
      else shapes.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" class="stroke"/>`);
      if (m.text) shapes.push(`<text x="${x! + w! + 6}" y="${y! + 14}" class="note">${esc(m.text)}</text>`);
      shapes.push(tag);
    }
  });
  if (chart) shapes.push(`<rect x="${chart.plot.x}" y="${chart.plot.y}" width="${chart.plot.w}" height="${chart.plot.h}" class="plot"/>`);
  return shapes.join("");
}

function report(captures: Capture[], results: Map<string, Run[]>, configs: Config[]): string {
  const totals = configs.map((cfg) => {
    const runs = [...results.values()].map((rs) => rs.find((r) => r.config === cfg.label)!);
    const ok = runs.filter((r) => r.answer);
    const usd = runs.reduce((n, r) => n + (r.usd ?? 0), 0);
    const ms = ok.length ? Math.round(ok.reduce((n, r) => n + (r.ms ?? 0), 0) / ok.length) : 0;
    const proposed = runs.reduce((n, r) => n + r.proposed, 0);
    const kept = runs.reduce((n, r) => n + r.kept, 0);
    return `<tr><td>${esc(cfg.label)}</td><td>${cfg.model} · ${cfg.effort}${cfg.full ? " · full map" : ""}${cfg.nothink ? " · thinking off" : ""}</td><td>${ok.length}/${runs.length}</td><td>$${(usd / Math.max(1, runs.length)).toFixed(4)}</td><td>${ms} ms</td><td>${kept}/${proposed}</td></tr>`;
  });
  const sections = captures.map((cap) => {
    const runs = results.get(cap.file)!;
    const cols = runs.map((r) => {
      const input = cap.input;
      const said = r.answer ? r.answer.segments.map((s, i) => `<li><b>${i + 1}</b> ${esc(s.say)}</li>`).join("") : "<li><b>failed</b></li>";
      const meta = r.config === "captured" ? "production answer at capture time" : `${r.ms} ms · $${r.usd?.toFixed(4) ?? "?"} · ${r.tokens} · marks kept ${r.kept}/${r.proposed}`;
      return `<div class="col"><h3>${esc(r.config)}</h3><p class="meta">${esc(meta)}${r.answer ? ` · action: ${r.answer.action.kind}` : ""}</p>
        <div class="shot">${cap.input.image ? `<img src="${cap.input.image}" alt="">` : `<div class="noimg">no screenshot</div>`}<svg viewBox="0 0 ${cap.input.size.w} ${cap.input.size.h}">${svgMarks(r.answer, input)}</svg></div>
        <ol>${said}</ol></div>`;
    });
    return `<section><h2>${esc(cap.input.question)}</h2><p class="meta">${esc(cap.input.url)} · ${esc(cap.capturedAt)} · ${cap.input.elements.length} elements · skills: ${esc((cap.answer?.skills ?? []).join(", ") || "none")}</p><div class="cols">${cols.join("")}</div></section>`;
  });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Show-me replay</title>
<style>
:root{--bg:#0d0d12;--fg:#e8e8ee;--muted:#9a9aa8;--accent:#5b8cff;--line:rgba(255,255,255,.1)}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif}
h1{font-size:20px}h2{font-size:16px;margin:28px 0 4px}h3{font-size:14px;margin:0}
table{border-collapse:collapse;margin:8px 0 16px}td,th{border-bottom:1px solid var(--line);padding:6px 10px;text-align:left}
.meta{color:var(--muted);font-size:12px;margin:2px 0 8px}
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(420px,1fr));gap:16px}
.col{border:1px solid var(--line);border-radius:10px;padding:10px;min-width:0}
.shot{position:relative}.shot img{width:100%;display:block;border-radius:6px}.shot svg{position:absolute;inset:0;width:100%;height:100%}
.noimg{aspect-ratio:16/9;display:grid;place-items:center;color:var(--muted);border:1px dashed var(--line)}
.stroke{fill:none;stroke:#ff5a8a;stroke-width:3}.dash{stroke-dasharray:8 6}.fill{fill:rgba(255,213,74,.28);stroke:#ffd54a;stroke-width:1}
.plot{fill:none;stroke:rgba(91,140,255,.6);stroke-width:1;stroke-dasharray:4 4}
.n{fill:#ff5a8a;font:bold 16px system-ui}.note{fill:#ffd54a;font:bold 16px system-ui}
ol{padding-left:18px;margin:8px 0 0}li{margin:2px 0}
</style></head><body><h1>"Show me" replay</h1>
<p class="meta">${captures.length} capture(s). Marks are numbered by the spoken segment they belong to; the dashed blue box is the chart plot area the answer declared. Judge by eye: are marks on the thing being said, and are price levels where the chart says?</p>
<table><tr><th>Config</th><th>Model</th><th>Answered</th><th>Avg cost</th><th>Avg time</th><th>Marks kept</th></tr>${totals.join("")}</table>
${sections.join("")}</body></html>`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const captures = loadCaptures(args.dir, args.only);
  if (!captures.length) throw new Error(`no captures in ${args.dir}`);
  if (args.tokens) return tokens(captures);
  if (!args.configs.length || !args.out) throw new Error("--configs <a,b> and --out <report.html> are required (or --tokens)");
  const results = await replay(captures, args.configs);
  writeFileSync(args.out, report(captures, results, args.configs));
  console.log(`report written to ${args.out}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
