/**
 * Devnet bootstrap for the vault architecture. Idempotent; rerun after a redeploy.
 *
 *   1. keypairs: issuer authority, desk, agent           → .keys/
 *   2. mock USDC (SPL, 6 dp, payer = mint authority)
 *   3. mock xStock mints: Token-2022 with PermanentDelegate = issuer authority (what guard 3 checks)
 *      + metadata pointer + metadata; desk gets 10,000 shares of each
 *   4. program config: init (upgrade authority only) or update — desk, stable mints,
 *      issuer authorities, curated mints, agent TTL
 *   5. rewrite src/config/issuers.mock.json and print the .env lines
 *
 * Prerequisite: `anchor deploy --provider.cluster devnet` from glance-vault/ (payer = upgrade authority).
 * Usage: pnpm tsx src/scripts/setup-devnet.ts [--tickers=AAPL,NVO,TSLA,NVDA,MSFT] [--fresh-mints]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMetadataPointerInstruction,
  createInitializeMintInstruction,
  createInitializePermanentDelegateInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  getMint,
  getMintLen,
  getPermanentDelegate,
  LENGTH_SIZE,
  TYPE_SIZE,
} from "@solana/spl-token";
import { createInitializeInstruction, pack, type TokenMetadata } from "@solana/spl-token-metadata";
import { env } from "../config.js";
import { connection } from "../lib/solana.js";
import { loadOrCreateKeypair, payerKeypair } from "../services/keys.js";
import { configPda, fetchConfig, ixInitConfig, ixUpdateConfig, programId } from "../services/vault.js";
import { ensureAllowed } from "../services/curation.js";

const conn = connection();
const args = process.argv.slice(2);
const tickers = (args.find((a) => a.startsWith("--tickers="))?.split("=")[1] ?? "AAPL,NVO,TSLA,NVDA,MSFT").split(",");
const freshMints = args.includes("--fresh-mints");
const STOCK_DECIMALS = 8;
const DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

const FEEDS_FILE = JSON.parse(readFileSync(new URL("../config/pyth-feeds.json", import.meta.url), "utf8")) as Record<string, unknown>;
const FEEDS = Object.fromEntries(Object.entries(FEEDS_FILE).filter(([k, v]) => !k.startsWith("_") && typeof v === "string")) as Record<string, string>;
const TOKEN_FEEDS = (FEEDS_FILE._tokenFeeds ?? {}) as Record<string, string>;
const REF_MINTS: Record<string, string> = {
  AAPL: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp",
  NVO: "XsfAzPzYrYjd4Dpa9BU3cusBsvWfVB9gBcyGC87S57n",
  TSLA: "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB",
  NVDA: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh",
  MSFT: "XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX",
  AMZN: "Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg",
  GOOGL: "XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN",
  META: "Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu",
  COIN: "Xs7ZdzSHLU9ftNJsii5fCeJhoRWSC32SQGzGQtePxNu",
  MSTR: "XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ",
  SPY: "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W",
  QQQ: "Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ",
};
const NAMES: Record<string, string> = { AAPL: "Apple", NVO: "Novo Nordisk", TSLA: "Tesla", NVDA: "Nvidia", MSFT: "Microsoft", AMZN: "Amazon", GOOGL: "Alphabet", META: "Meta", COIN: "Coinbase", MSTR: "Strategy", SPY: "S&P 500", QQQ: "Nasdaq 100" };

interface Registry {
  stableMints: string[];
  rules: { issuer: string; method: string; address: string }[];
  mints: Record<string, { ticker: string; issuer: string; decimals: number; pythFeedId: string; pythTokenFeedId?: string; tokenProgram: string; referenceMint?: string; issuerDelegate?: string | null }>;
}

async function ensureSol(pk: PublicKey, min: number, from?: Keypair) {
  if ((await conn.getBalance(pk)) >= min * LAMPORTS_PER_SOL) return;
  try {
    const sig = await conn.requestAirdrop(pk, 2 * LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig, "confirmed");
    return;
  } catch {
    /* faucet rate-limited */
  }
  if (from && (await conn.getBalance(from.publicKey)) > (min + 0.05) * LAMPORTS_PER_SOL) {
    await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: pk, lamports: Math.round(min * LAMPORTS_PER_SOL) })), [from]);
    return;
  }
  throw new Error(`fund ${pk.toBase58()} with SOL (https://faucet.solana.com) and rerun`);
}

