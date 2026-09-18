import { env } from "../config.js";
import type { PythPrice } from "../guards/price.js";

interface HermesParsed {
  id: string;
  price: { price: string; conf: string; expo: number; publish_time: number };
  ema_price?: { price: string; conf: string; expo: number; publish_time: number };
}

function norm(id: string) {
  return id.replace(/^0x/, "").toLowerCase();
}

function headers(): Record<string, string> {
  const h: Record<string, string> = { accept: "application/json" };
  if (env.PYTH_API_KEY) h.authorization = `Bearer ${env.PYTH_API_KEY}`;
  return h;
}

function toPrice(p: HermesParsed): PythPrice {
  return { price: BigInt(p.price.price), conf: BigInt(p.price.conf), expo: p.price.expo, publishTime: p.price.publish_time };
}

/** Latest prices for a set of Hermes feed ids. Missing ids are simply absent from the map. */
export async function getLatestPrices(feedIds: string[]): Promise<Map<string, PythPrice>> {
  const out = new Map<string, PythPrice>();
  if (feedIds.length === 0) return out;
  const qs = feedIds.map((id) => `ids[]=${norm(id)}`).join("&");
  const res = await fetch(`${env.PYTH_HERMES_URL}/v2/updates/price/latest?${qs}&parsed=true`, {
    headers: headers(),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`hermes ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { parsed?: HermesParsed[] };
  for (const p of body.parsed ?? []) out.set(norm(p.id), toPrice(p));
  return out;
}

export async function getLatestPrice(feedId: string): Promise<PythPrice | null> {
  return (await getLatestPrices([feedId])).get(norm(feedId)) ?? null;
}

/** Historical price at a unix timestamp via Pyth Benchmarks. Returns null if the feed has no data there. */
export async function getPriceAt(feedId: string, unixSec: number): Promise<PythPrice | null> {
  const res = await fetch(
    `${env.PYTH_BENCHMARKS_URL}/v1/updates/price/${Math.floor(unixSec)}?ids=${norm(feedId)}&parsed=true&encoding=hex`,
    { headers: headers(), signal: AbortSignal.timeout(5000) },
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`benchmarks ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { parsed?: HermesParsed[] };
  const p = body.parsed?.find((x) => norm(x.id) === norm(feedId));
  return p ? toPrice(p) : null;
}

export function usd(p: PythPrice): number {
  return Number(p.price) * 10 ** p.expo;
}
