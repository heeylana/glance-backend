import { describe, expect, it } from "vitest";
import { compactElements, earlierSteps, elementMap, explainCompanies, ExplainInputSchema, explainRequest, leanElements, memoryBlock, newsBlock, OFFSCREEN_KEPT, questionTerms, quoteFits, sanitizeAction, sanitizeChart, sanitizeExplanation, type ExplainInput } from "./explain.js";
import type { Mark } from "./llm.js";

const input: Pick<ExplainInput, "size" | "elements" | "stepsLeft"> = {
  size: { w: 1280, h: 800 },
  elements: [
    { id: "e1", kind: "heading", text: "Nvidia shares jump 4% after Blackwell demand", box: [40, 80, 900, 48] },
    { id: "e2", kind: "canvas", text: "", box: [40, 200, 800, 400] },
    { id: "e3", kind: "link", text: "1Y", box: [900, 180, 30, 20] },
    { id: "e4", kind: "input", text: "Search", box: [900, 20, 200, 30] },
    { id: "e5", kind: "heading", text: "Quarterly results", box: [40, 1400, 600, 40] },
  ],
  stepsLeft: 2,
};
const none = { kind: "none", element: null, direction: null } as const;
const mark = (m: Partial<Mark>): Mark => ({ kind: "circle", element: null, quote: null, box: null, points: null, text: null, price: null, price2: null, ...m });

describe("sanitizeExplanation", () => {
  it("keeps marks on known elements and real quotes, drops the rest", () => {
    const out = sanitizeExplanation(
      {
        segments: [
          {
            say: " Here is the headline. ",
            marks: [
              mark({ kind: "underline", element: "e1", quote: "jump 4%" }),
              mark({ kind: "highlight", element: "e1", quote: "falls 9%" }),
              mark({ kind: "circle", element: "e99" }),
              mark({ kind: "note", element: "e1", text: null }),
            ],
          },
        ],
        chart: null,
        action: none,
      },
      input,
    );
    expect(out.segments[0]!.say).toBe("Here is the headline.");
    expect(out.segments[0]!.marks).toEqual([mark({ kind: "underline", element: "e1", quote: "jump 4%" }), mark({ kind: "highlight", element: "e1", quote: null })]);
  });

  it("clamps pixel boxes and points into the screenshot, and needs points for a path", () => {
    const out = sanitizeExplanation(
      {
        segments: [
          {
            say: "The trend.",
            marks: [
              mark({ kind: "box", box: { x: 1200, y: -20, w: 400, h: 100 } }),
              mark({ kind: "path", points: [{ x: 100, y: 500 }, { x: 2000, y: 900 }] }),
              mark({ kind: "path", points: [{ x: 1, y: 1 }] }),
              mark({ kind: "note", box: { x: 10, y: 10, w: 10, h: 10 }, text: " level to watch " }),
            ],
          },
        ],
        chart: null,
        action: none,
      },
      input,
    );
    expect(out.segments[0]!.marks).toEqual([
      mark({ kind: "box", box: { x: 1200, y: 0, w: 80, h: 100 } }),
      mark({ kind: "path", points: [{ x: 100, y: 500 }, { x: 1280, y: 800 }] }),
      mark({ kind: "note", box: { x: 10, y: 10, w: 10, h: 10 }, text: "level to watch" }),
    ]);
  });

  it("caps the total number of marks and drops empty segments", () => {
    const many = Array.from({ length: 3 }, () => mark({ element: "e1" }));
    const out = sanitizeExplanation({ segments: [...Array.from({ length: 5 }, () => ({ say: "x", marks: many })), { say: " ", marks: [] }], chart: null, action: none }, input);
    expect(out.segments).toHaveLength(5);
    expect(out.segments.reduce((n, s) => n + s.marks.length, 0)).toBe(12);
  });
});

describe("elementMap", () => {
  it("writes one line per element", () => {
    expect(elementMap(input.elements.slice(0, 2))).toBe("e1 | heading | 40,80,900,48 | Nvidia shares jump 4% after Blackwell demand\ne2 | canvas | 40,200,800,400 | ");
    expect(elementMap(input.elements.slice(0, 1), "spaces")).toBe("e1 heading 40,80,900,48 Nvidia shares jump 4% after Blackwell demand");
  });
});

