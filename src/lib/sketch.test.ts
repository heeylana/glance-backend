import { describe, expect, it } from "vitest";
import { arrowPaths, arrowStart, boxPoints, edgePoint, extendAcross, notePlacement, polylinePath, priceToY, ringPoints, rng, smoothPath, underlinePoints } from "./sketch.js";

const rect = { x: 100, y: 200, w: 160, h: 40 };
const view = { w: 1280, h: 800 };

describe("rng", () => {
  it("is deterministic per seed", () => {
    const a = rng(7);
    const b = rng(7);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    expect(rng(8)()).not.toBe(rng(7)());
  });
});

describe("smoothPath", () => {
  it("starts at the first point and ends at the last", () => {
    const d = smoothPath([{ x: 0, y: 0 }, { x: 10, y: 5 }, { x: 20, y: 0 }]);
    expect(d.startsWith("M0,0 C")).toBe(true);
    expect(d.endsWith(" 20,0")).toBe(true);
    expect(d.match(/C/g)).toHaveLength(2);
  });
});

describe("polylinePath", () => {
  it("keeps corners", () => {
    expect(polylinePath([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }])).toBe("M0,0 L10,0 L10,10");
  });
});

describe("ringPoints", () => {
  it("goes all the way round the rect with room to spare, the same way every time", () => {
    const pts = ringPoints(rect, 3);
    expect(pts).toEqual(ringPoints(rect, 3));
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    expect(Math.min(...xs)).toBeLessThan(rect.x);
    expect(Math.max(...xs)).toBeGreaterThan(rect.x + rect.w);
    expect(Math.min(...ys)).toBeLessThan(rect.y);
    expect(Math.max(...ys)).toBeGreaterThan(rect.y + rect.h);
  });
  it("keeps a ring round a wide, short headline close to it", () => {
    const wide = { x: 40, y: 100, w: 700, h: 90 };
    const pts = ringPoints(wide, 5);
    expect(Math.min(...pts.map((p) => p.x))).toBeGreaterThan(0);
    expect(Math.max(...pts.map((p) => p.y)) - Math.min(...pts.map((p) => p.y))).toBeLessThan(wide.h * 2 + 60);
  });
});

describe("boxPoints and underlinePoints", () => {
  it("frame the rect and run under it", () => {
    const box = boxPoints(rect, 1);
    expect(box[0]!.x).toBeLessThan(rect.x);
    expect(box[2]!.y).toBeGreaterThan(rect.y + rect.h);
    const under = underlinePoints(rect, 1);
    expect(under[0]!.x).toBeLessThan(rect.x);
    expect(under.at(-1)!.x).toBeGreaterThan(rect.x + rect.w);
    for (const p of under) expect(p.y).toBeGreaterThan(rect.y + rect.h);
  });
});

describe("edgePoint", () => {
  it("stops on the rect's edge plus the gap", () => {
    expect(edgePoint({ x: 180, y: 0 }, rect, 8)).toEqual({ x: 180, y: 192 });
    expect(edgePoint({ x: 0, y: 220 }, rect, 8)).toEqual({ x: 92, y: 220 });
  });
  it("leaves a tail that is already inside the margin alone", () => {
    expect(edgePoint({ x: 105, y: 205 }, rect, 8)).toEqual({ x: 105, y: 205 });
  });
});

describe("arrowStart and arrowPaths", () => {
  it("starts on the side with more room and stays in the viewport", () => {
    const s = arrowStart({ x: 1200, y: 20, w: 60, h: 20 }, view);
    expect(s.x).toBeLessThan(1200);
    expect(s.y).toBeGreaterThan(40);
    const edge = arrowStart({ x: 0, y: 0, w: 1280, h: 800 }, view);
    expect(edge.x).toBeGreaterThanOrEqual(12);
    expect(edge.x).toBeLessThanOrEqual(1268);
  });
  it("ends the shaft and the head at the tip", () => {
    const { shaft, head } = arrowPaths({ x: 0, y: 0 }, { x: 100, y: 100 }, 2);
    expect(shaft.endsWith(" 100,100")).toBe(true);
    expect(head).toContain("L100,100");
  });
});

describe("notePlacement", () => {
  const note = { w: 120, h: 30 };
  it("prefers the right, then the left, then above", () => {
    expect(notePlacement(rect, note, view)).toEqual({ x: 272, y: 205 });
    expect(notePlacement({ x: 1150, y: 200, w: 100, h: 40 }, note, view).x).toBe(1150 - 12 - 120);
    expect(notePlacement({ x: 0, y: 300, w: 1280, h: 40 }, note, view)).toEqual({ x: 4, y: 300 - 12 - 30 });
  });
  it("moves to the next side when the spot is covered, and keeps the first when nothing is clear", () => {
    const bubble = { x: 260, y: 150, w: 400, h: 200 };
    // Right of the rect is under the bubble and left is off screen, so it goes above.
    expect(notePlacement(rect, note, view, [bubble])).toEqual({ x: 100, y: 200 - 12 - 30 });
    const everywhere = { x: 0, y: 0, w: 1280, h: 800 };
    expect(notePlacement(rect, note, view, [everywhere])).toEqual({ x: 272, y: 205 });
  });
});

describe("priceToY and extendAcross", () => {
  it("places a price between, above and below two axis labels", () => {
    const ticks = [{ price: 190, y: 220 }, { price: 160, y: 580 }];
    expect(priceToY(175, ticks)).toBe(400);
    expect(priceToY(195, ticks)).toBe(160);
    expect(priceToY(150, ticks)).toBe(700);
    expect(priceToY(170, [{ price: 170, y: 1 }, { price: 170, y: 9 }])).toBeNull();
  });
  it("extends a trend line to the chart's edges", () => {
    expect(extendAcross({ x: 100, y: 500 }, { x: 200, y: 450 }, { x: 0, y: 0, w: 400, h: 600 })).toEqual([{ x: 0, y: 550 }, { x: 400, y: 350 }]);
  });
});
