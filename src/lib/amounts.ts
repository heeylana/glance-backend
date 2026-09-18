export const USDC_DECIMALS = 6;
const USDC_UNIT = 10n ** BigInt(USDC_DECIMALS);

/** USD (1:1 USDC) → base units. Rounds to the nearest micro-USDC. */
export function usdToUsdc(usd: number): bigint {
  if (!Number.isFinite(usd) || usd < 0) throw new RangeError(`bad usd amount: ${usd}`);
  return BigInt(Math.round(usd * 1_000_000));
}

export function usdcToUsd(units: bigint): number {
  return Number(units) / 1_000_000;
}

/** amount * bps / 10_000, floor. */
export function bps(amount: bigint, basisPoints: number): bigint {
  return (amount * BigInt(Math.round(basisPoints))) / 10_000n;
}

export function rawToDecimal(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}

export { USDC_UNIT };
