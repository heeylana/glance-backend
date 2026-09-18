import { z } from "zod";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { auth, body, router } from "./_shared.js";
import * as store from "../services/store.js";
import { env } from "../config.js";
import { usdToUsdc, usdcToUsd } from "../lib/amounts.js";
import { GuardCode, GuardError } from "../lib/errors.js";
import { fundTestMoney } from "../services/faucet.js";
import { agentKeypair } from "../services/keys.js";
import { tokenBalance } from "../services/trade.js";
import { loadRegistry } from "../config/issuers.js";
import {
  buildUnsignedTx,
  fetchVault,
  glancePolicy,
  ixDeposit,
  ixInitializeVault,
  ixPause,
  ixRevokeAgent,
  ixSetPolicy,
  ixUnpause,
  ixWithdraw,
  tokenProgramFor,
  vaultPda,
  viewOf,
} from "../services/vault.js";

const r = router();
r.use("*", auth);

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

r.get("/session", async (c) => c.json({ ok: true, ...(await sessionView(c.get("owner"))) }));

/** Instant server-side pause (spec §8.4). On-chain pause is a separate owner-signed tx from the console. */
r.post("/session/pause", async (c) => {
  await store.updateSession(c.get("owner"), { paused: true });
  return c.json({ ok: true, ...(await sessionView(c.get("owner"))), message: "Glance is paused." });
});
r.post("/session/unpause", async (c) => {
  await store.updateSession(c.get("owner"), { paused: false });
  const v = await sessionView(c.get("owner"));
  return c.json({ ok: true, ...v, message: v.pausedOnChain ? "Also unpause your account to resume buys." : "Glance is back on." });
});

r.post("/session/preferences", async (c) => {
  const b = await body(c, z.object({ counterViewEnabled: z.boolean().optional() }));
  await store.updateSession(c.get("owner"), { ...(b.counterViewEnabled !== undefined ? { counterViewEnabled: b.counterViewEnabled } : {}) });
  return c.json({ ok: true, ...(await sessionView(c.get("owner"))) });
});

/** Devnet: test USDC into the vault (or the wallet before the vault exists) plus a little SOL. */
r.post("/session/fund", async (c) => {
  const b = await body(c, z.object({ usd: z.number().min(1).max(500).default(50) }));
  const res = await fundTestMoney(new PublicKey(c.get("owner")), b.usd);
  return c.json({ ok: true, ...res, message: `Added $${b.usd.toFixed(0)} to your Glance account.` });
});

r.get("/session/activity", async (c) => {
  const rows = await store.listActivity(c.get("owner"));
  return c.json({
    ok: true,
    activity: rows.map((x) => ({
      id: x.id,
      side: x.side,
      status: x.status,
      inputMint: x.inputMint,
      outputMint: x.outputMint,
      amountIn: x.amountIn.toString(),
      amountOut: x.amountOut?.toString() ?? null,
      usdcValue: usdcToUsd(x.usdcValue),
      signature: x.signature,
      headline: x.headline,
      url: x.url,
      failureCode: x.failureCode,
      createdAt: x.createdAt.toISOString(),
    })),
  });
});

/**
 * Owner-signed transactions, built here and signed by Phantom in the web console.
 * Every one of these is an instruction only the owner can authorize (spec §8.2).
 */
const TxSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("initialize"), depositUsd: z.number().min(0).max(100_000), dailyCapUsd: z.number().min(1).max(1000), perTxCapUsd: z.number().min(1).max(1000).optional(), maxSlippageBps: z.number().int().min(10).max(1000).optional() }),
  z.object({ kind: z.literal("deposit"), usd: z.number().positive().max(100_000) }),
  z.object({ kind: z.literal("withdraw"), mint: z.string().optional(), amountRaw: z.string().regex(/^\d+$/).optional(), usd: z.number().positive().optional() }),
  z.object({ kind: z.literal("set_policy"), dailyCapUsd: z.number().min(1).max(1000), perTxCapUsd: z.number().min(1).max(1000).optional(), maxSlippageBps: z.number().int().min(10).max(1000).optional(), ttlDays: z.number().int().min(1).max(30).optional() }),
  z.object({ kind: z.literal("pause") }),
  z.object({ kind: z.literal("unpause") }),
  z.object({ kind: z.literal("revoke") }),
]);

r.post("/vault/tx", async (c) => {
  const b = await body(c, TxSchema);
  const owner = new PublicKey(c.get("owner"));
  const usdc = new PublicKey(env.USDC_MINT);
  let ix;
  let description: string;
  switch (b.kind) {
    case "initialize": {
      const policy = glancePolicy({ dailyCap: usdToUsdc(b.dailyCapUsd), perTxCap: usdToUsdc(Math.min(b.perTxCapUsd ?? b.dailyCapUsd, b.dailyCapUsd)), maxSlippageBps: b.maxSlippageBps });
      ix = await ixInitializeVault({ owner, stableMint: usdc, stableTokenProgram: TOKEN_PROGRAM_ID, policy, depositAmount: usdToUsdc(b.depositUsd) });
      description = `Create your Glance account, add $${b.depositUsd}, and let Glance buy up to $${b.dailyCapUsd} a day for ${env.SESSION_TTL_DAYS} days.`;
      break;
    }
    case "deposit":
      ix = await ixDeposit({ depositor: owner, owner, mint: usdc, tokenProgram: TOKEN_PROGRAM_ID, amount: usdToUsdc(b.usd) });
      description = `Add $${b.usd} to your Glance account.`;
      break;
    case "withdraw": {
      const mint = new PublicKey(b.mint ?? env.USDC_MINT);
      const entry = loadRegistry().byMint.get(mint.toBase58());
      const tokenProgram = mint.equals(usdc) ? TOKEN_PROGRAM_ID : tokenProgramFor(entry?.tokenProgram ?? "token-2022");
      const amount = b.amountRaw ? BigInt(b.amountRaw) : b.usd !== undefined && mint.equals(usdc) ? usdToUsdc(b.usd) : null;
      if (amount === null) throw new GuardError(GuardCode.BAD_REQUEST, {}, "amountRaw or usd required");
      ix = await ixWithdraw({ owner, mint, tokenProgram, amount });
      description = mint.equals(usdc) ? `Withdraw $${usdcToUsd(amount)} to your wallet.` : `Withdraw ${entry?.ticker ?? "stock"} to your wallet.`;
      break;
    }
    case "set_policy": {
      const policy = glancePolicy({ dailyCap: usdToUsdc(b.dailyCapUsd), perTxCap: usdToUsdc(Math.min(b.perTxCapUsd ?? b.dailyCapUsd, b.dailyCapUsd)), maxSlippageBps: b.maxSlippageBps, ttlDays: b.ttlDays });
      ix = await ixSetPolicy(owner, policy);
      description = `Let Glance buy up to $${b.dailyCapUsd} a day for ${b.ttlDays ?? env.SESSION_TTL_DAYS} days.`;
      break;
    }
    case "pause":
      ix = await ixPause(owner);
      description = "Pause Glance on-chain.";
      break;
    case "unpause":
      ix = await ixUnpause(owner);
      description = "Unpause Glance.";
      break;
    case "revoke":
      ix = await ixRevokeAgent(owner);
      description = "Remove Glance's permission to buy for you.";
      break;
  }
  const tx = await buildUnsignedTx(owner, [ix]);
  return c.json({ ok: true, kind: b.kind, description, ...tx });
});

export default r;
