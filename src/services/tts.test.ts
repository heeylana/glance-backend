import { describe, expect, it } from "vitest";
import { GuardCode, userMessage } from "../lib/errors.js";
import { normalizeSpeech, ttsEnabled, ttsKey, TTS_MAX_CHARS, WARM_LINES, warmTts } from "./tts.js";

describe("normalizeSpeech", () => {
  it("collapses whitespace and softens the em dash", () => {
    expect(normalizeSpeech("  That didn't go through — nothing was spent.  ")).toBe("That didn't go through, nothing was spent.");
  });
  it("caps the length", () => {
    expect(normalizeSpeech("a".repeat(1000)).length).toBe(TTS_MAX_CHARS);
  });
});

describe("ttsKey", () => {
  it("is stable across whitespace and case, and differs per text", () => {
    expect(ttsKey("Glance is paused.")).toBe(ttsKey("  glance   is paused. "));
    expect(ttsKey("Glance is paused.")).not.toBe(ttsKey("Glance is offline."));
    expect(ttsKey("x")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("long spoken lines", () => {
  it("fits a whole four-part read, which used to fall back to the browser voice", () => {
    // The read Glance gives for "what do you think of Nvidia?" runs past 500 characters.
    const read =
      "Nvidia up 1.7% today. CEO Jensen Huang is in focus for comments on AI safety and chip demand doubling next year. " +
      "CEO projects chip sales doubling next year and says AI demand remains strong despite slowdown talk. " +
      "Some analysts worry an AI bubble is forming, and one ETF is betting winners emerge elsewhere. " +
      "Whether Nvidia's revenue actually doubles next year or if AI demand softens as some fear. " +
      "That's not advice, though — I'm not an analyst, so do your own research before you buy.";
    expect(read.length).toBeGreaterThan(400);
    expect(normalizeSpeech(read).length).toBe(read.replace(/\s*[—–]\s*/g, ", ").length);
  });

  it("cuts an over-long line at a sentence, not mid-word", () => {
    const line = `${"Nvidia rose again today. ".repeat(60)}And then something else happened.`;
    const said = normalizeSpeech(line);
    expect(said.length).toBeLessThanOrEqual(TTS_MAX_CHARS);
    expect(said.endsWith(".")).toBe(true);
  });
});

describe("warm lines", () => {
  it("never carry a number or a company name", () => {
    for (const line of WARM_LINES) expect(line).not.toMatch(/[0-9$]|that company/);
  });

  it("are the lines the backend actually says, so the warmed cache is hit", () => {
    const said = new Set(Object.values(GuardCode).map((c) => ttsKey(userMessage(c))));
    for (const line of WARM_LINES) expect(said.has(ttsKey(line)), line).toBe(true);
  });

  it.skipIf(ttsEnabled())("warming never throws, and does nothing without a key", async () => {
    await expect(warmTts()).resolves.toEqual({ warmed: 0, failed: [] });
  });
});
