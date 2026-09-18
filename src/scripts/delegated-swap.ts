/**
 * End-to-end check without the browser: the local payer acts as the user.
 *
 *   pnpm tsx src/scripts/delegated-swap.ts buy AAPL 10
 *   pnpm tsx src/scripts/delegated-swap.ts sell AAPL 5
 *
 * If the payer has no vault yet, one is created (owner-signed initialize_vault
 * with a $50 deposit and a $20 daily cap), exactly what Phantom would sign in
 * the console. Then the same delegated pipeline the extension uses runs.
 */
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { executeDelegatedSwap } from "../services/trade.js";
import { loadRegistry } from "../config/issuers.js";
import { ensureTradable } from "../services/mocks.js";
import { usdToUsdc } from "../lib/amounts.js";
import { GuardError, userMessage } from "../lib/errors.js";
import { closeDb } from "../db/client.js";
import { connection } from "../lib/solana.js";
import { env } from "../config.js";
import { payerKeypair } from "../services/keys.js";
import { fundTestMoney } from "../services/faucet.js";
import { compileTx, fetchVault, glancePolicy, ixInitializeVault, vaultPda } from "../services/vault.js";

const [side = "buy", ticker = "AAPL", usdStr = "10"] = process.argv.slice(2);

async function main() {
  const owner = payerKeypair();
  const listing = loadRegistry().listingsByTicker.get(ticker.toUpperCase())?.[0];
  const tradable = loadRegistry().byTicker.get(ticker.toUpperCase());
  if (!listing && !tradable) throw new Error(`${ticker} is not in the catalog`);
  // On devnet the first buy of a listing creates its mock (services/mocks.ts).
  const entry = tradable ?? (await ensureTradable(listing!));
  const usdc = new PublicKey(env.USDC_MINT);

  if (!(await fetchVault(owner.publicKey))) {
    // make sure the owner wallet holds USDC to deposit
    const ownerAta = getAssociatedTokenAddressSync(usdc, owner.publicKey, false, TOKEN_PROGRAM_ID);
    const bal = await getAccount(connection(), ownerAta, "confirmed", TOKEN_PROGRAM_ID).then((a) => a.amount).catch(() => 0n);
    if (bal < usdToUsdc(50)) await fundTestMoney(owner.publicKey, 50);
    const ix = await ixInitializeVault({ owner: owner.publicKey, stableMint: usdc, stableTokenProgram: TOKEN_PROGRAM_ID, policy: glancePolicy({ dailyCap: usdToUsdc(20) }), depositAmount: usdToUsdc(50) });
    const { blockhash, lastValidBlockHeight } = await connection().getLatestBlockhash("confirmed");
    const tx = compileTx(owner.publicKey, [ix], blockhash);
    tx.sign([owner]);
    const sig = await connection().sendRawTransaction(tx.serialize());
    await connection().confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    console.log(`initialized vault ${vaultPda(owner.publicKey).toBase58()} with $50 (${sig})`);
  }

  console.log({ owner: owner.publicKey.toBase58(), vault: vaultPda(owner.publicKey).toBase58(), ticker: entry.ticker, mint: entry.mint, side, usd: Number(usdStr) });
  const t0 = Date.now();
  const res =
    side === "sell"
      ? await executeDelegatedSwap({ side: "sell", owner: owner.publicKey.toBase58(), stockMint: entry.mint, usd: Number(usdStr), context: { title: "script sell" } })
      : await executeDelegatedSwap({ side: "buy", owner: owner.publicKey.toBase58(), stockMint: entry.mint, usdcAmount: usdToUsdc(Number(usdStr)), context: { url: "script://delegated-swap", title: "Delegated swap from script" } });
  console.log(JSON.stringify(res, null, 2));
  console.log(`✔ ${res.message}  (${Date.now() - t0} ms)  https://explorer.solana.com/tx/${res.signature}?cluster=devnet`);
}

main()
  .catch((e) => {
    if (e instanceof GuardError) console.error(`✘ ${e.code}: ${userMessage(e.code, e.ctx)}`, e.ctx.detail ?? "");
    else console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