async function hasPermanentDelegate(mint: PublicKey, delegate: PublicKey): Promise<boolean> {
  try {
    const m = await getMint(conn, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
    return getPermanentDelegate(m)?.delegate.equals(delegate) ?? false;
  } catch {
    return false;
  }
}

async function main() {
  const payer = payerKeypair();
  const issuer = loadOrCreateKeypair(".keys/issuer-authority.json");
  const desk = loadOrCreateKeypair(".keys/desk.json");
  const agent = loadOrCreateKeypair(env.AGENT_KEYPAIR);
  console.log({ rpc: env.SOLANA_RPC_URL, payer: payer.publicKey.toBase58(), issuer: issuer.publicKey.toBase58(), desk: desk.publicKey.toBase58(), agent: agent.publicKey.toBase58(), program: programId().toBase58() });
  for (const t of tickers) if (!FEEDS[t]) throw new Error(`no Pyth feed id for ${t} in pyth-feeds.json`);

  const progInfo = await conn.getAccountInfo(programId());
  if (!progInfo?.executable) throw new Error(`program ${programId().toBase58()} is not deployed on this cluster. Run: cd ../glance-vault && anchor deploy --provider.cluster devnet`);

  await ensureSol(payer.publicKey, 0.5);
  await ensureSol(desk.publicKey, 0.02, payer);
  await ensureSol(agent.publicKey, 0.1, payer); // agent pays fees + vault output ATA rent

  const regPath = new URL("../config/issuers.mock.json", import.meta.url);
  const reg = JSON.parse(readFileSync(regPath, "utf8")) as Registry;

  // mock USDC
  let usdcMint: PublicKey | null = null;
  for (const m of reg.stableMints) {
    if (m === DEVNET_USDC) continue;
    const info = await getMint(conn, new PublicKey(m), "confirmed", TOKEN_PROGRAM_ID).catch(() => null);
    if (info?.mintAuthority?.equals(payer.publicKey)) usdcMint = new PublicKey(m);
  }
  if (!usdcMint) {
    const kp = Keypair.generate();
    const lamports = await conn.getMinimumBalanceForRentExemption(getMintLen([]));
    await sendAndConfirmTransaction(
      conn,
      new Transaction().add(
        SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: kp.publicKey, space: getMintLen([]), lamports, programId: TOKEN_PROGRAM_ID }),
        createInitializeMintInstruction(kp.publicKey, 6, payer.publicKey, null, TOKEN_PROGRAM_ID),
      ),
      [payer, kp],
    );
    usdcMint = kp.publicKey;
    console.log("created mock USDC", usdcMint.toBase58());
  } else console.log("reusing mock USDC", usdcMint.toBase58());
  // desk + payer USDC float (mock)
  for (const [who, amount] of [[desk.publicKey, 1_000_000_000_000n], [payer.publicKey, 10_000_000_000n]] as const) {
    const a = getAssociatedTokenAddressSync(usdcMint, who, false, TOKEN_PROGRAM_ID);
    await sendAndConfirmTransaction(conn, new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, a, who, usdcMint, TOKEN_PROGRAM_ID), createMintToInstruction(usdcMint, a, payer.publicKey, amount, [], TOKEN_PROGRAM_ID)), [payer]);
  }
  // desk ATA for real devnet USDC (so sells can pay in it once the float exists)
  await sendAndConfirmTransaction(conn, new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, getAssociatedTokenAddressSync(new PublicKey(DEVNET_USDC), desk.publicKey, false, TOKEN_PROGRAM_ID), desk.publicKey, new PublicKey(DEVNET_USDC), TOKEN_PROGRAM_ID)), [payer]);

  // stock mints with PermanentDelegate = issuer authority
  const byTicker = new Map(Object.entries(reg.mints).map(([m, e]) => [e.ticker, m]));
  const newMints: Registry["mints"] = {};
  for (const ticker of tickers) {
    let mintPk: PublicKey | null = null;
    const existing = byTicker.get(ticker);
    if (existing && !freshMints && (await hasPermanentDelegate(new PublicKey(existing), issuer.publicKey))) {
      mintPk = new PublicKey(existing);
      console.log(`reusing ${ticker}x ${mintPk.toBase58()}`);
    } else {
      const mint = Keypair.generate();
      mintPk = mint.publicKey;
      const metadata: TokenMetadata = { mint: mintPk, name: `${NAMES[ticker] ?? ticker} xStock (mock)`, symbol: `${ticker}x`, uri: "", additionalMetadata: [], updateAuthority: issuer.publicKey };
      const mintLen = getMintLen([ExtensionType.PermanentDelegate, ExtensionType.MetadataPointer]);
      const metaLen = TYPE_SIZE + LENGTH_SIZE + pack(metadata).length;
      const lamports = await conn.getMinimumBalanceForRentExemption(mintLen + metaLen);
      await sendAndConfirmTransaction(
        conn,
        new Transaction().add(
          SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mintPk, space: mintLen, lamports, programId: TOKEN_2022_PROGRAM_ID }),
          createInitializePermanentDelegateInstruction(mintPk, issuer.publicKey, TOKEN_2022_PROGRAM_ID),
          createInitializeMetadataPointerInstruction(mintPk, issuer.publicKey, mintPk, TOKEN_2022_PROGRAM_ID),
          createInitializeMintInstruction(mintPk, STOCK_DECIMALS, issuer.publicKey, null, TOKEN_2022_PROGRAM_ID),
          createInitializeInstruction({ programId: TOKEN_2022_PROGRAM_ID, mint: mintPk, metadata: mintPk, name: metadata.name, symbol: metadata.symbol, uri: metadata.uri, mintAuthority: issuer.publicKey, updateAuthority: issuer.publicKey }),
        ),
        [payer, mint, issuer],
      );
      console.log(`created ${ticker}x ${mintPk.toBase58()} (permanent delegate = issuer)`);
    }
    const deskAta = getAssociatedTokenAddressSync(mintPk, desk.publicKey, false, TOKEN_2022_PROGRAM_ID);
    await sendAndConfirmTransaction(conn, new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, deskAta, desk.publicKey, mintPk, TOKEN_2022_PROGRAM_ID), createMintToInstruction(mintPk, deskAta, issuer.publicKey, 10_000n * 10n ** BigInt(STOCK_DECIMALS), [], TOKEN_2022_PROGRAM_ID)), [payer, issuer]);
    newMints[mintPk.toBase58()] = { issuerDelegate: issuer.publicKey.toBase58(), ticker, issuer: "mock-issuer", decimals: STOCK_DECIMALS, pythFeedId: FEEDS[ticker]!, ...(TOKEN_FEEDS[ticker] && !TOKEN_FEEDS[ticker]!.startsWith("_") ? { pythTokenFeedId: TOKEN_FEEDS[ticker] } : {}), tokenProgram: "token-2022", ...(REF_MINTS[ticker] ? { referenceMint: REF_MINTS[ticker] } : {}) };
  }

  // registry file
  reg.stableMints = [DEVNET_USDC, usdcMint.toBase58()];
  reg.rules = [{ issuer: "mock-issuer", method: "permanent_delegate", address: issuer.publicKey.toBase58() }];
  reg.mints = newMints;
  writeFileSync(regPath, JSON.stringify(reg, null, 2) + "\n");

  // program config
  const params = {
    desk: desk.publicKey,
    routerProgram: PublicKey.default,
    stableMints: reg.stableMints.map((m) => new PublicKey(m)),
    // Legacy v1 lists; the program reads each mint's AllowedMint instead (allowed below).
    issuerAuthorities: [],
    allowedMints: [],
    maxAgentTtlSecs: 30 * 86_400,
  };
  const existingCfg = await fetchConfig();
  const ix = existingCfg ? await ixUpdateConfig(payer.publicKey, params) : await ixInitConfig(payer.publicKey, params);
  const sig = await sendAndConfirmTransaction(conn, new Transaction().add(ix), [payer], { commitment: "confirmed" });
  console.log(`${existingCfg ? "updated" : "initialized"} config ${configPda().toBase58()} (${sig})`);
  for (const m of Object.keys(newMints)) await ensureAllowed(payer, new PublicKey(m), issuer.publicKey);
  console.log(`allowed ${Object.keys(newMints).length} mock mints; other catalog listings get a mock on first buy`);

  console.log(`\nwrote ${regPath.pathname}\n\n.env:\n  USDC_MINT=${DEVNET_USDC}   (or ${usdcMint.toBase58()} for mock USDC you can mint freely)\n  ROUTE_PROVIDER=desk\n  ISSUER_MODE=mock\n  AGENT_KEYPAIR=${env.AGENT_KEYPAIR}\n  DESK_KEYPAIR=./.keys/desk.json\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
