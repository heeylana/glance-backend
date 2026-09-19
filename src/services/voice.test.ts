import { describe, expect, it } from "vitest";
import { matchCompany, normalize, parseAmount, parseCommand, sanitize, type VoiceContext } from "./voice.js";
import { decodeWavDataUrl } from "./stt.js";

const apple = { companyId: "aapl", name: "Apple", ticker: "AAPL" };
const nvidia = { companyId: "nvda", name: "Nvidia", ticker: "NVDA" };
const alphabet = { companyId: "googl", name: "Alphabet", ticker: "GOOGL" };

const card: VoiceContext = { view: "company", entities: [apple], current: apple, amountUsd: 10 };
const choice: VoiceContext = { view: "choice", entities: [apple, nvidia, alphabet], current: null, amountUsd: null };
const closed: VoiceContext = { view: "closed", entities: [], current: null, amountUsd: null };

const say = (text: string, ctx: VoiceContext = card) => parseCommand(text, ctx);

describe("parseAmount", () => {
  it.each([
    ["buy $10", 10],
    ["10 bucks", 10],
    ["buy 12.50 dollars", 12.5],
    ["ten dollars", 10],
    ["twenty five", 25],
    ["one hundred and twenty", 120],
    ["a hundred", 100],
    ["two thousand five hundred", 2500],
    ["make it fifteen", 15],
    ["$1,000", 1000],
  ])("%s → %d", (text, n) => {
    expect(parseAmount(normalize(text))).toBe(n);
  });
  it("finds nothing, or refuses what Glance could never buy", () => {
    expect(parseAmount(normalize("buy it"))).toBeNull();
    expect(parseAmount(normalize("zero dollars"))).toBeNull();
    expect(parseAmount(normalize("a million dollars"))).toBeNull();
    expect(parseAmount(normalize("$50000"))).toBeNull();
  });
});

