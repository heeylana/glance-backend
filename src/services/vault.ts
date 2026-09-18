/**
 * Anchor client for the GlanceVault program (glance-vault/). Reads vault and
 * config state, builds instructions for owner-signed transactions (the web
 * console signs them with Phantom) and for the agent-signed swap.
 */
import { readFileSync } from "node:fs";
// @coral-xyz/anchor ships CJS without an exports map; under Node ESM only the default import reliably carries BN and Wallet.
import anchorPkg from "@coral-xyz/anchor";
import type { IdlAccounts, Program as ProgramT } from "@coral-xyz/anchor";
const { AnchorProvider, Program, BN, Wallet } = anchorPkg;
import { PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import type { GlanceVault } from "../idl/glance_vault.js";
import { env } from "../config.js";
import { connection } from "../lib/solana.js";
import { agentKeypair } from "./keys.js";

const BPF_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
export const DAY_SECS = 86_400;

let _program: ProgramT<GlanceVault> | null = null;
export function program(): ProgramT<GlanceVault> {
  if (_program) return _program;
  const idl = JSON.parse(readFileSync(new URL("../idl/glance_vault.json", import.meta.url), "utf8")) as GlanceVault;
  (idl as unknown as { address: string }).address = env.VAULT_PROGRAM_ID;
  const provider = new AnchorProvider(connection(), new Wallet(agentKeypair()), { commitment: "confirmed", preflightCommitment: "confirmed" });
  _program = new Program<GlanceVault>(idl, provider);
  return _program;
}

export const programId = () => new PublicKey(env.VAULT_PROGRAM_ID);
export const configPda = () => PublicKey.findProgramAddressSync([Buffer.from("config")], programId())[0];
/** A curated stock mint's allowance (program v2): one account per mint, created by the admin. */
export const allowedMintPda = (mint: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("allowed"), mint.toBuffer()], programId())[0];
export const vaultPda = (owner: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("vault"), owner.toBuffer()], programId())[0];
export const programDataPda = () => PublicKey.findProgramAddressSync([programId().toBuffer()], BPF_UPGRADEABLE)[0];
export const ata = (mint: PublicKey, owner: PublicKey, tokenProgram: PublicKey) => getAssociatedTokenAddressSync(mint, owner, true, tokenProgram);

export type VaultAccount = IdlAccounts<GlanceVault>["vault"];
export type ConfigAccount = IdlAccounts<GlanceVault>["config"];

export async function fetchVault(owner: PublicKey): Promise<VaultAccount | null> {
  return program().account.vault.fetchNullable(vaultPda(owner));
}
export async function fetchConfig(): Promise<ConfigAccount | null> {
  return program().account.config.fetchNullable(configPda());
}
export type AllowedMintAccount = IdlAccounts<GlanceVault>["allowedMint"];
export async function fetchAllowedMint(mint: PublicKey): Promise<AllowedMintAccount | null> {
  return program().account.allowedMint.fetchNullable(allowedMintPda(mint));
}
/** Admin: curate a stock mint with its issuer rule (a required permanent delegate, or null for curation only). */
export const ixAllowMint = (admin: PublicKey, mint: PublicKey, issuerDelegate: PublicKey | null) =>
  program().methods.allowMint(issuerDelegate).accountsPartial({ config: configPda(), admin, mint, allowedMint: allowedMintPda(mint), systemProgram: SystemProgram.programId }).instruction();

/** Mirror of the program's rolling-window rule: what the chain will count as spent if a buy lands now. */
export function effectiveDailySpent(v: VaultAccount, nowSec: number): bigint {
  const start = Number(v.dailyWindowStart);
  return nowSec - start >= DAY_SECS ? 0n : BigInt(v.dailySpent.toString());
}

export interface VaultView {
  exists: boolean;
  address: string;
  owner: string;
  paused: boolean;
  agent: string | null;
  agentIsGlance: boolean;
  agentExpiresAt: number; // unix seconds, 0 = none
  agentActive: boolean;
  perTxCap: bigint;
  dailyCap: bigint;
  dailySpent: bigint;
  maxSlippageBps: number;
}

