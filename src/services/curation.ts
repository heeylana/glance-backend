/**
 * On-chain curation (vault program v2): each tradable stock mint has an AllowedMint account with its
 * issuer rule. Creating one is an admin action. On devnet the admin is the payer key; on mainnet it
 * is an offline, multisig step, and this module is only used by scripts and devnet mocks.
 */
import { PublicKey, Transaction, sendAndConfirmTransaction, type Keypair } from "@solana/web3.js";
import { connection } from "../lib/solana.js";
import { log } from "../lib/log.js";
import { fetchAllowedMint, ixAllowMint } from "./vault.js";

/** Curate `mint` if it is not already; resolves true when it is curated with exactly this issuer rule. */
export async function ensureAllowed(admin: Keypair, mint: PublicKey, issuerDelegate: PublicKey | null): Promise<boolean> {
  const existing = await fetchAllowedMint(mint);
  if (existing) {
    const same = (existing.issuerDelegate?.toBase58() ?? null) === (issuerDelegate?.toBase58() ?? null);
    if (!same) log.warn("mint is curated with a different issuer rule; leaving it", { mint: mint.toBase58(), onChain: existing.issuerDelegate?.toBase58() ?? null });
    return same;
  }
  const ix = await ixAllowMint(admin.publicKey, mint, issuerDelegate);
  const sig = await sendAndConfirmTransaction(connection(), new Transaction().add(ix), [admin], { commitment: "confirmed" });
  log.info("mint allowed", { mint: mint.toBase58(), issuerDelegate: issuerDelegate?.toBase58() ?? null, sig });
  return true;
}
