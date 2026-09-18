import { GuardCode } from "../lib/errors.js";

/**
 * Spec §8.3 guard 4: after simulating the Jupiter transaction, every account
 * that gains value must be either a route account (a token account whose owner
 * is a program-derived address, i.e. off-curve) or an ATA owned by the user's
 * embedded wallet. A wallet-owned (on-curve) account that is not the user may
 * gain at most `feeToleranceBps` of amount_in, and only in the input mint
 * (DEX fee collectors). The user's own input account must drop by exactly
 * amount_in, nothing else of theirs may drop, and their SOL spend is capped.
 */
export interface TokenDelta {
  account: string;
  mint: string;
  owner: string;
  /** true when `owner` is off the ed25519 curve (a PDA), i.e. program-controlled. */
  ownerIsPda: boolean;
  pre: bigint;
  post: bigint;
}

export interface DestinationInput {
  deltas: TokenDelta[];
  userWallet: string;
  inputMint: string;
  outputMint: string;
  amountIn: bigint;
  minOut: bigint;
  feeToleranceBps: number;
  /** post - pre lamports on the user's wallet account (negative = spent). */
  userLamportsDelta: bigint;
  maxUserLamportsSpend: bigint;
  /** Wrapped SOL mint; a user wSOL ATA may be created+closed inside a route and net to zero. */
  wsolMint?: string;
  /**
   * Wallet-owned owners that may receive the input token up to amount_in.
   * Only the devnet mock desk uses this; on Jupiter it is empty and every
   * counterparty must be a PDA.
   */
  allowedCounterparties?: readonly string[];
}

export type DestinationResult =
  | { ok: true; userOutputGain: bigint; userInputDebit: bigint }
  | {
      ok: false;
      code:
        | typeof GuardCode.DESTINATION_NOT_USER
        | typeof GuardCode.INPUT_DEBIT_MISMATCH
        | typeof GuardCode.OUTPUT_BELOW_MIN
        | typeof GuardCode.SOL_SPEND_EXCEEDED;
      detail: string;
    };

const WSOL = "So11111111111111111111111111111111111111112";

export function checkDestinations(i: DestinationInput): DestinationResult {
  const wsol = i.wsolMint ?? WSOL;
  const feeTolerance = (i.amountIn * BigInt(Math.round(i.feeToleranceBps))) / 10_000n;

  let userInputDebit = 0n;
  let userOutputGain = 0n;

  for (const d of i.deltas) {
    const change = d.post - d.pre;
    if (change === 0n) continue;
    const isUser = d.owner === i.userWallet;

    if (change > 0n) {
      if (isUser) {
        if (d.mint === i.outputMint) userOutputGain += change;
        // Any other gain to the user's own wallet is harmless (dust, intermediate leftovers).
        continue;
      }
      if (d.ownerIsPda) continue; // route account (pool vault, program fee vault)
      // Explicit counterparty (mock desk): may take the input token, never more than amount_in.
      if (i.allowedCounterparties?.includes(d.owner) && d.mint === i.inputMint && change <= i.amountIn) continue;
      // Wallet-owned, not the user: only a small fee in the input mint is tolerated.
      if (d.mint === i.inputMint && change <= feeTolerance) continue;
      return {
        ok: false,
        code: GuardCode.DESTINATION_NOT_USER,
        detail: `account ${d.account} (owner ${d.owner}) gains ${change} of ${d.mint}`,
      };
    }

    // change < 0
    if (isUser) {
      if (d.mint === i.inputMint) {
        userInputDebit += -change;
        continue;
      }
      if (d.mint === wsol) continue; // transient wrap/unwrap inside a route
      return {
        ok: false,
        code: GuardCode.INPUT_DEBIT_MISMATCH,
        detail: `user account ${d.account} loses ${-change} of unexpected mint ${d.mint}`,
      };
    }
    // Non-user accounts losing value are pools paying out. Fine.
  }

  if (userInputDebit !== i.amountIn) {
    return {
      ok: false,
      code: GuardCode.INPUT_DEBIT_MISMATCH,
      detail: `user input debit ${userInputDebit} != amount_in ${i.amountIn}`,
    };
  }
  if (userOutputGain < i.minOut) {
    return { ok: false, code: GuardCode.OUTPUT_BELOW_MIN, detail: `user output gain ${userOutputGain} < min_out ${i.minOut}` };
  }
  if (-i.userLamportsDelta > i.maxUserLamportsSpend) {
    return {
      ok: false,
      code: GuardCode.SOL_SPEND_EXCEEDED,
      detail: `user SOL spend ${-i.userLamportsDelta} > cap ${i.maxUserLamportsSpend}`,
    };
  }
  return { ok: true, userOutputGain, userInputDebit };
}
