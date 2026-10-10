import { describe, expect, it } from "vitest";
import { thresholdFor } from "./expiry-scan.js";

describe("thresholdFor", () => {
  const now = Date.parse("2026-10-08T12:00:00Z");
  const at = (h: number) => new Date(now + h * 3_600_000).toISOString();
  it("warns at a day, then an hour, then once lapsed", () => {
    expect(thresholdFor(at(48), true, now)).toBeNull();
    expect(thresholdFor(at(23), true, now)).toBe("24h");
    expect(thresholdFor(at(0.5), true, now)).toBe("1h");
    expect(thresholdFor(at(-1), false, now)).toBe("expired");
  });
  it("says nothing for a vault with no agent at all", () => {
    expect(thresholdFor(null, false, now)).toBeNull();
  });
});
