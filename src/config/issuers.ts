import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";
import { env } from "../config.js";
import type { IssuerRule } from "../guards/issuer.js";

/**
 * The issuer registry: which stock tokens exist (the catalog) and which of them can be traded on this
 * cluster. The catalog (catalog.json, from scripts/refresh-catalog.ts) lists every xStocks, PreStocks
 * and Tessera token on Solana mainnet. In `registry` mode those mainnet mints are what trades; in
 * `mock` mode (devnet) each listing trades through a mock mint that mirrors it, created on first use
 * (services/mocks.ts) and recorded in issuers.mock.json with its `referenceMint`.
 */

const Kind = z.enum(["stock", "etf", "pre-ipo"]);
const Listing = z.object({
  mint: z.string(),
  symbol: z.string(),
  ticker: z.string(),
  name: z.string(),
  issuer: z.string(),
  kind: Kind,
  decimals: z.number().int().min(0).max(12),
  tokenProgram: z.enum(["spl-token", "token-2022"]),
  issuerDelegate: z.string().nullable(),
  pythFeedId: z.string().optional(),
  pythTokenFeedId: z.string().optional(),
  pythIndexFeedId: z.string().optional(),
  ambiguousName: z.boolean().optional(),
  ambiguousTicker: z.boolean().optional(),
  about: z.string().optional(),
});
const Catalog = z.object({ generatedAt: z.string(), listings: z.array(Listing) });

const MockEntry = z.object({
  ticker: z.string(),
  issuer: z.string(),
  decimals: z.number().int().min(0).max(12),
  tokenProgram: z.enum(["spl-token", "token-2022"]).default("token-2022"),
  /** The mainnet listing this mock mirrors (its catalog mint). */
  referenceMint: z.string(),
  /** Pyth ids from before the catalog; the catalog's win when both exist. */
  pythFeedId: z.string().optional(),
  pythTokenFeedId: z.string().optional(),
  /** The mock's permanent delegate (the mock issuer authority), or null for a curation-only listing. */
  issuerDelegate: z.string().nullable().optional(),
});
const Registry = z.object({
  stableMints: z.array(z.string()).min(1),
  rules: z.array(z.object({ issuer: z.string(), method: z.enum(["mint_authority", "metadata_update_authority", "permanent_delegate", "mint_allowlist"]), address: z.string() })),
  mints: z.record(z.string(), MockEntry).default({}),
});

/** One token: a catalog listing (mainnet mint), or the tradable entry on this cluster (a mock on devnet). */
export interface MintEntry {
  mint: string;
  /** Mock mode: the mainnet mint this entry mirrors, used for prices and for its listing. */
  referenceMint?: string;
  ticker: string;
  symbol: string;
  name: string;
  issuer: string;
  kind: z.infer<typeof Kind>;
  decimals: number;
  tokenProgram: "spl-token" | "token-2022";
  issuerDelegate: string | null;
  /** Equity.US.<T>/USD: the share, market hours. */
  pythFeedId?: string;
  /** Crypto.<T>X/USD: the xStock token itself, 24/7. */
  pythTokenFeedId?: string;
  /** Pyth.Index.<NAME>/USD: a pre-IPO index. */
  pythIndexFeedId?: string;
  ambiguousName?: boolean;
  ambiguousTicker?: boolean;
  about?: string;
}

export interface IssuerRegistry {
  mode: "mock" | "registry";
  stableMints: string[];
  rules: IssuerRule[];
  /** Tradable on this cluster, by the cluster's mint. */
  byMint: Map<string, MintEntry>;
  /** The first tradable entry per company ticker. */
  byTicker: Map<string, MintEntry>;
  /** Every token Glance knows, by mainnet mint. */
  listings: Map<string, MintEntry>;
  /** Every token of a company, most tradable first. */
  listingsByTicker: Map<string, MintEntry[]>;
  file: string;
}

const here = dirname(fileURLToPath(import.meta.url));
export const CATALOG_FILE = join(here, "catalog.json");

export function registryPath(mode = env.ISSUER_MODE): string {
  return join(here, mode === "mock" ? "issuers.mock.json" : "issuers.mainnet.json");
}

/** Issuers people trade most first on a company's card; within one, by symbol. */
const ISSUER_ORDER = ["xStocks", "PreStocks", "Tessera"];
const byIssuer = (a: MintEntry, b: MintEntry) => (ISSUER_ORDER.indexOf(a.issuer) + 1 || 99) - (ISSUER_ORDER.indexOf(b.issuer) + 1 || 99) || a.symbol.localeCompare(b.symbol);

