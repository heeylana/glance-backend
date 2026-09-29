import { describe, expect, it } from "vitest";
import type { MintEntry } from "../config/issuers.js";
import { judgeMock, type OnChainMock } from "./harvest.js";

const ISSUER = "AqCFNAyNgMfmCyRnmWtPWvLKvL4sgzUEhggFjyzCeFPW";
const META: MintEntry = { mint: "Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu", ticker: "META", symbol: "METAx", name: "Meta xStock", issuer: "xStocks", kind: "stock", decimals: 8, tokenProgram: "token-2022", issuerDelegate: "5aMNNLQJwAEeoemTEMkv5NVjqKwvvefRYCQ5Z67HFvEq" };
const TESSERA: MintEntry = { ...META, mint: "tesseraMETA", symbol: "METAt", name: "Meta Tessera", issuer: "Tessera", decimals: 9, issuerDelegate: null };
const catalog = [META, TESSERA];

const mock = (over: Partial<OnChainMock> = {}): OnChainMock => ({
  mint: "MockMint111",
  owner: "token-2022",
  decimals: 8,
  mintAuthority: ISSUER,
  permanentDelegate: ISSUER,
  metadata: { name: "Meta xStock (mock)", symbol: "METAx", updateAuthority: ISSUER },
  allowed: { mint: "MockMint111", issuerDelegate: ISSUER },
  ...over,
});

describe("judgeMock", () => {
  it("rebuilds the entry exactly as recordMock writes it, key order included", () => {
    const v = judgeMock(mock(), catalog, ISSUER);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(JSON.stringify(v.entry)).toBe(
      JSON.stringify({ ticker: "META", issuer: "xStocks", decimals: 8, tokenProgram: "token-2022", referenceMint: META.mint, issuerDelegate: ISSUER }),
    );
  });

  it("expects no delegate for a curation-only listing", () => {
    const m = mock({ decimals: 9, permanentDelegate: null, metadata: { name: "Meta Tessera (mock)", symbol: "METAt", updateAuthority: ISSUER }, allowed: { mint: "MockMint111", issuerDelegate: null } });
    const v = judgeMock(m, catalog, ISSUER);
    expect(v.ok && v.entry).toMatchObject({ issuer: "Tessera", issuerDelegate: null, referenceMint: "tesseraMETA" });
  });

  it.each([
    ["an SPL Token mint", mock({ owner: "spl-token" }), /Token-2022/],
    ["a symbol no listing has", mock({ metadata: { name: "x", symbol: "NOPE", updateAuthority: ISSUER } }), /matches no catalog listing/],
    ["the wrong decimals", mock({ decimals: 6 }), /decimals 6/],
    ["someone else's delegate", mock({ permanentDelegate: "Other111" }), /permanent delegate Other111/],
    ["another mint authority", mock({ mintAuthority: "Other111" }), /mint authority/],
    ["no AllowedMint", mock({ allowed: null }), /no AllowedMint/],
    ["an AllowedMint with another rule", mock({ allowed: { mint: "MockMint111", issuerDelegate: null } }), /AllowedMint issuer rule/],
  ])("rejects %s", (_, m, reason) => {
    const v = judgeMock(m, catalog, ISSUER);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reasons.join(" ")).toMatch(reason);
  });

  it("refuses a symbol that names two listings it cannot tell apart", () => {
    const v = judgeMock(mock({ metadata: { name: "renamed", symbol: "METAx", updateAuthority: ISSUER } }), [META, { ...META, mint: "other", issuer: "PreStocks" }], ISSUER);
    expect(v.ok).toBe(false);
  });
});
