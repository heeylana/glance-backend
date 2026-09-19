import { describe, expect, it } from "vitest";
import { alsoMentioned, CONFIDENT, decide, focusOn, matchText, wordCase } from "./match.js";

const top = (s: string) => matchText(s)[0];

describe("matchText", () => {
  it("resolves a plain company name", () => {
    const t = top("Nvidia just reported record data-center revenue.");
    expect(t?.company.ticker).toBe("NVDA");
    expect(t!.confidence).toBeGreaterThanOrEqual(0.8);
  });
  it("resolves a product mention to the company (the demo: iPhone review → Apple)", () => {
    const t = top("Hands-on with the new iPhone: the camera is the story this year");
    expect(t?.company.ticker).toBe("AAPL");
  });
  it("resolves 'the Ozempic company' to Novo Nordisk (demo step 5)", () => {
    const t = top("the Ozempic company just crushed earnings");
    expect(t?.company.ticker).toBe("NVO");
    expect(t!.confidence).toBeGreaterThanOrEqual(0.5);
  });
  it("cashtags are near-certain", () => {
    const t = top("$META breaking out after hours");
    expect(t?.company.ticker).toBe("META");
    expect(t!.confidence).toBeGreaterThanOrEqual(0.9);
  });
  it("a bare ambiguous ticker in caps is weak evidence on its own", () => {
    const t = top("Working on the META analysis");
    expect(t?.company.ticker).toBe("META");
    expect(t!.confidence).toBeLessThan(0.5);
  });
  it("ordinary words do not fire: 'an apple a day' stays below confident", () => {
    const t = top("I ate an apple and went for a walk");
    expect(t?.company.ticker).toBe("AAPL");
    expect(t!.confidence).toBeLessThan(0.8);
  });
  it("finance context lifts an ambiguous name: 'Apple shares fall' is the company", () => {
    const t = top("Apple shares fall 3% after weak guidance");
    expect(t?.company.ticker).toBe("AAPL");
    expect(t!.confidence).toBeGreaterThanOrEqual(0.8);
  });
  it("name + exec + product stack to high confidence", () => {
    const t = top("Tim Cook says Apple's iPhone demand in China is stabilising");
    expect(t?.company.ticker).toBe("AAPL");
    expect(t!.confidence).toBeGreaterThan(0.95);
  });
  it("multiple companies on a page are all returned", () => {
    const c = matchText("Apple, Nvidia and Tesla all fell after the Fed decision");
    expect(c.map((x) => x.company.ticker).sort()).toEqual(expect.arrayContaining(["AAPL", "NVDA", "TSLA"]));
  });
  it("exec-only mentions resolve: 'Jensen Huang keynote'", () => {
    expect(top("Jensen Huang keynote tonight")?.company.ticker).toBe("NVDA");
  });
  it("does not match inside other words", () => {
    expect(matchText("pineapple snapshot").find((c) => c.company.ticker === "AAPL")).toBeUndefined();
    expect(matchText("pineapple snapshot").find((c) => c.company.ticker === "SNAP")).toBeUndefined();
  });
  it("returns nothing for text without entities", () => {
    expect(matchText("The weather was lovely and the coffee was hot.")).toHaveLength(0);
  });
});

describe("decide", () => {
  it("confident for a single strong candidate", () => {
    expect(decide(matchText("Nvidia earnings beat")).kind).toBe("confident");
  });
  it("multiple when several are strong", () => {
    expect(decide(matchText("Apple Inc, Nvidia and Tesla Inc fell")).kind).toBe("multiple");
  });
  it("disambiguate for a lone product mention", () => {
    expect(decide(matchText("the Ozempic company just crushed earnings")).kind).toBe("disambiguate");
  });
  it("ask_user for a weak bare ticker", () => {
    expect(decide(matchText("COST cutting is the theme")).kind).toBe("ask_user");
  });
  it("none for nothing", () => {
    expect(decide([]).kind).toBe("none");
  });
});

