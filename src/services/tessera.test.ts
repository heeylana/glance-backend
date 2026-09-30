import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tesseraTokens } from "./tessera.js";

/** One row as Tessera's public endpoint actually serves it. */
const ROW = {
  id: "T-OpenAI",
  name: "T-OpenAI",
  symbol: "T-OpenAI",
  code: "tOpenAI",
  sector: "Artificial Intelligence",
  mint: "oPAiAikWTaFj9RYoRFD35ccfwhnMcB3ThgBZRHSkjTZ",
  markPrice: 812.79,
  holders: 14693,
  markValuation: 950000000000,
};

const answer = (body: unknown, ok = true, status = 200) =>
  vi.fn(async () => ({ ok, status, json: async () => body }) as unknown as Response);

/**
 * The cache lives in the module, so it survives between tests here. Rather than exporting a reset hatch that only
 * tests would ever call, each test starts an hour after the last one: anything cached by the previous test is long
 * stale by then, which is also closer to how the process really runs.
 */
let now = Date.parse("2026-09-30T00:00:00Z");

beforeEach(() => {
  vi.useFakeTimers();
  now += 3_600_000;
  vi.setSystemTime(now);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the issuer's own mark", () => {
  it("reads a token row, keyed by its mint", async () => {
    vi.stubGlobal("fetch", answer([ROW]));
    const tokens = await tesseraTokens();
    expect(tokens.get(ROW.mint)).toEqual({
      mint: ROW.mint,
      symbol: "T-OpenAI",
      markPrice: 812.79,
      holders: 14693,
      markValuation: 950000000000,
      sector: "Artificial Intelligence",
    });
  });

  it("asks the issuer once and serves the rest from cache", async () => {
    const f = answer([ROW]);
    vi.stubGlobal("fetch", f);
    await tesseraTokens();
    await tesseraTokens();
    await tesseraTokens();
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("asks again once the mark is stale", async () => {
    const f = answer([ROW]);
    vi.stubGlobal("fetch", f);
    await tesseraTokens();
    vi.setSystemTime(now + 6 * 60_000);
    await tesseraTokens();
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("skips a row with no mint or no usable mark, and keeps the rest", async () => {
    vi.stubGlobal("fetch", answer([ROW, { ...ROW, mint: undefined }, { ...ROW, mint: "x", markPrice: 0 }, { ...ROW, mint: "y", markPrice: "812" }]));
    const tokens = await tesseraTokens();
    expect([...tokens.keys()]).toEqual([ROW.mint]);
  });

  it("an issuer that cannot be reached is empty, not an error: the card keeps the mark it had", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    await expect(tesseraTokens()).resolves.toEqual(new Map());
  });

  it("a refusal is empty too, and is not cached as if it were an answer", async () => {
    const f = answer({ error: "nope" }, false, 503);
    vi.stubGlobal("fetch", f);
    expect(await tesseraTokens()).toEqual(new Map());
    await tesseraTokens();
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("an answer that is not a list is empty rather than nonsense", async () => {
    vi.stubGlobal("fetch", answer({ tokens: [ROW] }));
    expect(await tesseraTokens()).toEqual(new Map());
  });
});
