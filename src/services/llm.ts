/**
 * LLM calls (spec §9): disambiguation when the dictionary is unsure, and the
 * ≤ 40-word "why did it move" summary. Uses the Anthropic SDK with structured
 * output so the rest of the backend never parses free text. Server-side
 * refusal fallbacks are enabled by default on the models that take them.
 *
 * Every response logs one `llm usage` line (route, model, the four token counts,
 * its cost and the route's running total for the day), so the cost plan in
 * doc/cost-reduction-todo.md can be measured.
 */
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { env } from "../config.js";
import { log } from "../lib/log.js";
import { effortParam, fallbackParams, usageCostUsd, type TokenUsage } from "../lib/llm-models.js";
import { fitToSchema } from "../lib/structured.js";
import type { MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { Headline } from "./news.js";

let client: Anthropic | null = null;
let disabled = false;
let lastBillingLog = 0;

function anthropic(): Anthropic | null {
  if (disabled) return null;
  if (!client) client = env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }) : new Anthropic();
  return client;
}

function handleError(e: unknown, where: string): null {
  // No API key and no `ant auth login` profile: the SDK throws a generic error at request time.
  if (e instanceof Error && /Could not resolve authentication method/i.test(e.message)) {
    disabled = true;
    log.info("no anthropic credentials; LLM disambiguation and 'why' summaries disabled (set ANTHROPIC_API_KEY to enable)");
    return null;
  }
  if (e instanceof Anthropic.AuthenticationError) {
    disabled = true;
    log.warn("anthropic credentials missing or invalid; LLM features disabled for this process", { where });
    return null;
  }
  if (e instanceof Anthropic.RateLimitError) {
    log.warn("anthropic rate limited", { where });
    return null;
  }
  if (e instanceof Anthropic.APIError && /credit balance is too low/i.test(e.message)) {
    // Not fatal to the process: the next call works again as soon as credits are added.
    const now = Date.now();
    if (now - lastBillingLog > 5 * 60_000) {
      lastBillingLog = now;
      log.error("anthropic credit balance is too low: explain, the vision fallback, 'why' and the voice LLM fallback are failing until credits are added at console.anthropic.com (Plans & Billing); no restart needed", { where });
    }
    return null;
  }
  if (e instanceof Anthropic.APIError) {
    log.warn("anthropic api error", { where, status: e.status, message: e.message });
    return null;
  }
  throw e;
}

/**
 * Which model each kind of call runs on. The short text jobs (disambiguation, "why", counter-view, voice
 * commands the grammar missed, remember) read LLM_FAST_MODEL (default Haiku 4.5); the screenshot fallback,
 * which only transcribes, reads LLM_READ_MODEL (default Haiku 4.5); "show me", which has to see the pixels
 * to draw, reads LLM_VISION_MODEL, falling back to LLM_MODEL (default Sonnet 5).
 */
const fastModel = () => env.LLM_FAST_MODEL;
const readModel = () => env.LLM_READ_MODEL;
const visionModel = () => env.LLM_VISION_MODEL ?? env.LLM_MODEL;

/** Model plus the options that model accepts; spread into each request. */
function modelParams(model: string) {
  return { model, ...fallbackParams(model) };
}

export type LlmRoute = "disambiguate" | "explainMove" | "readScreenshot" | "counterView" | "interpretCommand" | "explainPage" | "notePage";

export interface UsageLine {
  route: LlmRoute;
  /** The model that answered, which is the fallback model after a refusal. */
  model: string;
  fallback: boolean;
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  usd: number | null;
  dayCalls: number;
  dayUsd: number;
}

// Running totals since UTC midnight, per route, for this process (a restart starts over).
let usageDay = "";
const dayTotals = new Map<LlmRoute, { calls: number; usd: number }>();
const lastByRoute = new Map<LlmRoute, UsageLine>();

