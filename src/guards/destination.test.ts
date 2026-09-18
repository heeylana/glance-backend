import { describe, expect, it } from "vitest";
import { checkDestinations, type TokenDelta } from "./destination.js";

const USER = "UserWa11et1111111111111111111111111111111111";
const ATTACKER = "Attacker111111111111111111111111111111111111";
const POOL_AUTH = "Poo1Authority111111111111111111111111111111";
const USDC = "USDC1111111111111111111111111111111111111111";
const AAPL = "AAPLx111111111111111111111111111111111111111";
const WSOL = "So11111111111111111111111111111111111111112";

const d = (account: string, mint: string, owner: string, pre: bigint, post: bigint, ownerIsPda = false): TokenDelta => ({
  account, mint, owner, ownerIsPda, pre, post,
});

const base = {
  userWallet: USER,
  inputMint: USDC,
  outputMint: AAPL,
  amountIn: 10_000_000n,
  minOut: 4_000_000n,
  feeToleranceBps: 100,
  userLamportsDelta: -2_100_000n,
  maxUserLamportsSpend: 15_000_000n,
};

const happy: TokenDelta[] = [
  d("uUSDC", USDC, USER, 50_000_000n, 40_000_000n),
  d("uAAPL", AAPL, USER, 0n, 4_300_000n),
  d("poolUSDC", USDC, POOL_AUTH, 1_000_000_000n, 1_010_000_000n, true),
  d("poolAAPL", AAPL, POOL_AUTH, 900_000_000n, 895_700_000n, true),
];

describe("checkDestinations", () => {
  it("accepts a clean single-hop swap", () => {
    const r = checkDestinations({ ...base, deltas: happy });
    expect(r).toEqual({ ok: true, userOutputGain: 4_300_000n, userInputDebit: 10_000_000n });
  });

  it("rejects when a wallet-owned non-user account receives the output token", () => {
    const deltas = [
      d("uUSDC", USDC, USER, 50_000_000n, 40_000_000n),
      d("attAAPL", AAPL, ATTACKER, 0n, 4_300_000n),
      d("poolUSDC", USDC, POOL_AUTH, 0n, 10_000_000n, true),
      d("poolAAPL", AAPL, POOL_AUTH, 900_000_000n, 895_700_000n, true),
    ];
    const r = checkDestinations({ ...base, deltas });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("DESTINATION_NOT_USER");
  });

  it("rejects a transfer-out disguised inside the tx (user USDC leaves to a wallet)", () => {
    const deltas = [
      ...happy,
      d("uUSDC2", USDC, USER, 40_000_000n, 30_000_000n), // extra 10 USDC debit
      d("attUSDC", USDC, ATTACKER, 0n, 10_000_000n),
    ];
    const r = checkDestinations({ ...base, deltas });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("DESTINATION_NOT_USER");
  });

  it("rejects when the user's input debit is not exactly amount_in", () => {
    const deltas = happy.map((x) => (x.account === "uUSDC" ? { ...x, post: 39_000_000n } : x));
    const r = checkDestinations({ ...base, deltas });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("INPUT_DEBIT_MISMATCH");
  });

  it("rejects when the user loses a token that is not the input mint", () => {
    const deltas = [...happy, d("uTSLA", "TSLAx111111111111111111111111111111111111111", USER, 5n, 0n)];
    const r = checkDestinations({ ...base, deltas });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("INPUT_DEBIT_MISMATCH");
  });

  it("allows a transient user wSOL account that nets to zero, and multi-hop via PDAs", () => {
    const deltas = [
      d("uUSDC", USDC, USER, 50_000_000n, 40_000_000n),
      d("uWSOL", WSOL, USER, 0n, 0n),
      d("pool1USDC", USDC, POOL_AUTH, 0n, 10_000_000n, true),
      d("pool1SOL", WSOL, POOL_AUTH, 100n, 50n, true),
      d("pool2SOL", WSOL, "Poo12Authority11111111111111111111111111111", 0n, 50n, true),
      d("pool2AAPL", AAPL, "Poo12Authority11111111111111111111111111111", 900_000_000n, 895_700_000n, true),
      d("uAAPL", AAPL, USER, 0n, 4_300_000n),
    ];
    expect(checkDestinations({ ...base, deltas }).ok).toBe(true);
  });

  it("tolerates a small DEX fee to a wallet-owned collector in the input mint, but not a large one", () => {
    const small = [...happy, d("feeUSDC", USDC, "FeeCo11ector11111111111111111111111111111111", 0n, 50_000n)]; // 0.5%
    expect(checkDestinations({ ...base, deltas: small }).ok).toBe(true);
    const large = [...happy, d("feeUSDC", USDC, "FeeCo11ector11111111111111111111111111111111", 0n, 500_000n)]; // 5%
    const r = checkDestinations({ ...base, deltas: large });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("DESTINATION_NOT_USER");
  });

  it("never tolerates a wallet-owned collector receiving the output mint, however small", () => {
    const deltas = [...happy, d("feeAAPL", AAPL, "FeeCo11ector11111111111111111111111111111111", 0n, 1n)];
    expect(checkDestinations({ ...base, deltas }).ok).toBe(false);
  });

  it("allows an explicit counterparty to take the input token, but never the output token", () => {
    const DESK = "Desk1111111111111111111111111111111111111111";
    const deltas = [
      d("uUSDC", USDC, USER, 50_000_000n, 40_000_000n),
      d("uAAPL", AAPL, USER, 0n, 4_300_000n),
      d("deskUSDC", USDC, DESK, 0n, 10_000_000n),
      d("deskAAPL", AAPL, DESK, 900_000_000n, 895_700_000n),
    ];
    expect(checkDestinations({ ...base, deltas, allowedCounterparties: [DESK] }).ok).toBe(true);
    expect(checkDestinations({ ...base, deltas }).ok).toBe(false); // same tx, no allowance → rejected
    const greedy = deltas.map((x) => (x.account === "deskUSDC" ? { ...x, post: 10_000_001n } : x));
    expect(checkDestinations({ ...base, deltas: greedy, allowedCounterparties: [DESK] }).ok).toBe(false);
    const stealsOutput = [...deltas, d("deskAAPL2", AAPL, DESK, 0n, 1n)];
    expect(checkDestinations({ ...base, deltas: stealsOutput, allowedCounterparties: [DESK] }).ok).toBe(false);
  });

  it("rejects output below min_out", () => {
    const r = checkDestinations({ ...base, deltas: happy, minOut: 4_400_000n });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("OUTPUT_BELOW_MIN");
  });

  it("rejects when the user's SOL spend exceeds the cap (hidden native transfer)", () => {
    const r = checkDestinations({ ...base, deltas: happy, userLamportsDelta: -500_000_000n });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("SOL_SPEND_EXCEEDED");
  });
});
