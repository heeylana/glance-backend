/**
 * Delegated swap through the vault program (spec §8.3):
 *
 *   server pause flag → on-chain vault state (exists, paused, agent, expiry) →
 *   curated + issuer-verified mint, one direction → caps mirrored from the chain →
 *   vault balance → reference price → desk quote → price within band →
 *   build execute_swap_desk → simulate → ledger(pending) → agent + desk sign →
 *   confirm → ledger(confirmed) → journal
 *
 * Everything the backend checks here is re-enforced by the program; these are
 * fast-fail pre-checks that map to the spec §7.8 lines. The agent key signs
 * nothing but this instruction.
 */
import { PublicKey } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { env } from "../config.js";
import { GuardCode, GuardError } from "../lib/errors.js";
import { rawToDecimal, usdcToUsd } from "../lib/amounts.js";
import { connection, getMintFacts } from "../lib/solana.js";
import { log } from "../lib/log.js";
import { checkCaps } from "../guards/caps.js";
import { classifySwapDirection } from "../guards/issuer.js";
import { checkQuoteAgainstPyth } from "../guards/price.js";
import { loadRegistry } from "../config/issuers.js";
import { COMPANIES } from "../resolver/companies.js";
import { asPythPrice, getReferencePrice } from "./prices.js";
import { routeProvider } from "./route.js";
import { simulateWithBalances } from "./simulate.js";
import { agentKeypair, deskKeypair } from "./keys.js";
import { compileTx, fetchVault, ixExecuteSwapDesk, tokenProgramFor, vaultPda, viewOf } from "./vault.js";
import * as store from "./store.js";

export interface TradeContext {
  url?: string;
  title?: string;
  site?: string;
  screenshotHash?: string;
  note?: string;
}

export type TradeRequest =
  | { side: "buy"; owner: string; stockMint: string; usdcAmount: bigint; context?: TradeContext }
  | { side: "sell"; owner: string; stockMint: string; stockAmountRaw?: bigint; usd?: number; context?: TradeContext };

export interface TradeResult {
  ok: true;
  side: "buy" | "sell";
  signature: string;
  ticker: string;
  companyName: string;
  mint: string;
  amountInRaw: string;
  amountOutRaw: string;
  usdcValue: number;
  usdPerShare: number;
  pythUsdPerShare: number;
  sharesDelta: number;
  positionShares: number;
  positionUsd: number;
  message: string;
  journalId?: number;
  ledgerId: number;
}

export function companyFor(ticker: string) {
  return COMPANIES.find((c) => c.ticker === ticker);
}

export async function tokenBalance(owner: PublicKey, mint: PublicKey, program: PublicKey): Promise<bigint> {
  const a = getAssociatedTokenAddressSync(mint, owner, true, program);
  try {
    return (await getAccount(connection(), a, "confirmed", program)).amount;
  } catch {
    return 0n;
  }
}

async function fillFromChain(signature: string, vault: string, inputMint: string, outputMint: string) {
  const tx = await connection().getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  const meta = tx?.meta;
  if (!meta?.preTokenBalances || !meta.postTokenBalances) return null;
  const pre = meta.preTokenBalances;
  const post = meta.postTokenBalances;
  const sum = (mint: string, list: typeof pre) => list.filter((b) => b.owner === vault && b.mint === mint).reduce((a, b) => a + BigInt(b.uiTokenAmount.amount), 0n);
  return { in: sum(inputMint, pre) - sum(inputMint, post), out: sum(outputMint, post) - sum(outputMint, pre) };
}

