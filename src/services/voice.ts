/**
 * Spoken commands (spec §7.4): "buy ten dollars", "make it twenty", "why", "no", "what else is on
 * this page", "note: …". A small grammar places the common phrasings instantly and without an LLM
 * key; whatever it cannot place goes to the LLM with the same shape. A command only says what the user
 * asked for. The extension acts on it by pressing the same bubble buttons a tap would, so a spoken buy
 * still goes through /buy and every guard.
 */
import { z } from "zod";
import { COMPANIES } from "../resolver/companies.js";
import { interpretCommand, type SpokenCommand } from "./llm.js";

export type VoiceCommand = SpokenCommand;

const Company = z.object({ companyId: z.string().max(64), name: z.string().max(120), ticker: z.string().max(16) });

/** What the bubble shows when the user lets go of the key; the grammar and the LLM read commands against it. */
export const VoiceContextSchema = z.object({
  view: z.enum(["closed", "thinking", "listening", "none", "company", "untokenized", "choice", "ask", "done", "error", "explain", "sell"]),
  /** Companies on the card (the choice chips, or the one being offered). */
  entities: z.array(Company).max(10),
  current: Company.nullable(),
  amountUsd: z.number().nullable(),
});
export type VoiceContext = z.infer<typeof VoiceContextSchema>;

const MAX_USD = 10_000;

function command(kind: VoiceCommand["kind"], extra: Partial<Omit<VoiceCommand, "kind">> = {}): VoiceCommand {
  return { kind, amountUsd: null, companyId: null, note: null, direction: null, all: null, ...extra };
}
export const UNKNOWN: VoiceCommand = command("unknown");

/** Lower-case, apostrophes dropped ("what's" → "whats"), hyphens to spaces ("twenty-five"), punctuation out, decimals kept. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[-–—]/g, " ")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9$.,\s]/g, " ")
    .replace(/(?<!\d)[.,]|[.,](?!\d)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SCALES: Record<string, number> = { hundred: 100, thousand: 1000 };
const isNumberWord = (w: string | undefined) => w !== undefined && (w in UNITS || w in TENS || w in SCALES);

/** The first dollar amount in a normalized utterance: "$10", "10 bucks", "twenty five dollars", "a hundred". */
export function parseAmount(t: string): number | null {
  const digits = /(?:^|\s)\$?\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d{1,2})?)(?=\s|$)/.exec(t);
  if (digits) {
    const n = Number(digits[1]!.replace(/,/g, ""));
    return n > 0 && n <= MAX_USD ? n : null;
  }
  const words = t.split(" ");
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const startsWithA = (w === "a" || w === "an") && words[i + 1]! in SCALES;
    if (!isNumberWord(w) && !startsWithA) continue;
    let total = 0;
    let current = 0;
    let j = startsWithA ? i + 1 : i;
    if (startsWithA) current = 1;
    for (; j < words.length; j++) {
      const x = words[j]!;
      if (x === "and" && isNumberWord(words[j + 1])) continue;
      if (x in UNITS) {
        const u = UNITS[x]!;
        if (current === 0 || (current >= 20 && current % 10 === 0 && u < 10) || (current % 100 === 0 && u < 20)) current += u;
        else break;
      } else if (x in TENS) {
        if (current === 0 || current % 100 === 0) current += TENS[x]!;
        else break;
      } else if (x === "hundred") {
        current = (current || 1) * 100;
      } else if (x === "thousand") {
        total += (current || 1) * 1000;
        current = 0;
      } else break;
    }
    const n = total + current;
    return n > 0 && n <= MAX_USD ? n : null;
  }
  return null;
}

/** Every way the user might say a company on the card: its name, ticker, and aliases ("google" for Alphabet). */
function spokenNames(ctx: VoiceContext): { id: string; name: string; re: RegExp }[] {
  const pool = [...ctx.entities, ...(ctx.current ? [ctx.current] : [])];
  return pool.flatMap((e) => {
    const seed = COMPANIES.find((c) => c.id === e.companyId);
    return [e.name, e.ticker.length >= 3 ? e.ticker : "", ...(seed?.aliases ?? [])]
      .map(normalize)
      .filter((n) => n.length >= 3)
      .map((n) => ({ id: e.companyId, name: n, re: new RegExp(`(?:^|\\s)${n.replace(/[.$]/g, "\\$&")}s?(?=\\s|$)`, "g") }));
  });
}

