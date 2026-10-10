/**
 * Chat images (doc/glance-whatsapp-bot-implementation-checklist.md §4): a screenshot or chart someone
 * sent, kept for a day under IMAGE_DIR as one normalized JPEG (rotated per EXIF, metadata stripped, long
 * edge ≤ 2000 px) so the model, the drawing and the user all see the same pixels. The read is cached on
 * the row; "show me" composites Glance's marks onto a copy and never touches the original.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import bs58 from "bs58";
import sharp from "sharp";
import heicConvert from "heic-convert";
import { and, eq, lt, sql } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { env } from "../config.js";
import { log } from "../lib/log.js";
import { readImage, type ImageChart, type ImageRead } from "./llm.js";
import { arrowPaths, arrowStart, boxPoints, edgePoint, notePlacement, polylinePath, priceToY, ringPoints, smoothPath, type Pt, type Rect } from "../lib/sketch.js";

export type ImageRow = typeof schema.images.$inferSelect;
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const MAX_EDGE = 2000;
export const ACCEPTED = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"] as const;
export type AcceptedMime = (typeof ACCEPTED)[number];
export const isAccepted = (m: string): m is AcceptedMime => (ACCEPTED as readonly string[]).includes(m);

const newId = () => bs58.encode(randomBytes(16));
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** `data:image/…;base64,…` → mime and bytes. Null for anything else. */
export function parseDataUrl(dataUrl: string): { mime: string; bytes: Buffer } | null {
  const m = /^data:([a-z0-9/+.-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(dataUrl);
  if (!m) return null;
  return { mime: m[1]!.toLowerCase(), bytes: Buffer.from(m[2]!, "base64") };
}

/** One JPEG the rest of the pipeline agrees on. HEIC goes through heic-convert first (prebuilt libvips has no HEIF decoder). */
export async function normalizeImage(bytes: Buffer, mime: string): Promise<{ bytes: Buffer; width: number; height: number; mime: "image/jpeg" }> {
  let input = bytes;
  if (mime === "image/heic" || mime === "image/heif") {
    const out = await heicConvert({ buffer: new Uint8Array(bytes) as unknown as Parameters<typeof heicConvert>[0]["buffer"], format: "JPEG", quality: 0.92 });
    input = Buffer.from(out);
  }
  const { data, info } = await sharp(input, { failOn: "none", limitInputPixels: 50_000_000 })
    .rotate()
    .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  return { bytes: data, width: info.width, height: info.height, mime: "image/jpeg" };
}

const filePath = (id: string) => join(env.IMAGE_DIR, `${id}.jpg`);
const expiry = (now = Date.now()) => new Date(now + env.IMAGE_TTL_HOURS * 3_600_000);

export async function storeImage(owner: string, normalized: { bytes: Buffer; width: number; height: number; mime: "image/jpeg" }, kind: "original" | "annotated" = "original"): Promise<ImageRow> {
  await mkdir(env.IMAGE_DIR, { recursive: true });
  const id = newId();
  await writeFile(filePath(id), normalized.bytes);
  const [row] = await db()
    .insert(schema.images)
    .values({ id, owner, kind, mime: normalized.mime, sha256: sha256(normalized.bytes), width: normalized.width, height: normalized.height, bytes: normalized.bytes.length, path: filePath(id), expiresAt: expiry() })
    .returning();
  log.info("image stored", { id, owner, kind, bytes: normalized.bytes.length, w: normalized.width, h: normalized.height });
  return row!;
}

/** The row, for its owner, while it lives. An expired row answers null (the sweep will delete it). */
export async function getImage(id: string, owner: string): Promise<ImageRow | null> {
  if (!/^[1-9A-HJ-NP-Za-km-z]{16,32}$/.test(id)) return null;
  const row = (await db().select().from(schema.images).where(and(eq(schema.images.id, id), eq(schema.images.owner, owner))))[0];
  if (!row || row.expiresAt.getTime() <= Date.now()) return null;
  return row;
}

export async function imageBytes(row: ImageRow): Promise<Buffer | null> {
  try {
    return await readFile(row.path);
  } catch {
    return null;
  }
}

/** The cached read, or one model call that is then kept on the row. `read` is null when the model could not read it. */
export async function readImageRecord(id: string, owner: string | null): Promise<{ row: ImageRow; read: ImageRead | null; sha256: string; cached: boolean } | null> {
  if (!owner) return null;
  const row = await getImage(id, owner);
  if (!row) return null;
  if (row.read) {
    const parsed = JSON.parse(row.read) as { read: ImageRead | null };
    return { row, read: parsed.read, sha256: row.sha256, cached: true };
  }
  const bytes = await imageBytes(row);
  if (!bytes) return null;
  const t0 = Date.now();
  const read = await readImage({ base64: bytes.toString("base64"), mediaType: "image/jpeg", width: row.width, height: row.height }).catch((e) => {
    log.warn("image read failed", { id, err: String(e) });
    return null;
  });
  if (read) await db().update(schema.images).set({ read: JSON.stringify({ read }) }).where(eq(schema.images.id, id));
  log.info("image read", { id, ms: Date.now() - t0, ok: !!read, kind: read?.kind, companies: read?.companies.length ?? 0, chart: !!read?.chart });
  return { row, read, sha256: row.sha256, cached: false };
}

// ---------------------------------------------------------------- marks

export interface ImageMark {
  kind: "ring" | "box" | "arrow" | "label" | "level" | "number";
  box?: Rect | null;
  from?: Pt | null;
  text?: string | null;
  price?: number | null;
  n?: number | null;
}

const intersects = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const clampRect = (r: Rect, w: number, h: number): Rect => {
  const x = Math.max(0, Math.min(w, r.x));
  const y = Math.max(0, Math.min(h, r.y));
  return { x, y, w: Math.max(1, Math.min(w - x, r.x + r.w - x)), h: Math.max(1, Math.min(h - y, r.y + r.h - y)) };
};

/** Only marks that land on the image survive: a box must overlap it, a level needs the chart's axis. At most eight. Pure. */
export function sanitizeMarks(marks: ImageMark[], width: number, height: number, chart: ImageChart | null): ImageMark[] {
  const frame = { x: 0, y: 0, w: width, h: height };
  const out: ImageMark[] = [];
  for (const m of marks) {
    if (out.length >= 8) break;
    const box = m.box && Number.isFinite(m.box.x) && Number.isFinite(m.box.y) && m.box.w > 0 && m.box.h > 0 && intersects(m.box, frame) ? clampRect(m.box, width, height) : null;
    const text = m.text?.trim().slice(0, 32) || null;
    switch (m.kind) {
      case "ring":
      case "box":
      case "number":
        if (box) out.push({ kind: m.kind, box, text, n: m.kind === "number" ? Math.max(1, Math.min(9, Math.round(m.n ?? 1))) : null });
        break;
      case "arrow":
        if (box) out.push({ kind: "arrow", box, from: m.from && intersects({ ...m.from, w: 1, h: 1 }, frame) ? m.from : null, text });
        break;
      case "label":
        if (box && text) out.push({ kind: "label", box, text });
        break;
      case "level":
        if (chart?.plot && chart.ticks?.length === 2 && typeof m.price === "number" && Number.isFinite(m.price)) {
          const y = priceToY(m.price, chart.ticks);
          if (y !== null && y >= 0 && y <= height) out.push({ kind: "level", price: m.price, text });
        }
        break;
    }
  }
  return out;
}

const ACCENT = "#5b8cff";
const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
const fmtPrice = (n: number) => (n >= 1000 ? `$${Math.round(n).toLocaleString("en-US")}` : n >= 100 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`);

/**
 * The overlay, as SVG at the image's own pixel size: accent strokes sized to the image, a pill behind each
 * label so it reads on a light or a dark screenshot, Caveat for the handwriting where the host has it. Pure.
 */
export function overlaySvg(width: number, height: number, marks: ImageMark[], chart: ImageChart | null, seed = 7): string {
  const view = { w: width, h: height };
  const stroke = Math.max(2.5, Math.min(8, width / 360));
  const font = Math.max(18, Math.min(56, width / 26));
  const avoid: Rect[] = [];
  const parts: string[] = [];
  const pathAttrs = `fill="none" stroke="${ACCENT}" stroke-width="${stroke.toFixed(1)}" stroke-linecap="round" stroke-linejoin="round"`;
  const pill = (at: Pt, w: number, h: number) => `<rect x="${at.x.toFixed(1)}" y="${at.y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="${(h / 2).toFixed(1)}" fill="rgba(12,12,22,0.78)" stroke="${ACCENT}" stroke-width="${(stroke * 0.5).toFixed(1)}"/>`;
  const label = (text: string, near: Rect) => {
    const w = text.length * font * 0.52 + font * 0.9;
    const h = font * 1.45;
    const at = notePlacement(near, { w, h }, view, avoid);
    avoid.push({ ...at, w, h });
    parts.push(pill(at, w, h), `<text x="${(at.x + w / 2).toFixed(1)}" y="${(at.y + h * 0.7).toFixed(1)}" text-anchor="middle" font-family="Caveat, 'Segoe Print', 'Comic Sans MS', cursive, sans-serif" font-size="${font.toFixed(0)}" fill="#fff">${esc(text)}</text>`);
  };
  marks.forEach((m, i) => {
    const s = seed + i * 31;
    if ((m.kind === "ring" || m.kind === "box" || m.kind === "arrow" || m.kind === "label" || m.kind === "number") && m.box) {
      const r = m.box;
      if (m.kind === "ring") {
        parts.push(`<path d="${smoothPath(ringPoints(r, s))}" ${pathAttrs}/>`);
        // Narrower than the label gap in notePlacement, or every spot "overlaps" and the label falls back onto the text.
        avoid.push({ x: r.x - 8, y: r.y - 8, w: r.w + 16, h: r.h + 16 });
      } else if (m.kind === "box") {
        parts.push(`<path d="${polylinePath(boxPoints(r, s))}" ${pathAttrs}/>`);
        avoid.push(r);
      } else if (m.kind === "arrow") {
        const from = m.from ?? arrowStart(r, view, Math.max(80, width * 0.14));
        const to = edgePoint(from, r, 8);
        const a = arrowPaths(from, to, s);
        parts.push(`<path d="${a.shaft}" ${pathAttrs}/>`, `<path d="${a.head}" ${pathAttrs}/>`);
        avoid.push(r);
        if (m.text) label(m.text, { x: from.x, y: from.y, w: 1, h: 1 });
        return;
      } else if (m.kind === "number") {
        const rad = font * 0.75;
        const cx = r.x + rad * 0.2;
        const cy = r.y + rad * 0.2;
        parts.push(`<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${rad.toFixed(1)}" fill="${ACCENT}" stroke="#fff" stroke-width="${(stroke * 0.5).toFixed(1)}"/>`, `<text x="${cx.toFixed(1)}" y="${(cy + font * 0.38).toFixed(1)}" text-anchor="middle" font-family="'IBM Plex Mono', Menlo, monospace" font-weight="700" font-size="${(font * 1.05).toFixed(0)}" fill="#fff">${m.n ?? 1}</text>`);
        avoid.push({ x: cx - rad, y: cy - rad, w: rad * 2, h: rad * 2 });
      }
      if (m.text) label(m.text, r);
    } else if (m.kind === "level" && chart?.plot && chart.ticks && typeof m.price === "number") {
      const y = priceToY(m.price, chart.ticks);
      if (y === null) return;
      const p = chart.plot;
      parts.push(`<path d="M${p.x.toFixed(1)},${y.toFixed(1)} L${(p.x + p.w).toFixed(1)},${y.toFixed(1)}" ${pathAttrs} stroke-dasharray="${(stroke * 3).toFixed(0)} ${(stroke * 2.2).toFixed(0)}"/>`);
      label(m.text ? `${m.text} ${fmtPrice(m.price)}` : fmtPrice(m.price), { x: p.x + p.w - 1, y: y - 1, w: 1, h: 2 });
    }
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${parts.join("")}</svg>`;
}

/** Glance's marks on a copy of the image: a new row with the same expiry; the original stays as it was. */
export async function annotateImage(id: string, owner: string, marks: ImageMark[]): Promise<{ row: ImageRow; marks: ImageMark[] } | null> {
  const src = await readImageRecord(id, owner);
  if (!src) return null;
  const bytes = await imageBytes(src.row);
  if (!bytes) return null;
  const chart = src.read?.chart ?? null;
  const kept = sanitizeMarks(marks, src.row.width, src.row.height, chart);
  const svg = Buffer.from(overlaySvg(src.row.width, src.row.height, kept, chart));
  const t0 = Date.now();
  const { data, info } = await sharp(bytes)
    .composite([{ input: svg, top: 0, left: 0 }])
    .jpeg({ quality: 90 })
    .toBuffer({ resolveWithObject: true });
  const row = await storeImage(owner, { bytes: data, width: info.width, height: info.height, mime: "image/jpeg" }, "annotated");
  log.info("image annotated", { id, out: row.id, marks: kept.length, ms: Date.now() - t0 });
  return { row, marks: kept };
}

/** Rows past their day: the file goes, then the row. */
export async function sweepImages(now = new Date()): Promise<number> {
  const rows = await db().delete(schema.images).where(lt(schema.images.expiresAt, now)).returning({ id: schema.images.id, path: schema.images.path });
  for (const r of rows) await unlink(r.path).catch(() => undefined);
  if (rows.length) log.info("images swept", { n: rows.length });
  return rows.length;
}

export async function countImages(): Promise<number> {
  const rows = await db().select({ n: sql<number>`count(*)` }).from(schema.images);
  return Number(rows[0]?.n ?? 0);
}
