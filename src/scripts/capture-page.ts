/**
 * Capture what the extension would send to POST /glance for real pages, and score it offline.
 * Drives a headless Chrome over the DevTools protocol; no extra dependencies (Node 22 WebSocket).
 *
 *   pnpm script:capture-page <url> [<url>...]                    # print context + offline verdict
 *   pnpm script:capture-page --expect AAPL --out src/resolver/fixtures/pages.json <url>
 *                                                                # append a fixture (see score-resolver.ts)
 *   pnpm script:capture-page --expect none ... <url>              # a page that must be declined
 *
 * Options: --id <fixture id>  --note "<why this page is in the set>"  --scroll <px>
 *          --profile <chrome profile dir>  (X needs a signed-in profile; use a spare one, never your own)
 *          CHROME_BIN=<path> for a non-default Chrome/Brave binary.
 *
 * `collector.page.js` mirrors glance-extension-app/lib/adapters.ts; keep them in sync.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide, matchText } from "../resolver/match.js";
import type { Fixture } from "./score-resolver.js";

const CHROME = process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const collector = readFileSync(new URL("./collector.page.js", import.meta.url), "utf8");

interface Args { urls: string[]; out?: string; expect?: string; id?: string; note?: string; scroll: number; profile?: string; port: number }
function parseArgs(argv: string[]): Args {
  const a: Args = { urls: [], scroll: 0, port: 9333 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    const v = () => argv[++i] ?? "";
    if (k === "--out") a.out = v();
    else if (k === "--expect") a.expect = v();
    else if (k === "--id") a.id = v();
    else if (k === "--note") a.note = v();
    else if (k === "--scroll") a.scroll = Number(v());
    else if (k === "--profile") a.profile = v();
    else if (k === "--port") a.port = Number(v());
    else if (k.startsWith("--")) throw new Error(`unknown flag ${k}`);
    else a.urls.push(k);
  }
  if (a.urls.length === 0) throw new Error("usage: capture-page [--expect AAPL|none --out fixtures.json] <url>...");
  if (a.out && !a.expect) throw new Error("--out needs --expect");
  return a;
}

interface Cdp { send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<any>; on(l: (m: any) => void): () => void; close(): void }
async function connect(wsUrl: string): Promise<Cdp> {
  const WS = (globalThis as any).WebSocket as new (u: string) => any;
  const ws = new WS(wsUrl);
  await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = (e: unknown) => rej(new Error(`websocket: ${String(e)}`)); });
  let id = 0;
  const pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
  const listeners = new Set<(m: any) => void>();
  ws.onmessage = (ev: { data: string }) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id)!;
      pending.delete(m.id);
      m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
    } else for (const l of listeners) l(m);
  };
  return {
    send: (method, params = {}, sessionId) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); }),
    on: (l) => { listeners.add(l); return () => listeners.delete(l); },
    close: () => ws.close(),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Captured { url: string; title?: string; site: Fixture["site"]; publishedAt?: string; text: string }

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}; set CHROME_BIN`);
  const profile = args.profile ?? mkdtempSync(join(tmpdir(), "glance-capture-"));
  const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${args.port}`, `--user-data-dir=${profile}`, "--window-size=1280,900", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
  try {
    let wsUrl: string | undefined;
    for (let i = 0; i < 50 && !wsUrl; i++) {
      try { wsUrl = ((await (await fetch(`http://127.0.0.1:${args.port}/json/version`)).json()) as { webSocketDebuggerUrl?: string }).webSocketDebuggerUrl; } catch { await sleep(200); }
    }
    if (!wsUrl) throw new Error("chrome did not expose a DevTools endpoint");
    const cdp = await connect(wsUrl);
    const fixtures: Fixture[] = args.out && existsSync(args.out) ? JSON.parse(readFileSync(args.out, "utf8")) : [];
    for (const url of args.urls) {
      const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
      await cdp.send("Page.enable", {}, sessionId);
      await cdp.send("Runtime.enable", {}, sessionId);
      await cdp.send("Emulation.setUserAgentOverride", { userAgent: UA }, sessionId);
      const loaded = new Promise<string>((r) => {
        const off = cdp.on((m) => { if (m.sessionId === sessionId && m.method === "Page.loadEventFired") { off(); r("load"); } });
        setTimeout(() => { off(); r("timeout"); }, 20_000);
      });
      await cdp.send("Page.navigate", { url }, sessionId);
      const how = await loaded;
      await sleep(3500);
      if (args.scroll) { await cdp.send("Runtime.evaluate", { expression: `window.scrollTo(0, ${args.scroll})` }, sessionId); await sleep(800); }
      const r = await cdp.send("Runtime.evaluate", { expression: collector, returnByValue: true }, sessionId);
      await cdp.send("Target.closeTarget", { targetId });
      if (r.exceptionDetails) { console.log(`\n${url}\n  collector threw: ${r.exceptionDetails.text}`); continue; }
      const ctx = JSON.parse(r.result.value) as Captured;
      const corpus = [ctx.title, ctx.text].filter(Boolean).join("\n");
      const cands = matchText(corpus, { titleLength: ctx.title?.length ?? 0 });
      const v = decide(cands);
      console.log(`\n${url}\n  loaded=${how} site=${ctx.site} publishedAt=${ctx.publishedAt ?? "-"} textLen=${ctx.text.length}\n  title=${JSON.stringify(ctx.title ?? "")}\n  text[0:200]=${JSON.stringify(ctx.text.slice(0, 200))}\n  offline verdict: ${v.kind}  ${cands.slice(0, 3).map((c) => `${c.company.ticker}:${c.confidence}`).join(" ")}`);
      if (args.out) {
        const id = args.id ?? `${new URL(url).hostname.replace(/^www\./, "")}-${(url.split("/").filter(Boolean).pop() ?? "").replace(/[^a-z0-9]+/gi, "-").slice(0, 40).toLowerCase()}`;
        const expect = args.expect === "none" ? { none: true as const } : { tickers: args.expect!.split(",").map((t) => t.trim().toUpperCase()) };
        const fx: Fixture = { id, site: ctx.site, url, capturedAt: new Date().toISOString().slice(0, 10), title: ctx.title, publishedAt: ctx.publishedAt, text: ctx.text, expect, ...(args.note ? { note: args.note } : {}) };
        const at = fixtures.findIndex((f) => f.id === id);
        if (at >= 0) fixtures[at] = fx; else fixtures.push(fx);
        writeFileSync(args.out, JSON.stringify(fixtures, null, 2) + "\n");
        console.log(`  → fixture ${id} (${fixtures.length} in ${args.out})`);
      }
    }
    cdp.close();
  } finally {
    chrome.kill();
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
