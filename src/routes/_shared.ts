import { Hono, type Context } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import { GuardCode, GuardError } from "../lib/errors.js";
import { verifyToken } from "../services/auth.js";
import * as store from "../services/store.js";

export type Vars = {
  /** Owner wallet pubkey (base58). */
  owner: string;
  user: store.User;
  session: store.Session;
};

export type App = Hono<{ Variables: Vars }>;
export const router = () => new Hono<{ Variables: Vars }>();

/** Spec §8.3 guard 1: a session JWT issued after a wallet signature. Identity is the owner pubkey. */
export const auth = createMiddleware<{ Variables: Vars }>(async (c, next) => {
  const h = c.req.header("authorization");
  if (!h?.startsWith("Bearer ")) throw new GuardError(GuardCode.AUTH_INVALID);
  const { owner } = await verifyToken(h.slice(7));
  const { user, session } = await store.ensureUser(owner);
  c.set("owner", owner);
  c.set("user", user);
  c.set("session", session);
  await next();
});

export async function body<T extends z.ZodTypeAny>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new GuardError(GuardCode.BAD_REQUEST, {}, "invalid json");
  }
  const r = schema.safeParse(raw);
  if (!r.success) throw new GuardError(GuardCode.BAD_REQUEST, { detail: r.error.issues }, "validation failed");
  return r.data;
}

export const TradeContextSchema = z
  .object({
    url: z.string().max(2048).optional(),
    title: z.string().max(512).optional(),
    site: z.string().max(32).optional(),
    screenshotHash: z.string().max(128).optional(),
    note: z.string().max(1000).optional(),
  })
  .optional();
