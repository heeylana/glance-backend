import { GuardCode } from "../lib/errors.js";

/** Spec §8.3 guards 1–2 (the parts that are pure): session present, not paused, not expired. */
export interface SessionState {
  paused: boolean;
  signerId: string | null;
  signerExpiresAt: Date | null;
}

export type SessionResult =
  | { ok: true }
  | { ok: false; code: typeof GuardCode.NO_SESSION | typeof GuardCode.SESSION_PAUSED | typeof GuardCode.SESSION_EXPIRED };

export function checkSession(s: SessionState, now: Date): SessionResult {
  // Pause wins over everything: the user asked us to stop.
  if (s.paused) return { ok: false, code: GuardCode.SESSION_PAUSED };
  if (!s.signerId || !s.signerExpiresAt) return { ok: false, code: GuardCode.NO_SESSION };
  if (s.signerExpiresAt.getTime() <= now.getTime()) return { ok: false, code: GuardCode.SESSION_EXPIRED };
  return { ok: true };
}
