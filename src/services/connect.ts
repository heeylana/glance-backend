/**
 * Connect sessions and bindings: how a chat account becomes a Glance owner.
 *
 *   bot: POST /v1/connect/sessions → code (15 min, single use, tied to the channel user)
 *   page: GET …/{code} (shows the masked number) → wallet signs connectMessage → POST …/verify
 *   page: create / fund / renew in the console's own flow → POST …/complete → bound
 *
 * The code is never stored, only its sha256. Sessions live in Postgres, not memory, because the page and
 * the bot may hit the server minutes apart and a restart in between must not lose the link.
 */
import { createHash, randomBytes } from "node:crypto";
import bs58 from "bs58";
import { and, desc, eq, lt, ne, or, sql } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { env } from "../config.js";
import { log } from "../lib/log.js";
import { connectMessage, verifySignature } from "./auth.js";
import { ensureUser } from "./store.js";

export type ConnectSession = typeof schema.connectSessions.$inferSelect;
export type Binding = typeof schema.bindings.$inferSelect;

export const CHANNELS = ["whatsapp", "telegram"] as const;
export type Channel = (typeof CHANNELS)[number];
export const isChannel = (s: string): s is Channel => (CHANNELS as readonly string[]).includes(s);

/** What the page shows before any wallet action: enough to catch a forwarded link, never the whole number. */
export function maskUser(channel: string, id: string): string {
  if (channel === "whatsapp") {
    const digits = id.replace(/\D/g, "");
    if (digits.length < 8) return `+${digits.slice(0, 1)}••• ${digits.slice(-2)}`;
    return `+${digits.slice(0, 2)} •••• ${digits.slice(-4)}`;
  }
  return `${channel} user •••${id.slice(-3)}`;
}

/** The first six hex of the sha256: enough to follow one user through the logs, never the number itself. */
export function userTag(channel: string, id: string): string {
  return `${channel}:${createHash("sha256").update(`${channel}:${id}`).digest("hex").slice(0, 6)}`;
}

export const hashCode = (code: string) => createHash("sha256").update(code).digest("hex");
export const newCode = () => bs58.encode(randomBytes(16));
export const connectUrl = (code: string) => `${(env.CONNECT_URL_BASE ?? env.WEB_CONSOLE_URL).replace(/\/$/, "")}/connect/${code}`;

export type SessionStatus = "pending" | "verified" | "used" | "expired";
export function sessionStatus(s: Pick<ConnectSession, "expiresAt" | "verifiedAt" | "usedAt">, now = new Date()): SessionStatus {
  if (s.usedAt) return "used";
  if (s.expiresAt.getTime() <= now.getTime()) return "expired";
  return s.verifiedAt ? "verified" : "pending";
}

export async function createSession(p: { clientId: string; channel: Channel; channelUserId: string }): Promise<{ code: string; url: string; expiresAt: Date }> {
  const code = newCode();
  const expiresAt = new Date(Date.now() + env.CONNECT_TTL_MIN * 60_000);
  await db().insert(schema.connectSessions).values({ codeHash: hashCode(code), clientId: p.clientId, channel: p.channel, channelUserId: p.channelUserId, expiresAt });
  log.info("connect session", { user: userTag(p.channel, p.channelUserId), client: p.clientId, expiresAt: expiresAt.toISOString() });
  return { code, url: connectUrl(code), expiresAt };
}

export async function findSession(code: string): Promise<ConnectSession | null> {
  if (!/^[1-9A-HJ-NP-Za-km-z]{16,32}$/.test(code)) return null;
  return (await db().select().from(schema.connectSessions).where(eq(schema.connectSessions.codeHash, hashCode(code))))[0] ?? null;
}

export function messageFor(s: ConnectSession, code: string, wallet: string): string {
  return connectMessage({ wallet, code, channel: s.channel, maskedUser: maskUser(s.channel, s.channelUserId) });
}

export async function getBinding(channel: string, channelUserId: string): Promise<Binding | null> {
  return (await db().select().from(schema.bindings).where(and(eq(schema.bindings.channel, channel), eq(schema.bindings.channelUserId, channelUserId))))[0] ?? null;
}

export async function listBindingsForOwner(owner: string): Promise<Binding[]> {
  return db().select().from(schema.bindings).where(eq(schema.bindings.owner, owner)).orderBy(desc(schema.bindings.createdAt));
}

export async function listBindings(): Promise<Binding[]> {
  return db().select().from(schema.bindings);
}

export async function removeBinding(channel: string, channelUserId: string): Promise<boolean> {
  const rows = await db().delete(schema.bindings).where(and(eq(schema.bindings.channel, channel), eq(schema.bindings.channelUserId, channelUserId))).returning();
  if (rows.length) log.info("binding removed", { user: userTag(channel, channelUserId), owner: rows[0]!.owner });
  return rows.length > 0;
}

export async function updateBinding(channel: string, channelUserId: string, patch: Partial<typeof schema.bindings.$inferInsert>): Promise<Binding | null> {
  return (await db().update(schema.bindings).set(patch).where(and(eq(schema.bindings.channel, channel), eq(schema.bindings.channelUserId, channelUserId))).returning())[0] ?? null;
}

