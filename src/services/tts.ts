/**
 * Voice out (spec §7.1): the bubble's spoken line, synthesized by Fish Audio with the "Soft male" voice
 * and streamed back to the extension as MP3. The lines repeat a lot ("Glance is paused."), so a
 * small in-memory cache keyed by the text keeps the common ones instant. Without a key this returns
 * null and the extension falls back to the browser's own voice.
 */
import { createHash } from "node:crypto";
import { env } from "../config.js";
import { log } from "../lib/log.js";

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

/** The last call to Fish, for /health: a deploy with a key Fish refuses otherwise only shows as the browser voice. */
export const lastTts: { at: string | null; ok: boolean | null; status: number | null; reason: string | null } = { at: null, ok: null, status: null, reason: null };
function noteTts(ok: boolean, status: number | null, reason: string | null) {
  Object.assign(lastTts, { at: new Date().toISOString(), ok, status, reason });
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
  return createHash("sha256").update(`${env.FISH_AUDIO_VOICE_ID}|${env.FISH_AUDIO_MODEL}|${normalizeSpeech(text).toLowerCase()}`).digest("hex");
}

export function ttsEnabled(): boolean {
  return !!env.FISH_AUDIO_API_KEY;
}

export async function synthesize(text: string): Promise<{ bytes: Buffer; mime: string; cached: boolean } | null> {
  if (!env.FISH_AUDIO_API_KEY) return null;
  const line = normalizeSpeech(text);
  if (!line) return null;
  const key = ttsKey(line);
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit); // most recently used last
    return { ...hit, cached: true };
  }
  try {
    const res = await fetch(FISH_TTS, {
      method: "POST",
      headers: { authorization: `Bearer ${env.FISH_AUDIO_API_KEY}`, "content-type": "application/json", model: env.FISH_AUDIO_MODEL },
      body: JSON.stringify({ text: line, reference_id: env.FISH_AUDIO_VOICE_ID, format: "mp3", mp3_bitrate: 64, latency: "balanced" }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const reason = (await res.text().catch(() => "")).slice(0, 200);
      log.warn("tts failed", { status: res.status, body: reason });
      noteTts(false, res.status, reason);
      return null;
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    const mime = res.headers.get("content-type")?.split(";")[0] || "audio/mpeg";
    if (bytes.length === 0) {
      noteTts(false, res.status, "empty audio");
      return null;
    }
    noteTts(true, res.status, null);
    cache.set(key, { bytes, mime });
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
    return { bytes, mime, cached: false };
  } catch (e) {
    log.warn("tts failed", { err: String(e) });
    noteTts(false, null, String(e).slice(0, 200));
    return null;
  }
}