describe("quoteFits", () => {
  it("ignores punctuation and spacing, and needs only the first three words", () => {
    const text = "The bull case rests on training clusters; the bear case is that a single quarter of softer orders would leave the chain holding inventory.";
    expect(quoteFits(text, "the bear case is that one quarter of softer orders leaves the chain")).toBe(true);
    expect(quoteFits(text, "clusters, the bear")).toBe(true);
    expect(quoteFits(text, "the bull market")).toBe(false);
    expect(quoteFits(text, "...")).toBe(false);
  });
});

describe("sanitizeAction", () => {
  const byId = new Map(input.elements.map((e) => [e.id, e]));
  it("clicks only mapped elements that can be clicked", () => {
    expect(sanitizeAction({ kind: "click", element: "e3", direction: "up" }, byId, 2)).toEqual({ kind: "click", element: "e3", direction: null });
    expect(sanitizeAction({ kind: "click", element: "e4", direction: null }, byId, 2)).toEqual(none);
    expect(sanitizeAction({ kind: "click", element: "e99", direction: null }, byId, 2)).toEqual(none);
  });
  it("scrolls to a mapped element, even off screen, or a screen up or down", () => {
    expect(sanitizeAction({ kind: "scroll", element: "e5", direction: "down" }, byId, 1)).toEqual({ kind: "scroll", element: "e5", direction: null });
    expect(sanitizeAction({ kind: "scroll", element: null, direction: "down" }, byId, 1)).toEqual({ kind: "scroll", element: null, direction: "down" });
    expect(sanitizeAction({ kind: "scroll", element: null, direction: null }, byId, 1)).toEqual(none);
  });
  it("takes no step once the steps are used up", () => {
    expect(sanitizeAction({ kind: "click", element: "e3", direction: null }, byId, 0)).toEqual(none);
  });
});

describe("earlierSteps", () => {
  it("tells the model what it said and did, and how that went", () => {
    expect(
      earlierSteps([
        { said: ["Let me open the one year view."], action: { kind: "click", target: "1Y", direction: null, outcome: "done" } },
        { said: ["And now the results."], action: { kind: "scroll", target: null, direction: "down", outcome: "refused" } },
      ]),
    ).toBe(
      'Step 1: you said: "Let me open the one year view." Then you clicked "1Y" (done).\nStep 2: you said: "And now the results." Then you scrolled down (refused: Glance does not click that kind of control).',
    );
  });
});

describe("chart marks", () => {
  const chart = { plot: { x: 40, y: 200, w: 800, h: 400 }, ticks: [{ price: 190, y: 220 }, { price: 160, y: 580 }] };
  it("keeps a price axis that reads the right way up", () => {
    expect(sanitizeChart(chart, 1280, 800)).toEqual(chart);
    expect(sanitizeChart({ ...chart, ticks: [{ price: 190, y: 580 }, { price: 160, y: 220 }] }, 1280, 800)).toBeNull();
    expect(sanitizeChart({ ...chart, ticks: [{ price: 170, y: 400 }, { price: 170, y: 300 }] }, 1280, 800)).toBeNull();
  });
  it("needs a price and an axis for a level, two prices for a zone, two points for a trend", () => {
    const out = sanitizeExplanation(
      {
        segments: [
          {
            say: "Support and resistance.",
            marks: [
              mark({ kind: "level", price: 170, text: "support" }),
              mark({ kind: "zone", price: 184, price2: 187 }),
              mark({ kind: "trend", points: [{ x: 100, y: 500 }] }),
            ],
          },
          { say: "The trend.", marks: [mark({ kind: "trend", points: [{ x: 100, y: 500 }, { x: 700, y: 300 }], text: "higher lows" })] },
        ],
        chart,
        action: none,
      },
      input,
    );
    expect(out.chart).toEqual(chart);
    expect(out.segments[0]!.marks.map((m) => m.kind)).toEqual(["level", "zone"]);
    expect(out.segments[0]!.marks[0]!.text).toBe("support");
    expect(out.segments[1]!.marks[0]!.text).toBe("higher lows");
    const noAxis = sanitizeExplanation({ segments: [{ say: "x", marks: [mark({ kind: "level", price: 170 })] }], chart: null, action: none }, input);
    expect(noAxis.segments[0]!.marks).toEqual([]);
  });
});