function recordUsage(route: LlmRoute, res: { model: string; usage: TokenUsage & { iterations?: ReadonlyArray<{ type?: string }> | null } }) {
  const u = res.usage;
  const usd = usageCostUsd(res.model, u);
  const day = new Date().toISOString().slice(0, 10);
  if (day !== usageDay) {
    usageDay = day;
    dayTotals.clear();
  }
  const total = dayTotals.get(route) ?? { calls: 0, usd: 0 };
  total.calls += 1;
  total.usd += usd ?? 0;
  dayTotals.set(route, total);
  const line: UsageLine = {
    route,
    model: res.model,
    fallback: (u.iterations ?? []).some((i) => i.type === "fallback_message"),
    input: u.input_tokens,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    output: u.output_tokens,
    usd: usd === null ? null : Math.round(usd * 1e6) / 1e6,
    dayCalls: total.calls,
    dayUsd: Math.round(total.usd * 1e4) / 1e4,
  };
  lastByRoute.set(route, line);
  log.info("llm usage", { ...line });
}

/** The last usage line a route logged in this process (the cache probe reads it). */
export function lastUsage(route: LlmRoute): UsageLine | null {
  return lastByRoute.get(route) ?? null;
}

type StructuredParams = Omit<MessageCreateParamsNonStreaming, "model" | "output_config" | "betas" | "fallbacks">;

/**
 * One structured-output call, at low effort unless `options.effort` says otherwise. Logs usage whatever the outcome, then fits the answer to
 * the schema (lib/structured.ts): text or lists a model ran past a limit are clipped instead of losing
 * the whole answer, which the SDK's strict `parse` did. Null on a refusal, a cut-off answer, or output
 * that still doesn't fit, each with a log line.
 */
async function structured<T>(
  route: LlmRoute,
  model: string,
  schema: z.ZodType<T>,
  params: StructuredParams,
  options: { timeout?: number; maxRetries?: number; effort?: "low" | "medium" | "high"; thinking?: "off" } = {},
): Promise<T | null> {
  const c = anthropic();
  if (!c) return null;
  const { effort = "low", thinking, ...request } = options;
  try {
    const res = await c.beta.messages.create(
      {
        ...modelParams(model),
        ...params,
        ...(thinking === "off" ? { thinking: { type: "disabled" as const } } : {}),
        output_config: { ...effortParam(model, effort), format: { type: "json_schema", schema: betaZodOutputFormat(schema).schema } },
      },
      request,
    );
    recordUsage(route, res);
    if (res.stop_reason === "refusal" || res.stop_reason === "max_tokens") {
      log.warn(res.stop_reason === "refusal" ? "llm refused" : "llm answer cut off", { route, model: res.model });
      return null;
    }
    let json: unknown;
    try {
      json = JSON.parse(res.content.map((b) => (b.type === "text" ? b.text : "")).join(""));
    } catch {
      log.warn("llm answer is not json", { route, model: res.model });
      return null;
    }
    const fit = fitToSchema(schema, json);
    if (!fit.ok) {
      log.warn("llm answer does not fit its schema", { route, model: res.model, error: fit.error });
      return null;
    }
    if (fit.clipped.length) log.info("llm answer clipped", { route, model: res.model, fields: fit.clipped });
    return fit.data;
  } catch (e) {
    return handleError(e, route);
  }
}

const PickSchema = z.object({
  companyId: z.string().nullable().describe("id of the single company the page is mainly about, or null if none of the candidates"),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(200),
});
export type Pick = z.infer<typeof PickSchema>;

const DISAMBIGUATE_SYSTEM = `You resolve which publicly traded company a piece of web content is mainly about.
You are given candidate companies (id, name, ticker) that a keyword matcher flagged, plus the page text.
Pick the one company the content is primarily about. Product names, executives and nicknames count
("the Ozempic company" is Novo Nordisk), and a review or news of a company's product is about that
company, even when the product's name matches a different candidate's name: pick the company that makes
the product. Return companyId null only when the content is about none of the candidates (for example
"apple" the fruit, or a passing mention). Be decisive.`;

