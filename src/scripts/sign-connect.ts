/**
 * Sign a chat connect message as the local payer, for testing /v1 by hand (Postman, curl). Prints the
 * wallet and the signature to paste into POST /v1/connect/sessions/{code}/verify.
 *
 *   pnpm tsx src/scripts/sign-connect.ts <code>
 *
 * A real user signs this in Phantom on the console's /connect/<code> page; this is the same bytes.
 */
import nacl from "tweetnacl";
import bs58 from "bs58";
import { env } from "../config.js";
import { payerKeypair } from "../services/keys.js";

const code = process.argv[2];
if (!code) throw new Error("usage: sign-connect.ts <code>");
const kp = payerKeypair();
const wallet = kp.publicKey.toBase58();
const base = (process.env.GLANCE_API_URL ?? `http://localhost:${env.PORT}`).replace(/\/$/, "");
const res = (await (await fetch(`${base}/v1/connect/sessions/${code}?wallet=${wallet}`)).json()) as { status: string; message?: string };
if (!res.message) throw new Error(`session is ${res.status}; ask for a new code`);
const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(res.message), kp.secretKey));
console.log(JSON.stringify({ wallet, signature }, null, 2));
