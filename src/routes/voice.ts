import { z } from "zod";
import { auth, body, router } from "./_shared.js";
import { GuardCode, GuardError } from "../lib/errors.js";
import { log } from "../lib/log.js";
import { decodeWavDataUrl, STT_MAX_BYTES, sttEnabled, transcribe } from "../services/stt.js";
import { interpret, UNKNOWN, VoiceContextSchema } from "../services/voice.js";

const VoiceSchema = z
  .object({
    /** `data:audio/wav;base64,…`, 16 kHz mono, recorded while the user held the key. */
    audio: z.string().max(Math.ceil((STT_MAX_BYTES * 4) / 3) + 64).optional(),
    /** Already-transcribed text instead of audio (curl, tests). */
    text: z.string().min(1).max(500).optional(),
    context: VoiceContextSchema,
  })
  .refine((b) => !!b.audio !== !!b.text, { message: "send audio or text" });

const r = router();
r.use("*", auth);

/**
 * POST /voice {audio | text, context} — push-to-talk (spec §7.4): transcript and command out. The
 * extension acts on the command with the bubble's own buttons; nothing here moves money. Neither the
 * audio nor the transcript is stored or logged.
 */
r.post("/voice", async (c) => {
  const b = await body(c, VoiceSchema);
  const t0 = Date.now();
  let transcript = b.text?.trim() ?? "";
  let sttMs: number | undefined;
  if (b.audio) {
    const wav = decodeWavDataUrl(b.audio);
    if (!wav) throw new GuardError(GuardCode.BAD_REQUEST, {}, "audio must be a wav data url");
    if (!sttEnabled()) throw new GuardError(GuardCode.VOICE_UNAVAILABLE);
    const heard = await transcribe(wav);
    sttMs = Date.now() - t0;
    if (heard === null) throw new GuardError(GuardCode.VOICE_UNAVAILABLE);
    transcript = heard;
  }
  const { command, via } = transcript ? await interpret(transcript, b.context) : { command: UNKNOWN, via: "none" as const };
  log.info("voice", { view: b.context.view, kind: command.kind, via, chars: transcript.length, sttMs, ms: Date.now() - t0 });
  return c.json({ ok: true, transcript, command, via });
});

export default r;
