import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { Keypair } from "@solana/web3.js";
import { env, optionalEnv } from "../config.js";

function expand(p: string) {
  return p.replace(/^~/, homedir());
}

/** A key given inline: the contents of a Solana CLI key file (a JSON array) rather than its path. */
const isInline = (source: string) => source.trim().startsWith("[");

/**
 * A keypair from a Solana CLI key file, or from that file's contents. A value starting with "[" is the key
 * itself (the JSON array of 64 numbers), so a host without a disk (Railway, Render) can keep keys in sealed
 * secret variables. `name` labels the error, which never includes the value.
 */
export function loadKeypair(source: string, name = "key"): Keypair {
  const bad = () => new Error(`${name}: not a Solana key (expected a key file's path, or its JSON array of 64 numbers)`);
  let bytes: unknown;
  try {
    bytes = JSON.parse(isInline(source) ? source : readFileSync(expand(source), "utf8"));
  } catch (e) {
    // JSON.parse quotes the input in its message; never let a key reach the logs.
    if (!isInline(source) && (e as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`${name}: no key file at ${source}`);
    throw bad();
  }
  if (!Array.isArray(bytes) || bytes.length !== 64 || !bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) throw bad();
  return Keypair.fromSecretKey(Uint8Array.from(bytes));
}

/** For setup scripts: load the key, or write a new one to the path when there is none. */
export function loadOrCreateKeypair(path: string): Keypair {
  if (isInline(path)) return loadKeypair(path);
  const p = expand(path);
  if (existsSync(p)) return loadKeypair(p);
  const kp = Keypair.generate();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
  return kp;
}

let _agent: Keypair | null = null;
let _desk: Keypair | null = null;
let _payer: Keypair | null = null;
let _issuer: Keypair | null = null;

/**
 * The delegated signer. Never created here: every vault names its agent, so a new one would silently
 * orphan them all (it happened on a first deploy). `setup-devnet.ts` makes it; production belongs in a KMS/TEE.
 */
export function agentKeypair(): Keypair {
  return (_agent ??= loadKeypair(env.AGENT_KEYPAIR, "AGENT_KEYPAIR"));
}
export function deskKeypair(): Keypair {
  return (_desk ??= loadKeypair(env.DESK_KEYPAIR, "DESK_KEYPAIR"));
}
/** Devnet payer: funds test money, deploys, and acts as the owner in scripts. */
export function payerKeypair(): Keypair {
  return (_payer ??= loadKeypair(optionalEnv("PAYER_KEYPAIR") ?? optionalEnv("MOCK_WALLET_KEYPAIR") ?? "~/.config/solana/id.json", "PAYER_KEYPAIR"));
}
/** The devnet mock issuer: mints the mock stocks (services/mocks.ts). */
export function issuerKeypair(): Keypair {
  return (_issuer ??= loadKeypair(env.ISSUER_KEYPAIR, "ISSUER_KEYPAIR"));
}
