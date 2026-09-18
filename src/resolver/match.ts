import { COMPANIES, type CompanySeed } from "./companies.js";

/**
 * Local dictionary match (spec §7.3 passive mode and the first step of §9
 * `/glance`). No network. Returns candidates with a confidence in [0, 1] and
 * the evidence that produced it, so the caller can decide whether the LLM
 * needs to disambiguate (0.5–0.8) or the user needs to pick (< 0.5 or ties).
 *
 * glance-extension-app/lib/dictionary.ts mirrors these rules; change both.
 */
export type Evidence =
  | { kind: "cashtag"; text: string }
  | { kind: "ticker"; text: string }
  | { kind: "name"; text: string }
  | { kind: "alias"; text: string }
  | { kind: "product"; text: string }
  | { kind: "exec"; text: string };

export interface Candidate {
  company: CompanySeed;
  confidence: number;
  evidence: Evidence[];
  /** Character offset of the first hit in the (normalised) text; useful for underlining. */
  firstIndex: number;
  /** Total hits across every term: a company named ten times outranks one named once. */
  mentions: number;
  /** Some hit sits inside the page title (needs `titleLength`). */
  inTitle: boolean;
}

const WEIGHTS: Record<Evidence["kind"], number> = {
  cashtag: 0.95,
  name: 0.9,
  alias: 0.85,
  ticker: 0.6,
  product: 0.55,
  exec: 0.6,
};

/** Tickers that are also ordinary words; a bare mention is weak evidence. */
const AMBIGUOUS_TICKERS = new Set(["META", "SNAP", "COIN", "APP", "MA", "V", "F", "GM", "BA", "COST", "DIS", "SPOT", "HOOD", "NKE", "HIMS", "MARA", "GOLD"]);
/** Names that are also ordinary words; need a second signal or a capital letter to be strong. */
const AMBIGUOUS_NAMES = new Set(["apple", "meta", "snap", "strategy", "circle", "gold", "oracle", "uber", "target", "visa", "nike", "ford", "shop"]);
/**
 * Products that are also ordinary words ("windows", "slack", "arc", "cruise"). Enough on their own to
 * ask the LLM, never enough to corroborate an ambiguous name: a geometry page that says "circle" and
 * "arc" is not Circle Internet.
 */
const WEAK_PRODUCTS = new Set([
  "arc", "cruise", "quest", "threads", "llama", "windows", "teams", "surface", "copilot", "slack", "java", "hopper", "rubin",
  "instinct", "foundry", "gotham", "axon", "falcon", "gaudi", "n2", "n3", "18a", "oci", "aip", "high na", "spectacles",
  "mustang", "bronco", "tensor", "r2", "r3", "optimus", "twitch", "kindle",
]);
/** Index funds are named in passing on most finance pages; they count only when the page is about them. */
const INCIDENTAL_IDS = new Set(["spy", "qqq", "gld", "tlt"]);
/** A weak product on its own: still above WEAK so the LLM gets to look, below anything that could confirm. */
const WEAK_PRODUCT_WEIGHT = 0.5;

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[’']s\b/g, "") // possessives: "Apple's" → "apple"
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9$+&]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface CompiledTerm {
  company: CompanySeed;
  kind: Evidence["kind"];
  re: RegExp;
  text: string;
}

let compiled: CompiledTerm[] | null = null;
function compile(): CompiledTerm[] {
  if (compiled) return compiled;
  const out: CompiledTerm[] = [];
  for (const c of COMPANIES) {
    const add = (kind: Evidence["kind"], term: string) => {
      const t = normalize(term);
      if (t.length < 2) return;
      out.push({ company: c, kind, text: t, re: new RegExp(`(?<![a-z0-9])${escapeRe(t)}(?![a-z0-9])`, "g") });
    };
    add("name", c.name);
    c.aliases.forEach((a) => add("alias", a));
    c.products.forEach((p) => add("product", p));
    c.execs.forEach((e) => add("exec", e));
  }
  compiled = out;
  return out;
}

/** Words that mark a finance context; an ambiguous name next to them is the company, not the fruit. */
const FINANCE_CONTEXT = /(?<![a-z])(shares?|stocks?|earnings|revenue|ceo|cfo|quarter|q[1-4]|guidance|nasdaq|nyse|market cap|ipo|analysts?|price target|upgrade|downgrade|dividend|buyback|valuation|investors?|profit|margins?|rally|sell ?off|premarket|after hours|wall street)(?![a-z])/;

