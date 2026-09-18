/**
 * Devnet test money (spec §7.2 step 3). Anyone may `deposit` into a vault, so the
 * payer can fund a user's vault directly with no wallet signature. If the vault
 * does not exist yet, the USDC goes to the owner's wallet so `initialize_vault`
 * can deposit it. A sliver of SOL goes to the owner for their own signatures.
 *
 *   USDC source: mint when the payer is the mint authority (mock USDC), else the
 *   payer's float of real devnet USDC (fill it at https://faucet.circle.com).
 */
import { PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  createTransferCheckedInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";
import { env } from "../config.js";
import { connection } from "../lib/solana.js";
import { GuardCode, GuardError } from "../lib/errors.js";
import { usdToUsdc, usdcToUsd } from "../lib/amounts.js";
import { log } from "../lib/log.js";
import { payerKeypair } from "./keys.js";
import { fetchVault, ixDeposit } from "./vault.js";

const SOL_TOPUP_LAMPORTS = 20_000_000; // 0.02 SOL
const SOL_TOPUP_BELOW = 10_000_000;

export interface FundResult {
  signature: string;
  usd: number;
  solToppedUp: boolean;
  destination: "vault" | "wallet";
  source: "mint" | "float";
}

export async function fundTestMoney(owner: PublicKey, usd: number): Promise<FundResult> {
  if (env.SOLANA_CLUSTER !== "devnet") throw new GuardError(GuardCode.BAD_REQUEST, {}, "funding is only available on devnet");
  const conn = connection();
  const payer = payerKeypair();
  const mint = new PublicKey(env.USDC_MINT);
  const amount = usdToUsdc(usd);
  const payerAta = getAssociatedTokenAddressSync(mint, payer.publicKey, false, TOKEN_PROGRAM_ID);
  const mintInfo = await getMint(conn, mint, "confirmed", TOKEN_PROGRAM_ID);
  const canMint = !!mintInfo.mintAuthority && mintInfo.mintAuthority.equals(payer.publicKey);

  const tx = new Transaction();
  tx.add(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, payerAta, payer.publicKey, mint, TOKEN_PROGRAM_ID));
  let source: FundResult["source"];
  if (canMint) {
    tx.add(createMintToInstruction(mint, payerAta, payer.publicKey, amount, [], TOKEN_PROGRAM_ID));
    source = "mint";
  } else {
    let float = 0n;
    try {
      float = (await getAccount(conn, payerAta, "confirmed", TOKEN_PROGRAM_ID)).amount;
    } catch {
      float = 0n;
    }
    if (float < amount) {
      log.error("devnet USDC float too low", { payer: payer.publicKey.toBase58(), floatUsd: usdcToUsd(float), requestedUsd: usd, faucet: "https://faucet.circle.com" });
      await topUpSol(owner).catch(() => undefined);
      throw new GuardError(GuardCode.FUNDING_UNAVAILABLE, {}, `payer ${payer.publicKey.toBase58()} holds ${usdcToUsd(float)} devnet USDC; fund it at https://faucet.circle.com`);
    }
    source = "float";
  }

  const vault = await fetchVault(owner);
  let destination: FundResult["destination"];
  if (vault) {
    tx.add(await ixDeposit({ depositor: payer.publicKey, owner, mint, tokenProgram: TOKEN_PROGRAM_ID, amount }));
    destination = "vault";
  } else {
    const ownerAta = getAssociatedTokenAddressSync(mint, owner, false, TOKEN_PROGRAM_ID);
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ownerAta, owner, mint, TOKEN_PROGRAM_ID),
      createTransferCheckedInstruction(payerAta, mint, ownerAta, payer.publicKey, amount, mintInfo.decimals, [], TOKEN_PROGRAM_ID),
    );
    destination = "wallet";
  }

  let solToppedUp = false;
  const lamports = await conn.getBalance(owner, "confirmed");
  if (lamports < SOL_TOPUP_BELOW && !owner.equals(payer.publicKey)) {
    tx.add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: owner, lamports: SOL_TOPUP_LAMPORTS }));
    solToppedUp = true;
  }

  const signature = await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
  log.info("funded test money", { owner: owner.toBase58(), usd, destination, source, solToppedUp, signature });
  return { signature, usd, solToppedUp, destination, source };
}

async function topUpSol(owner: PublicKey) {
  const conn = connection();
  const payer = payerKeypair();
  if ((await conn.getBalance(owner, "confirmed")) >= SOL_TOPUP_BELOW || owner.equals(payer.publicKey)) return;
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: owner, lamports: SOL_TOPUP_LAMPORTS }));
  await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
}