export async function disambiguate(p: {
  corpus: string;
  candidates: { id: string; name: string; ticker: string }[];
}): Promise<Pick | null> {
  return structured("disambiguate", fastModel(), PickSchema, {
    max_tokens: 1024,
    system: DISAMBIGUATE_SYSTEM,
    messages: [
      {
        role: "user",
        content: `Candidates:\n${p.candidates.map((x) => `- ${x.id}: ${x.name} (${x.ticker})`).join("\n")}\n\nPage text:\n"""\n${p.corpus.slice(0, 6000)}\n"""`,
      },
    ],
  });
}

function windowLabel(minutes: number): string {
  if (minutes <= 60) return "the last hour";
  if (minutes <= 1440) return `the last ${Math.round(minutes / 60)} hours`;
  return `the last ${Math.round(minutes / 1440)} days`;
}

const WhySchema = z.object({
  text: z.string().max(320).describe("At most 40 spoken words: what moved, the most-cited cause, one caveat. No tickers, no jargon."),
});

export async function explainMove(p: {
  name: string;
  ticker: string;
  headlines: Headline[];
  priceNow: number | null;
  priceDayAgo: number | null;
  /** How far back the headlines reach; the summary should say "today" rather than "in the last hour" when widened. */
  windowMinutes?: number;
}): Promise<{ text: string } | null> {
  if (p.headlines.length === 0) return null;
  const move =
    p.priceNow !== null && p.priceDayAgo ? `${(((p.priceNow - p.priceDayAgo) / p.priceDayAgo) * 100).toFixed(1)}% over the last day` : "an unknown amount";
  const out = await structured("explainMove", fastModel(), WhySchema, {
    max_tokens: 1024,
    system:
      "You explain a stock move to someone who reads the news but has never traded. Plain language, at most 40 words, spoken aloud. Structure: what moved, the most-cited cause from the headlines, one caveat. Never invent causes that are not in the headlines.",
    messages: [
      {
        role: "user",
        content: `${p.name} moved ${move}.\n\nHeadlines from ${windowLabel(p.windowMinutes ?? 60)}:\n${p.headlines
          .slice(0, 12)
          .map((h) => `- [${h.source}] ${h.title} (${h.publishedAt})`)
          .join("\n")}`,
      },
    ],
  });
  return out ? { text: out.text } : null;
}

const ReadSchema = z.object({
  headline: z.string().max(300).nullable().describe("The main headline or title visible in the screenshot, or null"),
  text: z.string().max(2000).describe("The visible body text, transcribed in reading order, up to about 1500 characters"),
  companies: z.array(z.string().max(80)).max(10).describe("Publicly traded companies the visible content is about, by name"),
});
export type ScreenshotRead = z.infer<typeof ReadSchema>;

/**
 * Vision fallback (spec §7.3): read the visible page from a screenshot when the DOM had no usable
 * text. The image is sent once and never stored; the caller keeps only its hash.
 */
export async function readScreenshot(p: { base64: string; mediaType: "image/jpeg" | "image/png" | "image/webp"; url?: string }): Promise<ScreenshotRead | null> {
  return structured("readScreenshot", readModel(), ReadSchema, {
    max_tokens: 2048,
    system:
      "You transcribe what a reader sees in a screenshot of a web page: the main headline, the body text in reading order, and which publicly traded companies the content is about. Ignore navigation, ads, cookie banners and the small round overlay in a corner. Transcribe faithfully; do not summarise or add anything that is not visible.",
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: p.mediaType, data: p.base64 } },
          { type: "text", text: `Screenshot of ${p.url ?? "a web page"}. Transcribe the headline and visible text, and name the companies it is about.` },
        ],
      },
    ],
  });
}

