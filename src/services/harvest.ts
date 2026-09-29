/**
 * Harvest devnet mocks the committed registry has lost (scripts/harvest-mocks.ts). A mock made on
 * first buy (services/mocks.ts) is recorded only in the running backend's registry file; on a host
 * without a volume that file resets on deploy, and the vault's position in that mint can no longer be
 * seen or sold. This finds those mints in a vault and rebuilds their entries from the chain, after
 * checking each one is really a Glance mock of a catalog listing. Read-only: it reads accounts, never
 * signs, and never loads a key (keys.ts would write a new key file for a missing one).
 */
import { PublicKey, type AccountInfo } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getMetadataPointerState, getPermanentDelegate, getTokenMetadata, unpackMint } from "@solana/spl-token";
import anchorPkg from "@coral-xyz/anchor";
import { readFileSync } from "node:fs";
import { connection } from "../lib/solana.js";
import { allowedMintPda, programId, vaultPda } from "./vault.js";
import type { MintEntry } from "../config/issuers.js";

const { BorshAccountsCoder } = anchorPkg;

/** Exactly what recordMock writes for a mock, key order included. */
export interface HarvestedEntry {
  ticker: string;
  issuer: string;
  decimals: number;
  tokenProgram: "token-2022";
  referenceMint: string;
  issuerDelegate: string | null;
}

/** What the chain says about one mint the vault holds. */
export interface OnChainMock {
  mint: string;
  owner: "token-2022" | "spl-token" | "other" | "missing";
  decimals: number | null;
  mintAuthority: string | null;
  permanentDelegate: string | null;
  metadata: { name: string; symbol: string; updateAuthority: string | null } | null;
  /** The vault program's AllowedMint for this mint: null when there is none. */
  allowed: { mint: string; issuerDelegate: string | null } | null;
}

export type Verdict = { ok: true; entry: HarvestedEntry; listing: MintEntry } | { ok: false; reasons: string[] };

/**
 * Is `m` a Glance mock of a catalog listing, made by `mockIssuer`? Every check mirrors what
 * services/mocks.ts does when it creates one, so a mint only passes if the backend could have made it.
 */
export function judgeMock(m: OnChainMock, catalog: MintEntry[], mockIssuer: string): Verdict {
  if (m.owner !== "token-2022") return { ok: false, reasons: [`not a Token-2022 mint (${m.owner})`] };
  if (!m.metadata) return { ok: false, reasons: ["no metadata on the mint, so no symbol to match a listing"] };
  // Mocks are named "<listing name> (mock)" and carry the listing's symbol, both clipped as createMockStockMint clips them.
  const bySymbol = catalog.filter((l) => l.symbol.slice(0, 10) === m.metadata!.symbol);
  if (bySymbol.length === 0) return { ok: false, reasons: [`metadata symbol ${m.metadata.symbol} matches no catalog listing`] };
  const byName = bySymbol.filter((l) => `${l.name} (mock)`.slice(0, 32) === m.metadata!.name);
  const candidates = byName.length > 0 ? byName : bySymbol;
  if (candidates.length > 1) return { ok: false, reasons: [`metadata symbol ${m.metadata.symbol} matches ${candidates.length} listings: ${candidates.map((l) => `${l.issuer} ${l.mint}`).join(", ")}`] };
  const listing = candidates[0]!;

  const expectedDelegate = listing.issuerDelegate !== null ? mockIssuer : null;
  const reasons: string[] = [];
  if (m.decimals !== listing.decimals) reasons.push(`decimals ${m.decimals}, listing has ${listing.decimals}`);
  if (m.permanentDelegate !== expectedDelegate) reasons.push(`permanent delegate ${m.permanentDelegate ?? "none"}, expected ${expectedDelegate ?? "none (curation-only listing)"}`);
  if (m.mintAuthority !== mockIssuer) reasons.push(`mint authority ${m.mintAuthority ?? "none"}, expected the mock issuer ${mockIssuer}`);
  if (m.metadata.updateAuthority !== mockIssuer) reasons.push(`metadata update authority ${m.metadata.updateAuthority ?? "none"}, expected the mock issuer`);
  if (!m.allowed) reasons.push("no AllowedMint on the vault program: the vault could not trade it");
  else {
    if (m.allowed.mint !== m.mint) reasons.push(`AllowedMint names mint ${m.allowed.mint}`);
    if (m.allowed.issuerDelegate !== expectedDelegate) reasons.push(`AllowedMint issuer rule ${m.allowed.issuerDelegate ?? "none"}, expected ${expectedDelegate ?? "none"}`);
  }
  if (reasons.length > 0) return { ok: false, reasons };
  return {
    ok: true,
    listing,
    entry: { ticker: listing.ticker, issuer: listing.issuer, decimals: listing.decimals, tokenProgram: "token-2022", referenceMint: listing.mint, issuerDelegate: expectedDelegate },
  };
}

