/** Connect sessions (doc/glance-whatsapp-bot-implementation-checklist.md §1.3). The page's calls carry no client credential: the code is the key. */
import { z } from "zod";
import { body } from "../_shared.js";
import { botAuth, rateLimit, v1Router } from "./_auth.js";
import { ApiError } from "./codes.js";
import { CHANNELS, completeSession, createSession, findSession, getBinding, maskUser, messageFor, sessionStatus, verifySession, userTag } from "../../services/connect.js";
import { sessionView } from "../../services/session-view.js";
import { issueToken } from "../../services/auth.js";
import { postWebhook } from "../../lib/signed-webhook.js";
import { apiClients } from "./_auth.js";
import { log } from "../../lib/log.js";

const r = v1Router();
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const HOUR = 3_600_000;

export type VaultStatus = "none" | "exists" | "agent_missing" | "agent_expiring";
export function vaultStatusOf(v: { exists: boolean; agentActive: boolean; agentExpiresAt: string | null }, now = Date.now()): VaultStatus {
  if (!v.exists) return "none";
  if (!v.agentActive) return "agent_missing";
  if (v.agentExpiresAt && new Date(v.agentExpiresAt).getTime() - now <= 24 * HOUR) return "agent_expiring";
  return "exists";
}

function vaultSummary(v: Awaited<ReturnType<typeof sessionView>>) {
  return {
    vault: v.vault,
    exists: v.exists,
    cashUsd: v.cashUsd.toFixed(2),
    dailyCapUsd: v.dailyCapUsd.toFixed(2),
    remainingTodayUsd: v.remainingTodayUsd.toFixed(2),
    agentActive: v.agentActive,
    agentExpiresAt: v.agentExpiresAt,
    paused: v.paused,
    cluster: v.cluster,
    consoleUrl: v.consoleUrl,
    sessionTtlDays: v.sessionTtlDays,
  };
}

/** Bot: a fresh link for a channel user. */
r.post("/connect/sessions", botAuth, rateLimit(30), async (c) => {
  const b = await body(c, z.object({ channel: z.enum(CHANNELS), channel_user_id: z.string().regex(/^[A-Za-z0-9_+.-]{3,64}$/) }));
  const s = await createSession({ clientId: c.get("client").id, channel: b.channel, channelUserId: b.channel_user_id });
  return c.json({ ok: true, code: s.code, url: s.url, expires_at: s.expiresAt.toISOString(), masked_user: maskUser(b.channel, b.channel_user_id) });
});

/** Page: what to show before any wallet action. With ?wallet= the exact message that wallet must sign. */
r.get("/connect/sessions/:code", async (c) => {
  const code = c.req.param("code");
  const s = await findSession(code);
  if (!s) return c.json({ ok: true, status: "expired" as const });
  const status = sessionStatus(s);
  const existing = await getBinding(s.channel, s.channelUserId);
  const wallet = c.req.query("wallet");
  return c.json({
    ok: true,
    status,
    channel: s.channel,
    masked_user: maskUser(s.channel, s.channelUserId),
    expires_at: s.expiresAt.toISOString(),
    already_bound_wallet: existing ? short(existing.owner) : null,
    verified_wallet: s.wallet ? short(s.wallet) : null,
    ...(wallet && status !== "used" && status !== "expired" ? { message: messageFor(s, code, wallet) } : {}),
  });
});

/** Page: the wallet's signature over the message. Returns the vault's state so the page knows what to do next. */
r.post("/connect/sessions/:code/verify", async (c) => {
  const b = await body(c, z.object({ wallet: z.string().min(32).max(44), signature: z.string().min(64).max(128) }));
  const v = await verifySession(c.req.param("code"), b.wallet, b.signature);
  if (!v.ok) throw new ApiError(v.code);
  const view = await sessionView(b.wallet);
  // The signature proved the wallet, which is all a session token asks for: the page can now build the
  // owner's vault transactions (POST /vault/tx) without a second message to sign.
  const token = await issueToken(b.wallet);
  return c.json({
    ok: true,
    wallet: b.wallet,
    token,
    vault_status: vaultStatusOf(view),
    vault: vaultSummary(view),
    replaces: v.replaces ? short(v.replaces.owner) : null,
    also_bound_to: v.alsoBoundTo,
  });
});

/** Page: after the on-chain steps. Re-reads the chain, binds, spends the code, and tells the bot. */
r.post("/connect/sessions/:code/complete", async (c) => {
  const b = await body(c, z.object({ vault: z.string().min(32).max(44).optional(), grant_signature: z.string().max(128).optional(), confirm_replace: z.boolean().optional(), confirm_multi: z.boolean().optional() }));
  const code = c.req.param("code");
  const s = await findSession(code);
  if (!s) throw new ApiError("session_expired");
  if (!s.wallet) throw new ApiError("session_not_verified");
  const view = await sessionView(s.wallet);
  if (!view.exists) throw new ApiError("vault_missing");
  if (!view.agentActive) throw new ApiError("agent_missing");
  if (b.vault && b.vault !== view.vault) throw new ApiError("bad_request", undefined, "That isn't this wallet's Glance account.");
  const done = await completeSession(code, { confirmReplace: !!b.confirm_replace, confirmMulti: !!b.confirm_multi });
  if (!done.ok) throw new ApiError(done.code);
  const client = apiClients().get(done.binding.clientId);
  if (client && !done.alreadyBound) {
    void postWebhook(client, "bound", { channel: s.channel, channel_user_id: s.channelUserId, wallet: s.wallet, vault: view.vault, agent_expires_at: view.agentExpiresAt });
  }
  log.info("connect complete", { user: userTag(s.channel, s.channelUserId), grant: b.grant_signature ? short(b.grant_signature) : undefined });
  return c.json({ ok: true, bound: true, channel: s.channel, masked_user: maskUser(s.channel, s.channelUserId), wallet: s.wallet, vault: vaultSummary(view) });
});

export default r;
