import { describe, expect, it } from "vitest";
import { vaultStatusOf } from "./connect.js";

describe("vaultStatusOf", () => {
  const now = Date.parse("2026-10-08T12:00:00Z");
  const at = (h: number) => new Date(now + h * 3_600_000).toISOString();
  it("tells the page what to do next", () => {
    expect(vaultStatusOf({ exists: false, agentActive: false, agentExpiresAt: null }, now)).toBe("none");
    expect(vaultStatusOf({ exists: true, agentActive: false, agentExpiresAt: at(-2) }, now)).toBe("agent_missing");
    expect(vaultStatusOf({ exists: true, agentActive: true, agentExpiresAt: at(12) }, now)).toBe("agent_expiring");
    expect(vaultStatusOf({ exists: true, agentActive: true, agentExpiresAt: at(100) }, now)).toBe("exists");
  });
});
