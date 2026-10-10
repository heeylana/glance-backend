/**
 * The account as the console, the side panel and the chat bot all see it: the vault's on-chain state
 * (caps, spend, agent, expiry, pause) read fresh on every call, the server-side pause flag, and the
 * cash balance. Lifted out of routes/session.ts so the /v1 API can call it for a bound channel user.
 */
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as store from "./store.js";
import { env } from "../config.js";
import { usdcToUsd } from "../lib/amounts.js";
import { agentKeypair } from "./keys.js";
import { tokenBalance } from "./trade.js";
import { fetchVault, vaultPda, viewOf } from "./vault.js";

export async function sessionView(owner: string) {
  const ownerPk = new PublicKey(owner);
  const [session, vault] = await Promise.all([store.getSession(owner), fetchVault(ownerPk)]);
  const v = viewOf(ownerPk, vault);
  const cashUsdc = v.exists ? await tokenBalance(vaultPda(ownerPk), new PublicKey(env.USDC_MINT), TOKEN_PROGRAM_ID) : 0n;
  const dailyCapUsd = usdcToUsd(v.dailyCap);
  const spentUsd = usdcToUsd(v.dailySpent);
  return {
    wallet: owner,
    vault: v.address,
    exists: v.exists,
    paused: (session?.paused ?? false) || v.paused,
    pausedOnChain: v.paused,
    pausedServer: session?.paused ?? false,
    agentActive: v.agentActive,
    agentExpiresAt: v.agentExpiresAt ? new Date(v.agentExpiresAt * 1000).toISOString() : null,
    needsAccount: !v.exists,
    needsRenewal: v.exists && !v.agentActive,
    dailyCapUsd,
    perTxCapUsd: usdcToUsd(v.perTxCap),
    maxSlippageBps: v.maxSlippageBps,
    spentTodayUsd: spentUsd,
    remainingTodayUsd: Math.max(0, dailyCapUsd - spentUsd),
    cashUsd: usdcToUsd(cashUsdc),
    counterViewEnabled: session?.counterViewEnabled ?? true,
    agent: agentKeypair().publicKey.toBase58(),
    consoleUrl: env.WEB_CONSOLE_URL,
    cluster: env.SOLANA_CLUSTER,
    sessionTtlDays: env.SESSION_TTL_DAYS,
    usdcMint: env.USDC_MINT,
  };
}
export type SessionViewResult = Awaited<ReturnType<typeof sessionView>>;
