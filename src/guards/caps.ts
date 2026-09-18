import { GuardCode } from "../lib/errors.js";

/** Spec §8.3 guard 5: per-transaction cap and rolling 24h daily cap. Amounts in USDC base units. */
export interface CapsInput {
  amountIn: bigint;
  perTxCap: bigint;
  dailyCap: bigint;
  /** Sum of pending + confirmed delegated spends in the trailing window. */
  spentInWindow: bigint;
}

export type CapsResult =
  | { ok: true; remainingAfter: bigint }
  | { ok: false; code: typeof GuardCode.OVER_PER_TX_CAP | typeof GuardCode.OVER_DAILY_CAP; remaining: bigint };

export function checkCaps(i: CapsInput): CapsResult {
  if (i.amountIn <= 0n) return { ok: false, code: GuardCode.OVER_PER_TX_CAP, remaining: 0n };
  const remaining = i.dailyCap > i.spentInWindow ? i.dailyCap - i.spentInWindow : 0n;
  if (i.amountIn > i.perTxCap) {
    return { ok: false, code: GuardCode.OVER_PER_TX_CAP, remaining: remaining < i.perTxCap ? remaining : i.perTxCap };
  }
  if (i.spentInWindow + i.amountIn > i.dailyCap) {
    return { ok: false, code: GuardCode.OVER_DAILY_CAP, remaining };
  }
  return { ok: true, remainingAfter: remaining - i.amountIn };
}

export interface LedgerRow {
  amountIn: bigint;
  createdAt: Date;
  status: "pending" | "confirmed" | "failed";
}

export const DAY_MS = 86_400_000;

/**
 * Rolling-window spend. Pending rows count (a tx in flight has already been
 * signed); failed rows never count. Buys only: the ledger caller passes side='buy' rows.
 */
export function spentInWindow(rows: LedgerRow[], now: Date, windowMs = DAY_MS): bigint {
  const cutoff = now.getTime() - windowMs;
  let sum = 0n;
  for (const r of rows) {
    if (r.status === "failed") continue;
    if (r.createdAt.getTime() <= cutoff) continue;
    sum += r.amountIn;
  }
  return sum;
}
