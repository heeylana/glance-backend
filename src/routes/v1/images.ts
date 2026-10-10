/** Images for a bound user (§4): upload, read, annotate, fetch. Deleted after a day by the sweep. */
import { z } from "zod";
import { body } from "../_shared.js";
import { botAuth, channelUser, rateLimit, v1Router } from "./_auth.js";
import { ApiError } from "./codes.js";
import { annotateImage, getImage, imageBytes, IMAGE_MAX_BYTES, isAccepted, normalizeImage, parseDataUrl, readImageRecord, storeImage, type ImageMark } from "../../services/images.js";

const r = v1Router();
r.use("*", botAuth, channelUser({ required: true }), rateLimit(60));

const imageView = (row: { id: string; sha256: string; width: number; height: number; bytes: number; kind: string; expiresAt: Date }) => ({
  image_id: row.id,
  kind: row.kind,
  sha256: row.sha256,
  width: row.width,
  height: row.height,
  bytes: row.bytes,
  expires_at: row.expiresAt.toISOString(),
  file_path: `/v1/images/${row.id}/file`,
});

/** `{ image: "data:image/jpeg;base64,…" }` up to 5 MB; HEIC is converted. Returns the normalized copy's id. */
r.post("/images", async (c) => {
  const b = await body(c, z.object({ image: z.string().max(7_200_000) }));
  const parsed = parseDataUrl(b.image);
  if (!parsed) throw new ApiError("bad_request", undefined, "image must be a base64 data URL");
  if (!isAccepted(parsed.mime)) throw new ApiError("image_unsupported");
  if (parsed.bytes.length > IMAGE_MAX_BYTES) throw new ApiError("image_too_large");
  let normalized;
  try {
    normalized = await normalizeImage(parsed.bytes, parsed.mime);
  } catch {
    throw new ApiError("image_unreadable", undefined, "That file isn't an image I can open.");
  }
  const row = await storeImage(c.get("owner"), normalized);
  return c.json({ ok: true, ...imageView(row) });
});

/** OCR and classification, cached on the image. `read` is null when the model could not read it. */
r.post("/images/:id/read", async (c) => {
  const res = await readImageRecord(c.req.param("id"), c.get("owner"));
  if (!res) throw new ApiError("image_expired");
  return c.json({ ok: true, image_id: res.row.id, sha256: res.sha256, cached: res.cached, read: res.read });
});

const MarkSchema = z.object({
  kind: z.enum(["ring", "box", "arrow", "label", "level", "number"]),
  box: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).nullable().optional(),
  from: z.object({ x: z.number(), y: z.number() }).nullable().optional(),
  text: z.string().max(32).nullable().optional(),
  price: z.number().nullable().optional(),
  n: z.number().int().min(1).max(9).nullable().optional(),
});

/** Marks on a copy. Returns the annotated image's id; the original is untouched. */
r.post("/images/:id/annotate", async (c) => {
  const b = await body(c, z.object({ marks: z.array(MarkSchema).min(1).max(12) }));
  const out = await annotateImage(c.req.param("id"), c.get("owner"), b.marks as ImageMark[]);
  if (!out) throw new ApiError("image_expired");
  return c.json({ ok: true, ...imageView(out.row), marks_drawn: out.marks.length });
});

/** The bytes, for the bot to send on. */
r.get("/images/:id/file", async (c) => {
  const row = await getImage(c.req.param("id"), c.get("owner"));
  if (!row) throw new ApiError("image_expired");
  const bytes = await imageBytes(row);
  if (!bytes) throw new ApiError("image_expired");
  return c.body(new Uint8Array(bytes), 200, { "content-type": row.mime, "content-length": String(bytes.length), "cache-control": "private, max-age=3600" });
});

export default r;
