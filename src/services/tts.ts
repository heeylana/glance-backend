/**
 * Voice out (spec §7.1): the bubble's spoken line, synthesized and sent back to the extension as MP3.
 * Deepgram speaks it when DEEPGRAM_API_KEY is set (services/deepgram.ts: under a second a line, where
 * Fish's free tier took six to ten), and Fish Audio's "Soft male" stays behind it as the fallback. The
 * lines repeat a lot ("Glance is paused."), so a small in-memory cache keyed by the text and the voice
 * keeps the common ones instant. With neither key this returns null and the panel shows the text in
 * silence, which is what the extension now does instead of using the browser's own voice.
 */
import { createHash } from "node:crypto";
import { Agent, request } from "node:https";
import { env } from "../config.js";
import { log } from "../lib/log.js";
import { deepgramReady, speak as deepgramSpeak } from "./deepgram.js";

/**
 * A spoken line's ceiling. It was 400, which silently dropped the four-part read (services/advice.ts,
 * about 520 characters) to the browser's own voice, because the route rejected the body and the
 * extension's speak() falls back on any failure. Long answers are said a line at a time, so this is
 * only the backstop for one unusually long line.
 */
export const TTS_MAX_CHARS = 1_000;
const FISH_TTS = "https://api.fish.audio/v1/tts";
const CACHE_MAX = 200;
const cache = new Map<string, { bytes: Buffer; mime: string }>();

/**
 * Fish is far from Lagos, so a fresh TLS handshake per line costs more than the synthesis of a short
 * one. This agent keeps the connection open between lines. It is used only for Fish here; the rest of
 * the backend keeps the global fetch.
 */
const fishAgent = new Agent({ keepAlive: true, keepAliveMsecs: 15_000, maxSockets: 8, maxFreeSockets: 4, timeout: 60_000 });

/** One POST to Fish over the kept-alive agent: status, content type and the whole body. */
function postFish(body: string, headers: Record<string, string>, signal: AbortSignal): Promise<{ ok: boolean; status: number; mime: string | null; bytes: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request(FISH_TTS, { method: "POST", agent: fishAgent, headers: { ...headers, "content-length": String(Buffer.byteLength(body)) }, signal }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const status = res.statusCode ?? 0;
        resolve({ ok: status >= 200 && status < 300, status, mime: res.headers["content-type"] ?? null, bytes: Buffer.concat(chunks) });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(body);
  });
}

/** The last synthesis, for /health: a deploy with a key the provider refuses otherwise only shows as silence. */
export const lastTts: { at: string | null; ok: boolean | null; status: number | null; reason: string | null; provider: string | null } = {
  at: null,
  ok: null,
  status: null,
  reason: null,
  provider: null,
};
function noteTts(ok: boolean, status: number | null, reason: string | null, provider: string | null = null) {
  Object.assign(lastTts, { at: new Date().toISOString(), ok, status, reason, provider });
}

/**
 * Who speaks: Deepgram when it has a key, Fish otherwise. Deepgram answers a short line in well under a
 * second where Fish's free tier took six to ten, so it goes first and Fish stays behind it as the fallback.
 */
export function ttsProvider(): string | null {
  if (deepgramReady()) return `deepgram ${env.DEEPGRAM_TTS_VOICE}`;
  return env.FISH_AUDIO_API_KEY ? `fish ${env.FISH_AUDIO_MODEL}` : null;
}

/** Collapse whitespace, soften the em dash the copy uses, and cap the length. */
export function normalizeSpeech(text: string): string {
  const line = text.replace(/\s*[—–]\s*/g, ", ").replace(/\s+/g, " ").trim();
  // Clipping mid-sentence is worse than saying less: cut at the last sentence that fits.
  if (line.length <= TTS_MAX_CHARS) return line;
  const cut = line.slice(0, TTS_MAX_CHARS);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
  log.warn("tts line too long", { chars: line.length });
  return stop > TTS_MAX_CHARS / 2 ? cut.slice(0, stop + 1) : cut;
}

export function ttsKey(text: string): string {
  // The voice is part of the key: change provider or voice and every cached line is synthesized again
  // rather than the panel playing yesterday's voice back.
  return createHash("sha256").update(`${ttsProvider() ?? "none"}|${env.FISH_AUDIO_VOICE_ID}|${normalizeSpeech(text).toLowerCase()}`).digest("hex");
}

