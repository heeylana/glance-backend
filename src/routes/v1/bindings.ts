/** Bindings as the bot sees them (§1.3). A client only sees and removes the bindings it made. */
import { z } from "zod";
import { body } from "../_shared.js";
import { botAuth, v1Router } from "./_auth.js";
import { ApiError } from "./codes.js";
import { CHANNELS, getBinding, maskUser, removeBinding, updateBinding, type Binding } from "../../services/connect.js";
import { sessionView } from "../../services/session-view.js";
import { env } from "../../config.js";

const r = v1Router();
r.use("/bindings/*", botAuth);

const Params = z.object({ channel: z.enum(CHANNELS), user: z.string().regex(/^[A-Za-z0-9_+.-]{3,64}$/) });

async function ownBinding(c: { req: { param: (k: string) => string }; get: (k: "client") => { id: string } }): Promise<Binding> {
  const p = Params.safeParse({ channel: c.req.param("channel"), user: c.req.param("user") });
  if (!p.success) throw new ApiError("bad_request");
  const b = await getBinding(p.data.channel, p.data.user);
  if (!b || b.clientId !== c.get("client").id) throw new ApiError("not_bound");
  return b;
}

export async function bindingView(b: Binding) {
  const v = await sessionView(b.owner);
  return {
    channel: b.channel,
    channel_user_id: b.channelUserId,
    masked_user: maskUser(b.channel, b.channelUserId),
    wallet: b.owner,
    vault: v.vault,
    vault_exists: v.exists,
    agent_active: v.agentActive,
    agent_expires_at: v.agentExpiresAt,
    paused: v.paused,
    cash_usd: v.cashUsd.toFixed(2),
    daily_cap_usd: v.dailyCapUsd.toFixed(2),
    remaining_today_usd: v.remainingTodayUsd.toFixed(2),
    confirm_each_trade: b.confirmEachTrade,
    created_at: b.createdAt.toISOString(),
    console_url: env.WEB_CONSOLE_URL,
    cluster: v.cluster,
  };
}

r.get("/bindings/:channel/:user", async (c) => c.json({ ok: true, binding: await bindingView(await ownBinding(c)) }));

r.patch("/bindings/:channel/:user", async (c) => {
  const b = await ownBinding(c);
  const patch = await body(c, z.object({ confirm_each_trade: z.boolean() }));
  const updated = await updateBinding(b.channel, b.channelUserId, { confirmEachTrade: patch.confirm_each_trade });
  return c.json({ ok: true, binding: await bindingView(updated ?? b) });
});

/** Unbind. Does not touch the chain: the response says where to revoke. */
r.delete("/bindings/:channel/:user", async (c) => {
  const b = await ownBinding(c);
  await removeBinding(b.channel, b.channelUserId);
  return c.json({ ok: true, removed: true, console_url: env.WEB_CONSOLE_URL, message: "Disconnected. Glance's permission on your account still stands; revoke it in the console if you want it gone." });
});

export default r;
