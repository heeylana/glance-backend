/**
 * "Show me": a spoken question about the page, answered out loud while Glance draws on it. The idea
 * is Clicky's (github.com/farzaa/clicky: the model sees the screen and returns a point to fly to);
 * a browser extension can do better than pixels, so the model also gets a map of the visible
 * elements and anchors most marks to element ids, which stay exact and follow scrolling. Pixel
 * boxes are kept for what has no element, such as a spot inside a chart drawn on a canvas.
 * The screenshot is read once and dropped, as in the vision fallback.
 */
import { z } from "zod";
import { explainPage, type ExplainAction, type ExplainChart, type Explanation, type Mark } from "./llm.js";
import { pickSkills, skillsPrompt } from "./skills.js";
import { parseImageDataUrl } from "../lib/screenshot.js";

export const ExplainInputSchema = z.object({
  question: z.string().min(1).max(500),
  url: z.string().max(2048),
  title: z.string().max(1024).optional(),
  /** The screenshot's size, which is also the coordinate space of every box. */
  size: z.object({ w: z.number().int().min(64).max(4096), h: z.number().int().min(64).max(4096) }),
  image: z.string().max(6_000_000).regex(/^data:image\/(jpeg|png|webp);base64,/).optional(),
  elements: z
    .array(
      z.object({
        id: z.string().regex(/^e\d{1,4}$/),
        kind: z.string().max(16),
        text: z.string().max(160),
        box: z.tuple([z.number(), z.number(), z.number(), z.number()]),
      }),
    )
    .max(260),
  /** Earlier steps of the same answer, oldest first: what was said, then what was scrolled or clicked and how it went. */
  history: z
    .array(
      z.object({
        said: z.array(z.string().max(300)).max(5),
        action: z.object({
          kind: z.enum(["scroll", "click"]),
          target: z.string().max(160).nullable(),
          direction: z.enum(["up", "down"]).nullable(),
          outcome: z.enum(["done", "refused", "failed", "off"]),
        }),
      }),
    )
    .max(4)
    .default([]),
  /** How many more scroll or click steps this answer may take; 0 forces the action to none. */
  stepsLeft: z.number().int().min(0).max(4).default(0),
  /** Pages the user asked Glance to remember, picked by the extension as relevant to this question (at most 3). */
  memory: z
    .array(
      z.object({
        title: z.string().max(300),
        url: z.string().max(2048),
        savedAt: z.string().max(40),
        /** When the saved page was published, if it said; lets the model place its facts in time. */
        publishedAt: z.string().max(40).nullable().optional(),
        summary: z.string().max(400),
        facts: z.array(z.string().max(240)).max(10),
      }),
    )
    .max(3)
    .default([]),
});
export type ExplainInput = z.input<typeof ExplainInputSchema>;
export type ExplainParsed = z.infer<typeof ExplainInputSchema>;

export type ExplainResult = Explanation & { imageBytes: number; skills: string[] };

const NO_ACTION: ExplainAction = { kind: "none", element: null, direction: null };
/** Kinds the extension will never click: typing is not supported and a frame's inside is out of reach. */
const UNCLICKABLE = new Set(["input", "frame"]);

const MAX_MARKS = 12;
/** glance-extension-app/lib/page-map.ts cuts each element's text at this length. */
const MAP_TEXT_CAP = 160;

export function elementMap(elements: ExplainInput["elements"]): string {
  return elements.map((e) => `${e.id} | ${e.kind} | ${e.box.map(Math.round).join(",")} | ${e.text.replace(/\s+/g, " ").slice(0, 120)}`).join("\n");
}

/** Letters, digits and single spaces only: "chain, holding" and "chain holding" compare equal. */
const plain = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}$%]+/gu, " ").trim();

