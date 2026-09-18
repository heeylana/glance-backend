import { GuardCode } from "../lib/errors.js";

/**
 * Spec §8.3 guard 3: the output mint must be genuinely from a recognised
 * tokenized-stock issuer. Which authority proves that differs per issuer
 * (mint authority vs Token-2022 metadata update authority vs permanent delegate),
 * so the registry carries the method alongside the address. `mint_allowlist`
 * pins exact mints and is what the demo uses on devnet.
 */
export type IssuerMethod = "mint_authority" | "metadata_update_authority" | "permanent_delegate" | "mint_allowlist";

export interface IssuerRule {
  issuer: string;
  method: IssuerMethod;
  /** Authority pubkey for the authority methods; the mint itself for mint_allowlist. */
  address: string;
}

export interface MintFacts {
  mint: string;
  tokenProgram: "spl-token" | "token-2022";
  decimals: number;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  metadataUpdateAuthority: string | null;
  permanentDelegate: string | null;
  /** Token-2022 scaled-UI multiplier (xStocks use it for corporate actions); 1 when absent. */
  uiMultiplier: number;
}

export type IssuerResult =
  | { ok: true; issuer: string; method: IssuerMethod }
  | { ok: false; code: typeof GuardCode.OUTPUT_MINT_NOT_ISSUER };

export function verifyIssuer(facts: MintFacts, rules: IssuerRule[]): IssuerResult {
  for (const r of rules) {
    switch (r.method) {
      case "mint_allowlist":
        if (r.address === facts.mint) return { ok: true, issuer: r.issuer, method: r.method };
        break;
      case "mint_authority":
        if (facts.mintAuthority && facts.mintAuthority === r.address) return { ok: true, issuer: r.issuer, method: r.method };
        break;
      case "metadata_update_authority":
        if (facts.metadataUpdateAuthority && facts.metadataUpdateAuthority === r.address)
          return { ok: true, issuer: r.issuer, method: r.method };
        break;
      case "permanent_delegate":
        if (facts.permanentDelegate && facts.permanentDelegate === r.address) return { ok: true, issuer: r.issuer, method: r.method };
        break;
    }
  }
  return { ok: false, code: GuardCode.OUTPUT_MINT_NOT_ISSUER };
}

export function isStableMint(mint: string, stableMints: readonly string[]): boolean {
  return stableMints.includes(mint);
}

/**
 * Exactly one direction per call (spec §8.3 guard 3): buy = stable → issuer,
 * sell = issuer → stable. Anything else is rejected.
 */
export function classifySwapDirection(
  input: { mint: string; facts: MintFacts | null },
  output: { mint: string; facts: MintFacts | null },
  stableMints: readonly string[],
  rules: IssuerRule[],
): { ok: true; side: "buy" | "sell"; issuer: string } | { ok: false; code: typeof GuardCode.INPUT_MINT_NOT_STABLE | typeof GuardCode.OUTPUT_MINT_NOT_ISSUER } {
  const inStable = isStableMint(input.mint, stableMints);
  const outStable = isStableMint(output.mint, stableMints);
  if (inStable && !outStable) {
    if (!output.facts) return { ok: false, code: GuardCode.OUTPUT_MINT_NOT_ISSUER };
    const v = verifyIssuer(output.facts, rules);
    return v.ok ? { ok: true, side: "buy", issuer: v.issuer } : { ok: false, code: v.code };
  }
  if (outStable && !inStable) {
    if (!input.facts) return { ok: false, code: GuardCode.OUTPUT_MINT_NOT_ISSUER };
    const v = verifyIssuer(input.facts, rules);
    return v.ok ? { ok: true, side: "sell", issuer: v.issuer } : { ok: false, code: v.code };
  }
  // stable→stable, stock→stock, or neither: not a Glance trade.
  return { ok: false, code: inStable ? GuardCode.OUTPUT_MINT_NOT_ISSUER : GuardCode.INPUT_MINT_NOT_STABLE };
}