describe("memoryBlock", () => {
  it("is empty without saved pages", () => {
    expect(memoryBlock([])).toBe("");
  });
  it("names each saved page, says it is from elsewhere, and forbids drawing it", () => {
    const out = memoryBlock([
      { title: "UBS lifts Nvidia target", url: "https://example.com/ubs", savedAt: "2026-09-17T10:00:00.000Z", summary: "UBS raised its target.", facts: ["UBS: price target $250", "Data centre revenue $41B in Q2"] },
    ]);
    expect(out).toContain("from other pages");
    expect(out).toContain("never draw marks for them");
    expect(out).toContain('1. "UBS lifts Nvidia target" (https://example.com/ubs), saved 2026-09-17, publish date unknown');
    expect(memoryBlock([{ title: "t", url: "u", savedAt: "2026-09-17T10:00:00Z", publishedAt: "2026-08-20T12:00:00Z", summary: "s", facts: [] }])).toContain("published 2026-08-20, saved 2026-09-17");
    expect(out).toContain("  - UBS: price target $250");
  });
});

describe("compactElements", () => {
  const el = (id: string, kind: string, text: string, y: number) => ({ id, kind, text, box: [0, y, 100, 20] as [number, number, number, number] });
  it("drops textless icons but keeps canvases, videos and frames", () => {
    const out = compactElements({ size: { w: 1280, h: 800 }, elements: [el("e1", "image", "", 10), el("e2", "canvas", "", 100), el("e3", "video", " ", 200), el("e4", "frame", "", 300), el("e5", "link", "Earnings", 400)] });
    expect(out.map((e) => e.id)).toEqual(["e2", "e3", "e4", "e5"]);
  });
  it("keeps every visible element and only the nearest off-screen ones", () => {
    const visible = Array.from({ length: 5 }, (_, i) => el(`e${i}`, "text", "on screen", i * 50));
    const below = Array.from({ length: OFFSCREEN_KEPT + 10 }, (_, i) => el(`e${100 + i}`, "text", "below", 900 + i * 40));
    const out = compactElements({ size: { w: 1280, h: 800 }, elements: [...visible, ...below] });
    expect(out).toHaveLength(5 + OFFSCREEN_KEPT);
    expect(out.at(-1)!.id).toBe(`e${100 + OFFSCREEN_KEPT - 1}`);
  });
});

describe("finding what the question names", () => {
  it("keeps the words worth looking for", () => {
    expect(questionTerms("point me to Anthropic")).toEqual(["anthropic"]);
    expect(questionTerms("Where does it talk about OpenAI's models?")).toEqual(["openai", "models"]);
  });
  it("keeps a far-off element the question names, past the off-screen limit", () => {
    const el = (id: string, text: string, y: number) => ({ id, kind: "text", text, box: [0, y, 100, 20] as [number, number, number, number] });
    const below = Array.from({ length: OFFSCREEN_KEPT + 10 }, (_, i) => el(`e${100 + i}`, "filler paragraph", 900 + i * 40));
    const far = el("e999", "…Anthropic's Claude escaped its test environment…", 5000);
    const kept = compactElements({ size: { w: 1280, h: 800 }, elements: [...below, far], question: "point me to Anthropic" });
    expect(kept.map((e) => e.id)).toContain("e999");
    expect(compactElements({ size: { w: 1280, h: 800 }, elements: [...below, far], question: "what is this" }).map((e) => e.id)).not.toContain("e999");
  });
});

