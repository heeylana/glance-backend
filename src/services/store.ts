import { and, desc, eq, gt } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { DAY_MS, spentInWindow, type LedgerRow } from "../guards/caps.js";

export type User = typeof schema.users.$inferSelect;
export type Session = typeof schema.sessions.$inferSelect;
export type Ledger = typeof schema.spendLedger.$inferSelect;

/** First sight of an owner pubkey: create the user row and the server-side flags row. */
export async function ensureUser(owner: string): Promise<{ user: User; session: Session }> {
  const d = db();
  let user = (await d.select().from(schema.users).where(eq(schema.users.id, owner)))[0];
  if (!user) {
    const inserted = (await d.insert(schema.users).values({ id: owner, walletAddress: owner }).onConflictDoNothing().returning())[0];
    user = inserted ?? (await d.select().from(schema.users).where(eq(schema.users.id, owner)))[0];
    if (!user) throw new Error(`could not create user row for ${owner}`);
  }
  let session = (await d.select().from(schema.sessions).where(eq(schema.sessions.userId, owner)))[0];
  if (!session) {
    session =
      (await d.insert(schema.sessions).values({ userId: owner }).onConflictDoNothing().returning())[0] ??
      (await d.select().from(schema.sessions).where(eq(schema.sessions.userId, owner)))[0]!;
  }
  return { user, session };
}

export async function getSession(userId: string): Promise<Session | undefined> {
  return (await db().select().from(schema.sessions).where(eq(schema.sessions.userId, userId)))[0];
}

export async function updateSession(userId: string, patch: Partial<typeof schema.sessions.$inferInsert>): Promise<Session> {
  return (
    await db()
      .update(schema.sessions)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(schema.sessions.userId, userId))
      .returning()
  )[0]!;
}

/** Trailing-24h buy spend for guard 5. */
export async function buySpendInWindow(userId: string, now = new Date()): Promise<bigint> {
  const rows = await db()
    .select({ amountIn: schema.spendLedger.usdcValue, createdAt: schema.spendLedger.createdAt, status: schema.spendLedger.status })
    .from(schema.spendLedger)
    .where(
      and(
        eq(schema.spendLedger.userId, userId),
        eq(schema.spendLedger.side, "buy"),
        gt(schema.spendLedger.createdAt, new Date(now.getTime() - DAY_MS)),
      ),
    );
  return spentInWindow(rows as LedgerRow[], now);
}

export async function insertLedger(v: typeof schema.spendLedger.$inferInsert): Promise<Ledger> {
  return (await db().insert(schema.spendLedger).values(v).returning())[0]!;
}

export async function updateLedger(id: number, patch: Partial<typeof schema.spendLedger.$inferInsert>): Promise<Ledger> {
  return (await db().update(schema.spendLedger).set(patch).where(eq(schema.spendLedger.id, id)).returning())[0]!;
}

export async function listActivity(userId: string, limit = 50): Promise<Ledger[]> {
  return db()
    .select()
    .from(schema.spendLedger)
    .where(eq(schema.spendLedger.userId, userId))
    .orderBy(desc(schema.spendLedger.createdAt))
    .limit(limit);
}

export async function insertJournal(v: typeof schema.journal.$inferInsert) {
  return (await db().insert(schema.journal).values(v).returning())[0]!;
}

export async function listJournal(userId: string) {
  return db().select().from(schema.journal).where(eq(schema.journal.userId, userId)).orderBy(desc(schema.journal.createdAt));
}

export async function deleteJournal(userId: string, id?: number) {
  const where = id === undefined ? eq(schema.journal.userId, userId) : and(eq(schema.journal.userId, userId), eq(schema.journal.id, id));
  await db().delete(schema.journal).where(where);
}

export async function updateJournalNote(userId: string, id: number, note: string | null) {
  return (
    await db()
      .update(schema.journal)
      .set({ note })
      .where(and(eq(schema.journal.userId, userId), eq(schema.journal.id, id)))
      .returning()
  )[0];
}

export async function addWatch(userId: string, companyId: string, ticker: string) {
  await db().insert(schema.watchlist).values({ userId, companyId, ticker }).onConflictDoNothing();
}
export async function listWatch(userId: string) {
  return db().select().from(schema.watchlist).where(eq(schema.watchlist.userId, userId));
}
export async function removeWatch(userId: string, companyId: string) {
  await db().delete(schema.watchlist).where(and(eq(schema.watchlist.userId, userId), eq(schema.watchlist.companyId, companyId)));
}
