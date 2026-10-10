/**
 * The image pipeline against the screenshot fixtures (doc/glance-whatsapp-bot-implementation-checklist.md §4.6):
 * read → resolve, per image, against src/services/fixtures/images/expected.json. Prints the resolve rate, the
 * chart reads, latency and what the model calls cost. Paid: one vision call per image (about a cent each).
 *
 *   pnpm script:score-images            # every fixture
 *   pnpm script:score-images chart      # fixtures whose name contains "chart"
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { normalizeImage } from "../services/images.js";
import { lastUsage, readImage } from "../services/llm.js";
import { glance } from "../services/glance.js";
import { closeDb } from "../db/client.js";

const DIR = "src/services/fixtures/images";
const only = process.argv[2];
type Expected = { kind: string; tickers: string[]; chart?: { ticker: string; timeframe: string } };
const expected = JSON.parse(readFileSync(join(DIR, "expected.json"), "utf8")) as Record<string, Expected | string>;
const files = readdirSync(DIR)
  .filter((f) => /\.(jpe?g|png|webp)$/i.test(f) && (!only || f.includes(only)))
  .sort();

let resolved = 0;
let resolvable = 0;
let kindsRight = 0;
let chartsRight = 0;
let charts = 0;
let usd = 0;
const times: number[] = [];
for (const f of files) {
  const exp = expected[f];
  if (!exp || typeof exp === "string") {
    console.log(`${f}: no expectation, skipped`);
    continue;
  }
  const t0 = Date.now();
  const img = await normalizeImage(readFileSync(join(DIR, f)), f.endsWith(".png") ? "image/png" : "image/jpeg");
  const read = await readImage({ base64: img.bytes.toString("base64"), mediaType: "image/jpeg", width: img.width, height: img.height });
  const readMs = Date.now() - t0;
  usd += lastUsage("readImage")?.usd ?? 0;
  let tickers: string[] = [];
  if (read) {
    const text = [read.text, read.companies.length ? `Companies: ${read.companies.map((c) => c.name).join(", ")}` : ""].filter(Boolean).join("\n");
    const r = await glance({ url: `fixture://${f}`, title: read.headline ?? undefined, text, site: "generic" });
    tickers = r.entities.slice(0, 3).map((e) => e.ticker);
  }
  const ms = Date.now() - t0;
  times.push(ms);
  const want = exp.tickers;
  const hit = want.length === 0 ? tickers.length === 0 : want.every((t) => tickers.includes(t));
  if (want.length) {
    resolvable++;
    if (want.some((t) => tickers.includes(t))) resolved++;
  }
  if (read?.kind === exp.kind) kindsRight++;
  if (exp.chart) {
    charts++;
    const ok = read?.chart?.ticker?.toUpperCase() === exp.chart.ticker && (read?.chart?.timeframe ?? "").toUpperCase().replace(/\s/g, "") === exp.chart.timeframe;
    if (ok) chartsRight++;
  }
  console.log(`${hit ? "✔" : "✘"} ${f}: kind ${read?.kind ?? "-"} (want ${exp.kind}), tickers [${tickers.join(", ")}] (want [${want.join(", ")}])${read?.chart ? `, chart ${read.chart.ticker ?? "?"} ${read.chart.timeframe ?? "?"} ${read.chart.from ?? "?"}→${read.chart.to ?? "?"}` : ""}, read ${readMs} ms, total ${ms} ms`);
}
const sorted = [...times].sort((a, b) => a - b);
const p = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
console.log(`\nresolve: ${resolved}/${resolvable} (${resolvable ? Math.round((100 * resolved) / resolvable) : 0}%, target 85%) · kind: ${kindsRight}/${files.length} · charts: ${chartsRight}/${charts} · p50 ${p(0.5)} ms, p95 ${p(0.95)} ms · $${usd.toFixed(4)} this run`);
await closeDb();
