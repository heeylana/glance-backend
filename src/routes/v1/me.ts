/** The owner's own bindings, under the console's session token: "Connected to WhatsApp" with Disconnect, usable without the phone. */
import { z } from "zod";
import { auth, body, router } from "../_shared.js";
import { listBindingsForOwner, maskUser, removeBinding, updateBinding } from "../../services/connect.js";
import { ApiError } from "./codes.js";

const r = router();
r.use("/me/*", auth);

const view = (b: Awaited<ReturnType<typeof listBindingsForOwner>>[number]) => ({
  channel: b.channel,
  channel_user_id: b.channelUserId,
  masked_user: maskUser(b.channel, b.channelUserId),
  confirm_each_trade: b.confirmEachTrade,
  created_at: b.createdAt.toISOString(),
});

r.get("/me/bindings", async (c) => c.json({ ok: true, bindings: (await listBindingsForOwner(c.get("owner"))).map(view) }));

r.patch("/me/bindings/:channel/:user", async (c) => {
  const mine = (await listBindingsForOwner(c.get("owner"))).find((b) => b.channel === c.req.param("channel") && b.channelUserId === c.req.param("user"));
  if (!mine) throw new ApiError("forbidden");
  const patch = await body(c, z.object({ confirm_each_trade: z.boolean() }));
  const updated = await updateBinding(mine.channel, mine.channelUserId, { confirmEachTrade: patch.confirm_each_trade });
  return c.json({ ok: true, binding: view(updated ?? mine) });
});

r.delete("/me/bindings/:channel/:user", async (c) => {
  const mine = (await listBindingsForOwner(c.get("owner"))).find((b) => b.channel === c.req.param("channel") && b.channelUserId === c.req.param("user"));
  if (!mine) throw new ApiError("forbidden");
  await removeBinding(mine.channel, mine.channelUserId);
  return c.json({ ok: true, removed: true });
});

export default r;