/** The company on the card named in the utterance (the longest name wins), or null. */
export function matchCompany(t: string, ctx: VoiceContext): string | null {
  let best: { id: string; len: number } | null = null;
  for (const n of spokenNames(ctx)) {
    n.re.lastIndex = 0;
    if (n.re.test(t) && (!best || n.name.length > best.len)) best = { id: n.id, len: n.name.length };
  }
  return best?.id ?? null;
}

const ORDINAL = /\b(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|last)\b/;

/** Any company Glance knows, by name, ticker or alias, for selling and holdings (not limited to the card). */
export function matchAnyCompany(t: string): string | null {
  let best: { id: string; len: number } | null = null;
  for (const c of COMPANIES) {
    for (const n of [c.name, c.ticker.length >= 3 ? c.ticker : "", ...c.aliases].map(normalize).filter((x) => x.length >= 3)) {
      if (new RegExp(`(?:^|\\s)${n.replace(/[.$]/g, "\\$&")}s?(?=\\s|$)`).test(t) && (!best || n.length > best.len)) best = { id: c.id, len: n.length };
    }
  }
  return best?.id ?? null;
}

/** "the second one", "the last one", "first": an index into the choice chips. */
function matchOrdinal(t: string, ctx: VoiceContext): string | null {
  if (ctx.entities.length < 2) return null;
  const m = ORDINAL.exec(t);
  if (!m) return null;
  const idx = { first: 0, "1st": 0, second: 1, "2nd": 1, third: 2, "3rd": 2, fourth: 3, "4th": 3, fifth: 4, "5th": 4, last: ctx.entities.length - 1 }[m[1] as "first"];
  return ctx.entities[idx]?.companyId ?? null;
}

/** "Remember this page", "save this article for later", "keep this in mind": a page to use on other pages. Checked before NOTE, which owns "remember that <something>". */
const REMEMBER =
  /^(?:(?:please |can you |could you )?(?:remember|save|keep|bookmark|store|memori[sz]e|hold on to|hang on to) (?:this|that|it)(?: (?:page|article|story|post|video|one|chart|report|tweet|thread))?(?: (?:for later|in mind|for me))?|keep (?:this|that|it) in mind)$/;
const NOTE = /^\s*(?:(?:add|make|take|leave)\s+a\s+note|note(?:\s+that)?|remember(?:\s+that)?)\b\s*[:,.-]?\s*(\S.*)$/i;
const CANCEL_PHRASE = "(?:no|nope|nah|not|no thanks|no thank you|cancel|cancel (?:it|that)|never ?mind|stop|close|close (?:it|this|that)|not now|forget it|dismiss|go away|dont)";
const CONFIRM_PHRASE = "(?:yes|yeah|yea|yep|yup|sure|ok|okay|confirm|do it|go ahead|go for it|buy it|buy that|buy this|thats right|thats it|correct|right|yes please|please|lets do it|lets go|sounds good|absolutely|definitely|of course)";
/** A whole answer made of these phrases only: "yes", "yeah do it", "no never mind". */
const CANCEL = new RegExp(`^${CANCEL_PHRASE}(?: ${CANCEL_PHRASE})*$`);
const CONFIRM = new RegExp(`^${CONFIRM_PHRASE}(?: ${CONFIRM_PHRASE})*$`);
const DONT_BUY = /\b(?:dont|do not|never) (?:buy|want)\b/;
const BUY = /\b(?:buy|purchase|invest|get me|grab|put)\b/;
const WHY = /\bwhy\b|\bwhat happened\b|\bwhats (?:the (?:news|story)|going on|happening)\b|\bany news\b/;
const LIST = /\b(?:what|who|which) else\b|\bother (?:compan(?:y|ies)|ones|stocks)\b|\b(?:all|which|what) (?:the )?(?:companies|stocks)\b|\bshow (?:me )?(?:all|them all|the others)\b|\banything else\b/;
/** Asking to be told later. Checked before BUY: the sentence often says "buy" ("ping me once I can buy this", "remind me to buy more"). */
const WATCH =
  /\btell me when\b|\blet me know (?:when|if|once)\b|\bnotify me\b|\bping me\b|\balert me\b|\bwatch (?:it|this|that|for it)\b|\bremind me\b|\badd (?:it |this )?to (?:my )?(?:watchlist|waiting)\b|\b(?:when|once|as soon as) (?:i|you) can (?:actually |finally )?(?:buy|get|trade)\b/;