// Cases from the captured page set (src/resolver/fixtures/pages.json), 15 September 2026.
describe("dominance and ambiguity", () => {
  const withTitle = (title: string, body: string) => decide(matchText(`${title}\n${body}`, { titleLength: title.length }));
  it("a company alone in the title beats a strong passing mention (Waymo in a Tesla story)", () => {
    const v = withTitle(
      "Tesla's stock drops 6% as Cybercab update underwhelms",
      "Tesla shares fell after the Cybercab event. Analysts compared the robotaxi plans with Alphabet's Waymo, which already runs in five cities. Elon Musk said production starts next year.",
    );
    expect(v.kind).toBe("confident");
    expect(v.kind === "confident" && v.top.company.ticker).toBe("TSLA");
  });
  it("two companies in the title stay a multiple (the user picks)", () => {
    const v = withTitle("Novo Nordisk CEO defends lawsuit against Eli Lilly", "Novo Nordisk sued Eli Lilly over compounded tirzepatide. Lilly called the suit meritless.");
    expect(v.kind).toBe("multiple");
    expect(v.kind === "multiple" && v.candidates.map((c) => c.company.ticker).sort()).toEqual(["LLY", "NVO"]);
  });
  it("without a title, the company named three times as often wins", () => {
    const v = decide(matchText("Amazon paused work with the cargo carrier. Amazon said the Boeing 767 crash was under investigation. Amazon Air flies daily; Amazon added it will review the contract."));
    expect(v.kind).toBe("confident");
    expect(v.kind === "confident" && v.top.company.ticker).toBe("AMZN");
  });
  it("'strategy' as an ordinary word in a finance story is not Strategy Inc", () => {
    const c = matchText("Novo's new pricing strategy worried investors. The strategy shift follows weak earnings, and the strategy team is being rebuilt.").find((x) => x.company.ticker === "MSTR");
    expect(c?.confidence ?? 0).toBeLessThan(0.8);
  });
  it("Strategy the company, capitalised mid-sentence with finance words, is confident", () => {
    const c = matchText("Shares of Strategy rose 8% after Strategy added 5,000 bitcoin to its treasury.").find((x) => x.company.ticker === "MSTR");
    expect(c?.confidence ?? 0).toBeGreaterThanOrEqual(0.8);
  });
  it("a capitalised ambiguous name on its own reaches the LLM, not the buy card (Meta teen-app story)", () => {
    const v = decide(matchText("Meta will change how its apps work for teens. Meta said the rollout starts in the US."));
    expect(v.kind).toBe("disambiguate");
    expect(v.kind === "disambiguate" && v.candidates[0]!.company.ticker).toBe("META");
  });
  it("a weak product never corroborates an ambiguous name: the geometry page is not Circle Internet", () => {
    const c = matchText("A circle is a shape. The arc of a circle is a part of its circumference, and every chord of a circle subtends an arc.").find((x) => x.company.ticker === "CRCL");
    expect(c?.confidence ?? 0).toBeLessThan(0.8);
  });
  it("the S&P 500 named in passing does not turn a Tesla story into a multiple", () => {
    const v = withTitle("Tesla shares jump 5% after delivery beat", "Tesla delivered 410,000 vehicles. The stock outpaced the S&P 500, which rose 0.3%.");
    expect(v.kind).toBe("confident");
    expect(v.kind === "confident" && v.top.company.ticker).toBe("TSLA");
  });
  it("a market wrap about the S&P 500 itself resolves to SPY", () => {
    const v = withTitle("S&P 500 closes at a record as tech rallies", "The S&P 500 rose 1.2% to a record close. The index has gained 14% this year.");
    expect(v.kind).toBe("confident");
    expect(v.kind === "confident" && v.top.company.ticker).toBe("SPY");
  });
  it("Apple's services corroborate the name (iCloud+, Apple TV, Arcade)", () => {
    const t = top("Apple adds Apple TV and Arcade to iCloud+ subscriptions in 100 countries");
    expect(t?.company.ticker).toBe("AAPL");
    expect(t!.confidence).toBeGreaterThanOrEqual(0.9);
  });
});

describe("wordCase", () => {
  it("distinguishes Apple, APPLE and apple", () => {
    expect(wordCase("Apple")).toBe("proper");
    expect(wordCase("APPLE")).toBe("caps");
    expect(wordCase("apple")).toBe("common");
    expect(wordCase("Apple's")).toBe("proper");
  });
  it("all-caps META with finance words is the company; without them it is anyone's guess", () => {
    expect(top("META earnings after the bell")!.confidence).toBeGreaterThanOrEqual(0.8);
    expect(top("Working on the META analysis")!.confidence).toBeLessThan(0.5);
  });
});

// A BBC article (19 Sep 2026) about Google that also names Nvidia, OpenAI and Anthropic: the glance
// only showed Google, and "News" in "CBS News" scored as News Corp.
const BBC_TITLE = "Google's Gemini AI hacked three companies in security test";
const BBC = `${BBC_TITLE}
Google's AI model Gemini autonomously hacked into three companies during a test of its cyber-security capabilities, the company has said.
In July, Anthropic's Claude escaped its test environment to hack three organisations on its own just days after OpenAI said its models had carried out cyber-attacks.
Both Nvidia's CEO Jensen Huang and OpenAI Chief Executive Sam Altman are expected to attend a White House state dinner next Friday.
On Friday, Huang told CBS News, the BBC's US partner, "we should go as fast as we can" with AI development.`;

describe("a page about one company that names others", () => {
  const cands = matchText(BBC, { titleLength: BBC_TITLE.length });
  const verdict = decide(cands);
  it("answers with the company in the headline", () => {
    expect(verdict.kind).toBe("confident");
    if (verdict.kind === "confident") expect(verdict.top.company.ticker).toBe("GOOGL");
  });
  it("offers the other strongly named companies as also on this page", () => {
    expect(alsoMentioned(cands, verdict).map((c) => c.company.ticker).sort()).toEqual(["ANTHROPIC", "NVDA", "OPENAI"]);
  });
  it("does not read another outlet's name as News Corp", () => {
    const news = cands.find((c) => c.company.ticker === "NWS" || c.company.ticker === "NWSA");
    expect(news === undefined || news.confidence < CONFIDENT).toBe(true);
  });
  it("leads with the company the user focused on, and names the page's own subject first after it", () => {
    const anthropic = cands.find((c) => c.company.ticker === "ANTHROPIC")!;
    const focused = focusOn(cands, verdict, anthropic);
    expect(focused.verdict.kind).toBe("confident");
    if (focused.verdict.kind === "confident") expect(focused.verdict.top.company.ticker).toBe("ANTHROPIC");
    expect(focused.also.map((c) => c.company.ticker)[0]).toBe("GOOGL");
    expect(focused.also.map((c) => c.company.ticker).sort()).toEqual(["GOOGL", "NVDA", "OPENAI"]);
  });
  it("offers nothing extra when the answer is not confident", () => {
    expect(alsoMentioned(cands, { kind: "none" })).toEqual([]);
  });
});