describe("news for show me", () => {
  it("fetches for the company the question names, then the page's own", () => {
    const elements = [{ id: "e1", kind: "heading", text: "Google's Gemini AI hacked three companies in security test", box: [0, 0, 100, 20] as [number, number, number, number] }];
    expect(explainCompanies({ question: "point me to Anthropic", title: "Google's Gemini AI hacked three companies", elements }).map((c) => c.ticker)).toEqual(["ANTHROPIC", "GOOGL"]);
    expect(explainCompanies({ question: "what does this chart show", title: "", elements: [] })).toEqual([]);
  });
  it("labels headlines as outside the page and forbids drawing them", () => {
    expect(newsBlock([])).toBe("");
    const out = newsBlock([{ company: "Anthropic", headlines: [{ title: "Anthropic raises funds", source: "Reuters", url: "u", publishedAt: "2026-09-18T10:00:00Z" }] }]);
    expect(out).toContain("not from this page");
    expect(out).toContain("never draw marks for them");
    expect(out).toContain("- Anthropic: [Reuters] Anthropic raises funds (2026-09-18)");
  });
});

describe("request limits", () => {
  it("trims page text that runs long instead of rejecting the request", () => {
    // A BBC photo's alt text (186 characters) used to fail every "show me" at the top of the article.
    const caption = "Getty Images A close-up shot of the Gemini application on a black screen. The icon is a white square with a four-point star in Google's colours, under which the word 'Gemini' is printed.";
    const r = ExplainInputSchema.safeParse({ question: "q".repeat(900), url: "https://x", size: { w: 1280, h: 800 }, elements: [{ id: "e1", kind: "image", text: caption, box: [0, 0, 10, 10] }] });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.elements[0]!.text).toHaveLength(160);
    expect(r.data.question).toHaveLength(500);
  });
});

describe("leanElements (the lean map)", () => {
  const el = (id: string, kind: string, text: string, x: number, y: number, w = 60, h = 20) => ({ id, kind, text, box: [x, y, w, h] as [number, number, number, number] });
  it("drops repeated banner copies, small icons and a ticker tape's tail, keeping controls and question matches", () => {
    const tape = Array.from({ length: 20 }, (_, i) => el(`t${i}`, "link", `TOKEN${i} +${i}%`, i * 60, 69));
    const buttons = ["1m", "5m", "15m", "1h", "4h", "1D", "1W", "1M", "3M", "6M", "1Y", "ALL", "5Y", "Log"].map((t, i) => el(`b${i}`, "button", t, i * 40, 120, 36, 20));
    const out = leanElements(
      [el("a1", "link", "Explore Now! →", 0, 5), el("a2", "link", "Explore Now! →", 300, 5), el("i1", "image", "Birdeye", 10, 30, 24, 24), el("i2", "image", "Revenue chart", 10, 300, 600, 300), ...tape, el("t99", "link", "Nvidia +3%", 1200, 69), ...buttons],
      ["nvidia"],
    ).map((e) => e.id);
    expect(out).toContain("a1");
    expect(out).not.toContain("a2");
    expect(out).not.toContain("i1");
    expect(out).toContain("i2");
    expect(out.filter((id) => id.startsWith("t") && id !== "t99")).toHaveLength(12);
    expect(out).toContain("t99");
    expect(out.filter((id) => id.startsWith("b"))).toHaveLength(14);
  });
});

describe("explainRequest", () => {
  it("sends the lean map written with spaces, and can still build the older maps for the replay", () => {
    const copy = { id: "e6", kind: "heading", text: "Nvidia shares jump 4% after Blackwell demand", box: [40, 700, 900, 48] };
    const withCopy = ExplainInputSchema.parse({ ...input, url: "https://example.com/a", title: "Nvidia", question: "what is this", elements: [...input.elements, copy] });
    const prod = explainRequest(withCopy).args;
    expect(prod.mapFormat).toBe("spaces");
    expect(prod.elementMap.split("\n")[0]).toBe("e1 heading 40,80,900,48 Nvidia shares jump 4% after Blackwell demand");
    expect(prod.elementMap).not.toContain("e6");
    const old = explainRequest(withCopy, { mapFormat: "pipes", lean: false }).args;
    expect(old.mapFormat).toBe("pipes");
    expect(old.elementMap).toContain("e6 | heading");
  });
});
