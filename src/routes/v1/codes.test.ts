import { describe, expect, it } from "vitest";
import { GuardCode, GuardError } from "../../lib/errors.js";
import { API_OWN, ApiError, GUARD_TO_API, refusalOf } from "./codes.js";

describe("code mapping", () => {
  it("covers every guard code with a snake_case API code", () => {
    for (const code of Object.values(GuardCode)) {
      expect(GUARD_TO_API[code], code).toMatch(/^[a-z_]+$/);
    }
  });
  it("the spec's codes are there with a sentence each", () => {
    expect(GUARD_TO_API.OVER_DAILY_CAP).toBe("leash_exceeded");
    expect(GUARD_TO_API.OUTPUT_MINT_NOT_ISSUER).toBe("mint_not_curated");
    expect(GUARD_TO_API.SESSION_EXPIRED).toBe("agent_expired");
    for (const k of ["not_bound", "quote_expired", "quote_used", "quote_moved"] as const) expect(API_OWN[k].message.length).toBeGreaterThan(10);
  });
  it("a guard rejection keeps its plain line and carries the remaining amount", () => {
    const r = refusalOf(new GuardError(GuardCode.OVER_DAILY_CAP, { dailyCapUsd: 20, remainingUsd: 8 }));
    expect(r?.status).toBe(422);
    expect(r?.body.code).toBe("leash_exceeded");
    expect(r?.body.message).toContain("$8");
    expect(r?.body.detail).toEqual({ remaining_today_usd: "8.00", daily_cap_usd: "20.00" });
  });
  it("an API refusal carries its own status and sentence", () => {
    const r = refusalOf(new ApiError("quote_expired", { quote: { id: 1 } }));
    expect(r).toEqual({ status: 409, body: { ok: false, code: "quote_expired", message: API_OWN.quote_expired.message, detail: { quote: { id: 1 } } } });
    expect(refusalOf(new Error("boom"))).toBeNull();
  });
});
