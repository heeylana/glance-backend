/**
 * The chat API end to end on devnet, no bot and no browser: the local payer acts as the person.
 *
 *   pnpm script:api-walkthrough            # buy $10 of AAPL through /v1
 *   pnpm script:api-walkthrough NVDA 5
 *
 * Against a running backend (pnpm dev) whose API_CLIENTS has at least one client. The script creates a
 * connect session as the bot would, signs the connect message as the wallet, completes the session (creating
 * or renewing the payer's vault as the console would), reads the account, quotes, executes, and shows that
 * a second "yes" does nothing. This is the API's delegated-swap.ts.
 */
import nacl from "tweetnacl";
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { env } from "../config.js";
import { closeDb } from "../db/client.js";
import { connection } from "../lib/solana.js";
import { payerKeypair } from "../services/keys.js";
import { usdToUsdc } from "../lib/amounts.js";
import { fundTestMoney } from "../services/faucet.js";
import { compileTx, fetchVault, glancePolicy, ixDeposit, ixInitializeVault, ixSetPolicy, viewOf } from "../services/vault.js";

const [ticker = "AAPL", usdStr = "10"] = process.argv.slice(2);
const base = (process.env.GLANCE_API_URL ?? `http://localhost:${env.PORT}`).replace(/\/$/, "");
const [clientId, secret] = (env.API_CLIENTS ?? "").split(",")[0]?.split(":") ?? [];
if (!clientId || !secret) throw new Error("API_CLIENTS is empty: add whatsapp:<secret> to .env and restart the backend");
const channelUser = process.env.WALKTHROUGH_USER ?? "15550001234";
const bot = { "x-client-id": clientId, authorization: `Bearer ${secret}`, "content-type": "application/json" };
const asUser = { ...bot, "x-channel-user": `whatsapp:${channelUser}` };

async function call<T = Record<string, unknown>>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T & { ok: boolean; code?: string; message?: string }> {
  const t0 = Date.now();
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = (await res.json()) as T & { ok: boolean; code?: string; message?: string };
  console.log(`${method} ${path} → ${res.status} (${Date.now() - t0} ms)${json.ok ? "" : ` ${json.code}: ${json.message}`}`);
  return json;
}

async function signAndSend(ixs: Awaited<ReturnType<typeof ixSetPolicy>>[]) {
  const owner = payerKeypair();
  const { blockhash, lastValidBlockHeight } = await connection().getLatestBlockhash("confirmed");
  const tx = compileTx(owner.publicKey, ixs, blockhash);
  tx.sign([owner]);
  const sig = await connection().sendRawTransaction(tx.serialize());
  await connection().confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  return sig;
}

