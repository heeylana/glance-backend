/**
 * The hourly look at every bound account's agent permission. Within 24 hours of expiry, then within one
 * hour, then once it has lapsed, the bot that made the binding gets one signed webhook per threshold so it
 * can send the reminder (a template outside the 24-hour window). The bot also checks on every inbound
 * message, so this is the only path that needs a template.
 */
import { listBindings, updateBinding, userTag } from "./connect.js";
import { sessionView } from "./session-view.js";
import { apiClients } from "../routes/v1/_auth.js";
import { postWebhook } from "../lib/signed-webhook.js";
import { log } from "../lib/log.js";

export type ExpiryThreshold = "24h" | "1h" | "expired";

/** Which warning an expiry time calls for right now, or null when none is due. Pure. */
export function thresholdFor(agentExpiresAt: string | null, agentActive: boolean, now = Date.now()): ExpiryThreshold | null {
  if (!agentExpiresAt) return null;
  if (!agentActive) return "expired";
  const left = new Date(agentExpiresAt).getTime() - now;
  if (left <= 3_600_000) return "1h";
  if (left <= 24 * 3_600_000) return "24h";
  return null;
}

export async function scanAgentExpiry(now = new Date()): Promise<{ checked: number; warned: number }> {
  const bindings = await listBindings();
  let warned = 0;
  for (const b of bindings) {
    const client = apiClients().get(b.clientId);
    if (!client?.webhookUrl) continue;
    let view: Awaited<ReturnType<typeof sessionView>>;
    try {
      view = await sessionView(b.owner);
    } catch (e) {
      log.warn("expiry scan: vault read failed", { user: userTag(b.channel, b.channelUserId), err: String(e) });
      continue;
    }
    if (!view.exists) continue;
    const t = thresholdFor(view.agentExpiresAt, view.agentActive, now.getTime());
    if (!t || b.warnedExpiryFor === t) continue;
    const ok = await postWebhook(client, t === "expired" ? "agent_expired" : "agent_expiring", {
      channel: b.channel,
      channel_user_id: b.channelUserId,
      threshold: t,
      expires_at: view.agentExpiresAt,
      console_url: view.consoleUrl,
    });
    if (ok) {
      await updateBinding(b.channel, b.channelUserId, { warnedExpiryAt: now, warnedExpiryFor: t });
      warned++;
    }
    // The public RPC rate-limits bursts; the scan is in no hurry.
    await new Promise((r) => setTimeout(r, 250));
  }
  return { checked: bindings.length, warned };
}
