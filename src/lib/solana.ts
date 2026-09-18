import { Connection, PublicKey } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getMetadataPointerState,
  getPermanentDelegate,
  getScaledUiAmountConfig,
  getTokenMetadata,
  unpackMint,
} from "@solana/spl-token";
import { env } from "../config.js";
import type { MintFacts } from "../guards/issuer.js";

let _conn: Connection | null = null;
export function connection(): Connection {
  if (!_conn) _conn = new Connection(env.SOLANA_RPC_URL, { commitment: "confirmed" });
  return _conn;
}

export function isPda(pubkey: string | PublicKey): boolean {
  const pk = typeof pubkey === "string" ? new PublicKey(pubkey) : pubkey;
  return !PublicKey.isOnCurve(pk.toBytes());
}

const factsCache = new Map<string, { at: number; facts: MintFacts | null }>();
const FACTS_TTL_MS = 5 * 60_000;

/**
 * Read the facts guard 3 needs about a mint: which token program, decimals,
 * mint/freeze authority, and for Token-2022 the permanent delegate and the
 * metadata update authority (only when the metadata pointer targets the mint
 * itself; Metaplex-external metadata is not parsed here).
 */
export async function getMintFacts(mint: string, opts: { force?: boolean } = {}): Promise<MintFacts | null> {
  const hit = factsCache.get(mint);
  if (hit && !opts.force && Date.now() - hit.at < FACTS_TTL_MS) return hit.facts;

  const pk = new PublicKey(mint);
  const info = await connection().getAccountInfo(pk);
  let facts: MintFacts | null = null;
  if (info && (info.owner.equals(TOKEN_PROGRAM_ID) || info.owner.equals(TOKEN_2022_PROGRAM_ID))) {
    const is2022 = info.owner.equals(TOKEN_2022_PROGRAM_ID);
    const m = unpackMint(pk, info, info.owner);
    let metadataUpdateAuthority: string | null = null;
    let permanentDelegate: string | null = null;
    let uiMultiplier = 1;
    if (is2022) {
      const pd = getPermanentDelegate(m);
      permanentDelegate = pd?.delegate.toBase58() ?? null;
      try {
        const sc = getScaledUiAmountConfig(m);
        if (sc) {
          const nowSec = BigInt(Math.floor(Date.now() / 1000));
          const eff = sc.newMultiplierEffectiveTimestamp <= nowSec ? sc.newMultiplier : sc.multiplier;
          if (Number.isFinite(eff) && eff > 0) uiMultiplier = eff;
        }
      } catch {
        uiMultiplier = 1;
      }
      const ptr = getMetadataPointerState(m);
      if (ptr?.metadataAddress && ptr.metadataAddress.equals(pk)) {
        try {
          const md = await getTokenMetadata(connection(), pk, "confirmed", TOKEN_2022_PROGRAM_ID);
          metadataUpdateAuthority = md?.updateAuthority?.toBase58() ?? null;
        } catch {
          metadataUpdateAuthority = null;
        }
      }
    }
    facts = {
      mint,
      tokenProgram: is2022 ? "token-2022" : "spl-token",
      decimals: m.decimals,
      mintAuthority: m.mintAuthority?.toBase58() ?? null,
      freezeAuthority: m.freezeAuthority?.toBase58() ?? null,
      metadataUpdateAuthority,
      permanentDelegate,
      uiMultiplier,
    };
  }
  factsCache.set(mint, { at: Date.now(), facts });
  return facts;
}