describe("parseCommand", () => {
  it("reads the spec's grammar (§7.4)", () => {
    expect(say("Buy ten dollars.")).toMatchObject({ kind: "buy", amountUsd: 10, companyId: null });
    expect(say("Make it twenty")).toMatchObject({ kind: "amount", amountUsd: 20 });
    expect(say("Why?")).toMatchObject({ kind: "why" });
    expect(say("No.")).toMatchObject({ kind: "cancel" });
    expect(say("What else is on this page?")).toMatchObject({ kind: "list" });
    expect(say("Note: bought because of the China numbers.")).toMatchObject({ kind: "note", note: "bought because of the China numbers." });
  });

  it("hears a watch request even when it says buy (found by the voice eval, 18 Sep 2026)", () => {
    const rivian = { companyId: "rivn", name: "Rivian", ticker: "RIVN" };
    const untokenized: VoiceContext = { view: "untokenized", entities: [rivian], current: rivian, amountUsd: null };
    expect(say("can you ping me once I can actually buy this", untokenized)?.kind).toBe("watch");
    expect(say("let me know once it's available", untokenized)?.kind).toBe("watch");
    // Used to buy at once on a buy card.
    expect(say("remind me to buy more next week")?.kind).toBe("watch");
    expect(say("buy ten dollars")).toMatchObject({ kind: "buy", amountUsd: 10 });
  });

  it("answers how many shares from the vault instead of explaining the page", () => {
    expect(say("how many shares of nvidia have I got", closed)).toMatchObject({ kind: "holdings", companyId: "nvda" });
    expect(say("how many nvidia shares do I have", closed)).toMatchObject({ kind: "holdings", companyId: "nvda" });
    expect(say("how much apple have I got", closed)).toMatchObject({ kind: "holdings", companyId: "aapl" });
    expect(say("how much money have I got", closed)?.kind).toBe("balance");
    expect(say("how many shares do I have", closed)).toMatchObject({ kind: "holdings", companyId: null });
    // Slang for money is not a company: left to the balance rule or the LLM.
    expect(say("how much dough have I got left in there")?.kind).not.toBe("holdings");
    expect(say("how many employees does it have", closed)?.kind).toBe("explain");
  });

  it("sends wallet-only changes to settings, and leaves nearby phrasings alone", () => {
    for (const t of ["change my daily limit to fifty", "can you raise my limit", "up my limit to 50", "withdraw fifty dollars to my wallet", "deposit twenty dollars", "add money to my account", "put more money in my vault", "revoke Glance"])
      expect(say(t)?.kind, t).toBe("settings");
    expect(say("what's my daily limit", closed)?.kind).toBe("limit");
    expect(say("cash out of Tesla", closed)?.kind).toBe("sell");
    expect(say("make it twenty")).toMatchObject({ kind: "amount", amountUsd: 20 });
    expect(say("set it to twenty")).toMatchObject({ kind: "amount", amountUsd: 20 });
  });

  it("treats what's happening on the page as a page question, and about the stock as why", () => {
    for (const t of ["what's happening on this page", "what's going on here", "what's going on in this chart", "what happened in this article"]) expect(say(t, closed)?.kind, t).toBe("explain");
    for (const t of ["what's going on with Nvidia today", "why is it down", "what happened today"]) expect(say(t)?.kind, t).toBe("why");
  });

  it("sends pointing at something on the page to explain, and glances a named company", () => {
    for (const t of ["point me to Anthropic", "point me to where Anthropic is", "can you point to Anthropic so I can glance at it", "highlight Microsoft", "locate the earnings table", "circle the price"])
      expect(say(t, closed)?.kind, t).toBe("explain");
    expect(say("glance Anthropic", closed)).toMatchObject({ kind: "glance", companyId: "anthropic" });
    expect(say("glance at Nvidia", closed)).toMatchObject({ kind: "glance", companyId: "nvda" });
    expect(say("glance this", closed)).toMatchObject({ kind: "glance", companyId: null });
    expect(sanitize({ kind: "glance", amountUsd: null, companyId: "anthropic", note: null, direction: null, all: null }, closed)).toMatchObject({ kind: "glance", companyId: "anthropic" });
  });

  it("remembers a page, and leaves notes about a purchase to note", () => {
    for (const t of ["Remember this", "remember this page", "Hey Glance, remember this article.", "save this for later", "keep this in mind", "bookmark this page", "please remember it", "hold on to this story"])
      expect(say(t)?.kind, t).toBe("remember");
    expect(say("Remember that I bought it for the China numbers.")).toMatchObject({ kind: "note", note: "I bought it for the China numbers." });
    expect(say("note: remember this")).toMatchObject({ kind: "note" });
    expect(say("remember to buy more next week")?.kind).not.toBe("remember");
  });

  it("confirms and cancels only on a whole short answer", () => {
    for (const t of ["Yes", "yeah, do it", "Go ahead please", "Buy it", "OK"]) expect(say(t)?.kind, t).toBe("confirm");
    expect(say("Yes")?.kind).toBe("confirm");
    expect(say("Hey Glance, yes please")?.kind).toBe("confirm");
    for (const t of ["Never mind", "no thanks", "Cancel that", "not now"]) expect(say(t)?.kind, t).toBe("cancel");
    expect(say("Don't buy that")?.kind).toBe("cancel");
    expect(say("No, make it five")).toMatchObject({ kind: "amount", amountUsd: 5 });
  });

  it("names the company on the card, by name, ticker, alias or position", () => {
    expect(say("Buy twenty-five dollars of Nvidia.", choice)).toMatchObject({ kind: "buy", amountUsd: 25, companyId: "nvda" });
    expect(say("put $5 in google", choice)).toMatchObject({ kind: "buy", amountUsd: 5, companyId: "googl" });
    expect(say("Nvidia", choice)).toMatchObject({ kind: "pick", companyId: "nvda" });
    expect(say("the second one", choice)).toMatchObject({ kind: "pick", companyId: "nvda" });
    expect(say("the last one", choice)).toMatchObject({ kind: "pick", companyId: "googl" });
    // A reference it can't resolve, with companies to pick from, goes to the LLM; a plain buy does not.
    expect(say("buy tesla", choice)).toBeNull();
    expect(say("hmm let's grab some of the chip maker, like fifteen bucks worth", choice)).toBeNull();
    expect(say("let's buy some more, ten dollars", choice)).toMatchObject({ kind: "buy", amountUsd: 10, companyId: null });
  });

  it("asks what the page is about, and asks to be told later", () => {
    expect(say("What's this about?", closed)?.kind).toBe("glance");
    expect(say("glance this page", closed)?.kind).toBe("glance");
    expect(say("Tell me when it's available")?.kind).toBe("watch");
    expect(say("what happened today")?.kind).toBe("why");
  });

  it("sends questions about the page to explain, after the fixed phrasings", () => {
    expect(say("What does this chart show?", closed)?.kind).toBe("explain");
    expect(say("where's the price", card)?.kind).toBe("explain");
    expect(say("walk me through this table", closed)?.kind).toBe("explain");
    expect(say("what's this about?", closed)?.kind).toBe("glance");
    expect(say("what am I looking at", closed)?.kind).toBe("glance");
    // Not a paid "show me" call (found by the voice eval, 18 Sep 2026).
    expect(say("what am I looking at here", closed)?.kind).toBe("glance");
    expect(say("why is it down today")?.kind).toBe("why");
  });

  it("scrolls on its own, and sends click requests to explain", () => {
    expect(say("Scroll down.", closed)).toMatchObject({ kind: "scroll", direction: "down" });
    expect(say("page up", closed)).toMatchObject({ kind: "scroll", direction: "up" });
    expect(say("go back to the top", closed)).toMatchObject({ kind: "scroll", direction: "top" });
    expect(say("bottom of the page", closed)).toMatchObject({ kind: "scroll", direction: "bottom" });
    expect(say("Open the earnings tab", closed)?.kind).toBe("explain");
    expect(say("click the one year chart", closed)?.kind).toBe("explain");
    expect(say("Scroll down to the quarterly results and walk me through them, then click buy.", card)?.kind).toBe("explain");
  });

  it("reads the account: balance, today's limit, holdings", () => {
    expect(say("What's my balance?", closed)?.kind).toBe("balance");
    expect(say("how much cash do I have", closed)?.kind).toBe("balance");
    expect(say("How much can I still spend today?", closed)?.kind).toBe("limit");
    expect(say("what's my daily limit", closed)?.kind).toBe("limit");
    expect(say("What do I own?", closed)).toMatchObject({ kind: "holdings", companyId: null });
    expect(say("how much Apple do I have", closed)).toMatchObject({ kind: "holdings", companyId: "aapl" });
    expect(say("how are my stocks doing", closed)?.kind).toBe("holdings");
  });

  it("sells any company it knows, an amount or all of it", () => {
    expect(say("Sell five dollars of Apple.", closed)).toMatchObject({ kind: "sell", amountUsd: 5, companyId: "aapl", all: false });
    expect(say("sell all my Nvidia", closed)).toMatchObject({ kind: "sell", amountUsd: null, companyId: "nvda", all: true });
    expect(say("cash out of tesla", closed)).toMatchObject({ kind: "sell", companyId: "tsla" });
  });

  it("leaves what it cannot place to the LLM", () => {
    expect(say("what would warren buffett think of this")).toBeNull();
    // Withdrawals no longer need the LLM: the grammar answers them as settings.
    expect(say("withdraw everything to my wallet")?.kind).toBe("settings");
    expect(say("hmm I wonder about the dividend")).toBeNull();
    expect(say("how much money do I have left")?.kind).toBe("balance");
    expect(say("")).toBeNull();
  });
});

