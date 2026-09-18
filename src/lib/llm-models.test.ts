import { describe, expect, it } from "vitest";
import { effortParam, fallbackParams, ratesFor, usageCostUsd } from "./llm-models.js";

describe("ratesFor", () => {
  it("knows the models Glance can run on, including dated ids", () => {
    expect(ratesFor("claude-opus-5")?.input).toBe(5);
    expect(ratesFor("claude-sonnet-5")?.output).toBe(10);
    expect(ratesFor("claude-haiku-4-5-20251001")?.input).toBe(1);
    expect(ratesFor("claude-fable-5-1")?.cacheRead).toBe(0.25);
    expect(ratesFor("claude-fable-5")?.cacheRead).toBe(1);
  });
  it("returns null for a model without a price", () => {
    expect(ratesFor("gpt-5")).toBeNull();
  });
});

describe("usageCostUsd", () => {
  it("bills each token kind at its own rate", () => {
    // Opus 5: 1,000 uncached in at $5, 2,000 cache writes at $6.25, 3,000 cache reads at $0.50, 400 out at $25 (per million).
    const usd = usageCostUsd("claude-opus-5", { input_tokens: 1000, cache_creation_input_tokens: 2000, cache_read_input_tokens: 3000, output_tokens: 400 });
    expect(usd).toBeCloseTo((1000 * 5 + 2000 * 6.25 + 3000 * 0.5 + 400 * 25) / 1e6, 12);
  });
  it("uses the 1-hour write rate when the breakdown says so", () => {
    const usd = usageCostUsd("claude-sonnet-5", {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 1000,
      cache_creation: { ephemeral_5m_input_tokens: 400, ephemeral_1h_input_tokens: 600 },
    });
    expect(usd).toBeCloseTo((400 * 2.5 + 600 * 4) / 1e6, 12);
  });
  it("is null for an unknown model", () => {
    expect(usageCostUsd("some-other-model", { input_tokens: 10, output_tokens: 10 })).toBeNull();
  });
});

describe("request options per model", () => {
  it("sends refusal fallbacks only to Opus 5 and Fable 5.x", () => {
    expect(fallbackParams("claude-opus-5")).toEqual({ betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" });
    expect(fallbackParams("claude-fable-5-1").fallbacks).toBe("default");
    expect(fallbackParams("claude-sonnet-5")).toEqual({});
    expect(fallbackParams("claude-haiku-4-5")).toEqual({});
  });
  it("sends effort only to models that accept it", () => {
    expect(effortParam("claude-opus-5", "low")).toEqual({ effort: "low" });
    expect(effortParam("claude-sonnet-5", "low")).toEqual({ effort: "low" });
    expect(effortParam("claude-opus-4-8", "medium")).toEqual({ effort: "medium" });
    expect(effortParam("claude-haiku-4-5", "low")).toEqual({});
    expect(effortParam("claude-sonnet-4-5", "low")).toEqual({});
  });
});
