/** Voice notes in and spoken lines out (§5): the same speech-to-text and voice as the bubble, for a chat client. */
import { z } from "zod";
import { body } from "../_shared.js";
import { botAuth, channelUser, rateLimit, v1Router } from "./_auth.js";
import { ApiError } from "./codes.js";
import { STT_MAX_BYTES, sttEnabled, transcribeAudio } from "../../services/stt.js";
import { interpret, VoiceContextSchema } from "../../services/voice.js";
import { synthesize, ttsEnabled, TTS_MAX_CHARS } from "../../services/tts.js";

const r = v1Router();
r.use("*", botAuth, channelUser({ required: false }), rateLimit(60));

const AUDIO_MIMES = ["audio/ogg", "audio/opus", "audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp4", "audio/aac", "audio/webm", "audio/amr"];

/** `data:audio/ogg;base64,…` (the bot downloads the note and sends it on). The audio is transcribed once and dropped. */
r.post("/voice", async (c) => {
  const b = await body(c, z.object({ audio: z.string().max(4_000_000), context: VoiceContextSchema.partial().optional() }));
  if (!sttEnabled()) throw new ApiError("not_available", undefined, "I can't hear voice notes right now. Type it instead?");
  const m = /^data:([a-z0-9/+.-]+)(?:;codecs=[^;]+)?;base64,([A-Za-z0-9+/=]+)$/i.exec(b.audio);
  if (!m) throw new ApiError("bad_request", undefined, "audio must be a base64 data URL");
  const mime = m[1]!.toLowerCase();
  if (!AUDIO_MIMES.includes(mime)) throw new ApiError("bad_request", undefined, `audio type ${mime} is not supported`);
  const bytes = new Uint8Array(Buffer.from(m[2]!, "base64")) as Uint8Array<ArrayBuffer>;
  if (bytes.length > STT_MAX_BYTES * 2) throw new ApiError("bad_request", undefined, "that clip is too long");
  const transcript = await transcribeAudio(bytes, mime);
  if (!transcript) return c.json({ ok: true, transcript: null, command: null, via: "none" });
  const ctx = { view: b.context?.view ?? "none", entities: b.context?.entities ?? [], current: b.context?.current ?? null, amountUsd: b.context?.amountUsd ?? null } as const;
  const { command, via } = await interpret(transcript, ctx);
  return c.json({ ok: true, transcript, command, via });
});

/** A line in Glance's voice, as base64 audio the bot sends as a voice message. Null-safe: no key → 503 with the plain line. */
r.post("/speak", async (c) => {
  const b = await body(c, z.object({ text: z.string().min(1).max(TTS_MAX_CHARS) }));
  if (!ttsEnabled()) throw new ApiError("not_available", undefined, "Glance has no voice configured.");
  const clip = await synthesize(b.text);
  if (!clip) throw new ApiError("not_available", undefined, "Glance couldn't speak that line.");
  return c.json({ ok: true, mime: clip.mime, audio: clip.bytes.toString("base64"), cached: clip.cached });
});

export default r;
