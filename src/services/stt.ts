/**
 * Voice in (spec §7.4): push-to-talk audio to text with Fish Audio's ASR, the same vendor and key as
 * the voice out. The extension records 16 kHz mono WAV, because Fish rejects the WebM that
 * MediaRecorder produces. The audio is transcribed once and dropped; neither it nor the transcript is
 * stored or logged.
 */
import { env } from "../config.js";
import { log } from "../lib/log.js";

const FISH_ASR = "https://api.fish.audio/v1/asr";
/** ~45 s of 16 kHz mono 16-bit PCM; the extension stops recording at 30 s. */
export const STT_MAX_BYTES = 1_500_000;

export function sttEnabled(): boolean {
  return !!env.FISH_AUDIO_API_KEY;
}

/** Decode the extension's `data:audio/wav;base64,…` upload; null unless it is a RIFF/WAVE file of sane size. */
export function decodeWavDataUrl(dataUrl: string): Uint8Array<ArrayBuffer> | null {
  const m = /^data:audio\/(?:wav|wave|x-wav);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) return null;
  const bytes = new Uint8Array(Buffer.from(m[1]!, "base64"));
  if (bytes.length < 44 || bytes.length > STT_MAX_BYTES) return null;
  const tag = (o: number) => String.fromCharCode(...bytes.subarray(o, o + 4));
  return tag(0) === "RIFF" && tag(8) === "WAVE" ? bytes : null;
}

export async function transcribe(wav: Uint8Array<ArrayBuffer>): Promise<string | null> {
  if (!env.FISH_AUDIO_API_KEY) return null;
  const send = () => {
    const form = new FormData();
    form.append("audio", new Blob([wav], { type: "audio/wav" }), "speech.wav");
    // A hint only (Fish auto-detects); the command grammar is English.
    form.append("language", "en");
    form.append("ignore_timestamps", "true");
    return fetch(FISH_ASR, { method: "POST", headers: { authorization: `Bearer ${env.FISH_AUDIO_API_KEY}` }, body: form, signal: AbortSignal.timeout(15_000) });
  };
  try {
    // One retry for a dropped connection, a rate limit or a server hiccup: the user is waiting on this take.
    const retry = async (why: Record<string, unknown>) => {
      log.warn("stt retry", why);
      await new Promise((r) => setTimeout(r, 700));
      return send();
    };
    let res = await send().catch((e) => retry({ err: String(e) }));
    if (res.status === 429 || res.status >= 500) res = await retry({ status: res.status });
    if (!res.ok) {
      log.warn("stt failed", { status: res.status, body: (await res.text().catch(() => "")).slice(0, 200) });
      return null;
    }
    const json = (await res.json()) as { text?: unknown };
    return typeof json.text === "string" ? json.text.trim() : null;
  } catch (e) {
    log.warn("stt failed", { err: String(e) });
    return null;
  }
}