/** Other channel users this wallet is already bound to (the "one wallet, several numbers" check). */
async function othersBoundTo(wallet: string, channel: string, channelUserId: string): Promise<number> {
  const rows = await db()
    .select({ n: sql<number>`count(*)` })
    .from(schema.bindings)
    .where(and(eq(schema.bindings.owner, wallet), or(ne(schema.bindings.channel, channel), ne(schema.bindings.channelUserId, channelUserId))));
  return Number(rows[0]?.n ?? 0);
}

export type VerifyFailure = "session_expired" | "session_used" | "bad_signature";
export type VerifyResult =
  | { ok: true; session: ConnectSession; wallet: string; replaces: Binding | null; alsoBoundTo: number; message: string }
  | { ok: false; code: VerifyFailure };

/** The wallet proves it is the one being bound: an ed25519 signature over the connect message. */
export async function verifySession(code: string, wallet: string, signature: string, now = new Date()): Promise<VerifyResult> {
  const s = await findSession(code);
  if (!s) return { ok: false, code: "session_expired" };
  const status = sessionStatus(s, now);
  if (status === "used") return { ok: false, code: "session_used" };
  if (status === "expired") return { ok: false, code: "session_expired" };
  const message = messageFor(s, code, wallet);
  if (!verifySignature(wallet, message, signature)) return { ok: false, code: "bad_signature" };
  const [updated] = await db().update(schema.connectSessions).set({ wallet, verifiedAt: now }).where(eq(schema.connectSessions.codeHash, s.codeHash)).returning();
  const existing = await getBinding(s.channel, s.channelUserId);
  const replaces = existing && existing.owner !== wallet ? existing : null;
  const alsoBoundTo = await othersBoundTo(wallet, s.channel, s.channelUserId);
  log.info("connect verified", { user: userTag(s.channel, s.channelUserId), wallet, replaces: !!replaces, alsoBoundTo });
  return { ok: true, session: updated ?? s, wallet, replaces, alsoBoundTo, message };
}

export type BindingDecision = { ok: true; replaces: boolean } | { ok: false; code: "needs_confirm_replace" | "needs_confirm_multi" };

/** The two rules from the spec: a number maps to one wallet (replacing needs a yes), a wallet to one number by default. Pure. */
export function bindingDecision(p: { existing: Pick<Binding, "owner"> | null; wallet: string; othersForWallet: number; confirmReplace: boolean; confirmMulti: boolean }): BindingDecision {
  const replaces = !!p.existing && p.existing.owner !== p.wallet;
  if (replaces && !p.confirmReplace) return { ok: false, code: "needs_confirm_replace" };
  if (p.othersForWallet > 0 && !p.confirmMulti) return { ok: false, code: "needs_confirm_multi" };
  return { ok: true, replaces };
}

export type CompleteResult = { ok: true; binding: Binding; alreadyBound: boolean } | { ok: false; code: "session_expired" | "session_used" | "session_not_verified" | "needs_confirm_replace" | "needs_confirm_multi" };

/** Bind and spend the code. Idempotent: the same code and wallet completing twice returns the binding again. */
export async function completeSession(code: string, flags: { confirmReplace: boolean; confirmMulti: boolean }, now = new Date()): Promise<CompleteResult> {
  const s = await findSession(code);
  if (!s) return { ok: false, code: "session_expired" };
  const status = sessionStatus(s, now);
  if (status === "used") {
    const b = s.wallet ? await getBinding(s.channel, s.channelUserId) : null;
    return b && b.owner === s.wallet ? { ok: true, binding: b, alreadyBound: true } : { ok: false, code: "session_used" };
  }
  if (status === "expired") return { ok: false, code: "session_expired" };
  if (status !== "verified" || !s.wallet) return { ok: false, code: "session_not_verified" };
  const wallet = s.wallet;
  const existing = await getBinding(s.channel, s.channelUserId);
  const decision = bindingDecision({ existing, wallet, othersForWallet: await othersBoundTo(wallet, s.channel, s.channelUserId), ...flags });
  if (!decision.ok) return decision;
  await ensureUser(wallet);
  const message = messageFor(s, code, wallet);
  const binding = await db().transaction(async (tx) => {
    const [b] = await tx
      .insert(schema.bindings)
      .values({ channel: s.channel, channelUserId: s.channelUserId, clientId: s.clientId, owner: wallet, connectMessage: message })
      .onConflictDoUpdate({
        target: [schema.bindings.channel, schema.bindings.channelUserId],
        set: { owner: wallet, clientId: s.clientId, connectMessage: message, createdAt: now, replacedAt: decision.replaces ? now : null, warnedExpiryAt: null, warnedExpiryFor: null },
      })
      .returning();
    await tx.update(schema.connectSessions).set({ usedAt: now }).where(eq(schema.connectSessions.codeHash, s.codeHash));
    return b!;
  });
  log.info("connect bound", { user: userTag(s.channel, s.channelUserId), owner: wallet, client: s.clientId, replaced: decision.replaces ? existing?.owner : undefined });
  return { ok: true, binding, alreadyBound: false };
}

/** Sessions a day past their expiry are gone; until then the page can still say "expired" rather than "unknown". */
export async function sweepSessions(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - 24 * 3_600_000);
  const rows = await db().delete(schema.connectSessions).where(lt(schema.connectSessions.expiresAt, cutoff)).returning({ h: schema.connectSessions.codeHash });
  return rows.length;
}

export async function countBindings(): Promise<number> {
  const rows = await db().select({ n: sql<number>`count(*)` }).from(schema.bindings);
  return Number(rows[0]?.n ?? 0);
}
