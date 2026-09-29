/**
 * Find the devnet mocks a vault holds that the committed registry has lost, check each on-chain, and
 * print their entries for issuers.mock.json (services/harvest.ts). Read-only: it writes no file, sends
 * no transaction and loads no key. The JSON goes to stdout; what was checked and skipped goes to stderr.
 *
 *   pnpm script:harvest-mocks <wallet address>
 *
 * Paste the printed entries into "mints" in src/config/issuers.mock.json. Existing entries stay as
 * they are: a mint already in the file is never printed.
 */
import { readFileSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";
import { env } from "../config.js";
import { bundledRegistryPath, loadCatalog } from "../config/issuers.js";
import { judgeMock, readMock, vaultHoldings, type HarvestedEntry } from "../services/harvest.js";

async function main() {
  const arg = process.argv[2];
  let owner: PublicKey;
  try {
    owner = new PublicKey(arg ?? "");
  } catch {
    console.error("usage: pnpm script:harvest-mocks <wallet address>  (the full base58 address, not the shortened one)");
    process.exit(2);
  }
  if (env.SOLANA_CLUSTER !== "devnet") {
    console.error(`SOLANA_CLUSTER is ${env.SOLANA_CLUSTER}: mocks only exist on devnet.`);
    process.exit(2);
  }

  // The committed file is the source of truth here: read it directly, not through registryPath(),
  // which would seed ISSUER_REGISTRY_FILE if it were set.
  const committed = JSON.parse(readFileSync(bundledRegistryPath("mock"), "utf8")) as {
    stableMints: string[];
    rules: { method: string; address: string }[];
    mints: Record<string, { referenceMint: string }>;
  };
  const issuers = [...new Set(committed.rules.filter((r) => r.method === "permanent_delegate").map((r) => r.address))];
  if (issuers.length !== 1) {
    console.error(`expected one mock issuer (a permanent_delegate rule) in issuers.mock.json, found ${issuers.length}`);
    process.exit(1);
  }
  const mockIssuer = issuers[0]!;
  const catalog = loadCatalog();

  const { vault, vaultExists, holdings } = await vaultHoldings(owner);
  console.error(`wallet ${owner.toBase58()}\nvault  ${vault}${vaultExists ? "" : "  (no vault account on this program: wrong wallet, or VAULT_PROGRAM_ID?)"}\nrpc    ${env.SOLANA_RPC_URL}\nmock issuer ${mockIssuer}\n`);
  console.error(`${holdings.length} token account(s)`);

  const known = new Set([...committed.stableMints, ...Object.keys(committed.mints)]);
  const unknown = holdings.filter((h) => !known.has(h.mint));
  for (const h of holdings) if (known.has(h.mint)) console.error(`  known    ${h.mint}  ${h.amount}`);

  const out: Record<string, HarvestedEntry> = {};
  let rejected = 0;
  for (const h of unknown) {
    const verdict = judgeMock(await readMock(h.mint), catalog, mockIssuer);
    if (!verdict.ok) {
      rejected++;
      console.error(`  SKIPPED  ${h.mint}  ${h.amount}\n           ${verdict.reasons.join("\n           ")}`);
      continue;
    }
    const { entry, listing } = verdict;
    console.error(`  FOUND    ${h.mint}  ${h.amount}  ${listing.symbol} (${listing.issuer}), reference ${listing.mint}`);
    const twin = Object.entries(committed.mints).find(([, e]) => e.referenceMint === entry.referenceMint);
    // Still printed: the position in it is only sellable if the backend knows the mint. Buys keep going to the first entry.
    if (twin) console.error(`           note: ${twin[0]} already trades this listing; both will be kept`);
    out[h.mint] = entry;
  }

  console.error(`\n${Object.keys(out).length} to add, ${rejected} skipped\n`);
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