describe("matchCompany", () => {
  it("wants a whole word", () => {
    expect(matchCompany(normalize("pineapple"), card)).toBeNull();
    expect(matchCompany(normalize("apples"), card)).toBe("aapl");
  });
});

describe("sanitize", () => {
  it("drops companies the LLM was not shown and amounts out of range", () => {
    expect(sanitize({ kind: "buy", amountUsd: 20_000, companyId: "tsla", note: "x", direction: "up", all: true }, choice)).toEqual({ kind: "buy", amountUsd: null, companyId: null, note: null, direction: null, all: null });
    expect(sanitize({ kind: "pick", amountUsd: null, companyId: "tsla", note: null, direction: null, all: null }, choice).kind).toBe("unknown");
    expect(sanitize({ kind: "note", amountUsd: null, companyId: null, note: "for the dividend", direction: null, all: null }, card)).toMatchObject({ kind: "note", note: "for the dividend" });
  });
});

describe("decodeWavDataUrl", () => {
  const wav = (tag = "RIFF", size = 64) => {
    const b = Buffer.alloc(size);
    b.write(tag, 0, "ascii");
    b.write("WAVE", 8, "ascii");
    return `data:audio/wav;base64,${b.toString("base64")}`;
  };
  it("accepts a RIFF/WAVE upload and rejects anything else", () => {
    expect(decodeWavDataUrl(wav())?.length).toBe(64);
    expect(decodeWavDataUrl(wav("OggS"))).toBeNull();
    expect(decodeWavDataUrl(wav("RIFF", 20))).toBeNull();
    expect(decodeWavDataUrl(wav().replace("audio/wav", "audio/webm"))).toBeNull();
  });
});

describe("sanitize for the account", () => {
  it("resolves a named company for selling from anywhere, by name or ticker", () => {
    expect(sanitize({ kind: "sell", amountUsd: 5, companyId: "Apple", note: null, direction: null, all: null }, closed)).toMatchObject({ kind: "sell", companyId: "aapl", all: false });
    expect(sanitize({ kind: "holdings", amountUsd: null, companyId: "NVDA", note: null, direction: null, all: null }, closed)).toMatchObject({ companyId: "nvda" });
    expect(sanitize({ kind: "buy", amountUsd: 5, companyId: "Apple", note: null, direction: null, all: null }, closed)).toMatchObject({ companyId: null });
  });
});