let tickerRes: { c: CompanySeed; cash: RegExp; bare: RegExp }[] | null = null;
function tickerRegexes() {
  tickerRes ??= COMPANIES.map((c) => {
    const sym = escapeRe(c.ticker);
    return { c, cash: new RegExp(`\\$${sym}(?![A-Za-z0-9])`, "g"), bare: new RegExp(`(?<![A-Za-z0-9$])${sym}(?![A-Za-z0-9])`, "g") };
  });
  return tickerRes;
}

/** Tickers are matched on the raw text, case-sensitively, so "Meta" ≠ "META" and "$META" is unambiguous. */
function matchTickers(raw: string): Map<string, { evidence: Evidence[]; firstIndex: number }> {
  const hits = new Map<string, { evidence: Evidence[]; firstIndex: number }>();
  // A page with no capital run of two or more letters and no "$" cannot mention a ticker.
  if (!/\$[A-Z]|[A-Z]{2}/.test(raw)) return hits;
  for (const { c, cash, bare } of tickerRegexes()) {
    cash.lastIndex = 0;
    bare.lastIndex = 0;
    let m: RegExpExecArray | null;
    const ev: Evidence[] = [];
    let first = Infinity;
    while ((m = cash.exec(raw))) { ev.push({ kind: "cashtag", text: m[0] }); first = Math.min(first, m.index); }
    if (ev.length === 0) {
      while ((m = bare.exec(raw))) {
        // Bare 1–2 letter tickers (V, F, MA, GM, BA) only count as cashtags.
        if (c.ticker.length <= 2) break;
        ev.push({ kind: "ticker", text: m[0] });
        first = Math.min(first, m.index);
      }
    }
    if (ev.length) hits.set(c.id, { evidence: ev, firstIndex: first });
  }
  return hits;
}

/**
 * How an ambiguous name is written on this page. "Apple" mid-sentence is the company; "an apple a day"
 * is fruit; "META analysis" in caps says nothing either way. Counted on the raw text so the capital
 * survives normalisation; the first word is enough. Majority wins.
 */
export function caseOf(raw: string, term: string): "proper" | "caps" | "common" | "absent" {
  const re = new RegExp(`(?<![A-Za-z0-9])${escapeRe(term)}(?![A-Za-z0-9])`, "gi");
  let proper = 0;
  let caps = 0;
  let lower = 0;
  for (const m of raw.matchAll(re)) {
    const k = wordCase(m[0]);
    if (k === "proper") proper++;
    else if (k === "caps") caps++;
    else lower++;
  }
  if (proper + caps + lower === 0) return "absent";
  if (lower > proper + caps) return "common";
  return proper >= caps ? "proper" : "caps";
}

/** "Apple" → proper, "APPLE" → caps, "apple" → common. */
export function wordCase(word: string): "proper" | "caps" | "common" {
  const first = word[0] ?? "";
  if (first !== first.toUpperCase() || first === first.toLowerCase()) return "common";
  const rest = word.slice(1).replace(/[^A-Za-z]/g, "");
  return rest.length > 0 && rest === rest.toUpperCase() ? "caps" : "proper";
}

export interface MatchOptions {
  maxCandidates?: number;
  /** Length of the title prefix of `raw` (callers join the title first), for the in-title signal. */
  titleLength?: number;
}

export function matchText(raw: string, opts: MatchOptions = {}): Candidate[] {
  const text = normalize(raw);
  const financeContext = FINANCE_CONTEXT.test(text);
  const titleEnd = opts.titleLength ? normalize(raw.slice(0, opts.titleLength)).length : 0;
  const byId = new Map<string, Candidate>();
  const bump = (c: CompanySeed, e: Evidence, idx: number, count: number, inTitle: boolean) => {
    const cur = byId.get(c.id) ?? { company: c, confidence: 0, evidence: [], firstIndex: Infinity, mentions: 0, inTitle: false };
    cur.evidence.push(e);
    cur.firstIndex = Math.min(cur.firstIndex, idx);
    cur.mentions += count;
    cur.inTitle ||= inTitle;
    byId.set(c.id, cur);
  };

  for (const t of compile()) {
    t.re.lastIndex = 0;
    let count = 0;
    let first = -1;
    for (const m of text.matchAll(t.re)) {
      if (first < 0) first = m.index!;
      count++;
    }
    if (count) bump(t.company, { kind: t.kind, text: t.text }, first, count, first < titleEnd);
  }
  for (const [id, h] of matchTickers(raw)) {
    const c = COMPANIES.find((x) => x.id === id)!;
    for (const e of h.evidence) {
      // A bare ticker that is also the company's name ("META" / "Meta") is the same token the
      // name matcher already saw; counting it twice would manufacture corroboration.
      if (e.kind === "ticker" && sameAsName(c, e.text)) continue;
      bump(c, e, h.firstIndex, 1, !!opts.titleLength && h.firstIndex < opts.titleLength);
    }
  }

  const out: Candidate[] = [];
  for (const cand of byId.values()) {
    out.push({ ...cand, confidence: score(cand, financeContext, raw) });
  }
  out.sort((a, b) => b.confidence - a.confidence || a.firstIndex - b.firstIndex);
  return out.slice(0, opts.maxCandidates ?? 5);
}