/**
 * Changes only the owner can make, with their wallet, in the console: limits, deposits, withdrawals,
 * revoking. Glance says where to make them. Checked before SELL, LIMIT and BUY, which share words with them.
 */
const SETTINGS =
  /\b(?:(?:change|raise|lower|increase|decrease|set|update|reset|bump up|up) (?:my |the )?(?:daily |spending |per buy |per trade )?(?:limit|cap|leash)|withdraw|deposit|add (?:more )?(?:money|funds|cash)|top up|fund (?:my )?(?:account|vault)|put (?:more )?(?:money|cash|funds) (?:in|into) (?:my )?(?:account|vault|glance)|revoke)\b/;
const GLANCE = /^(?:glance(?: at)?(?: this| this page| here| the page)?|whats this(?: about| page| company| stock| one)?|what is this(?: about| page| company| stock)?|what (?:company|stock) is (?:this|that)|(?:read|check) (?:this|this page|the page)|look at (?:this|this page)|what am i (?:looking at|reading|watching)(?: here| right now| now)?)$/;
/** A question about the page itself, answered by talking and drawing on it. Checked after the fixed phrasings above. */
const EXPLAIN = /^(?:explain|show me|click|tap|press|open|expand|select|switch to|go to|take me to|find|(?:scroll|go|jump) (?:down |up |back )?to |point (?:to|at|out)|where(?:s| is| are| do| does| can)\b|walk me through|help me (?:understand|read)|what (?:does|do|is|are|was|were|should|can|am) |how (?:do|does|much|many|is|are|did|can) |tell me (?:about|what)|can you (?:explain|show))/;
/** "scroll down", "page up", "back to the top": moving the page needs no model. */
const SCROLL = /^(?:(?:scroll|page|go|move) (up|down)(?: a bit| a little| more| please)?|(?:go |scroll )?(?:back )?(?:up )?to the (top|bottom)(?: of the page)?|(?:go |scroll )?(?:back )?(top|bottom) of the page)$/;

/** The account: what is left to spend today, what is owned, how much cash, and selling. */
const LIMIT = /\b(?:daily limit|my limit|spending limit|limit left|left to spend|(?:can|could) i (?:still )?(?:spend|buy)|how much (?:more )?(?:can|could) i (?:spend|buy)|left (?:for )?today)\b/;
const HOLDINGS = /\b(?:what do i own|what have i bought|what am i holding|my (?:portfolio|holdings|positions|stocks|shares|investments)|how (?:is|are) my \w+ doing|do i (?:own|have|hold) any|have i got any)\b/;
/**
 * "How much Apple do I have", "how many shares of Nvidia have I got": holdings only when the word is a
 * company or shares/stock, so "how much dough have I got" stays a balance question.
 */
const HOLDING_OF = /\bhow (?:much|many) (?:shares (?:of )?)?\w+(?: \w+)? (?:do i (?:own|have|hold)|have i (?:got|bought))\b/;
const SHARES = /\b(?:shares?|stocks?)\b/;
const BALANCE = /\b(?:(?:my|account|vault) balance|balance|how much (?:money|cash)|how much do i have|how much have i got|cash (?:left|do i have)|buying power|whats in my (?:account|vault))\b/;
const SELL = /\b(?:sell|cash out(?: of)?|take (?:my )?profits? (?:on|in|from)|get out of)\b/;
const ALL = /\b(?:all|everything|entire|whole)\b/;