export function viewOf(owner: PublicKey, v: VaultAccount | null, nowSec = Math.floor(Date.now() / 1000)): VaultView {
  if (!v) {
    return { exists: false, address: vaultPda(owner).toBase58(), owner: owner.toBase58(), paused: false, agent: null, agentIsGlance: false, agentExpiresAt: 0, agentActive: false, perTxCap: 0n, dailyCap: 0n, dailySpent: 0n, maxSlippageBps: 0 };
  }
  const agent = v.agent.equals(PublicKey.default) ? null : v.agent.toBase58();
  const agentIsGlance = agent === agentKeypair().publicKey.toBase58();
  const exp = Number(v.agentExpiresAt);
  return {
    exists: true,
    address: vaultPda(owner).toBase58(),
    owner: owner.toBase58(),
    paused: v.paused,
    agent,
    agentIsGlance,
    agentExpiresAt: exp,
    agentActive: agentIsGlance && exp > nowSec,
    perTxCap: BigInt(v.perTxCap.toString()),
    dailyCap: BigInt(v.dailyCap.toString()),
    dailySpent: effectiveDailySpent(v, nowSec),
    maxSlippageBps: v.maxSlippageBps,
  };
}

// ------------------------------------------------------------ params

export interface Policy {
  agent: PublicKey;
  agentExpiresAt: number;
  perTxCap: bigint;
  dailyCap: bigint;
  maxSlippageBps: number;
}

export function glancePolicy(p: { dailyCap: bigint; perTxCap?: bigint; maxSlippageBps?: number; ttlDays?: number }): Policy {
  return {
    agent: agentKeypair().publicKey,
    agentExpiresAt: Math.floor(Date.now() / 1000) + (p.ttlDays ?? env.SESSION_TTL_DAYS) * DAY_SECS,
    perTxCap: p.perTxCap ?? p.dailyCap,
    dailyCap: p.dailyCap,
    maxSlippageBps: p.maxSlippageBps ?? env.DEFAULT_MAX_SLIPPAGE_BPS,
  };
}

const policyArg = (p: Policy) => ({
  agent: p.agent,
  agentExpiresAt: new BN(p.agentExpiresAt),
  perTxCap: new BN(p.perTxCap.toString()),
  dailyCap: new BN(p.dailyCap.toString()),
  maxSlippageBps: p.maxSlippageBps,
});

export function tokenProgramFor(kind: "spl-token" | "token-2022"): PublicKey {
  return kind === "token-2022" ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
}

// ------------------------------------------------------------ instruction builders

