/**
 * Two-tier auth for /v1 (doc/glance-whatsapp-bot-implementation-checklist.md §1.1):
 *   botAuth      — a client credential from API_CLIENTS (`X-Client-Id` + `Authorization: Bearer <secret>`)
 *   channelUser  — `X-Channel-User: whatsapp:<wa_id>` resolved through the binding the client made, which
 *                  sets `owner`, `user` and `session` exactly as the owner-JWT `auth` does, so every
 *                  service below runs unchanged.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { env } from "../../config.js";
import { GuardCode, GuardError } from "../../lib/errors.js";
import * as store from "../../services/store.js";
import { getBinding, isChannel, type Binding, type Channel } from "../../services/connect.js";
import type { Vars } from "../_shared.js";
import { ApiError } from "./codes.js";

export interface ApiClient {
  id: string;
  secretHash: Buffer;
  webhookUrl: string | null;
}

let clients: Map<string, ApiClient> | null = null;

/** `id:secret,…` and `id=url,…` → clients. A secret under 16 characters is ignored, with a warning at start. Pure. */
export function parseClients(clientsStr: string | undefined, hooksStr: string | undefined): { clients: Map<string, ApiClient>; rejected: string[] } {
  const hooks = new Map<string, string>();
  for (const part of (hooksStr ?? "").split(",")) {
    const i = part.indexOf("=");
    if (i > 0) hooks.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  const out = new Map<string, ApiClient>();
  const rejected: string[] = [];
  for (const part of (clientsStr ?? "").split(",")) {
    if (!part.trim()) continue;
    const i = part.indexOf(":");
    const id = i > 0 ? part.slice(0, i).trim() : "";
    const secret = i > 0 ? part.slice(i + 1).trim() : "";
    if (!id || secret.length < 16) {
      rejected.push(id || "?");
      continue;
    }
    out.set(id, { id, secretHash: createHash("sha256").update(secret).digest(), webhookUrl: hooks.get(id) ?? null });
  }
  return { clients: out, rejected };
}

/** Clients from API_CLIENTS and their webhooks from API_WEBHOOKS. Parsed once. */
export function apiClients(force = false): Map<string, ApiClient> {
  if (clients && !force) return clients;
  clients = parseClients(env.API_CLIENTS, env.API_WEBHOOKS).clients;
  return clients;
}

export const secretHash = (secret: string) => createHash("sha256").update(secret).digest();

export type V1Vars = Vars & {
  client: ApiClient;
  channel: Channel;
  channelUserId: string;
  binding: Binding | null;
};

export const v1Router = () => new Hono<{ Variables: V1Vars }>();

export const botAuth = createMiddleware<{ Variables: V1Vars }>(async (c, next) => {
  const id = c.req.header("x-client-id") ?? "";
  const h = c.req.header("authorization") ?? "";
  const client = apiClients().get(id);
  if (!client || !h.startsWith("Bearer ")) throw new GuardError(GuardCode.AUTH_INVALID, {}, "unknown client");
  const given = secretHash(h.slice(7));
  if (given.length !== client.secretHash.length || !timingSafeEqual(given, client.secretHash)) throw new GuardError(GuardCode.AUTH_INVALID, {}, "bad client secret");
  c.set("client", client);
  await next();
});

/** Parse `channel:id`; the id is whatever the channel calls the user (WhatsApp: the E.164 digits). */
export function parseChannelUser(raw: string | undefined): { channel: Channel; channelUserId: string } | null {
  if (!raw) return null;
  const i = raw.indexOf(":");
  if (i <= 0) return null;
  const channel = raw.slice(0, i).trim().toLowerCase();
  const channelUserId = raw.slice(i + 1).trim();
  if (!isChannel(channel) || !/^[A-Za-z0-9_+.-]{3,64}$/.test(channelUserId)) return null;
  return { channel, channelUserId };
}

/**
 * The person behind the request. `required` routes refuse an unbound user with `not_bound`; optional
 * ones (prices, resolve) run for anyone and only pick up the session when there is a binding.
 */
export const channelUser = (opts: { required: boolean }) =>
  createMiddleware<{ Variables: V1Vars }>(async (c, next) => {
    const parsed = parseChannelUser(c.req.header("x-channel-user"));
    if (!parsed) {
      if (opts.required) throw new ApiError("not_bound", undefined, "X-Channel-User is missing or malformed.");
      c.set("binding", null);
      await next();
      return;
    }
    c.set("channel", parsed.channel);
    c.set("channelUserId", parsed.channelUserId);
    const binding = await getBinding(parsed.channel, parsed.channelUserId);
    // A client only acts for the bindings it made itself.
    const own = binding && binding.clientId === c.get("client").id ? binding : null;
    c.set("binding", own);
    if (own) {
      const { user, session } = await store.ensureUser(own.owner);
      c.set("owner", own.owner);
      c.set("user", user);
      c.set("session", session);
    } else if (opts.required) {
      throw new ApiError("not_bound");
    }
    await next();
  });

/** A small token bucket per key (client + channel user, or client alone); one instance, in memory. */
export function rateLimit(perMinute: number) {
  const buckets = new Map<string, { tokens: number; at: number }>();
  return createMiddleware<{ Variables: V1Vars }>(async (c, next) => {
    const key = `${c.get("client")?.id ?? "anon"}|${c.req.header("x-channel-user") ?? c.req.header("x-forwarded-for") ?? ""}`;
    const now = Date.now();
    const b = buckets.get(key) ?? { tokens: perMinute, at: now };
    b.tokens = Math.min(perMinute, b.tokens + ((now - b.at) / 60_000) * perMinute);
    b.at = now;
    if (b.tokens < 1) {
      buckets.set(key, b);
      throw new ApiError("rate_limited");
    }
    b.tokens -= 1;
    buckets.set(key, b);
    if (buckets.size > 10_000) buckets.clear();
    await next();
  });
}
