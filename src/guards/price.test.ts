import { describe, expect, it } from "vitest";
import { checkQuoteAgainstPyth, impliedUsdPerShare } from "./price.js";

const now = 1_800_000_000;
const pyth = (usd: number, ageSec = 5) => ({
  price: BigInt(Math.round(usd * 1e8)),
  expo: -8,
  conf: 1000n,
  publishTime: now - ageSec,
});
const base = {
  nowSec: now,
  maxDeviationBps: 100,
  maxAgeSec: 300,
  stalePolicy: "widen" as const,
  staleDeviationBps: 300,
  stockDecimals: 8,
};

describe("impliedUsdPerShare", () => {
  it("buy: $10 USDC for 0.0432 shares → ~$231.48", () => {
    const v = impliedUsdPerShare({ side: "buy", inAmount: 10_000_000n, outAmount: 4_320_000n, stockDecimals: 8 });
    expect(v).toBeCloseTo(231.48, 1);
  });
  it("sell: 0.05 shares for $11.55 → $231", () => {
    const v = impliedUsdPerShare({ side: "sell", inAmount: 5_000_000n, outAmount: 11_550_000n, stockDecimals: 8 });
    expect(v).toBeCloseTo(231, 5);
  });
});

describe("checkQuoteAgainstPyth", () => {
  it("passes when quote is within 1% of Pyth", () => {
    // $10 → shares at $232 while Pyth says $231 (0.43%)
    const out = BigInt(Math.round((10 / 232) * 1e8));
    const r = checkQuoteAgainstPyth({ ...base, side: "buy", inAmount: 10_000_000n, outAmount: out, pyth: pyth(231) });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.stale).toBe(false);
  });
  it("rejects when quote is more than 1% off Pyth", () => {
    const out = BigInt(Math.round((10 / 236) * 1e8)); // 2.2% worse
    const r = checkQuoteAgainstPyth({ ...base, side: "buy", inAmount: 10_000_000n, outAmount: out, pyth: pyth(231) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("PRICE_DEVIATION");
  });
  it("stale feed + widen policy: 2.2% passes inside the 3% band and is flagged stale", () => {
    const out = BigInt(Math.round((10 / 236) * 1e8));
    const r = checkQuoteAgainstPyth({ ...base, side: "buy", inAmount: 10_000_000n, outAmount: out, pyth: pyth(231, 3600) });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.stale).toBe(true);
  });
  it("stale feed + reject policy → PRICE_UNAVAILABLE", () => {
    const out = BigInt(Math.round((10 / 231) * 1e8));
    const r = checkQuoteAgainstPyth({ ...base, stalePolicy: "reject", side: "buy", inAmount: 10_000_000n, outAmount: out, pyth: pyth(231, 3600) });
    expect(r).toEqual({ ok: false, code: "PRICE_UNAVAILABLE" });
  });
  it("sell side is checked symmetrically", () => {
    const usdcOut = BigInt(Math.round(0.05 * 226 * 1e6)); // selling 0.05 sh at $226 vs Pyth $231 = 2.2% off
    const r = checkQuoteAgainstPyth({ ...base, side: "sell", inAmount: 5_000_000n, outAmount: usdcOut, pyth: pyth(231) });
    expect(r.ok).toBe(false);
  });
  it("zero or negative Pyth price → PRICE_UNAVAILABLE", () => {
    const r = checkQuoteAgainstPyth({ ...base, side: "buy", inAmount: 1n, outAmount: 1n, pyth: { ...pyth(0), price: 0n } });
    expect(r).toEqual({ ok: false, code: "PRICE_UNAVAILABLE" });
  });
});
