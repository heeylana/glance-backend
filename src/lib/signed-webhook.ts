/**
 * Webhooks from the API to a bot (agent expiry warnings): one POST, signed with HMAC-SHA256 over the
 * body. The key is sha256(client secret), which both sides can compute and which never leaves memory
 * here as the secret itself. Never throws; a failure is a log line.
 */
import { createHmac } from "node:crypto";
import { log } from "./log.js";
import type { ApiClient } from "../routes/v1/_auth.js";

export function signBody(keyHash: Buffer, body: string): string {
  return `sha256=${createHmac("sha256", keyHash).update(body).digest("hex")}`;
}

export async function postWebhook(client: ApiClient, event: string, payload: Record<string, unknown>): Promise<boolean> {
  if (!client.webhookUrl) return false;
  const body = JSON.stringify({ event, at: new Date().toISOString(), ...payload });
  try {
    const res = await fetch(client.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "x-glance-event": event, "x-glance-signature": signBody(client.secretHash, body) },
      body,
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) log.warn("webhook refused", { client: client.id, event, status: res.status });
    return res.ok;
  } catch (e) {
    log.warn("webhook failed", { client: client.id, event, err: String(e) });
    return false;
  }
}