const CounterSchema = z.object({
  text: z.string().max(220).nullable().describe("One plain sentence, at most 25 spoken words, giving the strongest reason NOT to buy right now, drawn from one headline; null if no headline argues against buying"),
  headlineIndex: z.number().int().min(0).nullable().describe("Index into the headline list of the headline the sentence rests on, or null"),
});

/**
 * Counter-view (spec §7.5): the strongest bear case from the last week's headlines, one sentence,
 * shown under the amount before a buy. Null when nothing in the list argues against buying.
 */
export async function counterView(p: { name: string; ticker: string; headlines: Headline[] }): Promise<{ text: string; headlineIndex: number | null } | null> {
  if (p.headlines.length === 0) return null;
  const out = await structured("counterView", fastModel(), CounterSchema, {
    max_tokens: 512,
    system:
      "Someone is about to buy a small amount of a stock from a headline. Give them the strongest case against it from the headlines provided, in one plain sentence of at most 25 words, the way a level-headed friend would. When the reason is someone's opinion or forecast rather than something that happened, say so ('one analyst argues…'); never state a prediction as fact. No tickers, no jargon, no advice verbs like 'sell' or 'avoid'. If nothing in the list argues against buying, return null.",
    messages: [
      {
        role: "user",
        content: `Company: ${p.name}.\n\nHeadlines from the last 7 days:\n${p.headlines
          .slice(0, 20)
          .map((h, i) => `${i}. [${h.source}] ${h.title} (${h.publishedAt})`)
          .join("\n")}`,
      },
    ],
  });
  if (!out?.text) return null;
  const idx = out.headlineIndex;
  return { text: out.text, headlineIndex: idx !== null && idx < p.headlines.length ? idx : null };
}

const NoteSchema = z.object({
  summary: z.string().max(280).describe("What the page is about, in one or two plain sentences"),
  facts: z
    .array(z.string().max(200))
    .max(8)
    .describe("The facts worth recalling on another page, one short line each: numbers with their units and dates, results, targets, forecasts, who said what. Say whose opinion or forecast it is. Only what the page states."),
  companies: z.array(z.string().max(80)).max(5).describe("Publicly traded or pre-IPO companies the page is about, by name; empty if none"),
});
export type PageNoteDraft = z.infer<typeof NoteSchema>;

/**
 * "Remember this page": the short fact sheet Glance keeps (in the user's browser) to use on other pages.
 * Built once when the user asks; the backend returns it and keeps nothing.
 */
export async function notePage(p: { url: string; title?: string; site?: string; publishedAt?: string; text: string }): Promise<PageNoteDraft | null> {
  return structured("notePage", fastModel(), NoteSchema, {
    max_tokens: 1024,
    system:
      "You keep notes for someone who reads about companies and later asks questions on other pages, like a chart of the same stock. From the page, write a one or two sentence summary and up to eight facts worth recalling later: numbers with units and dates, results, price targets, forecasts, and who said what. Attribute opinions and forecasts ('UBS expects…'). Only what the page states; never add outside knowledge.",
    messages: [
      {
        role: "user",
        content: `Page: ${p.title ?? "(untitled)"}\nURL: ${p.url}${p.publishedAt ? `\nPublished: ${p.publishedAt}` : ""}\n\nText:\n"""\n${p.text.slice(0, 8000)}\n"""`,
      },
    ],
  });
}

export const COMMAND_KINDS = ["glance", "list", "buy", "sell", "amount", "confirm", "cancel", "why", "pick", "watch", "note", "explain", "scroll", "balance", "limit", "holdings", "remember", "settings", "unknown"] as const;

const CommandSchema = z.object({
  kind: z.enum(COMMAND_KINDS),
  amountUsd: z.number().nullable().describe("The dollar amount the user said, or null. Never invent one."),
  companyId: z.string().nullable().describe("The id of the on-screen company the user named or pointed at; for sell and holdings, the name or ticker of any company they named; or null"),
  note: z.string().max(1000).nullable().describe("For kind=note only: the note itself, without the word 'note'"),
  direction: z.enum(["up", "down", "top", "bottom"]).nullable().describe("For kind=scroll only: which way, or to the top or bottom of the page"),
  all: z.boolean().nullable().describe("For kind=sell: true when they said all of it (everything, the whole position)"),
});
export type SpokenCommand = z.infer<typeof CommandSchema>;

