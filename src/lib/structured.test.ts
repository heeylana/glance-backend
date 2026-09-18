import { describe, expect, it } from "vitest";
import { z } from "zod";
import { clipText, fitToSchema } from "./structured.js";

describe("clipText", () => {
  it("leaves short text alone", () => {
    expect(clipText("Apple is up.", 50)).toBe("Apple is up.");
  });
  it("cuts at a sentence end when one is near the limit", () => {
    const s = "Nvidia rose four percent after earnings. Analysts cite data centre demand and more";
    expect(clipText(s, 60)).toBe("Nvidia rose four percent after earnings.");
  });
  it("otherwise cuts at a word boundary, within the limit", () => {
    const s = "RTX 5090 is a graphics card made by Nvidia under its GeForce brand for gamers";
    const out = clipText(s, 50);
    expect(out.length).toBeLessThanOrEqual(50);
    expect(s.startsWith(out)).toBe(true);
    expect(out.endsWith(" ")).toBe(false);
    expect(out).toBe("RTX 5090 is a graphics card made by Nvidia under");
  });
});

describe("fitToSchema", () => {
  const Pick = z.object({ companyId: z.string().nullable(), confidence: z.number().min(0).max(1), reason: z.string().max(40) });

  it("passes valid answers through untouched", () => {
    expect(fitToSchema(Pick, { companyId: "nvo", confidence: 0.9, reason: "Ozempic maker." })).toEqual({
      ok: true,
      data: { companyId: "nvo", confidence: 0.9, reason: "Ozempic maker." },
      clipped: [],
    });
  });

  it("clips an over-long string instead of losing the answer", () => {
    const r = fitToSchema(Pick, { companyId: "nvo", confidence: 0.95, reason: "The Ozempic company refers to Novo Nordisk, maker of Ozempic, and the post is about its earnings." });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.companyId).toBe("nvo");
    expect(r.data.reason.length).toBeLessThanOrEqual(40);
    expect(r.clipped).toEqual(["reason"]);
  });

  it("clamps numbers into range", () => {
    const r = fitToSchema(Pick, { companyId: null, confidence: 1.2, reason: "x" });
    expect(r).toMatchObject({ ok: true, data: { confidence: 1 }, clipped: ["confidence"] });
  });

  it("trims nested lists and strings in one go", () => {
    const Explanation = z.object({
      segments: z.array(z.object({ say: z.string().max(20), marks: z.array(z.string()).max(2) })).max(2),
    });
    const r = fitToSchema(Explanation, {
      segments: [
        { say: "Here is the price line on the chart.", marks: ["a", "b", "c"] },
        { say: "ok", marks: [] },
        { say: "extra", marks: [] },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.segments).toHaveLength(2);
    expect(r.data.segments[0]!.say.length).toBeLessThanOrEqual(20);
    expect(r.data.segments[0]!.marks).toEqual(["a", "b"]);
  });

  it("still fails on what it can't fix", () => {
    expect(fitToSchema(Pick, { companyId: "nvo", reason: "missing confidence" }).ok).toBe(false);
    expect(fitToSchema(z.object({ kind: z.enum(["buy", "sell"]) }), { kind: "hold" }).ok).toBe(false);
  });

  it("does not modify the input", () => {
    const input = { companyId: "nvo", confidence: 2, reason: "x" };
    fitToSchema(Pick, input);
    expect(input.confidence).toBe(2);
  });
});
