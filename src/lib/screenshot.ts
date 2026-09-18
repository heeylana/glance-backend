/**
 * Screenshot handling for the vision fallback (spec §7.3, §7.9): the image is parsed, hashed,
 * read once by the LLM, and dropped. Only the hash survives, in the journal entry of a buy.
 */
import { createHash } from "node:crypto";

export type ImageMediaType = "image/jpeg" | "image/png" | "image/webp";

const DATA_URL = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/;

/** Parse a `data:image/...;base64,` URL as produced by `chrome.tabs.captureVisibleTab`. */
export function parseImageDataUrl(dataUrl: string): { mediaType: ImageMediaType; bytes: Buffer; base64: string } {
  const m = DATA_URL.exec(dataUrl);
  if (!m) throw new Error("not an image data url");
  const bytes = Buffer.from(m[2]!, "base64");
  if (bytes.length === 0) throw new Error("empty image");
  return { mediaType: m[1] as ImageMediaType, bytes, base64: m[2]! };
}

export function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
