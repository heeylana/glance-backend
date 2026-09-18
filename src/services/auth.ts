/**
 * Wallet sign-in (Phantom via the web console) and session JWTs.
 *
 *   1. POST /auth/nonce   { pubkey }                 → { nonce, message }
 *   2. wallet.signMessage(message)                    (Phantom)
 *   3. POST /auth/verify  { pubkey, nonce, signature } → { token }
 *
 * The extension cannot reach Phantom, so it starts a "handoff": it creates a
 * code, opens the console with it, and polls until the console (once signed in)
 * completes the handoff with its token.
 */
import { randomBytes } from "node:crypto";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";
import { SignJWT, jwtVerify } from "jose";
import { env } from "../config.js";
import { GuardCode, GuardError } from "../lib/errors.js";

const NONCE_TTL_MS = 10 * 60_000;
const HANDOFF_TTL_MS = 10 * 60_000;
const nonces = new Map<string, { pubkey: string; issuedAt: string; expires: number }>();
const handoffs = new Map<string, { expires: number; token?: string; owner?: string }>();
const secret = new TextEncoder().encode(env.SESSION_SECRET);

function sweep() {
  const now = Date.now();
  for (const [k, v] of nonces) if (v.expires < now) nonces.delete(k);
  for (const [k, v] of handoffs) if (v.expires < now) handoffs.delete(k);
}

export function signInMessage(pubkey: string, nonce: string, issuedAt: string): string {
  return `Glance sign-in\n\nWallet: ${pubkey}\nNonce: ${nonce}\nIssued: ${issuedAt}\n\nThis signature proves you own this wallet. It costs nothing and moves nothing.`;
}

export function createNonce(pubkey: string): { nonce: string; message: string } {
  sweep();
  new PublicKey(pubkey); // throws on a bad key
  const nonce = bs58.encode(randomBytes(24));
  const issuedAt = new Date().toISOString();
  nonces.set(nonce, { pubkey, issuedAt, expires: Date.now() + NONCE_TTL_MS });
  return { nonce, message: signInMessage(pubkey, nonce, issuedAt) };
}

export async function verifyAndIssue(p: { pubkey: string; nonce: string; signature: string }): Promise<{ token: string; owner: string }> {
  sweep();
  const n = nonces.get(p.nonce);
  if (!n || n.pubkey !== p.pubkey) throw new GuardError(GuardCode.AUTH_INVALID, {}, "unknown or expired nonce");
  nonces.delete(p.nonce);
  const msg = new TextEncoder().encode(signInMessage(p.pubkey, p.nonce, n.issuedAt));
  let sig: Uint8Array;
  try {
    sig = p.signature.length > 100 ? bs58.decode(p.signature) : Buffer.from(p.signature, "base64");
    if (sig.length !== 64) sig = bs58.decode(p.signature);
  } catch {
    throw new GuardError(GuardCode.AUTH_INVALID, {}, "bad signature encoding");
  }
  const ok = nacl.sign.detached.verify(msg, sig, new PublicKey(p.pubkey).toBytes());
  if (!ok) throw new GuardError(GuardCode.AUTH_INVALID, {}, "signature does not verify");
  return { token: await issueToken(p.pubkey), owner: p.pubkey };
}

export async function issueToken(owner: string): Promise<string> {
  return new SignJWT({ sub: owner })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${env.SESSION_TTL_DAYS}d`)
    .sign(secret);
}

export async function verifyToken(token: string): Promise<{ owner: string }> {
  try {
    const { payload } = await jwtVerify(token, secret, { algorithms: ["HS256"] });
    if (typeof payload.sub !== "string") throw new Error("no sub");
    return { owner: payload.sub };
  } catch (e) {
    throw new GuardError(GuardCode.AUTH_INVALID, {}, String(e));
  }
}

// ---- extension ↔ console handoff ----

export function startHandoff(): { code: string; expiresAt: string } {
  sweep();
  const code = bs58.encode(randomBytes(16));
  const expires = Date.now() + HANDOFF_TTL_MS;
  handoffs.set(code, { expires });
  return { code, expiresAt: new Date(expires).toISOString() };
}

export function completeHandoff(code: string, token: string, owner: string): boolean {
  const h = handoffs.get(code);
  if (!h || h.expires < Date.now()) return false;
  h.token = token;
  h.owner = owner;
  return true;
}

/** One-shot: the token is deleted once read. */
export function pollHandoff(code: string): { status: "pending" } | { status: "ready"; token: string; owner: string } | { status: "unknown" } {
  const h = handoffs.get(code);
  if (!h || h.expires < Date.now()) return { status: "unknown" };
  if (!h.token || !h.owner) return { status: "pending" };
  handoffs.delete(code);
  return { status: "ready", token: h.token, owner: h.owner };
}
