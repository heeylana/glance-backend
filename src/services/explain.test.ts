import { describe, expect, it } from "vitest";
import { compactElements, earlierSteps, elementMap, memoryBlock, OFFSCREEN_KEPT, quoteFits, sanitizeAction, sanitizeChart, sanitizeExplanation, type ExplainInput } from "./explain.js";
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
