/**
 * Deepgram, the fast path for both directions of voice. Fish Audio stays behind it as the fallback, so a
 * deploy with no Deepgram key behaves exactly as before.
 *
 * Why: measured from Lagos against the deployed backend, Fish's s2.1-pro-free tier took 6.5-10.4s to
 * synthesize one spoken line and its ASR took 3.3s. Deepgram answers the same two calls in well under a
 * second, and it is the provider the EVM build already uses, so the voice a judge hears is the same speed
 * on both chains.
 *
 * speak  DEEPGRAM_TTS_VOICE picks the voice and the endpoint by its prefix:
 *          aura-*  Aura-2, POST /v1/speak?model=<voice>&encoding=mp3
 *          flux-*  Flux TTS, POST /v2/speak?model=<voice>&encoding=mp3
 *        Either way MP3 comes back, which is exactly what the extension already plays, so nothing in the
 *        route or the panel changes. The body is buffered here like Fish's: the lines are short, and
 *        streaming would mean changing the route and the player too.
 * listen POST /v1/listen?model=nova-3, the WAV bytes as the body. `keyterm` prompting is given the names
 *        Glance actually hears ("Anduril", "xStocks"), which general models mishear.
 *
 * The key is sent only to Deepgram, in the Authorization header, and is never logged or put in an error.
 */
import { Agent, request } from "node:https";
import { env } from "../config.js";
import { log } from "../lib/log.js";

const HOST = "api.deepgram.com";

/**
 * Lagos to Deepgram is a slow round trip, so a fresh TLS handshake per line costs more than synthesizing a
 * short one. This agent keeps the connection open between calls, as the Fish one does.
 */
const agent = new Agent({ keepAlive: true, keepAliveMsecs: 15_000, maxSockets: 8, maxFreeSockets: 4, timeout: 60_000 });

/** Names and tickers the resolver deals in that a general model hears wrong. nova-3 takes up to 100. */
const KEYTERMS: readonly string[] = [
  "Glance",
  "xStocks",
  "PreStocks",
  "Tessera",
  "Solana",
  "USDC",
  "Anduril",
  "Neuralink",
  "Anthropic",
  "SpaceX",
  "OpenAI",
  "Figure AI",
  "Kalshi",
  "Polymarket",
  "Nvidia",
  "Tesla",
  "pre-IPO",
];

export function deepgramReady(): boolean {
  return !!env.DEEPGRAM_API_KEY;
}

/** Flux voices ("flux-sienna-en") are served on /v2/speak; Aura voices ("aura-2-apollo-en") on /v1/speak. */
export function speakPath(voice: string): string {
  const base = voice.startsWith("flux-") ? "/v2/speak" : "/v1/speak";
  return `${base}?${new URLSearchParams({ model: voice, encoding: "mp3" })}`;
}

interface Answer {
  ok: boolean;
  status: number;
  mime: string | null;
  bytes: Buffer;
}

/** One POST to Deepgram over the kept-alive agent: status, content type and the whole body. */
function post(path: string, body: Buffer, headers: Record<string, string>, timeoutMs: number): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: HOST,
        path,
        method: "POST",
        agent,
        signal: AbortSignal.timeout(timeoutMs),
        headers: { ...headers, authorization: `Token ${env.DEEPGRAM_API_KEY}`, "content-length": String(body.byteLength) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          resolve({ ok: status >= 200 && status < 300, status, mime: res.headers["content-type"] ?? null, bytes: Buffer.concat(chunks) });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

/** The spoken line as MP3, or null when Deepgram has no key, refuses, or sends something that isn't audio. */
export async function speak(line: string): Promise<{ bytes: Buffer; mime: string; status: number } | null> {
  if (!env.DEEPGRAM_API_KEY) return null;
  try {
    const res = await post(speakPath(env.DEEPGRAM_TTS_VOICE), Buffer.from(JSON.stringify({ text: line }), "utf8"), { "content-type": "application/json" }, 12_000);
    if (!res.ok) {
      log.warn("deepgram tts failed", { status: res.status, body: res.bytes.toString("utf8").slice(0, 200) });
      return null;
    }
    const mime = res.mime?.split(";")[0] || "audio/mpeg";
    // A 200 that isn't audio (JSON, text) is as good as an error: Fish is asked instead.
    if (!/^audio\//i.test(mime) || res.bytes.length === 0) {
      log.warn("deepgram tts sent no audio", { status: res.status, mime });
      return null;
    }
    return { bytes: res.bytes, mime, status: res.status };
  } catch (e) {
    log.warn("deepgram tts failed", { err: String(e) });
    return null;
  }
}

/** The transcript of one push-to-talk take, or null when Deepgram has no key or refuses. */
export async function listen(wav: Uint8Array): Promise<string | null> {
  if (!env.DEEPGRAM_API_KEY) return null;
  const q = new URLSearchParams({ model: env.DEEPGRAM_STT_MODEL, smart_format: "true", language: "en", punctuate: "true" });
  for (const term of KEYTERMS) q.append("keyterm", term);
  try {
    const res = await post(`/v1/listen?${q}`, Buffer.from(wav), { "content-type": "audio/wav" }, 15_000);
    if (!res.ok) {
      log.warn("deepgram stt failed", { status: res.status, body: res.bytes.toString("utf8").slice(0, 200) });
      return null;
    }
    const json = JSON.parse(res.bytes.toString("utf8")) as {
      results?: { channels?: { alternatives?: { transcript?: unknown }[] }[] };
    };
    const text = json.results?.channels?.[0]?.alternatives?.[0]?.transcript;
    return typeof text === "string" && text.trim() ? text.trim() : null;
  } catch (e) {
    log.warn("deepgram stt failed", { err: String(e) });
    return null;
  }
}