export function ttsEnabled(): boolean {
  return !!(env.DEEPGRAM_API_KEY || env.FISH_AUDIO_API_KEY);
}

export async function synthesize(text: string): Promise<{ bytes: Buffer; mime: string; cached: boolean } | null> {
  if (!ttsEnabled()) return null;
  const line = normalizeSpeech(text);
  if (!line) return null;
  const key = ttsKey(line);
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit); // most recently used last
    return { ...hit, cached: true };
  }
  // Deepgram first when it is configured; on any failure Fish still gets its turn below, so one provider
  // refusing a key never costs the user the spoken line.
  if (deepgramReady()) {
    const dg = await deepgramSpeak(line);
    if (dg) {
      noteTts(true, dg.status, null, "deepgram");
      cache.set(key, { bytes: dg.bytes, mime: dg.mime });
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
      return { bytes: dg.bytes, mime: dg.mime, cached: false };
    }
    noteTts(false, null, "deepgram declined", "deepgram");
    if (!env.FISH_AUDIO_API_KEY) return null;
  }
  try {
    const res = await postFish(
      JSON.stringify({ text: line, reference_id: env.FISH_AUDIO_VOICE_ID, format: "mp3", mp3_bitrate: 64, latency: "balanced" }),
      { authorization: `Bearer ${env.FISH_AUDIO_API_KEY}`, "content-type": "application/json", model: env.FISH_AUDIO_MODEL },
      AbortSignal.timeout(15_000),
    );
    if (!res.ok) {
      const reason = res.bytes.toString("utf8").slice(0, 200);
      log.warn("tts failed", { status: res.status, body: reason });
      noteTts(false, res.status, reason, "fish");
      return null;
    }
    const bytes = res.bytes;
    const mime = res.mime?.split(";")[0] || "audio/mpeg";
    if (bytes.length === 0) {
      noteTts(false, res.status, "empty audio");
      return null;
    }
    noteTts(true, res.status, null, "fish");
    cache.set(key, { bytes, mime });
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
    return { bytes, mime, cached: false };
  } catch (e) {
    log.warn("tts failed", { err: String(e) });
    noteTts(false, null, String(e).slice(0, 200), "fish");
    return null;
  }
}

/**
 * Lines from the spec's fixed set that never vary, synthesized at boot so the first user to hear one
 * doesn't wait on a cold Fish call. Only lines with no number or company name in them: those differ
 * per user and would never hit. The greeting and the empty states are not here: their wording lives in
 * the spec and the extension, not in this repo, and a guessed line would just be a wasted call.
 */
export const WARM_LINES: readonly string[] = [
  // Said the moment the user stops talking, while the answer is still being worked out (the extension's ACK_LINES).
  // These are the most-heard lines in the product, so they are the ones that must never wait on the provider.
  "One moment.",
  "Let me look.",
  "On it.",
  "Glance is paused.",
  "Glance needs a quick renewal to keep buying for you.",
  "That didn't go through — nothing was spent. Try again?",
  "I can't get a fair price right now. Try again in a moment?",
  "Test money is running low. Ask the Glance team to top it up.",
  "Please sign in to Glance again.",
  "I can't hear you right now. Tap instead?",
  "I can't walk you through this page right now. Try again in a moment?",
  "I couldn't read this page well enough to remember it. Scroll to the story and try again?",
  "That's more than Glance buys in one go. Try a smaller amount, or raise the limit in settings?",
];

/**
 * Fill the cache with WARM_LINES, one at a time so a real user's line never queues behind a burst.
 * Best effort: never throws, stops at the first failure, and a line it missed is synthesized on first use.
 */
export async function warmTts(lines: readonly string[] = WARM_LINES): Promise<{ warmed: number; failed: string[] }> {
  const failed: string[] = [];
  let warmed = 0;
  if (!ttsEnabled()) return { warmed, failed };
  for (const [i, line] of lines.entries()) {
    const ok = await synthesize(line).catch(() => null);
    if (ok) {
      warmed++;
      continue;
    }
    // The provider is down or refusing the key: the rest would fail the same way, so stop asking.
    failed.push(...lines.slice(i));
    break;
  }
  return { warmed, failed };
}