let coder: InstanceType<typeof BorshAccountsCoder> | null = null;
function decodeAllowed(info: AccountInfo<Buffer> | null): OnChainMock["allowed"] {
  if (!info || !info.owner.equals(programId())) return null;
  coder ??= new BorshAccountsCoder(JSON.parse(readFileSync(new URL("../idl/glance_vault.json", import.meta.url), "utf8")));
  try {
    const a = coder.decode("AllowedMint", info.data) as { mint: PublicKey; issuerDelegate?: PublicKey | null; issuer_delegate?: PublicKey | null };
    const d = a.issuerDelegate ?? a.issuer_delegate ?? null;
    return { mint: a.mint.toBase58(), issuerDelegate: d ? d.toBase58() : null };
  } catch {
    return null;
  }
}

/** Read one mint and its AllowedMint from the chain. */
export async function readMock(mint: string): Promise<OnChainMock> {
  const pk = new PublicKey(mint);
  const [info, allowedInfo] = await connection().getMultipleAccountsInfo([pk, allowedMintPda(pk)]);
  const base: OnChainMock = { mint, owner: "missing", decimals: null, mintAuthority: null, permanentDelegate: null, metadata: null, allowed: decodeAllowed(allowedInfo ?? null) };
  if (!info) return base;
  if (info.owner.equals(TOKEN_PROGRAM_ID)) return { ...base, owner: "spl-token" };
  if (!info.owner.equals(TOKEN_2022_PROGRAM_ID)) return { ...base, owner: "other" };
  const m = unpackMint(pk, info, TOKEN_2022_PROGRAM_ID);
  let metadata: OnChainMock["metadata"] = null;
  const ptr = getMetadataPointerState(m);
  if (ptr?.metadataAddress?.equals(pk)) {
    const md = await getTokenMetadata(connection(), pk, "confirmed", TOKEN_2022_PROGRAM_ID).catch(() => null);
    if (md) metadata = { name: md.name, symbol: md.symbol, updateAuthority: md.updateAuthority?.toBase58() ?? null };
  }
  return {
    ...base,
    owner: "token-2022",
    decimals: m.decimals,
    mintAuthority: m.mintAuthority?.toBase58() ?? null,
    permanentDelegate: getPermanentDelegate(m)?.delegate.toBase58() ?? null,
    metadata,
  };
}

/** Every token account the vault owns, in either token program: mint and raw balance. */
export async function vaultHoldings(owner: PublicKey): Promise<{ vault: string; vaultExists: boolean; holdings: { mint: string; amount: string; program: string }[] }> {
  const vault = vaultPda(owner);
  const conn = connection();
  const [info, ...lists] = await Promise.all([
    conn.getAccountInfo(vault),
    ...[TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].map((programId) => conn.getParsedTokenAccountsByOwner(vault, { programId })),
  ]);
  const holdings = lists.flatMap((l, i) =>
    l.value.map((a) => {
      const t = (a.account.data as { parsed: { info: { mint: string; tokenAmount: { amount: string } } } }).parsed.info;
      return { mint: t.mint, amount: t.tokenAmount.amount, program: i === 0 ? "spl-token" : "token-2022" };
    }),
  );
  return { vault: vault.toBase58(), vaultExists: !!info?.owner.equals(programId()), holdings };
}
