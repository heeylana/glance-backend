import { describe, expect, it } from "vitest";
import { checkCaps, spentInWindow, DAY_MS } from "./caps.js";
import { usdToUsdc } from "../lib/amounts.js";

const $ = usdToUsdc;

describe("checkCaps", () => {
  it("passes inside both caps", () => {
    const r = checkCaps({ amountIn: $(10), perTxCap: $(20), dailyCap: $(20), spentInWindow: $(5) });
    expect(r).toEqual({ ok: true, remainingAfter: $(5) });
  });
  it("rejects over per-tx cap", () => {
    const r = checkCaps({ amountIn: $(25), perTxCap: $(20), dailyCap: $(100), spentInWindow: 0n });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("OVER_PER_TX_CAP");
  });
  it("rejects over daily cap and reports the remainder (spec: 'Buy $8 now')", () => {
    const r = checkCaps({ amountIn: $(10), perTxCap: $(20), dailyCap: $(20), spentInWindow: $(12) });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("OVER_DAILY_CAP");
      expect(r.remaining).toBe($(8));
    }
  });
  it("allows exactly reaching the daily cap", () => {
    const r = checkCaps({ amountIn: $(8), perTxCap: $(20), dailyCap: $(20), spentInWindow: $(12) });
    expect(r.ok).toBe(true);
  });
  it("rejects zero and negative amounts", () => {
    expect(checkCaps({ amountIn: 0n, perTxCap: $(20), dailyCap: $(20), spentInWindow: 0n }).ok).toBe(false);
    expect(checkCaps({ amountIn: -1n, perTxCap: $(20), dailyCap: $(20), spentInWindow: 0n }).ok).toBe(false);
  });
});

describe("spentInWindow", () => {
  const now = new Date("2026-09-14T12:00:00Z");
  const at = (msAgo: number) => new Date(now.getTime() - msAgo);
  it("sums pending and confirmed inside the window, ignores failed and old rows", () => {
    const rows = [
      { amountIn: $(5), createdAt: at(1000), status: "confirmed" as const },
      { amountIn: $(3), createdAt: at(60_000), status: "pending" as const },
      { amountIn: $(7), createdAt: at(120_000), status: "failed" as const },
      { amountIn: $(9), createdAt: at(DAY_MS + 1), status: "confirmed" as const },
    ];
    expect(spentInWindow(rows, now)).toBe($(8));
  });
  it("window boundary: a row exactly 24h old has rolled off", () => {
    const rows = [{ amountIn: $(5), createdAt: at(DAY_MS), status: "confirmed" as const }];
    expect(spentInWindow(rows, now)).toBe(0n);
    const rows2 = [{ amountIn: $(5), createdAt: at(DAY_MS - 1), status: "confirmed" as const }];
    expect(spentInWindow(rows2, now)).toBe($(5));
  });
});
