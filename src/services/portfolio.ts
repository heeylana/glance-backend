/** The vault's holdings, curated mints only, valued (spec §7.7). Lifted out of routes/portfolio.ts for the /v1 API. */
import { PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { connection } from "../lib/solana.js";
import { env } from "../config.js";
import { loadRegistry } from "../config/issuers.js";
import { getReferencePrices, getPriceAt, type RefPrice } from "./prices.js";
import { log } from "../lib/log.js";
import { COMPANIES } from "../resolver/companies.js";
import { usdcToUsd } from "../lib/amounts.js";
import { vaultPda } from "./vault.js";
import { sessionView } from "./session-view.js";

export interface Holding {
  ticker: string;
  name: string;
  mint: string;
  shares: number;
  sharesRaw: string;
  decimals: number;
  priceUsd: number | null;
  valueUsd: number | null;
  dayChangePct: number | null;
}

export async function portfolioView(owner: string) {
  const ownerPk = new PublicKey(owner);
  const vault = vaultPda(ownerPk);
  const conn = connection();
  const [legacy, t22] = await Promise.all([
    conn.getParsedTokenAccountsByOwner(vault, { programId: TOKEN_PROGRAM_ID }),
    conn.getParsedTokenAccountsByOwner(vault, { programId: TOKEN_2022_PROGRAM_ID }),
  ]);
  const reg = loadRegistry();
  let cashUsdc = 0n;
  const raw = new Map<string, { amount: bigint; decimals: number }>();
  for (const a of [...legacy.value, ...t22.value]) {
    const info = a.account.data.parsed?.info as { mint: string; tokenAmount: { amount: string; decimals: number } } | undefined;
    if (!info) continue;
    const amt = BigInt(info.tokenAmount.amount);
    if (info.mint === env.USDC_MINT) cashUsdc += amt;
    else if (reg.byMint.has(info.mint) && amt > 0n) {
      const cur = raw.get(info.mint);
      raw.set(info.mint, { amount: (cur?.amount ?? 0n) + amt, decimals: info.tokenAmount.decimals });
    }
  }
  const entries = [...raw.keys()].map((m) => reg.byMint.get(m)!);
  // A price feed hiccup (Jupiter rate-limits bursts) must not take the balance down: values go null instead.
  const prices = entries.length
    ? await getReferencePrices(entries).catch((e) => {
        log.warn("portfolio prices failed", { err: String(e) });
        return new Map<string, RefPrice>();
      })
    : new Map<string, RefPrice>();
  const dayAgo = Math.floor(Date.now() / 1000) - 86_400;
  const holdings: Holding[] = await Promise.all(
    entries.map(async (e) => {
      const h = raw.get(e.mint)!;
      const shares = Number(h.amount) / 10 ** h.decimals;
      const px = prices.get(e.mint);
      const priceUsd = px ? px.usd : null;
      const prevUsd = await getPriceAt(e, dayAgo).catch(() => null);
      return {
        ticker: e.ticker,
        name: COMPANIES.find((x) => x.ticker === e.ticker)?.name ?? e.ticker,
        mint: e.mint,
        shares,
        sharesRaw: h.amount.toString(),
        decimals: h.decimals,
        priceUsd,
        valueUsd: priceUsd !== null ? shares * priceUsd : null,
        dayChangePct: priceUsd !== null && prevUsd ? ((priceUsd - prevUsd) / prevUsd) * 100 : null,
      };
    }),
  );
  const s = await sessionView(owner);
  return {
    wallet: owner,
    vault: vault.toBase58(),
    exists: s.exists,
    cashUsd: usdcToUsd(cashUsdc),
    holdings: holdings.sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0)),
    totalUsd: holdings.reduce((x, h) => x + (h.valueUsd ?? 0), 0),
    paused: s.paused,
    remainingTodayUsd: s.remainingTodayUsd,
    session: s,
  };
}