async function main() {
  const owner = payerKeypair();
  const wallet = owner.publicKey.toBase58();
  console.log({ base, clientId, channelUser, wallet, ticker, usd: Number(usdStr) });

  // 1. The bot asks for a link.
  const s = await call<{ code: string; url: string }>("POST", "/v1/connect/sessions", { channel: "whatsapp", channel_user_id: channelUser }, bot);
  if (!s.ok) throw new Error("session");
  // 2. The page shows the code and the masked number, and asks for the message this wallet must sign.
  const page = await call<{ message: string; masked_user: string }>("GET", `/v1/connect/sessions/${s.code}?wallet=${wallet}`);
  console.log(`   page shows ${page.masked_user}`);
  // 3. The wallet signs it.
  const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(page.message), owner.secretKey));
  const v = await call<{ vault_status: string; vault: { vault: string } }>("POST", `/v1/connect/sessions/${s.code}/verify`, { wallet, signature });
  if (!v.ok) throw new Error("verify");
  console.log(`   vault_status ${v.vault_status}`);
  // 4. The console's own transactions, signed by the owner, as the page would run them.
  const usdc = new PublicKey(env.USDC_MINT);
  if (v.vault_status === "none") {
    const ata = getAssociatedTokenAddressSync(usdc, owner.publicKey, false, TOKEN_PROGRAM_ID);
    const bal = await getAccount(connection(), ata, "confirmed", TOKEN_PROGRAM_ID).then((a) => a.amount).catch(() => 0n);
    if (bal < usdToUsdc(50)) await fundTestMoney(owner.publicKey, 50);
    const sig = await signAndSend([await ixInitializeVault({ owner: owner.publicKey, stableMint: usdc, stableTokenProgram: TOKEN_PROGRAM_ID, policy: glancePolicy({ dailyCap: usdToUsdc(20) }), depositAmount: usdToUsdc(50) })]);
    console.log(`   created the vault with $50 (${sig.slice(0, 8)}…)`);
  } else if (v.vault_status === "agent_missing" || v.vault_status === "agent_expiring") {
    const view = viewOf(owner.publicKey, await fetchVault(owner.publicKey));
    const sig = await signAndSend([await ixSetPolicy(owner.publicKey, glancePolicy({ dailyCap: view.dailyCap || usdToUsdc(20), perTxCap: view.perTxCap || undefined, maxSlippageBps: view.maxSlippageBps || undefined }))]);
    console.log(`   renewed the agent's permission (${sig.slice(0, 8)}…)`);
  }
  // 5. Bind.
  const done = await call<{ vault: { cashUsd: string; dailyCapUsd: string; agentExpiresAt: string } }>("POST", `/v1/connect/sessions/${s.code}/complete`, { confirm_replace: true, confirm_multi: true });
  if (!done.ok) throw new Error("complete");
  console.log(`   bound: cash $${done.vault.cashUsd}, limit $${done.vault.dailyCapUsd}/day, agent until ${done.vault.agentExpiresAt}`);
  // Completing again with the same code is idempotent.
  await call("POST", `/v1/connect/sessions/${s.code}/complete`, {});
  // 6. The account, as the bot reads it. A vault short of cash gets a deposit, as "Add money" in the console would.
  let vault = await call<{ cash_usd: string; remaining_today_usd: string; holdings: { ticker: string; shares: number }[] }>("GET", "/v1/vault", undefined, asUser);
  if (Number(vault.cash_usd) < Number(usdStr)) {
    const ata = getAssociatedTokenAddressSync(usdc, owner.publicKey, false, TOKEN_PROGRAM_ID);
    let bal = await getAccount(connection(), ata, "confirmed", TOKEN_PROGRAM_ID).then((a) => a.amount).catch(() => 0n);
    if (bal < usdToUsdc(Number(usdStr))) {
      await fundTestMoney(owner.publicKey, 50);
      bal = await getAccount(connection(), ata, "confirmed", TOKEN_PROGRAM_ID).then((a) => a.amount).catch(() => 0n);
    }
    // Whatever the wallet holds up to $50 (Circle's devnet USDC comes from faucet.circle.com, not from us).
    const amount = bal < usdToUsdc(50) ? bal : usdToUsdc(50);
    const sig = await signAndSend([await ixDeposit({ depositor: owner.publicKey, owner: owner.publicKey, mint: usdc, tokenProgram: TOKEN_PROGRAM_ID, amount })]);
    console.log(`   deposited $${(Number(amount) / 1e6).toFixed(2)} into the vault (${sig.slice(0, 8)}…)`);
    vault = await call("GET", "/v1/vault", undefined, asUser);
  }
  console.log(`   cash $${vault.cash_usd}, $${vault.remaining_today_usd} left today, holdings ${JSON.stringify(vault.holdings.map((h) => [h.ticker, h.shares]))}`);
  // 7. Quote, 8. execute, 9. execute again.
  const q = await call<{ quote: { quote_id: string; usd_per_share: number; est_shares: number; expires_at: string } }>("POST", "/v1/trades/quote", { side: "buy", ticker, usd: Number(usdStr), context: { title: "API walkthrough", url: "script://api-walkthrough" } }, asUser);
  if (!q.ok) throw new Error("quote");
  console.log(`   quote ${q.quote.quote_id}: ${q.quote.est_shares} shares at $${q.quote.usd_per_share}, expires ${q.quote.expires_at}`);
  const x = await call<{ signature: string; explorer_url: string; message: string; remaining_today_usd: string }>("POST", `/v1/trades/${q.quote.quote_id}/execute`, {}, asUser);
  if (!x.ok) throw new Error("execute");
  console.log(`   ✔ ${x.message}  $${x.remaining_today_usd} left today  ${x.explorer_url}`);
  const again = await call("POST", `/v1/trades/${q.quote.quote_id}/execute`, {}, asUser);
  if (again.ok || again.code !== "quote_used") throw new Error(`a second yes should be quote_used, got ${again.code}`);
  // 10. The position.
  const after = await call<{ holdings: { ticker: string; shares: number; value_usd: string }[] }>("GET", "/v1/vault", undefined, asUser);
  console.log(`   holdings now ${JSON.stringify(after.holdings.map((h) => [h.ticker, h.shares, h.value_usd]))}`);
  const trades = await call<{ trades: { ticker: string; status: string }[] }>("GET", "/v1/trades", undefined, asUser);
  console.log(`   ${trades.trades.length} trades on record, latest ${trades.trades[0]?.ticker} ${trades.trades[0]?.status}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