const COMMAND_SYSTEM = `You turn one spoken sentence into a command for Glance, a browser helper that buys small amounts of a company's stock from the page the user is reading. The sentence comes from speech recognition, so expect filler words and misheard names.
Kinds:
- glance: look at the page and say which company it is about ("what's this", "check this page"). With a company named, glance that company (companyId: its name): "glance Anthropic", "glance at Nvidia".
- list: name every company on the page ("what else is here").
- buy: buy now, with an optional amount and company ("buy ten dollars", "put twenty in Nvidia", "let's get some"). Any wording that asks to spend money on, put money in, get or grab a company is buy, also when the company is described instead of named.
- amount: change the amount without buying ("make it twenty", "actually five"). Not when they ask to spend it: that is buy.
- confirm: agree with what is on screen ("yes", "sounds good").
- cancel: decline or close ("no", "never mind").
- why: explain why the stock's price moved, from the news ("why is it down", "what happened today"). Not a question about the page itself ("what's happening on this page" is explain).
- pick: choose one of the on-screen companies without buying ("Nvidia", "the second one").
- watch: ask to be told when the company can be bought ("let me know when it's available").
- note: save a note about the purchase ("note: bought because of the China numbers").
- explain: a question about what is on the page, answered by talking and drawing on it, or a request to point at, find, highlight or circle something on the page, a company included ("point me to Anthropic", "where is Nvidia mentioned"), or to click or open something on the page ("what does this chart show", "where's the price", "open the earnings tab", "show me the one year chart"). Questions about what the page says, reports or shows (results, numbers, what happened) are explain, even when nothing is open.
- scroll: move the page with no question attached ("scroll down", "go back to the top").
- sell: sell some or all of a stock they own ("sell five dollars of Apple", "sell all my Nvidia", "cash out of Tesla").
- balance: how much money is in their Glance account ("what's my balance", "how much cash do I have").
- limit: how much more Glance may spend today under their daily limit ("how much can I still spend today", "what's my daily limit").
- holdings: what they own, or how much of one company ("what do I own", "how much Apple do I have", "how are my stocks doing").
- remember: keep this page in mind to use on other pages later ("remember this page", "save this article for later"). Not a note about a purchase: "remember that I bought it for the China numbers" is note.
- settings: a change only the account owner can make, with their wallet: the daily limit or caps, deposits, withdrawals, revoking Glance ("raise my limit to fifty", "withdraw twenty dollars", "move my cash back to my wallet"). Glance answers where to make it.
- unknown: anything else.
Use companyId values only from the on-screen list. When unsure, answer unknown.`;

/** Spoken commands the grammar in services/voice.ts could not place (spec §7.4). */
export async function interpretCommand(p: { text: string; screen: string }): Promise<SpokenCommand | null> {
  return structured(
    "interpretCommand",
    fastModel(),
    CommandSchema,
    {
      max_tokens: 512,
      system: COMMAND_SYSTEM,
      messages: [{ role: "user", content: `${p.screen}\n\nThey said: """${p.text.slice(0, 500)}"""` }],
    },
    // Someone is holding a key and waiting: one short try, no retries.
    { timeout: 8_000, maxRetries: 0 },
  );
}

