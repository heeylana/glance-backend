import { AddressLookupTableAccount, PublicKey, VersionedTransaction, type AccountInfo } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, unpackAccount } from "@solana/spl-token";
import { connection, isPda } from "../lib/solana.js";
import type { TokenDelta } from "../guards/destination.js";

export interface SimulationReport {
  err: unknown | null;
  logs: string[];
  unitsConsumed: number | undefined;
  /** Top-level program ids the transaction invokes. */
  programIds: string[];
  feePayer: string;
  deltas: TokenDelta[];
  userLamportsDelta: bigint;
}

interface TokenSnapshot {
  mint: string;
  owner: string;
  amount: bigint;
}

function decodeToken(address: PublicKey, info: AccountInfo<Buffer> | null): TokenSnapshot | null {
  if (!info) return null;
  const is2022 = info.owner.equals(TOKEN_2022_PROGRAM_ID);
  if (!is2022 && !info.owner.equals(TOKEN_PROGRAM_ID)) return null;
  if (info.data.length < 165) return null;
  try {
    const acc = unpackAccount(address, info, info.owner);
    return { mint: acc.mint.toBase58(), owner: acc.owner.toBase58(), amount: acc.amount };
  } catch {
    return null;
  }
}

export async function resolveLookupTables(tx: VersionedTransaction): Promise<AddressLookupTableAccount[]> {
  const out: AddressLookupTableAccount[] = [];
  for (const l of tx.message.addressTableLookups) {
    const r = await connection().getAddressLookupTable(l.accountKey);
    if (!r.value) throw new Error(`missing lookup table ${l.accountKey.toBase58()}`);
    out.push(r.value);
  }
  return out;
}

/**
 * Simulate a v0 transaction and return per-token-account balance deltas for
 * every writable account, plus the fee payer's lamport change. Spec §8.3
 * guards 4 and 7 consume this.
 */
export async function simulateWithBalances(tx: VersionedTransaction, userWallet: PublicKey): Promise<SimulationReport> {
  const conn = connection();
  const luts = await resolveLookupTables(tx);
  const keys = tx.message.getAccountKeys({ addressLookupTableAccounts: luts });
  const all = keys.keySegments().flat();
  const writable = all.filter((_, i) => tx.message.isAccountWritable(i));
  const feePayer = all[0]!;

  const programIds = tx.message.compiledInstructions.map((ix) => keys.get(ix.programIdIndex)!.toBase58());

  const watch = [...writable];
  if (!watch.some((k) => k.equals(userWallet))) watch.push(userWallet);

  const preInfos = await conn.getMultipleAccountsInfo(watch, "confirmed");
  const pre = new Map<string, { token: TokenSnapshot | null; lamports: bigint }>();
  watch.forEach((k, i) => {
    const info = preInfos[i] ?? null;
    pre.set(k.toBase58(), { token: decodeToken(k, info), lamports: BigInt(info?.lamports ?? 0) });
  });

  const sim = await conn.simulateTransaction(tx, {
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: "confirmed",
    accounts: { encoding: "base64", addresses: watch.map((k) => k.toBase58()) },
  });

  const deltas: TokenDelta[] = [];
  let userLamportsDelta = 0n;

  // Agave ≥ mid-2025 returns pre/post token balances from simulateTransaction (like getTransaction meta).
  // That covers every touched token account, including ATAs created inside the tx. Prefer it.
  interface TokenBalanceEntry {
    accountIndex: number;
    mint: string;
    owner?: string;
    uiTokenAmount: { amount: string; decimals: number };
  }
  const v = sim.value as typeof sim.value & {
    preTokenBalances?: TokenBalanceEntry[] | null;
    postTokenBalances?: TokenBalanceEntry[] | null;
    preBalances?: number[] | null;
    postBalances?: number[] | null;
  };
  if (Array.isArray(v.preTokenBalances) && Array.isArray(v.postTokenBalances)) {
    const preByIdx = new Map(v.preTokenBalances.map((b) => [b.accountIndex, b]));
    const postByIdx = new Map(v.postTokenBalances.map((b) => [b.accountIndex, b]));
    for (const i of new Set([...preByIdx.keys(), ...postByIdx.keys()])) {
      const preB = preByIdx.get(i);
      const postB = postByIdx.get(i);
      const ref = (postB ?? preB)!;
      const owner = ref.owner ?? "";
      deltas.push({
        account: all[i]?.toBase58() ?? `index:${i}`,
        mint: ref.mint,
        owner,
        ownerIsPda: owner ? isPda(owner) : false, // unknown owner → treated as a wallet → gains rejected
        pre: BigInt(preB?.uiTokenAmount.amount ?? "0"),
        post: BigInt(postB?.uiTokenAmount.amount ?? "0"),
      });
    }
    const userIdx = all.findIndex((k) => k.equals(userWallet));
    if (Array.isArray(v.preBalances) && Array.isArray(v.postBalances) && userIdx >= 0) {
      userLamportsDelta = BigInt(v.postBalances[userIdx] ?? 0) - BigInt(v.preBalances[userIdx] ?? 0);
    } else {
      const raw = (sim.value.accounts ?? [])[watch.findIndex((k) => k.equals(userWallet))];
      userLamportsDelta = BigInt(raw?.lamports ?? 0) - pre.get(userWallet.toBase58())!.lamports;
    }
    return {
      err: sim.value.err ?? null,
      logs: sim.value.logs ?? [],
      unitsConsumed: sim.value.unitsConsumed,
      programIds,
      feePayer: feePayer.toBase58(),
      deltas,
      userLamportsDelta,
    };
  }

  // Fallback for RPCs without the newer fields: diff requested post-state against our pre-fetch.
  const postAccounts = sim.value.accounts ?? [];
  watch.forEach((k, i) => {
    const addr = k.toBase58();
    const p = pre.get(addr)!;
    const raw = postAccounts[i];
    let postInfo: AccountInfo<Buffer> | null = null;
    if (raw) {
      postInfo = {
        data: Buffer.from(raw.data[0] ?? "", "base64"),
        owner: new PublicKey(raw.owner),
        lamports: raw.lamports,
        executable: raw.executable,
        rentEpoch: raw.rentEpoch,
      };
    }
    const postTok = decodeToken(k, postInfo);
    if (k.equals(userWallet)) userLamportsDelta = BigInt(postInfo?.lamports ?? 0) - p.lamports;
    const tok = postTok ?? p.token;
    if (!tok) return;
    deltas.push({
      account: addr,
      mint: tok.mint,
      owner: tok.owner,
      ownerIsPda: isPda(tok.owner),
      pre: p.token?.amount ?? 0n,
      post: postTok?.amount ?? 0n,
    });
  });

  return {
    err: sim.value.err ?? null,
    logs: sim.value.logs ?? [],
    unitsConsumed: sim.value.unitsConsumed,
    programIds,
    feePayer: feePayer.toBase58(),
    deltas,
    userLamportsDelta,
  };
}
