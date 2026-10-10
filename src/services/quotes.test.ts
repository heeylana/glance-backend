import { describe, expect, it } from "vitest";
import { newQuoteId, quoteStatus } from "./quotes.js";

describe("quoteStatus", () => {
  const now = new Date("2026-10-08T12:00:00Z");
  const open = { expiresAt: new Date("2026-10-08T12:02:00Z"), executedAt: null, ledgerId: null, failureCode: null };
  it("is open until it expires or is taken", () => {
    expect(quoteStatus(open, now)).toBe("open");
    expect(quoteStatus(open, new Date("2026-10-08T12:02:00Z"))).toBe("expired");
    expect(quoteStatus({ ...open, executedAt: now, ledgerId: 7 }, now)).toBe("executed");
    expect(quoteStatus({ ...open, executedAt: now, failureCode: "quote_moved" }, now)).toBe("failed");
  });
  it("an executed quote is executed even after the two minutes", () => {
    expect(quoteStatus({ ...open, executedAt: now, ledgerId: 7 }, new Date("2026-10-08T13:00:00Z"))).toBe("executed");
  });
  it("ids are random and long", () => {
    expect(newQuoteId()).not.toBe(newQuoteId());
    expect(newQuoteId().length).toBeGreaterThanOrEqual(20);
  });
});