export async function ixInitializeVault(p: { owner: PublicKey; stableMint: PublicKey; stableTokenProgram: PublicKey; policy: Policy; depositAmount: bigint }): Promise<TransactionInstruction> {
  const vault = vaultPda(p.owner);
  return program()
    .methods.initializeVault(policyArg(p.policy), new BN(p.depositAmount.toString()))
    .accountsPartial({
      config: configPda(),
      vault,
      owner: p.owner,
      stableMint: p.stableMint,
      ownerStableAta: ata(p.stableMint, p.owner, p.stableTokenProgram),
      vaultStableAta: ata(p.stableMint, vault, p.stableTokenProgram),
      stableTokenProgram: p.stableTokenProgram,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

export async function ixDeposit(p: { depositor: PublicKey; owner: PublicKey; mint: PublicKey; tokenProgram: PublicKey; amount: bigint }): Promise<TransactionInstruction> {
  const vault = vaultPda(p.owner);
  return program()
    .methods.deposit(new BN(p.amount.toString()))
    .accountsPartial({
      config: configPda(),
      vault,
      depositor: p.depositor,
      mint: p.mint,
      depositorAta: ata(p.mint, p.depositor, p.tokenProgram),
      vaultAta: ata(p.mint, vault, p.tokenProgram),
      tokenProgram: p.tokenProgram,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

export async function ixWithdraw(p: { owner: PublicKey; mint: PublicKey; tokenProgram: PublicKey; amount: bigint }): Promise<TransactionInstruction> {
  const vault = vaultPda(p.owner);
  return program()
    .methods.withdraw(new BN(p.amount.toString()))
    .accountsPartial({
      vault,
      owner: p.owner,
      mint: p.mint,
      vaultAta: ata(p.mint, vault, p.tokenProgram),
      ownerAta: ata(p.mint, p.owner, p.tokenProgram),
      tokenProgram: p.tokenProgram,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

const ownerOnly = (owner: PublicKey) => ({ config: configPda(), vault: vaultPda(owner), owner });
export const ixSetPolicy = (owner: PublicKey, policy: Policy) => program().methods.setPolicy(policyArg(policy)).accountsPartial(ownerOnly(owner)).instruction();
export const ixPause = (owner: PublicKey) => program().methods.pause().accountsPartial(ownerOnly(owner)).instruction();
export const ixUnpause = (owner: PublicKey) => program().methods.unpause().accountsPartial(ownerOnly(owner)).instruction();
export const ixRevokeAgent = (owner: PublicKey) => program().methods.revokeAgent().accountsPartial(ownerOnly(owner)).instruction();

export async function ixExecuteSwapDesk(p: {
  owner: PublicKey;
  desk: PublicKey;
  inputMint: PublicKey;
  outputMint: PublicKey;
  inputTokenProgram: PublicKey;
  outputTokenProgram: PublicKey;
  /** The stock side (output on a buy, input on a sell): its AllowedMint goes in the transaction. */
  stockMint: PublicKey;
  amountIn: bigint;
  amountOut: bigint;
  minOut: bigint;
}): Promise<TransactionInstruction> {
  const vault = vaultPda(p.owner);
  return program()
    .methods.executeSwapDesk(new BN(p.amountIn.toString()), new BN(p.amountOut.toString()), new BN(p.minOut.toString()))
    .accountsPartial({
      config: configPda(),
      vault,
      agent: agentKeypair().publicKey,
      desk: p.desk,
      inputMint: p.inputMint,
      outputMint: p.outputMint,
      allowedMint: allowedMintPda(p.stockMint),
      vaultIn: ata(p.inputMint, vault, p.inputTokenProgram),
      vaultOut: ata(p.outputMint, vault, p.outputTokenProgram),
      deskIn: ata(p.inputMint, p.desk, p.inputTokenProgram),
      deskOut: ata(p.outputMint, p.desk, p.outputTokenProgram),
      inputTokenProgram: p.inputTokenProgram,
      outputTokenProgram: p.outputTokenProgram,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

export interface ConfigParams {
  desk: PublicKey;
  routerProgram: PublicKey;
  stableMints: PublicKey[];
  issuerAuthorities: PublicKey[];
  allowedMints: PublicKey[];
  maxAgentTtlSecs: number;
}
const configArg = (c: ConfigParams) => ({ ...c, maxAgentTtlSecs: new BN(c.maxAgentTtlSecs) });
export const ixInitConfig = (admin: PublicKey, c: ConfigParams) =>
  program().methods.initConfig(configArg(c)).accountsPartial({ config: configPda(), admin, program: programId(), programData: programDataPda(), systemProgram: SystemProgram.programId }).instruction();
export const ixUpdateConfig = (admin: PublicKey, c: ConfigParams) => program().methods.updateConfig(configArg(c)).accountsPartial({ config: configPda(), admin }).instruction();

// ------------------------------------------------------------ transactions

export interface UnsignedTx {
  /** base64 v0 transaction, fee payer = owner, no signatures */
  tx: string;
  blockhash: string;
  lastValidBlockHeight: number;
}

/** Build an unsigned v0 transaction for a wallet to sign (Phantom via the console). */
export async function buildUnsignedTx(feePayer: PublicKey, ixs: TransactionInstruction[]): Promise<UnsignedTx> {
  const { blockhash, lastValidBlockHeight } = await connection().getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({ payerKey: feePayer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  return { tx: Buffer.from(tx.serialize()).toString("base64"), blockhash, lastValidBlockHeight };
}

export function compileTx(feePayer: PublicKey, ixs: TransactionInstruction[], blockhash: string): VersionedTransaction {
  return new VersionedTransaction(new TransactionMessage({ payerKey: feePayer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message());
}
