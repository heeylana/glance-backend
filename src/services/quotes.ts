/**
 * Chat quotes: a swap after every pre-check and the desk price, waiting for one confirmation in the
 * thread. Execute claims the row with one UPDATE … WHERE executed_at IS NULL, so a second "yes" or a
 * redelivered webhook cannot run it twice. A quote reserves nothing: caps, balance and the price band
 * are checked again at execute.
 */
import { randomBytes } from "node:crypto";
import bs58 from "bs58";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { env } from "../config.js";

export type TradeQuote = typeof schema.tradeQuotes.$inferSelect;
export const newQuoteId = () => bs58.encode(randomBytes(16));
export const quoteExpiry = (now = new Date()) => new Date(now.getTime() + env.QUOTE_TTL_SEC * 1000);

export type QuoteStatus = "open" | "expired" | "executed" | "failed";
export function quoteStatus(q: Pick<TradeQuote, "expiresAt" | "executedAt" | "ledgerId" | "failureCode">, now = new Date()): QuoteStatus {
  if (q.executedAt) return q.failureCode ? "failed" : "executed";
  return q.expiresAt.getTime() <= now.getTime() ? "expired" : "open";
}

export async function insertQuote(v: typeof schema.tradeQuotes.$inferInsert): Promise<TradeQuote> {
  return (await db().insert(schema.tradeQuotes).values(v).returning())[0]!;
}

export async function getQuote(id: string, owner: string): Promise<TradeQuote | null> {
  return (await db().select().from(schema.tradeQuotes).where(and(eq(schema.tradeQuotes.id, id), eq(schema.tradeQuotes.owner, owner))))[0] ?? null;
}

export type ClaimResult = { status: "claimed"; quote: TradeQuote } | { status: "expired" | "used" | "unknown"; quote: TradeQuote | null };

/** Take the quote for execution, once. Anyone else arriving sees why they could not. */
export async function claimQuote(id: string, owner: string, now = new Date()): Promise<ClaimResult> {
  const [claimed] = await db()
    .update(schema.tradeQuotes)
    .set({ executedAt: now })
    .where(and(eq(schema.tradeQuotes.id, id), eq(schema.tradeQuotes.owner, owner), isNull(schema.tradeQuotes.executedAt), gt(schema.tradeQuotes.expiresAt, now)))
    .returning();
  if (claimed) return { status: "claimed", quote: claimed };
  const q = await getQuote(id, owner);
  if (!q) return { status: "unknown", quote: null };
  return { status: q.executedAt ? "used" : "expired", quote: q };
}

export async function finishQuote(id: string, result: { ledgerId: number } | { failureCode: string }): Promise<void> {
  await db()
    .update(schema.tradeQuotes)
    .set("ledgerId" in result ? { ledgerId: result.ledgerId } : { failureCode: result.failureCode })
    .where(eq(schema.tradeQuotes.id, id));
}

export async function listQuotes(owner: string, limit = 20): Promise<TradeQuote[]> {
  return db().select().from(schema.tradeQuotes).where(eq(schema.tradeQuotes.owner, owner)).orderBy(desc(schema.tradeQuotes.createdAt)).limit(limit);
}

export async function countOpenQuotes(now = new Date()): Promise<number> {
  const rows = await db()
    .select({ n: sql<number>`count(*)` })
    .from(schema.tradeQuotes)
    .where(and(isNull(schema.tradeQuotes.executedAt), gt(schema.tradeQuotes.expiresAt, now)));
  return Number(rows[0]?.n ?? 0);
}
