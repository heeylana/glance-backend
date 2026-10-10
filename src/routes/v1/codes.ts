/**
 * Every /v1 refusal is `{ ok: false, code, message }` with a machine code from this file and a sentence
 * the bot can send as-is. Guard rejections keep their plain-language line from lib/errors.ts and get a
 * snake_case code here; the API's own refusals (not bound, quote expired…) are listed below.
 */
import { GuardCode, GuardError, userMessage, type GuardContext } from "../../lib/errors.js";

export const GUARD_TO_API: Record<GuardCode, string> = {
  AUTH_INVALID: "unauthorized",
  WALLET_MISMATCH: "unauthorized",
  NO_SESSION: "agent_expired",
  SESSION_PAUSED: "paused",
  SESSION_EXPIRED: "agent_expired",
  INPUT_MINT_NOT_STABLE: "mint_not_curated",
  OUTPUT_MINT_NOT_ISSUER: "mint_not_curated",
  MINT_NOT_TOKENIZED: "not_tokenized",
  DESTINATION_NOT_USER: "trade_failed",
  INPUT_DEBIT_MISMATCH: "trade_failed",
  OUTPUT_BELOW_MIN: "trade_failed",
  SOL_SPEND_EXCEEDED: "trade_failed",
  FEE_PAYER_MISMATCH: "trade_failed",
  DISALLOWED_PROGRAM: "trade_failed",
  OVER_PER_TX_CAP: "per_trade_exceeded",
  OVER_DAILY_CAP: "leash_exceeded",
  PRICE_DEVIATION: "trade_failed",
  PRICE_UNAVAILABLE: "price_unavailable",
  SIMULATION_FAILED: "trade_failed",
  INSUFFICIENT_FUNDS: "insufficient_funds",
  ROUTE_UNAVAILABLE: "trade_failed",
  FUNDING_UNAVAILABLE: "funding_unavailable",
  SIGNER_REJECTED: "trade_failed",
  SUBMIT_FAILED: "trade_failed",
  BAD_REQUEST: "bad_request",
  VOICE_UNAVAILABLE: "voice_unavailable",
  EXPLAIN_UNAVAILABLE: "explain_unavailable",
  REMEMBER_UNAVAILABLE: "remember_unavailable",
};

export const API_OWN = {
  not_bound: { status: 404, message: "This number isn't connected to Glance yet. Send \"connect\" to get a link." },
  unauthorized: { status: 401, message: "Please sign in to Glance again." },
  forbidden: { status: 403, message: "That isn't yours to act on." },
  rate_limited: { status: 429, message: "One at a time — give me a second." },
  quote_expired: { status: 409, message: "That quote expired. Want a fresh one?" },
  quote_used: { status: 409, message: "That one already went through." },
  quote_moved: { status: 409, message: "The price moved since I quoted you, so nothing was spent. Want a fresh quote?" },
  needs_confirm_replace: { status: 409, message: "This number is already connected to another wallet. Confirm to replace it." },
  needs_confirm_multi: { status: 409, message: "This wallet is already connected to another number. Confirm to add this one too." },
  session_expired: { status: 410, message: "That link expired. Message Glance again for a new one." },
  session_used: { status: 410, message: "That link was already used. Message Glance again for a new one." },
  session_not_verified: { status: 409, message: "Connect a wallet and approve the message first." },
  bad_signature: { status: 401, message: "That signature didn't verify. Try approving the message again." },
  vault_missing: { status: 409, message: "There's no Glance account on that wallet yet." },
  agent_missing: { status: 409, message: "Glance doesn't have permission on that account yet." },
  unknown_company: { status: 404, message: "I don't know that company yet." },
  no_position: { status: 404, message: "You don't own any of that." },
  image_too_large: { status: 413, message: "That image is too big. Anything up to 5 MB works." },
  image_unsupported: { status: 415, message: "I read JPEG, PNG, WebP and HEIC images." },
  image_expired: { status: 410, message: "That image is gone. I keep them for a day. Send it again?" },
  image_unreadable: { status: 422, message: "I couldn't read that image." },
  not_available: { status: 503, message: "I can't do that right now. Try again in a moment?" },
  bad_request: { status: 400, message: "I didn't follow that." },
} as const;
export type ApiOwnCode = keyof typeof API_OWN;

/** A refusal of the API's own (not a guard): carries the code, the sentence and the HTTP status. */
export class ApiError extends Error {
  readonly code: ApiOwnCode;
  readonly status: number;
  readonly detail?: unknown;
  constructor(code: ApiOwnCode, detail?: unknown, overrideMessage?: string) {
    super(overrideMessage ?? API_OWN[code].message);
    this.code = code;
    this.status = API_OWN[code].status;
    this.detail = detail;
  }
}

export interface Refusal {
  status: number;
  body: { ok: false; code: string; message: string; detail?: unknown };
}

export function refusalOf(err: unknown): Refusal | null {
  if (err instanceof ApiError) return { status: err.status, body: { ok: false, code: err.code, message: err.message, ...(err.detail !== undefined ? { detail: err.detail } : {}) } };
  if (err instanceof GuardError) {
    const ctx = err.ctx as GuardContext;
    const detail: Record<string, unknown> = {};
    if (ctx.remainingUsd !== undefined) detail.remaining_today_usd = ctx.remainingUsd.toFixed(2);
    if (ctx.dailyCapUsd !== undefined) detail.daily_cap_usd = ctx.dailyCapUsd.toFixed(2);
    if (ctx.balanceUsd !== undefined) detail.balance_usd = ctx.balanceUsd.toFixed(2);
    if (ctx.companyName) detail.company = ctx.companyName;
    return { status: err.status, body: { ok: false, code: GUARD_TO_API[err.code] ?? "trade_failed", message: userMessage(err.code, ctx), ...(Object.keys(detail).length ? { detail } : {}) } };
  }
  return null;
}
