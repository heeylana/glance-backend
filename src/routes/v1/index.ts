/**
 * The Glance API (doc/glance-whatsapp-bot-implementation-checklist.md §1): a thin HTTP layer in front of
 * the services the extension already runs. Mounted at /v1 with its own error mapping, so every refusal
 * is `{ ok: false, code, message }` with a snake_case code the bot can switch on and a sentence it can send.
 */
import { v1Router } from "./_auth.js";
import { API_OWN, refusalOf } from "./codes.js";
import { log } from "../../lib/log.js";
import connectRoutes from "./connect.js";
import bindingRoutes from "./bindings.js";
import meRoutes from "./me.js";
import marketRoutes from "./market.js";
import vaultRoutes from "./vault.js";
import imageRoutes from "./images.js";
import voiceRoutes from "./voice.js";

export function v1App() {
  const app = v1Router();
  app.onError((err, c) => {
    const r = refusalOf(err);
    if (r) {
      if (r.status >= 500) log.error("api error", { code: r.body.code, path: c.req.path, msg: err.message });
      else log.info("api refused", { code: r.body.code, path: c.req.path });
      return c.json(r.body, r.status as 400);
    }
    log.error("api unhandled", { err: String(err), path: c.req.path, stack: (err as Error).stack?.split("\n").slice(0, 4).join(" | ") });
    return c.json({ ok: false, code: "internal", message: API_OWN.not_available.message }, 500);
  });
  app.route("/", connectRoutes);
  app.route("/", bindingRoutes);
  app.route("/", meRoutes);
  app.route("/", marketRoutes);
  app.route("/", vaultRoutes);
  app.route("/", imageRoutes);
  app.route("/", voiceRoutes);
  return app;
}
