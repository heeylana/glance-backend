import { describe, expect, it } from "vitest";
import { checkSession } from "./session.js";

const now = new Date("2026-09-14T12:00:00Z");
const future = new Date(now.getTime() + 3_600_000);
const past = new Date(now.getTime() - 1);

describe("checkSession", () => {
  it("ok with an unexpired signer", () => {
    expect(checkSession({ paused: false, signerId: "s1", signerExpiresAt: future }, now)).toEqual({ ok: true });
  });
  it("paused beats everything", () => {
    expect(checkSession({ paused: true, signerId: "s1", signerExpiresAt: future }, now)).toEqual({ ok: false, code: "SESSION_PAUSED" });
    expect(checkSession({ paused: true, signerId: null, signerExpiresAt: null }, now)).toEqual({ ok: false, code: "SESSION_PAUSED" });
  });
  it("no signer → NO_SESSION", () => {
    expect(checkSession({ paused: false, signerId: null, signerExpiresAt: null }, now)).toEqual({ ok: false, code: "NO_SESSION" });
  });
  it("expired signer → SESSION_EXPIRED (inclusive at the boundary)", () => {
    expect(checkSession({ paused: false, signerId: "s1", signerExpiresAt: past }, now)).toEqual({ ok: false, code: "SESSION_EXPIRED" });
    expect(checkSession({ paused: false, signerId: "s1", signerExpiresAt: now }, now)).toEqual({ ok: false, code: "SESSION_EXPIRED" });
  });
});