/** A quote is kept when the element holds its first three words (the extension narrows it down on the page). */
export function quoteFits(elementText: string, quote: string): boolean {
  const head = plain(quote).split(" ").slice(0, 3).join(" ");
  return head.length > 0 && plain(elementText).includes(head);
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Keep the model inside the page: marks point at elements that were in the map or at pixels inside
 * the screenshot, quotes are words that element really contains, and every kind carries what it
 * needs to be drawn. Anything else is dropped rather than drawn in the wrong place.
 */
export function sanitizeExplanation(ex: Explanation, input: Pick<ExplainInput, "size" | "elements" | "stepsLeft">): Explanation {
  const byId = new Map(input.elements.map((e) => [e.id, e]));
  const { w, h } = input.size;
  let budget = MAX_MARKS;
  const chart = sanitizeChart(ex.chart, w, h);
  const segments = ex.segments
    .map((seg) => {
      const marks: Mark[] = [];
      for (const m of seg.marks) {
        if (budget <= 0) break;
        const el = m.element !== null ? byId.get(m.element) : undefined;
        // The map cuts long text short, so a quote from further in is left for the extension to find on the page.
        const quote = el && m.quote && (quoteFits(el.text, m.quote) || el.text.length >= MAP_TEXT_CAP - 1) ? m.quote.trim() : null;
        const box = m.box
          ? (() => {
              const x = clamp(m.box.x, 0, w - 1);
              const y = clamp(m.box.y, 0, h - 1);
              return { x, y, w: clamp(m.box.w, 1, w - x), h: clamp(m.box.h, 1, h - y) };
            })()
          : null;
        const points = m.points?.map((p) => ({ x: clamp(p.x, 0, w), y: clamp(p.y, 0, h) })) ?? null;
        const text = m.text?.trim() ? m.text.trim().slice(0, 32) : null;
        const price = m.price !== null && Number.isFinite(m.price) ? m.price : null;
        const price2 = m.price2 !== null && Number.isFinite(m.price2) ? m.price2 : null;
        const anchored = !!el || !!box;
        const nPoints = points?.length ?? 0;
        const ok =
          m.kind === "line" ? nPoints >= 2 || anchored
          : m.kind === "path" || m.kind === "trend" ? nPoints >= 2
          : m.kind === "arrow" ? anchored || nPoints >= 2
          : m.kind === "note" ? (anchored || nPoints >= 1) && !!text
          : m.kind === "level" ? (chart !== null && price !== null) || (nPoints >= 1 && (chart !== null || anchored))
          : m.kind === "zone" ? (chart !== null && price !== null && price2 !== null) || anchored
          : anchored;
        if (!ok) continue;
        const labelled = m.kind === "note" || m.kind === "arrow" || m.kind === "level" || m.kind === "zone" || m.kind === "trend";
        marks.push({ kind: m.kind, element: el ? m.element : null, quote, box: el ? null : box, points, text: labelled ? text : null, price, price2 });
        budget--;
      }
      return { say: seg.say.trim(), marks };
    })
    .filter((seg) => seg.say || seg.marks.length);
  return { segments, chart, action: sanitizeAction(ex.action, byId, input.stepsLeft ?? 0) };
}

/** A usable price axis: a plot inside the screenshot and two ticks at different prices and heights. */
export function sanitizeChart(c: ExplainChart, w: number, h: number): ExplainChart {
  if (!c) return null;
  const x = clamp(c.plot.x, 0, w - 1);
  const y = clamp(c.plot.y, 0, h - 1);
  const plot = { x, y, w: clamp(c.plot.w, 1, w - x), h: clamp(c.plot.h, 1, h - y) };
  const [a, b] = c.ticks;
  if (!a || !b || a.price === b.price || Math.abs(a.y - b.y) < 8 || plot.w < 20 || plot.h < 20) return null;
  // Higher prices sit higher on a chart; ticks the other way round mean the labels were misread.
  if ((a.price - b.price) * (a.y - b.y) > 0) return null;
  return { plot, ticks: [a, b] };
}

/** A step only on an element that was in the map (or a plain screen scroll), and only while steps are left. */
export function sanitizeAction(a: ExplainAction, byId: Map<string, ExplainInput["elements"][number]>, stepsLeft: number): ExplainAction {
  if (stepsLeft <= 0 || a.kind === "none") return NO_ACTION;
  const el = a.element !== null ? byId.get(a.element) : undefined;
  if (a.kind === "click") return el && !UNCLICKABLE.has(el.kind) ? { kind: "click", element: a.element, direction: null } : NO_ACTION;
  if (el) return { kind: "scroll", element: a.element, direction: null };
  return a.direction ? { kind: "scroll", element: null, direction: a.direction } : NO_ACTION;
}

/**
 * Saved pages as the model reads them: clearly from elsewhere, to be named when used, and never drawn,
 * since nothing in them is on this page. Empty when there are none.
 */
export function memoryBlock(notes: ExplainParsed["memory"]): string {
  if (!notes.length) return "";
  const pages = notes.map((n, i) => {
    const facts = n.facts.map((f) => `  - ${f}`).join("\n");
    const when = n.publishedAt ? `published ${n.publishedAt.slice(0, 10)}, saved ${n.savedAt.slice(0, 10)}` : `saved ${n.savedAt.slice(0, 10)}, publish date unknown`;
    return `${i + 1}. "${n.title}" (${n.url}), ${when}\n  ${n.summary}${facts ? `\n${facts}` : ""}`;
  });
  return `Pages the user asked you to remember, from other pages they read (use them only when the question needs them, say which page a fact comes from, and never draw marks for them: they are not on this page):\n${pages.join("\n")}`;
}

/** The earlier steps as the model reads them. */
export function earlierSteps(history: ExplainParsed["history"]): string {
  const outcome = { done: "done", refused: "refused: Glance does not click that kind of control", failed: "did not work", off: "not done: the user turned scrolling and clicking off" } as const;
  return history
    .map((h, i) => {
      const what = h.action.kind === "click" ? `clicked "${h.action.target ?? "an element"}"` : h.action.target ? `scrolled to "${h.action.target}"` : `scrolled ${h.action.direction ?? "down"}`;
      return `Step ${i + 1}: you said: ${h.said.map((l) => `"${l}"`).join(" ")} Then you ${what} (${outcome[h.action.outcome]}).`;
    })
    .join("\n");
}

/** Off-screen elements kept as scroll targets; the extension sends them nearest first. */
export const OFFSCREEN_KEPT = 20;
/** Kinds kept even without text: the big things a mark rings (a chart canvas, a video, an embed). */
const KEEP_EMPTY = new Set(["canvas", "video", "frame"]);

/**
 * The element map the model reads (doc/cost-reduction-todo.md 2.1). The map is most of a "show me"
 * request's input tokens, so leave out what the model can't use: elements with no text (icons; a
 * mark on one can still use pixels) other than canvases, videos and frames, and all but the nearest
 * OFFSCREEN_KEPT elements off screen. On the first capture measured (a 260-element chart page) this cut
 * 1,795 of 8,842 input tokens with no visible change in the answer.
 */
export function compactElements(input: Pick<ExplainParsed, "elements" | "size">): ExplainParsed["elements"] {
  let offscreen = 0;
  return input.elements.filter((e) => {
    if (!e.text.trim() && !KEEP_EMPTY.has(e.kind)) return false;
    const visible = e.box[1] < input.size.h && e.box[1] + e.box[3] > 0;
    return visible || ++offscreen <= OFFSCREEN_KEPT;
  });
}

/**
 * Everything `explainPage` is given for one request, plus the skills picked; the replay script builds
 * requests the same way. `fullMap` skips compactElements, to compare against the uncut map.
 */
export function explainRequest(input: ExplainParsed, opts: { fullMap?: boolean } = {}) {
  const img = input.image ? parseImageDataUrl(input.image) : null;
  const pageHeader = [`Page: ${input.title ?? "(untitled)"}`, `URL: ${input.url}`, `Screenshot: ${input.size.w}x${input.size.h} pixels${img ? "" : " (not available; use the element map only)"}`].join("\n");
  const skills = pickSkills({ question: input.question, title: input.title, url: input.url });
  const args: Parameters<typeof explainPage>[0] = {
    question: input.question,
    skills: skillsPrompt(skills),
    pageHeader,
    elementMap: elementMap(opts.fullMap ? input.elements : compactElements(input)),
    earlier: earlierSteps(input.history),
    memory: memoryBlock(input.memory),
    image: img ? { base64: img.base64, mediaType: img.mediaType } : null,
  };
  return { args, skills, img };
}

export async function explain(input: ExplainParsed): Promise<ExplainResult | null> {
  const { args, skills, img } = explainRequest(input);
  const ex = await explainPage(args);
  if (!ex) return null;
  const clean = sanitizeExplanation(ex, input);
  return clean.segments.length || clean.action.kind !== "none" ? { ...clean, imageBytes: img?.bytes.length ?? 0, skills: skills.map((s) => s.name) } : null;
}
