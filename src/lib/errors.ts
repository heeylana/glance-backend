/**
 * Guard and execution error codes, each mapped to the plain-language line the
 * user sees (spec §7.8). The extension never shows raw errors; it renders
 * `userMessage` and uses `code` only to pick an action (watchlist, renew, ...).
 */
export const GuardCode = {
  AUTH_INVALID: "AUTH_INVALID",
  WALLET_MISMATCH: "WALLET_MISMATCH",
  NO_SESSION: "NO_SESSION",
  SESSION_PAUSED: "SESSION_PAUSED",
  SESSION_EXPIRED: "SESSION_EXPIRED",
  INPUT_MINT_NOT_STABLE: "INPUT_MINT_NOT_STABLE",
  OUTPUT_MINT_NOT_ISSUER: "OUTPUT_MINT_NOT_ISSUER",
  MINT_NOT_TOKENIZED: "MINT_NOT_TOKENIZED",
  DESTINATION_NOT_USER: "DESTINATION_NOT_USER",
  INPUT_DEBIT_MISMATCH: "INPUT_DEBIT_MISMATCH",
  OUTPUT_BELOW_MIN: "OUTPUT_BELOW_MIN",
  SOL_SPEND_EXCEEDED: "SOL_SPEND_EXCEEDED",
  FEE_PAYER_MISMATCH: "FEE_PAYER_MISMATCH",
  DISALLOWED_PROGRAM: "DISALLOWED_PROGRAM",
  OVER_PER_TX_CAP: "OVER_PER_TX_CAP",
  OVER_DAILY_CAP: "OVER_DAILY_CAP",
  PRICE_DEVIATION: "PRICE_DEVIATION",
  PRICE_UNAVAILABLE: "PRICE_UNAVAILABLE",
  SIMULATION_FAILED: "SIMULATION_FAILED",
  INSUFFICIENT_FUNDS: "INSUFFICIENT_FUNDS",
  ROUTE_UNAVAILABLE: "ROUTE_UNAVAILABLE",
  FUNDING_UNAVAILABLE: "FUNDING_UNAVAILABLE",
  SIGNER_REJECTED: "SIGNER_REJECTED",
  SUBMIT_FAILED: "SUBMIT_FAILED",
  BAD_REQUEST: "BAD_REQUEST",
  VOICE_UNAVAILABLE: "VOICE_UNAVAILABLE",
  EXPLAIN_UNAVAILABLE: "EXPLAIN_UNAVAILABLE",
  REMEMBER_UNAVAILABLE: "REMEMBER_UNAVAILABLE",
} as const;
export type GuardCode = (typeof GuardCode)[keyof typeof GuardCode];

export interface GuardContext {
  companyName?: string;
  dailyCapUsd?: number;
  remainingUsd?: number;
  balanceUsd?: number;
  realMint?: string;
  detail?: unknown;
}

const money = (n: number | undefined) =>
  n === undefined ? "$0" : n >= 1 ? `$${Math.floor(n)}` : `$${n.toFixed(2)}`;

/** Spec §7.8 lines. Keep crypto vocabulary out of every string here. */
export function userMessage(code: GuardCode, ctx: GuardContext = {}): string {
  const name = ctx.companyName ?? "that company";
  switch (code) {
    case GuardCode.MINT_NOT_TOKENIZED:
      return `That's ${name}. It's not available on-chain yet. Want me to tell you when it is?`;
    case GuardCode.OUTPUT_MINT_NOT_ISSUER:
      return `That looks like ${name} but isn't the real one. The real ${name} is here — want that instead?`;
    case GuardCode.OVER_DAILY_CAP:
      return `That would pass your daily limit of ${money(ctx.dailyCapUsd)}. Buy ${money(
        ctx.remainingUsd,
      )} now, or raise the limit in settings?`;
    case GuardCode.OVER_PER_TX_CAP:
      return `That's more than Glance buys in one go. Try a smaller amount, or raise the limit in settings?`;
    case GuardCode.SESSION_EXPIRED:
    case GuardCode.NO_SESSION:
      return "Glance needs a quick renewal to keep buying for you.";
    case GuardCode.SESSION_PAUSED:
      return "Glance is paused.";
    case GuardCode.INSUFFICIENT_FUNDS:
      return `You have ${money(ctx.balanceUsd)} left. Add more?`;
    case GuardCode.SIMULATION_FAILED:
    case GuardCode.SUBMIT_FAILED:
    case GuardCode.SIGNER_REJECTED:
    case GuardCode.OUTPUT_BELOW_MIN:
    case GuardCode.PRICE_DEVIATION:
    case GuardCode.ROUTE_UNAVAILABLE:
      return "That didn't go through — nothing was spent. Try again?";
    case GuardCode.PRICE_UNAVAILABLE:
      return "I can't get a fair price right now. Try again in a moment?";
    case GuardCode.FUNDING_UNAVAILABLE:
      return "Test money is running low. Ask the Glance team to top it up.";
    case GuardCode.AUTH_INVALID:
    case GuardCode.WALLET_MISMATCH:
      return "Please sign in to Glance again.";
    case GuardCode.VOICE_UNAVAILABLE:
      return "I can't hear you right now. Tap instead?";
    case GuardCode.EXPLAIN_UNAVAILABLE:
      return "I can't walk you through this page right now. Try again in a moment?";
    case GuardCode.REMEMBER_UNAVAILABLE:
      return "I couldn't read this page well enough to remember it. Scroll to the story and try again?";
    default:
      // Any internal safety rejection surfaces as a neutral failure. Never leak the reason.
      return "That didn't go through — nothing was spent. Try again?";
  }
}

const HTTP_STATUS: Partial<Record<GuardCode, number>> = {
  AUTH_INVALID: 401,
  WALLET_MISMATCH: 403,
  NO_SESSION: 409,
  SESSION_PAUSED: 409,
  SESSION_EXPIRED: 409,
  OVER_PER_TX_CAP: 422,
  OVER_DAILY_CAP: 422,
  INSUFFICIENT_FUNDS: 422,
  MINT_NOT_TOKENIZED: 404,
  BAD_REQUEST: 400,
  PRICE_UNAVAILABLE: 503,
  ROUTE_UNAVAILABLE: 503,
  FUNDING_UNAVAILABLE: 503,
  VOICE_UNAVAILABLE: 503,
  EXPLAIN_UNAVAILABLE: 503,
  REMEMBER_UNAVAILABLE: 503,
};

export class GuardError extends Error {
  readonly code: GuardCode;
  readonly ctx: GuardContext;
  readonly status: number;
  constructor(code: GuardCode, ctx: GuardContext = {}, internal?: string) {
    super(internal ?? code);
    this.name = "GuardError";
    this.code = code;
    this.ctx = ctx;
    this.status = HTTP_STATUS[code] ?? 422;
  }
  toResponse() {
    return {
      ok: false as const,
      code: this.code,
      message: userMessage(this.code, this.ctx),
      ...(this.ctx.remainingUsd !== undefined ? { remainingUsd: this.ctx.remainingUsd } : {}),
      ...(this.ctx.realMint ? { realMint: this.ctx.realMint } : {}),
    };
  }
}