function sameAsName(c: CompanySeed, tickerText: string): boolean {
  const t = tickerText.toLowerCase();
  return normalize(c.name) === t || c.aliases.some((a) => normalize(a) === t);
}

const isWeakProduct = (e: Evidence) => e.kind === "product" && WEAK_PRODUCTS.has(e.text);

function score(c: Candidate, financeContext: boolean, raw: string): number {
  // Noisy-OR over distinct evidence kinds, with ambiguity penalties.
  const kinds = new Map<Evidence["kind"], number>();
  // Kinds that can vouch for each other; a weak product is not one of them.
  const strongKinds = new Set(c.evidence.filter((e) => !isWeakProduct(e)).map((e) => e.kind));
  const corroborated = strongKinds.size >= 2 || financeContext;
  for (const e of c.evidence) {
    let w = WEIGHTS[e.kind];
    if (isWeakProduct(e)) w = WEAK_PRODUCT_WEIGHT;
    if (e.kind === "ticker" && (AMBIGUOUS_TICKERS.has(e.text) || c.company.ambiguousTicker)) w = corroborated ? 0.6 : 0.35;
    if ((e.kind === "name" || e.kind === "alias") && (AMBIGUOUS_NAMES.has(e.text) || (c.company.ambiguousName && e.text === normalize(c.company.name)))) {
      // "apple" next to "iphone" or "tim cook" is the company whatever the case. On its own, "Apple"
      // mid-page says company (0.75, the LLM confirms) and a finance word makes it certain; "APPLE"
      // needs the finance word; lower-case "strategy" or "circle" is an ordinary word even in a
      // finance story.
      const cs = caseOf(raw, e.text.split(" ")[0]!);
      if (strongKinds.size >= 2) w = 0.9;
      else if (cs === "proper") w = financeContext ? 0.9 : 0.75;
      else if (cs === "caps") w = financeContext ? 0.9 : 0.45;
      else w = financeContext ? 0.6 : 0.45;
    }
    if ((e.kind === "name" || e.kind === "alias") && INCIDENTAL_IDS.has(c.company.id) && !c.inTitle && c.mentions < 3) w = 0.6;
    kinds.set(e.kind, Math.max(kinds.get(e.kind) ?? 0, w));
  }
  let notP = 1;
  for (const w of kinds.values()) notP *= 1 - w;
  const p = 1 - notP;
  return Math.min(0.98, Math.round(p * 1000) / 1000);
}

export type Verdict =
  | { kind: "confident"; top: Candidate }
  | { kind: "disambiguate"; candidates: Candidate[] } // ask the LLM
  | { kind: "ask_user"; candidates: Candidate[] } // low confidence: Yes / No / Pick
  | { kind: "multiple"; candidates: Candidate[] } // several strong: chips
  | { kind: "none" };

export const CONFIDENT = 0.8;
export const WEAK = 0.5;

/**
 * Among several strong candidates, the one the page is actually about: alone in the title, or
 * named at least three times and three times as often as any other. Two companies in the title
 * (a lawsuit, a market wrap) is a genuine multiple and the user picks.
 */
export function dominant<T extends { inTitle: boolean; mentions: number }>(strong: T[]): T | undefined {
  const titled = strong.filter((c) => c.inTitle);
  if (titled.length === 1) return titled[0];
  if (titled.length > 1) return undefined;
  const [a, b] = [...strong].sort((x, y) => y.mentions - x.mentions);
  if (a && b && a.mentions >= 3 && a.mentions >= 3 * b.mentions) return a;
  return undefined;
}

export function decide(cands: Candidate[]): Verdict {
  if (cands.length === 0) return { kind: "none" };
  const strong = cands.filter((c) => c.confidence >= CONFIDENT);
  if (strong.length > 1) {
    const primary = dominant(strong);
    return primary ? { kind: "confident", top: primary } : { kind: "multiple", candidates: strong };
  }
  const top = cands[0]!;
  if (top.confidence >= CONFIDENT) return { kind: "confident", top };
  if (top.confidence >= WEAK) return { kind: "disambiguate", candidates: cands.slice(0, 3) };
  return { kind: "ask_user", candidates: cands.slice(0, 3) };
}
