import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { normalizeImage, overlaySvg, parseDataUrl, sanitizeMarks, type ImageMark } from "./images.js";
import type { ImageChart } from "./llm.js";

const chart: ImageChart = { ticker: "TSLA", name: "Tesla", timeframe: "1D", from: 258, to: 241, plot: { x: 40, y: 60, w: 700, h: 400 }, ticks: [{ price: 260, y: 80 }, { price: 240, y: 440 }], levels: [], describe: "" };

describe("parseDataUrl", () => {
  it("reads mime and bytes, and refuses anything else", () => {
    const p = parseDataUrl("data:image/png;base64,aGVsbG8=");
    expect(p?.mime).toBe("image/png");
    expect(p?.bytes.toString()).toBe("hello");
    expect(parseDataUrl("hello")).toBeNull();
    expect(parseDataUrl("data:text/plain;base64,aGVsbG8=")?.mime).toBe("text/plain");
  });
});

describe("normalizeImage", () => {
  it("keeps the orientation EXIF asked for, strips metadata, and caps the long edge", async () => {
    // 3000×1000 with orientation 6 (rotate 90° clockwise): the stored copy must be portrait and ≤ 2000 tall.
    const src = await sharp({ create: { width: 3000, height: 1000, channels: 3, background: "#5b8cff" } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const out = await normalizeImage(src, "image/jpeg");
    expect(out.mime).toBe("image/jpeg");
    expect(out.height).toBeGreaterThan(out.width);
    expect(out.height).toBe(2000);
    const meta = await sharp(out.bytes).metadata();
    expect(meta.orientation ?? 1).toBe(1);
    expect(meta.exif).toBeUndefined();
  });
  it("re-encodes a PNG as JPEG without enlarging it", async () => {
    const src = await sharp({ create: { width: 300, height: 200, channels: 4, background: "#000" } }).png().toBuffer();
    const out = await normalizeImage(src, "image/png");
    expect([out.width, out.height]).toEqual([300, 200]);
  });
});

describe("sanitizeMarks", () => {
  it("drops marks off the image, clamps the rest, and caps at eight", () => {
    const marks: ImageMark[] = [
      { kind: "ring", box: { x: 10, y: 10, w: 100, h: 40 } },
      { kind: "ring", box: { x: 900, y: 10, w: 100, h: 40 } },
      { kind: "box", box: { x: 760, y: 500, w: 100, h: 100 } },
      { kind: "label", box: { x: 10, y: 10, w: 100, h: 40 }, text: null },
      { kind: "level", price: 250 },
      { kind: "level", price: 999 },
      ...Array.from({ length: 10 }, (_, i) => ({ kind: "number" as const, box: { x: i * 10, y: 5, w: 20, h: 20 }, n: i })),
    ];
    const kept = sanitizeMarks(marks, 800, 600, chart);
    expect(kept.length).toBe(8);
    expect(kept[0]).toMatchObject({ kind: "ring" });
    expect(kept[1]).toMatchObject({ kind: "box", box: { x: 760, y: 500, w: 40, h: 100 } });
    expect(kept[2]).toMatchObject({ kind: "level", price: 250 });
    expect(kept.find((m) => m.kind === "label")).toBeUndefined();
    expect(kept.filter((m) => m.kind === "number").every((m) => (m.n ?? 0) >= 1 && (m.n ?? 0) <= 9)).toBe(true);
  });
  it("a level needs a chart with an axis", () => {
    expect(sanitizeMarks([{ kind: "level", price: 250 }], 800, 600, null)).toEqual([]);
  });
});

describe("overlaySvg", () => {
  it("is the image's size and draws each mark", () => {
    const svg = overlaySvg(800, 600, [{ kind: "ring", box: { x: 100, y: 100, w: 200, h: 50 }, text: "Nvidia" }, { kind: "arrow", box: { x: 400, y: 300, w: 60, h: 30 } }, { kind: "level", price: 250, text: "support" }], chart);
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"')).toBe(true);
    expect(svg.match(/<path /g)?.length).toBe(4);
    expect(svg).toContain("Nvidia");
    expect(svg).toContain("support $250");
    expect(svg).toContain("stroke-dasharray");
  });
  it("escapes label text", () => {
    expect(overlaySvg(100, 100, [{ kind: "label", box: { x: 1, y: 1, w: 10, h: 10 }, text: "<b>&" }], null)).toContain("&lt;b&gt;&amp;");
  });
  it("composites onto an image through sharp", async () => {
    const base = await sharp({ create: { width: 400, height: 300, channels: 3, background: "#fff" } }).jpeg().toBuffer();
    const svg = Buffer.from(overlaySvg(400, 300, [{ kind: "ring", box: { x: 50, y: 50, w: 100, h: 40 } }], null));
    const out = await sharp(base).composite([{ input: svg, top: 0, left: 0 }]).jpeg().toBuffer({ resolveWithObject: true });
    expect([out.info.width, out.info.height]).toEqual([400, 300]);
    const stats = await sharp(out.data).stats();
    // Something blue landed on the white: the mean of the blue channel sits above the red one.
    expect(stats.channels[2]!.mean).toBeGreaterThan(stats.channels[0]!.mean);
  });
});
