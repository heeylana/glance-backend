/**
 * Devnet mocks, created on first use (ISSUER_MODE=mock only). The catalog lists ~930 real mainnet
 * tokens; devnet has none of them, so the first buy of a listing creates a Token-2022 mint that
 * mirrors it (same decimals; the mock issuer as permanent delegate when the real mint has one, none
 * when it is curation-only like Tessera), 10,000 tokens of desk inventory, and its AllowedMint on the
 * vault program. About 0.007 SOL from the payer, once per listing. On mainnet the catalog's own mints
 * trade and curation is an offline admin step; this module refuses to run there.
 */
import { Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  ExtensionType,
  LENGTH_SIZE,
  TOKEN_2022_PROGRAM_ID,
  TYPE_SIZE,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMetadataPointerInstruction,
  createInitializeMintInstruction,
  createInitializePermanentDelegateInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  getMintLen,
} from "@solana/spl-token";
import { createInitializeInstruction, pack, type TokenMetadata } from "@solana/spl-token-metadata";
import { env } from "../config.js";
import { recordMock, tradableFor, type MintEntry } from "../config/issuers.js";
import { connection } from "../lib/solana.js";
import { log } from "../lib/log.js";
import { GuardCode, GuardError } from "../lib/errors.js";
import { deskKeypair, loadKeypair, payerKeypair } from "./keys.js";
import { ensureAllowed } from "./curation.js";

const DESK_INVENTORY_TOKENS = 10_000n;
const inFlight = new Map<string, Promise<MintEntry>>();

/** Create a Token-2022 stock mint with metadata, and optionally a permanent delegate. Shared with setup-devnet. */
export async function createMockStockMint(p: { payer: Keypair; issuer: Keypair; decimals: number; name: string; symbol: string; withDelegate: boolean }): Promise<PublicKey> {
  const conn = connection();
  const mint = Keypair.generate();
  const metadata: TokenMetadata = { mint: mint.publicKey, name: p.name.slice(0, 32), symbol: p.symbol.slice(0, 10), uri: "", additionalMetadata: [], updateAuthority: p.issuer.publicKey };
  const extensions = [...(p.withDelegate ? [ExtensionType.PermanentDelegate] : []), ExtensionType.MetadataPointer];
  const mintLen = getMintLen(extensions);
  const lamports = await conn.getMinimumBalanceForRentExemption(mintLen + TYPE_SIZE + LENGTH_SIZE + pack(metadata).length);
  await sendAndConfirmTransaction(
    conn,
    new Transaction().add(
      SystemProgram.createAccount({ fromPubkey: p.payer.publicKey, newAccountPubkey: mint.publicKey, space: mintLen, lamports, programId: TOKEN_2022_PROGRAM_ID }),
      ...(p.withDelegate ? [createInitializePermanentDelegateInstruction(mint.publicKey, p.issuer.publicKey, TOKEN_2022_PROGRAM_ID)] : []),
      createInitializeMetadataPointerInstruction(mint.publicKey, p.issuer.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID),
      createInitializeMintInstruction(mint.publicKey, p.decimals, p.issuer.publicKey, null, TOKEN_2022_PROGRAM_ID),
      createInitializeInstruction({ programId: TOKEN_2022_PROGRAM_ID, mint: mint.publicKey, metadata: mint.publicKey, name: metadata.name, symbol: metadata.symbol, uri: "", mintAuthority: p.issuer.publicKey, updateAuthority: p.issuer.publicKey }),
    ),
    [p.payer, mint, p.issuer],
    { commitment: "confirmed" },
  );
  return mint.publicKey;
}

/** The entry that trades `listing` on this cluster, creating the devnet mock the first time. */
export function ensureTradable(listing: MintEntry): Promise<MintEntry> {
  const existing = tradableFor(listing.mint);
  if (existing) return Promise.resolve(existing);
  if (env.ISSUER_MODE !== "mock" || env.SOLANA_CLUSTER !== "devnet") {
    return Promise.reject(new GuardError(GuardCode.MINT_NOT_TOKENIZED, { companyName: listing.name }, "not tradable on this cluster"));
  }
  const pending = inFlight.get(listing.mint);
  if (pending) return pending;
  const job = (async () => {
    const t0 = Date.now();
    const payer = payerKeypair();
    const issuer = loadKeypair(".keys/issuer-authority.json");
    const desk = deskKeypair();
    const withDelegate = listing.issuerDelegate !== null;
    const mint = await createMockStockMint({ payer, issuer, decimals: listing.decimals, name: `${listing.name} (mock)`, symbol: listing.symbol, withDelegate });
    const deskAta = getAssociatedTokenAddressSync(mint, desk.publicKey, false, TOKEN_2022_PROGRAM_ID);
    await sendAndConfirmTransaction(
      connection(),
      new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, deskAta, desk.publicKey, mint, TOKEN_2022_PROGRAM_ID),
        createMintToInstruction(mint, deskAta, issuer.publicKey, DESK_INVENTORY_TOKENS * 10n ** BigInt(listing.decimals), [], TOKEN_2022_PROGRAM_ID),
      ),
      [payer, issuer],
      { commitment: "confirmed" },
    );
    await ensureAllowed(payer, mint, withDelegate ? issuer.publicKey : null);
    recordMock(mint.toBase58(), {
      ticker: listing.ticker,
      issuer: listing.issuer,
      decimals: listing.decimals,
      tokenProgram: "token-2022",
      referenceMint: listing.mint,
      issuerDelegate: withDelegate ? issuer.publicKey.toBase58() : null,
    });
    log.info("mock created", { symbol: listing.symbol, issuer: listing.issuer, mint: mint.toBase58(), referenceMint: listing.mint, curationOnly: !withDelegate, ms: Date.now() - t0 });
    return tradableFor(listing.mint)!;
  })().finally(() => inFlight.delete(listing.mint));
  inFlight.set(listing.mint, job);
  return job;
}
