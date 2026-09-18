/**
 * Quote providers. The vault program moves the tokens; this layer only says at
 * what price.
 *   desk    → devnet OTC counterparty (Jupiter has no devnet): reference price + spread.
 *   jupiter → Jupiter quote (mainnet). The router fill path (execute_swap_router with
 *             Jupiter's instructions as remaining_accounts) is not wired yet.
 */
import { PublicKey } from "@solana/web3.js";
import { env, optionalEnv } from "../config.js";
import { GuardCode, GuardError } from "../lib/errors.js";
import { loadRegistry } from "../config/issuers.js";
import { getReferencePrice } from "./prices.js";
import { getQuote } from "./jupiter.js";
import { deskKeypair } from "./keys.js";

export interface RouteQuote {
  inputMint: string;
  outputMint: string;
  inAmount: bigint;
  outAmount: bigint;
  /** Worst acceptable output after slippage. */
  minOut: bigint;
  slippageBps: number;
  priceImpactPct: number | null;
  raw?: unknown;
}

export interface RouteProvider {
  readonly name: "jupiter" | "desk";
  quote(p: { inputMint: string; outputMint: string; amount: bigint; slippageBps: number }): Promise<RouteQuote>;
  /** The desk pubkey that must co-sign, when this provider fills OTC. */
  desk(): PublicKey | null;
}

class JupiterRoute implements RouteProvider {
  readonly name = "jupiter" as const;
  async quote(p: { inputMint: string; outputMint: string; amount: bigint; slippageBps: number }): Promise<RouteQuote> {
    const q = await getQuote(p);
    return {
      inputMint: q.inputMint,
      outputMint: q.outputMint,
      inAmount: BigInt(q.inAmount),
      outAmount: BigInt(q.outAmount),
      minOut: BigInt(q.otherAmountThreshold),
      slippageBps: q.slippageBps,
      priceImpactPct: Number.isFinite(Number(q.priceImpactPct)) ? Number(q.priceImpactPct) : null,
      raw: q,
    };
  }
  desk(): PublicKey | null {
    return null;
  }
}

class DeskRoute implements RouteProvider {
  readonly name = "desk" as const;
  private spreadBps = Number(optionalEnv("DESK_SPREAD_BPS") ?? 30);
  desk(): PublicKey {
    return deskKeypair().publicKey;
  }
  async quote(p: { inputMint: string; outputMint: string; amount: bigint; slippageBps: number }): Promise<RouteQuote> {
    const reg = loadRegistry();
    const side = reg.stableMints.includes(p.inputMint) ? "buy" : "sell";
    const stockMint = side === "buy" ? p.outputMint : p.inputMint;
    const e = reg.byMint.get(stockMint);
    if (!e) throw new GuardError(GuardCode.OUTPUT_MINT_NOT_ISSUER);
    const ref = await getReferencePrice(e);
    if (!ref) throw new GuardError(GuardCode.PRICE_UNAVAILABLE);
    const price = ref.usd;
    const fill = side === "buy" ? price * (1 + this.spreadBps / 10_000) : price * (1 - this.spreadBps / 10_000);
    let outAmount: bigint;
    if (side === "buy") outAmount = BigInt(Math.floor((Number(p.amount) / 1e6 / fill) * 10 ** e.decimals));
    else outAmount = BigInt(Math.floor((Number(p.amount) / 10 ** e.decimals) * fill * 1e6));
    const minOut = outAmount - (outAmount * BigInt(p.slippageBps)) / 10_000n;
    return { inputMint: p.inputMint, outputMint: p.outputMint, inAmount: p.amount, outAmount, minOut, slippageBps: p.slippageBps, priceImpactPct: 0 };
  }
}

let _route: RouteProvider | null = null;
export function routeProvider(): RouteProvider {
  if (_route) return _route;
  const mode = optionalEnv("ROUTE_PROVIDER") ?? (env.SOLANA_CLUSTER === "devnet" ? "desk" : "jupiter");
  _route = mode === "desk" ? new DeskRoute() : new JupiterRoute();
  return _route;
}
