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

// ---------------------------------------------------------------- The Glance API (/v1), chat clients
// doc/glance-whatsapp-bot-implementation-checklist.md §1.2. A "channel user" is a person on a chat channel
// (whatsapp:<wa_id>, telegram:<user id>); a binding ties one to an owner wallet after a signed connect.

/** One connect link. The code itself is never stored, only its sha256; it lives 15 minutes and is spent once. */
export const connectSessions = pgTable(
  "connect_sessions",
  {
    codeHash: text("code_hash").primaryKey(),
    clientId: text("client_id").notNull(),
    channel: text("channel").notNull(),
    channelUserId: text("channel_user_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** Set at verify: the wallet that signed the connect message. */
    wallet: text("wallet"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("connect_sessions_expires_idx").on(t.expiresAt)],
);

/** Channel user → owner wallet. One per channel user; a replaced row keeps `replaced_at` for the record. */
export const bindings = pgTable(
  "bindings",
  {
    channel: text("channel").notNull(),
    channelUserId: text("channel_user_id").notNull(),
    clientId: text("client_id").notNull(),
    owner: text("owner").notNull().references(() => users.id, { onDelete: "cascade" }),
    /** The spec's default: every chat buy or sell is confirmed once in the thread. Off brings chat in line with the extension. */
    confirmEachTrade: boolean("confirm_each_trade").notNull().default(true),
    /** The signed connect message, kept for the record of who tied this number to this wallet. */
    connectMessage: text("connect_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    replacedAt: timestamp("replaced_at", { withTimezone: true }),
    /** Last agent-expiry warning sent, so the hourly scan warns once per threshold. */
    warnedExpiryAt: timestamp("warned_expiry_at", { withTimezone: true }),
    warnedExpiryFor: text("warned_expiry_for"),
  },
  (t) => [primaryKey({ columns: [t.channel, t.channelUserId] }), index("bindings_owner_idx").on(t.owner)],
);

/** A chat quote: the swap as pre-checked and priced, waiting for one confirmation. Not a reservation. */
export const tradeQuotes = pgTable(
  "trade_quotes",
  {
    id: text("id").primaryKey(),
    owner: text("owner").notNull().references(() => users.id, { onDelete: "cascade" }),
    side: text("side", { enum: ["buy", "sell"] }).notNull(),
    stockMint: text("stock_mint").notNull(),
    ticker: text("ticker").notNull(),
    companyName: text("company_name").notNull(),
    usd: numeric("usd", { precision: 18, scale: 2 }).notNull(),
    amountInRaw: bigint("amount_in_raw", { mode: "bigint" }).notNull(),
    estAmountOutRaw: bigint("est_amount_out_raw", { mode: "bigint" }).notNull(),
    quotedUsdPerShare: numeric("quoted_usd_per_share", { precision: 18, scale: 6 }).notNull(),
    remainingTodayUsd: numeric("remaining_today_usd", { precision: 18, scale: 2 }).notNull(),
    maxSlippageBps: integer("max_slippage_bps").notNull(),
    context: text("context"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    executedAt: timestamp("executed_at", { withTimezone: true }),
    ledgerId: integer("ledger_id").references(() => spendLedger.id, { onDelete: "set null" }),
    failureCode: text("failure_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("trade_quotes_owner_created_idx").on(t.owner, t.createdAt)],
);

/** A chat image: the normalized copy on disk under IMAGE_DIR, gone 24 hours after receipt. The read is cached on the row. */
export const images = pgTable(
  "images",
  {
    id: text("id").primaryKey(),
    owner: text("owner").notNull().references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["original", "annotated"] }).notNull().default("original"),
    mime: text("mime").notNull(),
    sha256: text("sha256").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    bytes: integer("bytes").notNull(),
    path: text("path").notNull(),
    read: text("read"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("images_expires_idx").on(t.expiresAt), index("images_owner_created_idx").on(t.owner, t.createdAt)],
);
