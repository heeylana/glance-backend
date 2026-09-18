import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { Keypair } from "@solana/web3.js";
import { env, optionalEnv } from "../config.js";

function expand(p: string) {
  return p.replace(/^~/, homedir());
}

export function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(expand(path), "utf8"))));
}

export function loadOrCreateKeypair(path: string): Keypair {
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

/** The delegated signer. Created on first use in dev; in production load from KMS/TEE instead. */
export function agentKeypair(): Keypair {
  return (_agent ??= loadOrCreateKeypair(env.AGENT_KEYPAIR));
}
export function deskKeypair(): Keypair {
  return (_desk ??= loadKeypair(env.DESK_KEYPAIR));
}
/** Devnet payer: funds test money, deploys, and acts as the owner in scripts. */
export function payerKeypair(): Keypair {
  return (_payer ??= loadKeypair(optionalEnv("PAYER_KEYPAIR") ?? optionalEnv("MOCK_WALLET_KEYPAIR") ?? "~/.config/solana/id.json"));
}