export async function executeDelegatedSwap(req: TradeRequest): Promise<TradeResult> {
  const t0 = Date.now();
  const { user, session } = await store.ensureUser(req.owner);
  const owner = new PublicKey(user.walletAddress);
  const vaultAddr = vaultPda(owner);
  const now = new Date();
  const nowSec = Math.floor(now.getTime() / 1000);
  const reg = loadRegistry();
  const entry = reg.byMint.get(req.stockMint);
  const companyName = entry ? (companyFor(entry.ticker)?.name ?? entry.ticker) : undefined;

  // Guard 2: server-side pause first (instant), then the vault's own state.
  if (session.paused) throw new GuardError(GuardCode.SESSION_PAUSED);
  const view = viewOf(owner, await fetchVault(owner), nowSec);
  if (!view.exists || !view.agentIsGlance) throw new GuardError(GuardCode.NO_SESSION);
  if (view.paused) throw new GuardError(GuardCode.SESSION_PAUSED);
  if (!view.agentActive) throw new GuardError(GuardCode.SESSION_EXPIRED);

  // Guard 3: curated + issuer-verified, exactly one direction.
  if (!entry) throw new GuardError(GuardCode.OUTPUT_MINT_NOT_ISSUER, { companyName });
  const facts = await getMintFacts(req.stockMint);
  const inputMint = req.side === "buy" ? env.USDC_MINT : req.stockMint;
  const outputMint = req.side === "buy" ? req.stockMint : env.USDC_MINT;
  const dir = classifySwapDirection(
    { mint: inputMint, facts: req.side === "sell" ? facts : null },
    { mint: outputMint, facts: req.side === "buy" ? facts : null },
    reg.stableMints,
    reg.rules,
  );
  if (!dir.ok) throw new GuardError(dir.code, { companyName });
  if (dir.side !== req.side) throw new GuardError(GuardCode.BAD_REQUEST);

  const stockMint = new PublicKey(req.stockMint);
  const stockProgram = tokenProgramFor(facts?.tokenProgram ?? entry.tokenProgram);
  const usdcMint = new PublicKey(env.USDC_MINT);

  // Reference price.
  const ref = await getReferencePrice(entry);
  if (!ref) throw new GuardError(GuardCode.PRICE_UNAVAILABLE);
  const refUsd = ref.source === "pyth" && ref.feedKind === "equity" ? ref.usd * (facts?.uiMultiplier ?? 1) : ref.usd;
  const px = asPythPrice({ ...ref, usd: refUsd });

  // Amount in.
  let amountIn: bigint;
  if (req.side === "buy") amountIn = req.usdcAmount;
  else if (req.stockAmountRaw !== undefined) amountIn = req.stockAmountRaw;
  else if (req.usd !== undefined) amountIn = BigInt(Math.floor((req.usd / refUsd) * 10 ** entry.decimals));
  else throw new GuardError(GuardCode.BAD_REQUEST);
  if (amountIn <= 0n) throw new GuardError(GuardCode.BAD_REQUEST);

  // Guard 5: caps, mirrored from the chain (the program charges them again on-chain).
  const dailyCapUsd = usdcToUsd(view.dailyCap);
  if (req.side === "buy") {
    const caps = checkCaps({ amountIn, perTxCap: view.perTxCap, dailyCap: view.dailyCap, spentInWindow: view.dailySpent });
    if (!caps.ok) throw new GuardError(caps.code, { dailyCapUsd, remainingUsd: usdcToUsd(caps.remaining) });
  }

  // Balance in the vault.
  const inBalance = req.side === "buy" ? await tokenBalance(vaultAddr, usdcMint, TOKEN_PROGRAM_ID) : await tokenBalance(vaultAddr, stockMint, stockProgram);
  if (inBalance < amountIn) {
    const balanceUsd = req.side === "buy" ? usdcToUsd(inBalance) : rawToDecimal(inBalance, entry.decimals) * refUsd;
    throw new GuardError(GuardCode.INSUFFICIENT_FUNDS, { balanceUsd });
  }

  // Quote (desk on devnet).
  const route = routeProvider();
  const desk = route.desk();
  if (!desk) throw new GuardError(GuardCode.ROUTE_UNAVAILABLE, {}, "router fills are not wired yet; use ROUTE_PROVIDER=desk");
  const quote = await route.quote({ inputMint, outputMint, amount: amountIn, slippageBps: view.maxSlippageBps || env.DEFAULT_MAX_SLIPPAGE_BPS });

  // Guard 6: quote within band of the reference price.
  const pc = checkQuoteAgainstPyth({
    side: req.side,
    inAmount: quote.inAmount,
    outAmount: quote.outAmount,
    stockDecimals: entry.decimals,
    pyth: px,
    nowSec,
    maxDeviationBps: env.PRICE_MAX_DEVIATION_BPS,
    maxAgeSec: env.PRICE_MAX_AGE_SEC,
    stalePolicy: env.PRICE_STALE_POLICY,
    staleDeviationBps: env.PRICE_STALE_DEVIATION_BPS,
  });
  if (!pc.ok) {
    log.warn("price guard rejected", { owner: req.owner, mint: req.stockMint, ...pc });
    throw new GuardError(pc.code, { detail: pc });
  }

  // Build the vault instruction: the program enforces destination, caps, direction, issuer on-chain.
  const ix = await ixExecuteSwapDesk({
    owner,
    desk,
    inputMint: new PublicKey(inputMint),
    outputMint: new PublicKey(outputMint),
    inputTokenProgram: req.side === "buy" ? TOKEN_PROGRAM_ID : stockProgram,
    outputTokenProgram: req.side === "buy" ? stockProgram : TOKEN_PROGRAM_ID,
    stockMint: new PublicKey(req.stockMint),
    amountIn,
    amountOut: quote.outAmount,
    minOut: quote.minOut,
  });
  const agent = agentKeypair();
  const { blockhash, lastValidBlockHeight } = await connection().getLatestBlockhash("confirmed");
  const tx = compileTx(agent.publicKey, [ix], blockhash);

  // Simulate for a readable failure before anything is signed.
  const report = await simulateWithBalances(tx, agent.publicKey);
  if (report.err) {
    const logs = report.logs.join("\n");
    log.warn("simulation failed", { owner: req.owner, err: report.err, logs: report.logs.slice(-8) });
    const m = /Error Code: (\w+)/.exec(logs);
    if (m) throw new GuardError(programErrorToCode(m[1]!), { dailyCapUsd, remainingUsd: Math.max(0, dailyCapUsd - usdcToUsd(view.dailySpent)), balanceUsd: usdcToUsd(inBalance), companyName });
    if (/insufficient (funds|lamports)/i.test(logs)) throw new GuardError(GuardCode.INSUFFICIENT_FUNDS, { balanceUsd: usdcToUsd(inBalance) });
    throw new GuardError(GuardCode.SIMULATION_FAILED, { detail: report.err });
  }

  const usdcValue = req.side === "buy" ? amountIn : quote.outAmount;
  const ledger = await store.insertLedger({
    userId: req.owner,
    side: req.side,
    inputMint,
    outputMint,
    amountIn,
    usdcValue,
    quotedUsdPerShare: pc.impliedUsdPerShare.toFixed(6),
    pythUsdPerShare: pc.pythUsdPerShare.toFixed(6),
    headline: req.context?.title,
    url: req.context?.url,
    status: "pending",
  });

  let signature: string;
  try {
    tx.sign([agent, deskKeypair()]);
    signature = await connection().sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
  } catch (e) {
    await store.updateLedger(ledger.id, { status: "failed", failureCode: GuardCode.SUBMIT_FAILED });
    throw new GuardError(GuardCode.SUBMIT_FAILED, {}, String(e));
  }
  const conf = await connection().confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  if (conf.value.err) {
    await store.updateLedger(ledger.id, { status: "failed", failureCode: GuardCode.SUBMIT_FAILED, signature });
    throw new GuardError(GuardCode.SUBMIT_FAILED, { detail: conf.value.err });
  }

  const fill = (await fillFromChain(signature, vaultAddr.toBase58(), inputMint, outputMint).catch(() => null)) ?? { in: amountIn, out: quote.outAmount };
  await store.updateLedger(ledger.id, { status: "confirmed", signature, amountOut: fill.out, usdcValue: req.side === "buy" ? fill.in : fill.out, confirmedAt: new Date() });

  const positionRaw = await tokenBalance(vaultAddr, stockMint, stockProgram);
  const positionShares = rawToDecimal(positionRaw, entry.decimals);
  const positionUsd = positionShares * refUsd;
  const sharesDelta = rawToDecimal(req.side === "buy" ? fill.out : fill.in, entry.decimals);
  const usdPerShare = sharesDelta > 0 ? usdcToUsd(req.side === "buy" ? fill.in : fill.out) / sharesDelta : pc.impliedUsdPerShare;

  let journalId: number | undefined;
  if (req.side === "buy") {
    const company = companyFor(entry.ticker);
    const j = await store.insertJournal({
      userId: req.owner,
      ledgerId: ledger.id,
      companyId: company?.id ?? entry.ticker.toLowerCase(),
      ticker: entry.ticker,
      mint: req.stockMint,
      url: req.context?.url ?? "",
      title: req.context?.title ?? `Bought ${companyName}`,
      site: req.context?.site,
      screenshotHash: req.context?.screenshotHash,
      amountUsdc: fill.in,
      priceUsd: usdPerShare.toFixed(6),
      sharesRaw: fill.out,
      note: req.context?.note,
    });
    journalId = j.id;
  }

  const message = req.side === "buy" ? `You own $${positionUsd.toFixed(2)} of ${companyName}.` : `Sold $${usdcToUsd(fill.out).toFixed(2)} of ${companyName}. You have $${positionUsd.toFixed(2)} left.`;
  log.info("delegated swap confirmed", { owner: req.owner, side: req.side, ticker: entry.ticker, signature, ms: Date.now() - t0, route: route.name });

  return {
    ok: true,
    side: req.side,
    signature,
    ticker: entry.ticker,
    companyName: companyName!,
    mint: req.stockMint,
    amountInRaw: fill.in.toString(),
    amountOutRaw: fill.out.toString(),
    usdcValue: usdcToUsd(req.side === "buy" ? fill.in : fill.out),
    usdPerShare,
    pythUsdPerShare: refUsd,
    sharesDelta,
    positionShares,
    positionUsd,
    message,
    journalId,
    ledgerId: ledger.id,
  };
}

/** Map the program's error names onto the user-facing codes (spec §7.8). */
function programErrorToCode(name: string): GuardCode {
  switch (name) {
    case "VaultPaused":
      return GuardCode.SESSION_PAUSED;
    case "NoAgent":
    case "NotAgent":
      return GuardCode.NO_SESSION;
    case "AgentExpired":
      return GuardCode.SESSION_EXPIRED;
    case "OverPerTxCap":
      return GuardCode.OVER_PER_TX_CAP;
    case "OverDailyCap":
      return GuardCode.OVER_DAILY_CAP;
    case "InputMintNotStable":
      return GuardCode.INPUT_MINT_NOT_STABLE;
    case "OutputMintNotAllowed":
    case "OutputMintNotIssuer":
      return GuardCode.OUTPUT_MINT_NOT_ISSUER;
    case "OutputBelowMin":
      return GuardCode.OUTPUT_BELOW_MIN;
    case "InputDebitMismatch":
      return GuardCode.INPUT_DEBIT_MISMATCH;
    default:
      return GuardCode.SIMULATION_FAILED;
  }
}
