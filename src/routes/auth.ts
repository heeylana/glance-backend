import { Hono } from "hono";
import { z } from "zod";
import { auth, body, router } from "./_shared.js";
import { completeHandoff, createNonce, issueToken, pollHandoff, startHandoff, verifyAndIssue } from "../services/auth.js";
import { GuardCode, GuardError } from "../lib/errors.js";
import { optionalEnv } from "../config.js";

const pub = new Hono();

/** Step 1 of wallet sign-in: a nonce and the exact message Phantom will sign. */
pub.post("/auth/nonce", async (c) => {
  const b = await body(c, z.object({ pubkey: z.string().min(32).max(44) }));
  try {
    return c.json({ ok: true, ...createNonce(b.pubkey) });
  } catch {
    throw new GuardError(GuardCode.BAD_REQUEST, {}, "bad pubkey");
  }
});

/** Step 2: verify the ed25519 signature and issue a session token. */
pub.post("/auth/verify", async (c) => {
  const b = await body(c, z.object({ pubkey: z.string().min(32).max(44), nonce: z.string().min(8), signature: z.string().min(64) }));
  const r = await verifyAndIssue(b);
  return c.json({ ok: true, ...r });
});

/** Extension → console handoff. The extension starts a code and polls; the console completes it once signed in. */
pub.post("/auth/handoff/start", (c) => c.json({ ok: true, ...startHandoff() }));
pub.get("/auth/handoff/:code", (c) => {
  const r = pollHandoff(c.req.param("code"));
  if (r.status === "unknown") return c.json({ ok: false, code: "UNKNOWN_HANDOFF", message: "That sign-in link expired. Start again from the Glance panel." }, 404);
  return c.json({ ok: true, ...r });
});

/** Dev only: mint a session for any pubkey without a signature (DEV_LOGIN=1). Never enable in production. */
if (optionalEnv("DEV_LOGIN") === "1") {
  pub.post("/auth/dev", async (c) => {
    const b = await body(c, z.object({ pubkey: z.string().min(32).max(44) }));
    return c.json({ ok: true, token: await issueToken(b.pubkey), owner: b.pubkey });
  });
}

const priv = router();
priv.use("*", auth);
priv.post("/auth/handoff/complete", async (c) => {
  const b = await body(c, z.object({ code: z.string().min(8) }));
  const h = c.req.header("authorization")!.slice(7);
  const ok = completeHandoff(b.code, h, c.get("owner"));
  if (!ok) return c.json({ ok: false, code: "UNKNOWN_HANDOFF", message: "That sign-in link expired. Start again from the Glance panel." }, 404);
  return c.json({ ok: true });
});
priv.get("/auth/me", (c) => c.json({ ok: true, owner: c.get("owner") }));

export const authPublicRoutes = pub;
export const authPrivateRoutes = priv;
