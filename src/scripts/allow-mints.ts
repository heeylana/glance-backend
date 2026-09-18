/**
 * Curate every stock mint in the active issuer registry on-chain (vault program v2), with the
 * registry's issuer rule for it. Idempotent.
 *
 *   pnpm tsx src/scripts/allow-mints.ts
 */
import { PublicKey } from "@solana/web3.js";
import { loadRegistry } from "../config/issuers.js";
import { payerKeypair } from "../services/keys.js";
import { ensureAllowed } from "../services/curation.js";

async function main() {
  const reg = loadRegistry();
  const admin = payerKeypair();
  const delegates = new Map(reg.rules.filter((r) => r.method === "permanent_delegate").map((r) => [r.issuer, r.address]));
  for (const e of reg.byMint.values()) {
    const d = delegates.get(e.issuer);
    const ok = await ensureAllowed(admin, new PublicKey(e.mint), d ? new PublicKey(d) : null);
    console.log(`${ok ? "allowed" : "MISMATCH"} ${e.ticker} ${e.mint} ${d ? `delegate ${d}` : "curation only"}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