/** "how much do I have left", "what's in my portfolio": about the account, not the page. */
const ABOUT_ME = /\b(?:my|i have|i own|ive got|have i got|do i have|left|balance|portfolio|account|limit)\b/;
const CHANGE_AMOUNT = /\b(?:make it|change (?:it )?to|set (?:it )?to|switch to|instead|actually|how about)\b/;
const AMOUNT_ONLY = /^(?:(?:\$?\d[\d.,]*|a|an|and|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|dollars?|bucks?|usd)(?:\s|$))+$/;

/** Words that may surround a bare pick: "the second one", "Nvidia please", "I mean Apple". */
const PICK_FILLER = new Set(["the", "one", "yes", "yeah", "no", "i", "mean", "that", "its", "it", "is", "about", "oh", "actually", "pick", "choose", "go", "with", "lets", "do", "show", "me", "how", "what"]);

/** True when the utterance is a company on the card (or a position) and filler, nothing else. */
function isBarePick(t: string, ctx: VoiceContext): boolean {
  let rest = t;
  for (const n of spokenNames(ctx)) rest = rest.replace(n.re, " ");
  rest = rest.replace(new RegExp(ORDINAL.source, "g"), " ");
  return rest.split(" ").every((w) => !w || PICK_FILLER.has(w));
}

const BUY_FILLER = new Set(["buy", "purchase", "invest", "get", "grab", "put", "me", "i", "want", "to", "lets", "some", "more", "of", "in", "into", "worth", "it", "this", "that", "please", "now", "like", "just", "another", "a", "an", "and", "dollars", "dollar", "bucks", "buck", "usd", "hmm", "um", "uh", "ok", "okay", "yes", "yeah", "then"]);

/** "buy ten dollars", "let's buy some more": nothing but the verb, an amount and filler. */
function isPlainBuy(t: string): boolean {
  return t.split(" ").every((w) => BUY_FILLER.has(w) || isNumberWord(w) || /^\$?\d[\d.,]*$/.test(w));
}

/** Filler a push-to-talk utterance tends to carry: "hey glance, …", "um, …", "…, please". */
function trimFiller(t: string): string {
  return t
    .replace(/^(?:(?:hey|hi|ok|okay) glance\s+)/, "")
    .replace(/^(?:(?:um|uh|so|oh|well|and|hmm)\s+)+/, "")
    .replace(/\s+(?:please|thanks|thank you)$/, "")
    .trim();
}

/** The grammar: a command for the phrasings it knows, null for the LLM. */
export function parseCommand(text: string, ctx: VoiceContext): VoiceCommand | null {
  if (REMEMBER.test(trimFiller(normalize(text)))) return command("remember");
  const note = NOTE.exec(text.trim());
  if (note) return command("note", { note: note[1]!.trim().slice(0, 1000) });
  const t = trimFiller(normalize(text));
  if (!t) return null;
  if (DONT_BUY.test(t) || CANCEL.test(t)) return command("cancel");
  if (CONFIRM.test(t)) return command("confirm");
  // A request that opens with a page verb ("scroll down to…", "click…") is about the page, even if "buy" comes later.
  const scroll = SCROLL.exec(t);
  if (scroll) return command("scroll", { direction: (scroll[1] ?? scroll[2] ?? scroll[3]) as VoiceCommand["direction"] });
  if (GLANCE.test(t)) return command("glance");
  if (SETTINGS.test(t)) return command("settings");
  if (SELL.test(t)) {
    return command("sell", { amountUsd: ALL.test(t) ? null : parseAmount(t), companyId: matchCompany(t, ctx) ?? matchAnyCompany(t) ?? (ctx.view === "sell" ? (ctx.current?.companyId ?? null) : null), all: ALL.test(t) });
  }
  if (LIMIT.test(t)) return command("limit");
  if (HOLDINGS.test(t)) return command("holdings", { companyId: matchAnyCompany(t) });
  if (HOLDING_OF.test(t)) {
    const companyId = matchAnyCompany(t);
    if (companyId || SHARES.test(t)) return command("holdings", { companyId });
  }
  if (BALANCE.test(t)) return command("balance");
  if (EXPLAIN.test(t) && !ABOUT_ME.test(t)) return command("explain");
  if (WATCH.test(t)) return command("watch");
  if (BUY.test(t)) {
    const companyId = matchCompany(t, ctx) ?? matchOrdinal(t, ctx);
    // "grab some of the chip maker": a reference the grammar can't resolve, with companies to resolve it against.
    if (!companyId && ctx.entities.length > 1 && !isPlainBuy(t)) return null;
    return command("buy", { amountUsd: parseAmount(t), companyId });
  }
  if (WHY.test(t)) return command("why");
  if (LIST.test(t)) return command("list");
  const amount = parseAmount(t);
  if (amount !== null && (CHANGE_AMOUNT.test(t) || AMOUNT_ONLY.test(t))) return command("amount", { amountUsd: amount });
  const pick = matchCompany(t, ctx) ?? matchOrdinal(t, ctx);
  if (pick && isBarePick(t, ctx)) return command("pick", { companyId: pick });
  return null;
}

