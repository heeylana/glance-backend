import { bigint, boolean, index, integer, numeric, pgTable, primaryKey, serial, text, timestamp } from "drizzle-orm/pg-core";
export { integer };

/** One row per wallet owner. `id` and `walletAddress` are both the owner's Solana pubkey. */
export const users = pgTable("users", {
  id: text("id").primaryKey(), // owner pubkey
  walletAddress: text("wallet_address").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Server-side flags only. Policy (agent, caps, expiry, on-chain pause) lives in the vault
 * account; `paused` here is the instant off-switch the backend honours before it even
 * builds a transaction (spec §8.4: both, so either failing still stops trades).
 */
export const sessions = pgTable("sessions", {
  userId: text("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  paused: boolean("paused").notNull().default(false),
  counterViewEnabled: boolean("counter_view_enabled").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Every delegated transaction attempt. Doubles as the activity log (§8.4) and the daily-cap ledger (§8.3 guard 5). */
export const spendLedger = pgTable(
  "spend_ledger",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    side: text("side", { enum: ["buy", "sell"] }).notNull(),
    inputMint: text("input_mint").notNull(),
    outputMint: text("output_mint").notNull(),
    amountIn: bigint("amount_in", { mode: "bigint" }).notNull(),
    amountOut: bigint("amount_out", { mode: "bigint" }),
    /** USDC value of the trade, for the cap window (equals amountIn for buys). */
    usdcValue: bigint("usdc_value", { mode: "bigint" }).notNull(),
    quotedUsdPerShare: numeric("quoted_usd_per_share", { precision: 18, scale: 6 }),
    pythUsdPerShare: numeric("pyth_usd_per_share", { precision: 18, scale: 6 }),
    signature: text("signature"),
    status: text("status", { enum: ["pending", "confirmed", "failed"] }).notNull().default("pending"),
    failureCode: text("failure_code"),
    headline: text("headline"),
    url: text("url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  },
  (t) => [index("spend_ledger_user_created_idx").on(t.userId, t.createdAt)],
);

/** Thesis journal: "Headlines you own" (§7.7). */
export const journal = pgTable(
  "journal",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    ledgerId: integer("ledger_id").references(() => spendLedger.id, { onDelete: "set null" }),
    companyId: text("company_id").notNull(),
    ticker: text("ticker").notNull(),
    mint: text("mint").notNull(),
    url: text("url").notNull(),
    title: text("title").notNull(),
    site: text("site"),
    screenshotHash: text("screenshot_hash"),
    amountUsdc: bigint("amount_usdc", { mode: "bigint" }).notNull(),
    priceUsd: numeric("price_usd", { precision: 18, scale: 6 }).notNull(),
    sharesRaw: bigint("shares_raw", { mode: "bigint" }),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("journal_user_created_idx").on(t.userId, t.createdAt)],
);

/** "Waiting on the headline": glanced but not tokenized yet (§7.7). */
export const watchlist = pgTable(
  "watchlist",
  {
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    companyId: text("company_id").notNull(),
    ticker: text("ticker").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.userId, t.companyId] })],
);

/** Hourly Pyth samples for "since this was published" (§9 indexer). */
export const priceHistory = pgTable(
  "price_history",
  {
    feedId: text("feed_id").notNull(),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    priceUsd: numeric("price_usd", { precision: 18, scale: 6 }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.feedId, t.ts] })],
);