const MarkPoint = z.object({ x: z.number(), y: z.number() });
const MarkSchema = z.object({
  kind: z
    .enum(["circle", "underline", "highlight", "box", "arrow", "line", "path", "note", "level", "zone", "trend"])
    .describe("circle/box: ring a thing; underline/highlight: the exact words; arrow: point at a thing, or from points[0] to points[1]; line/path: sketch something that is not there; note: a few handwritten words beside a thing or at points[0]; level: a horizontal line at a price across the chart; zone: a band from price to price2 across the chart; trend: a line through two points, extended across the chart"),
  element: z.string().nullable().describe("id from the element map (e.g. e12) of the thing this mark is about; null only when the thing has no element"),
  quote: z.string().max(80).nullable().describe("exact words inside that element to underline or highlight; null for the whole element"),
  box: z
    .object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })
    .nullable()
    .describe("screenshot pixels, only for a thing with no element (a spot inside a chart, an image or a video)"),
  points: z.array(MarkPoint).max(40).nullable().describe("screenshot pixels for line (2 points) and path (a sketch); null otherwise"),
  text: z.string().max(32).nullable().describe("note: the words to write (at most 4); arrow, level, zone, trend: an optional short label; null otherwise"),
  price: z.number().nullable().describe("level: the price; zone: one edge; uses the chart's price axis"),
  price2: z.number().nullable().describe("zone: the other edge"),
});
const ChartSchema = z
  .object({
    plot: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).describe("screenshot pixels of the area the candles or line sit in, without the axis labels"),
    ticks: z
      .array(z.object({ price: z.number(), y: z.number() }))
      .min(2)
      .max(2)
      .describe("two labelled prices on the price axis, far apart, each with the y pixel of the centre of its label"),
  })
  .nullable()
  .describe("The price chart the marks are drawn on; null when there is no chart");
const ActionSchema = z
  .object({
    kind: z.enum(["none", "scroll", "click"]),
    element: z.string().nullable().describe("scroll: the element to bring into view, which may be off screen; click: the link, tab or button to press"),
    direction: z.enum(["up", "down"]).nullable().describe("scroll with no element: one screen up or down"),
  })
  .describe("One step to take after the segments are spoken; you then see the page again and continue. kind none when the question is answered.");
const ExplanationSchema = z.object({
  segments: z
    .array(
      z.object({
        say: z.string().max(260).describe("One or two spoken sentences, at most 35 words"),
        marks: z.array(MarkSchema).max(3).describe("What to draw while this is said; may be empty"),
      }),
    )
    .min(1)
    .max(5),
  chart: ChartSchema,
  action: ActionSchema,
});
export type ExplainChart = z.infer<typeof ChartSchema>;
export type ExplainAction = z.infer<typeof ActionSchema>;
export type Explanation = z.infer<typeof ExplanationSchema>;
export type Mark = z.infer<typeof MarkSchema>;

const EXPLAIN_SYSTEM = `You are Glance, a browser helper for people who read the news and buy small amounts of stock from it. The user asked a question out loud about the page in front of them. Answer it out loud while drawing on the page, like a teacher at a whiteboard.

Speech: two to four segments, each one or two short sentences (at most 35 words), written for the ear: plain words, no markdown, no lists, numbers as people say them. Refer to what is actually on the page. If the page does not answer the question, say so in one segment. Never tell the user to buy or sell, and never invent a number that is not on the page.

Drawing: each segment carries the marks drawn while it is spoken, at most three, and a segment may have none. Circle or box a thing when you name it; underline or highlight the exact words when you quote them; draw an arrow to a thing when you say "here" or connect two things; write a short note (at most four words) beside a thing to label it; sketch a line or path for something that is not on the page, such as a trend line across a chart or a level to watch. Keep it sparse: a mark should earn its place.

Anchoring: you get a screenshot and a map of the visible elements, each with an id, a kind, its text and its box, all in the screenshot's pixels (origin top-left). Anchor a mark to an element id whenever the thing is in the map, and add a quote for words inside it: to point at a name or phrase inside a longer element, set quote to exactly those words so the mark lands on them, not on the whole paragraph. Use a box, or points, in screenshot pixels only for things with no element, such as a spot inside a chart, an image or a video. To draw at prices on a chart (level, zone), set chart to its plot area and two price labels on its axis. Elements whose box lies outside the screenshot are off screen: to point at one, just mark it, and Glance scrolls it into view while that segment is said. Use a scroll action only when you need to see something off screen before you can answer, such as a chart or a table.

Acting: after your segments are spoken you may take one step: scroll to an element, scroll a screen up or down, or click one link, tab, "show more" or similar control. You then get a fresh screenshot and map and continue the same answer. Act only when the question needs it (what they asked about is behind a tab or collapsed, or off screen and you need to see it) or when they asked you to scroll, click or open something. Say what you are about to do in your last segment and circle the thing you will click. Never click anything that buys, sells, trades, pays, orders, subscribes, signs in or out, submits a form, sends, deletes, downloads, installs, accepts terms or changes settings: tell the user to do that themselves. On a later step, continue from what you already said without repeating it, and set the action to none as soon as the question is answered.`;

