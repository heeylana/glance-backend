import { describe, expect, it } from "vitest";
import { classifySwapDirection, verifyIssuer, type IssuerRule, type MintFacts } from "./issuer.js";

const USDC = "USDC1111111111111111111111111111111111111111";
const ISSUER_AUTH = "Backed11111111111111111111111111111111111111";
const facts = (over: Partial<MintFacts>): MintFacts => ({
  mint: "AAPLx111111111111111111111111111111111111111",
  tokenProgram: "token-2022",
  decimals: 8,
  mintAuthority: null,
  freezeAuthority: null,
  metadataUpdateAuthority: null,
  permanentDelegate: null,
  uiMultiplier: 1,
  ...over,
});
const rules: IssuerRule[] = [
  { issuer: "xStocks", method: "metadata_update_authority", address: ISSUER_AUTH },
  { issuer: "mock", method: "mint_allowlist", address: "MOCK1111111111111111111111111111111111111111" },
];

describe("verifyIssuer", () => {
  it("accepts a mint whose metadata update authority is a registered issuer", () => {
    expect(verifyIssuer(facts({ metadataUpdateAuthority: ISSUER_AUTH }), rules)).toEqual({ ok: true, issuer: "xStocks", method: "metadata_update_authority" });
  });
  it("rejects a lookalike with the right name but an unknown authority", () => {
    expect(verifyIssuer(facts({ metadataUpdateAuthority: "Scam1111111111111111111111111111111111111111" }), rules).ok).toBe(false);
  });
  it("does not let the wrong authority type satisfy a rule (mint authority ≠ metadata authority)", () => {
    expect(verifyIssuer(facts({ mintAuthority: ISSUER_AUTH }), rules).ok).toBe(false);
  });
  it("accepts an exact allowlisted mint", () => {
    expect(verifyIssuer(facts({ mint: "MOCK1111111111111111111111111111111111111111" }), rules).ok).toBe(true);
  });
  it("rejects when no rules", () => {
    expect(verifyIssuer(facts({ metadataUpdateAuthority: ISSUER_AUTH }), []).ok).toBe(false);
  });
});

describe("classifySwapDirection", () => {
  const stock = facts({ metadataUpdateAuthority: ISSUER_AUTH });
  it("USDC → issuer stock is a buy", () => {
    expect(classifySwapDirection({ mint: USDC, facts: null }, { mint: stock.mint, facts: stock }, [USDC], rules)).toEqual({ ok: true, side: "buy", issuer: "xStocks" });
  });
  it("issuer stock → USDC is a sell", () => {
    expect(classifySwapDirection({ mint: stock.mint, facts: stock }, { mint: USDC, facts: null }, [USDC], rules)).toEqual({ ok: true, side: "sell", issuer: "xStocks" });
  });
  it("USDC → junk is rejected as not-issuer", () => {
    const junk = facts({ mint: "JUNK1111111111111111111111111111111111111111" });
    expect(classifySwapDirection({ mint: USDC, facts: null }, { mint: junk.mint, facts: junk }, [USDC], rules)).toEqual({ ok: false, code: "OUTPUT_MINT_NOT_ISSUER" });
  });
  it("stock → stock and USDC → USDC are rejected", () => {
    expect(classifySwapDirection({ mint: stock.mint, facts: stock }, { mint: stock.mint, facts: stock }, [USDC], rules).ok).toBe(false);
    expect(classifySwapDirection({ mint: USDC, facts: null }, { mint: USDC, facts: null }, [USDC], rules).ok).toBe(false);
  });
  it("non-stable input to a non-stable output → INPUT_MINT_NOT_STABLE", () => {
    const r = classifySwapDirection({ mint: "SOL", facts: null }, { mint: stock.mint, facts: stock }, [USDC], rules);
    expect(r).toEqual({ ok: false, code: "INPUT_MINT_NOT_STABLE" });
  });
});
