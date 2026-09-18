import { GuardCode } from "../lib/errors.js";

/**
 * Spec §8.3 guard 6: the Jupiter quote's implied price must sit within
 * `maxDeviationBps` of Pyth. Off-hours the equity feed can be stale while the
 * on-chain price keeps moving, so a stale feed either rejects or widens the band
 * (configurable). Both the reject and the widened band are logged by the caller.
 */
export interface PythPrice {
  /** Integer price as published, scale by 10^expo. */
  price: bigint;
  expo: number;
  conf: bigint;
  publishTime: number; // unix seconds
}

export interface PriceCheckInput {
  side: "buy" | "sell";
  /** Quote amounts in base units. For buy: in=USDC, out=stock. For sell: in=stock, out=USDC. */
  inAmount: bigint;
  outAmount: bigint;
  stockDecimals: number;
  usdcDecimals?: number;
  pyth: PythPrice;
  nowSec: number;
  maxDeviationBps: number;
  maxAgeSec: number;
  stalePolicy: "reject" | "widen";
  staleDeviationBps: number;
}

export type PriceCheckResult =
  | { ok: true; impliedUsdPerShare: number; pythUsdPerShare: number; deviationBps: number; stale: boolean }
  | { ok: false; code: typeof GuardCode.PRICE_DEVIATION | typeof GuardCode.PRICE_UNAVAILABLE; impliedUsdPerShare?: number; pythUsdPerShare?: number; deviationBps?: number };

export function pythToUsd(p: PythPrice): number {
  return Number(p.price) * 10 ** p.expo;
}

export function impliedUsdPerShare(i: Pick<PriceCheckInput, "side" | "inAmount" | "outAmount" | "stockDecimals" | "usdcDecimals">): number {
  const usdcDec = i.usdcDecimals ?? 6;
  const usdc = i.side === "buy" ? i.inAmount : i.outAmount;
  const shares = i.side === "buy" ? i.outAmount : i.inAmount;
  if (shares <= 0n || usdc <= 0n) return NaN;
  return Number(usdc) / 10 ** usdcDec / (Number(shares) / 10 ** i.stockDecimals);
}

export function checkQuoteAgainstPyth(i: PriceCheckInput): PriceCheckResult {
  const pythUsd = pythToUsd(i.pyth);
  if (!Number.isFinite(pythUsd) || pythUsd <= 0) return { ok: false, code: GuardCode.PRICE_UNAVAILABLE };

  const stale = i.nowSec - i.pyth.publishTime > i.maxAgeSec;
  if (stale && i.stalePolicy === "reject") return { ok: false, code: GuardCode.PRICE_UNAVAILABLE };

  const implied = impliedUsdPerShare(i);
  if (!Number.isFinite(implied)) return { ok: false, code: GuardCode.PRICE_DEVIATION };

  const deviationBps = Math.abs(implied - pythUsd) / pythUsd * 10_000;
  const band = stale ? i.staleDeviationBps : i.maxDeviationBps;
  if (deviationBps > band) {
    return { ok: false, code: GuardCode.PRICE_DEVIATION, impliedUsdPerShare: implied, pythUsdPerShare: pythUsd, deviationBps };
  }
  return { ok: true, impliedUsdPerShare: implied, pythUsdPerShare: pythUsd, deviationBps, stale };
}