export interface ExplainPromptInput {
  question: string;
  /** The skills that fit this question, as a prompt section (services/skills.ts). */
  skills: string;
  pageHeader: string;
  elementMap: string;
  /** How elementMap is written (services/explain.ts); the header says so. */
  mapFormat?: "pipes" | "spaces";
  /** Earlier steps of this same answer: what was said, and what was scrolled or clicked. */
  earlier: string;
  /** Pages the user asked Glance to remember, as a prompt section (services/explain.ts memoryBlock), or "". */
  memory?: string;
  /** Recent headlines about the page's companies, as a prompt section (services/explain.ts newsBlock), or "". */
  news?: string;
  image: { base64: string; mediaType: "image/jpeg" | "image/png" | "image/webp" } | null;
}

/**
 * The system blocks and user turn of a "show me" request, shared by `explainPage` and the replay
 * script's token count, so both see exactly the same prompt.
 *
 * Prompt caching: the instructions, then the skills, are the stable prefix, each with a breakpoint so
 * a question with other skills still reads the instructions from the cache. Everything that changes
 * per request (screenshot, map, saved pages, question) is in the user turn after them. Nothing dynamic
 * may enter the two system blocks. A breakpoint only caches past the model's minimum (Sonnet 5: 1,024
 * tokens); the answer schema is part of the cached prefix, and on Sonnet 5 the instructions alone
 * measured 3,835 cached tokens, with one skill 4,632.
 */
export function explainPrompt(p: ExplainPromptInput) {
  const mapHeader = p.mapFormat === "spaces" ? "Element map, one element per line: id, kind, box x,y,w,h, then its text:" : "Element map (id | kind | box x,y,w,h | text):";
  const text = `${p.pageHeader}\n\n${mapHeader}\n${p.elementMap}${p.memory ? `\n\n${p.memory}` : ""}${p.news ? `\n\n${p.news}` : ""}\n\nThe user asked: """${p.question.slice(0, 500)}"""${p.earlier ? `\n\nSo far in this answer:\n${p.earlier}` : ""}`;
  const skills = p.skills.trimStart();
  const system = [
    { type: "text" as const, text: EXPLAIN_SYSTEM, cache_control: { type: "ephemeral" as const } },
    ...(skills ? [{ type: "text" as const, text: skills, cache_control: { type: "ephemeral" as const } }] : []),
  ];
  const content = p.image
    ? [{ type: "image" as const, source: { type: "base64" as const, media_type: p.image.mediaType, data: p.image.base64 } }, { type: "text" as const, text }]
    : text;
  return { system, messages: [{ role: "user" as const, content }] };
}

/** "Show me" (spec §7.4 voice): spoken segments with the marks to draw while each is said. */
export async function explainPage(p: ExplainPromptInput): Promise<Explanation | null> {
  return structured("explainPage", visionModel(), ExplanationSchema, { max_tokens: 4096, ...explainPrompt(p) }, {
    timeout: 40_000,
    maxRetries: 0,
    effort: env.LLM_VISION_EFFORT,
    thinking: env.LLM_VISION_THINKING === "off" ? "off" : undefined,
  });
}
