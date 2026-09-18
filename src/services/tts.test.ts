import { describe, expect, it } from "vitest";
import { normalizeSpeech, ttsKey, TTS_MAX_CHARS } from "./tts.js";

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