let cached: IssuerRegistry | null = null;

export function loadCatalog(): MintEntry[] {
  return Catalog.parse(JSON.parse(readFileSync(CATALOG_FILE, "utf8"))).listings.map((l) => ({ ...l, pythFeedId: norm(l.pythFeedId), pythTokenFeedId: norm(l.pythTokenFeedId), pythIndexFeedId: norm(l.pythIndexFeedId) }));
}
const norm = (id: string | undefined) => id?.replace(/^0x/, "").toLowerCase();

export function loadRegistry(force = false): IssuerRegistry {
  if (cached && !force) return cached;
  const file = registryPath();
  const raw = Registry.parse(JSON.parse(readFileSync(file, "utf8")));
  const listings = new Map(loadCatalog().map((l) => [l.mint, l]));

  const byMint = new Map<string, MintEntry>();
  const rules: IssuerRule[] = [...raw.rules];
  if (env.ISSUER_MODE === "mock") {
    for (const [mint, m] of Object.entries(raw.mints)) {
      const listing = listings.get(m.referenceMint);
      const base: MintEntry = listing ?? {
        mint: m.referenceMint,
        symbol: `${m.ticker}x`,
        ticker: m.ticker,
        name: m.ticker,
        issuer: m.issuer,
        kind: "stock",
        decimals: m.decimals,
        tokenProgram: m.tokenProgram,
        issuerDelegate: null,
      };
      byMint.set(mint, {
        ...base,
        mint,
        referenceMint: m.referenceMint,
        decimals: m.decimals,
        tokenProgram: m.tokenProgram,
        issuerDelegate: m.issuerDelegate ?? null,
        pythFeedId: base.pythFeedId ?? norm(m.pythFeedId),
        pythTokenFeedId: base.pythTokenFeedId ?? norm(m.pythTokenFeedId),
      });
      // Belt and braces: every mock is also pinned by mint.
      rules.push({ issuer: base.issuer, method: "mint_allowlist", address: mint });
    }
  } else {
    const delegates = new Set<string>();
    for (const l of listings.values()) {
      byMint.set(l.mint, l);
      if (l.issuerDelegate && !delegates.has(`${l.issuer}:${l.issuerDelegate}`)) {
        delegates.add(`${l.issuer}:${l.issuerDelegate}`);
        rules.push({ issuer: l.issuer, method: "permanent_delegate", address: l.issuerDelegate });
      }
      // Curation-only issuers (Tessera) are recognised by exact mint.
      if (!l.issuerDelegate) rules.push({ issuer: l.issuer, method: "mint_allowlist", address: l.mint });
    }
  }

  const byTicker = new Map<string, MintEntry>();
  for (const e of [...byMint.values()].sort(byIssuer)) if (!byTicker.has(e.ticker)) byTicker.set(e.ticker, e);
  const listingsByTicker = new Map<string, MintEntry[]>();
  for (const l of listings.values()) listingsByTicker.set(l.ticker, [...(listingsByTicker.get(l.ticker) ?? []), l]);
  for (const list of listingsByTicker.values()) list.sort(byIssuer);

  cached = { mode: env.ISSUER_MODE, stableMints: raw.stableMints, rules, byMint, byTicker, listings, listingsByTicker, file };
  return cached;
}

/** The entry that trades a listing on this cluster, if there is one yet. */
export function tradableFor(listingMint: string): MintEntry | null {
  const reg = loadRegistry();
  if (reg.mode === "registry") return reg.byMint.get(listingMint) ?? null;
  for (const e of reg.byMint.values()) if (e.referenceMint === listingMint) return e;
  return null;
}

/** Record a devnet mock (services/mocks.ts) and reload. */
export function recordMock(mockMint: string, entry: z.input<typeof MockEntry>) {
  const file = registryPath("mock");
  const raw = JSON.parse(readFileSync(file, "utf8")) as { mints: Record<string, unknown> };
  raw.mints[mockMint] = entry;
  writeFileSync(file, JSON.stringify(raw, null, 2) + "\n");
  cached = null;
}

/** A price-history key for entries with and without a Pyth feed. */
export const priceKey = (e: MintEntry) => e.pythFeedId ?? `mint:${e.referenceMint ?? e.mint}`;

/** A mint is buyable only if it is curated in the registry AND passes the issuer authority check at trade time. */
export function isCurated(mint: string): boolean {
  return loadRegistry().byMint.has(mint);
}