/** The screen as the LLM reads it. */
function describe(ctx: VoiceContext): string {
  const views: Record<VoiceContext["view"], string> = {
    closed: "Nothing is open.",
    thinking: "Glance is still reading the page.",
    listening: "Nothing is open.",
    none: "Glance found no company on this page.",
    company: "A buy card for the current company, with an amount and a Buy button.",
    untokenized: "The current company can't be bought yet; Glance offers to say when it can.",
    choice: "Glance asks which of the companies the user means.",
    ask: "Glance asks whether the page is about the current company (yes or no).",
    done: "A purchase just finished.",
    error: "Glance just showed an error.",
    sell: "Glance asks the user to confirm selling the current company.",
    explain: "Glance is explaining the page and drawing on it.",
  };
  return [
    `On screen: ${views[ctx.view]}`,
    ctx.entities.length ? `Companies on screen:\n${ctx.entities.map((e) => `- ${e.companyId}: ${e.name} (${e.ticker})`).join("\n")}` : "Companies on screen: none",
    ctx.current ? `Current company: ${ctx.current.companyId}: ${ctx.current.name} (${ctx.current.ticker})` : "",
    ctx.amountUsd !== null ? `Amount selected: $${ctx.amountUsd}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Keep the LLM inside the card: only companies it was shown, only amounts Glance could buy, a note only on a note. */
export function sanitize(c: VoiceCommand, ctx: VoiceContext): VoiceCommand {
  const known = new Set([...ctx.entities, ...(ctx.current ? [ctx.current] : [])].map((e) => e.companyId));
  // Selling and holdings can name any company Glance knows; everything else stays on the card.
  const anyCompany = c.kind === "sell" || c.kind === "holdings";
  const companyId = c.companyId === null ? null : known.has(c.companyId) ? c.companyId : anyCompany ? matchAnyCompany(normalize(c.companyId)) : null;
  const out = command(c.kind, {
    amountUsd: c.amountUsd !== null && c.amountUsd > 0 && c.amountUsd <= MAX_USD ? c.amountUsd : null,
    companyId,
    all: c.kind === "sell" ? c.all === true : null,
    note: c.kind === "note" && c.note ? c.note.slice(0, 1000) : null,
    direction: c.kind === "scroll" ? c.direction : null,
  });
  if ((out.kind === "scroll" && !out.direction) || (out.kind === "pick" && !out.companyId) || (out.kind === "amount" && out.amountUsd === null) || (out.kind === "note" && !out.note)) return UNKNOWN;
  return out;
}

export async function interpret(text: string, ctx: VoiceContext): Promise<{ command: VoiceCommand; via: "grammar" | "llm" | "none" }> {
  const g = parseCommand(text, ctx);
  if (g) return { command: g, via: "grammar" };
  const l = await interpretCommand({ text, screen: describe(ctx) });
  if (l) return { command: sanitize(l, ctx), via: "llm" };
  return { command: UNKNOWN, via: "none" };
}
