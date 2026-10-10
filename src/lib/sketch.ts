/**
 * Geometry for the marks Glance draws: on a page (the extension renders them in entrypoints/content/sketch.ts)
 * and on a chat image (services/images.ts composites them). A mirror of glance-extension-app/lib/sketch.ts; change both. Pure functions in pixels. Every mark takes a seed, so its wobble is the same each
 * time it is redrawn on scroll, and a few points are smoothed into one pen stroke.
 */
export interface Pt {
  x: number;
  y: number;
}
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** mulberry32: a small seeded generator, so a mark keeps its hand-drawn shape across redraws. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** Catmull-Rom through the points, as cubic Béziers: a handful of points reads as one smooth stroke. */
export function smoothPath(points: Pt[]): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M${r1(points[0]!.x)},${r1(points[0]!.y)}`;
  let d = `M${r1(points[0]!.x)},${r1(points[0]!.y)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[i + 2] ?? p2;
    const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
    d += ` C${r1(c1.x)},${r1(c1.y)} ${r1(c2.x)},${r1(c2.y)} ${r1(p2.x)},${r1(p2.y)}`;
  }
  return d;
}

/** Straight segments through the points: for strokes that should keep their corners, like a box. */
export function polylinePath(points: Pt[]): string {
  return points.map((p, i) => `${i === 0 ? "M" : "L"}${r1(p.x)},${r1(p.y)}`).join(" ");
}

/** A ring drawn by hand around a rect: a little more than one turn, slightly tilted, never quite round. */
export function ringPoints(r: Rect, seed: number): Pt[] {
  const rand = rng(seed);
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  // Widen a little past the ends, then make it just tall enough to clear the corners
  // ((w/2)²/rx² + (h/2)²/ry² = 1): a wide headline gets a flat ring, not one that leaves the screen.
  const rx = (r.w / 2) * 1.1 + 10;
  const ratio = r.w / 2 / rx;
  const ry = Math.min((r.h / 2) / Math.sqrt(1 - ratio * ratio) + 4, r.h + 24);
  const start = -Math.PI * (0.55 + rand() * 0.2);
  const turn = Math.PI * 2 * (1.08 + rand() * 0.06);
  const tilt = (rand() - 0.5) * 0.08;
  const steps = 28;
  const out: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = start + (turn * i) / steps;
    const wobble = 1 + (rand() - 0.5) * 0.06;
    const x = Math.cos(t) * rx * wobble;
    const y = Math.sin(t) * ry * wobble;
    out.push({ x: cx + x * Math.cos(tilt) - y * Math.sin(tilt), y: cy + x * Math.sin(tilt) + y * Math.cos(tilt) });
  }
  return out;
}

/** A rectangle drawn in one stroke, closing past its first corner. */
export function boxPoints(r: Rect, seed: number): Pt[] {
  const rand = rng(seed);
  const pad = 5;
  const j = () => (rand() - 0.5) * 3;
  const x0 = r.x - pad;
  const y0 = r.y - pad;
  const x1 = r.x + r.w + pad;
  const y1 = r.y + r.h + pad;
  return [
    { x: x0 + j(), y: y0 + j() },
    { x: x1 + j(), y: y0 + j() },
    { x: x1 + j(), y: y1 + j() },
    { x: x0 + j(), y: y1 + j() },
    { x: x0 + j(), y: y0 + j() },
    { x: x0 + Math.min(18, r.w / 3), y: y0 + j() },
  ];
}

/** A line under a rect with a gentle wave, running a touch past both ends. */
export function underlinePoints(r: Rect, seed: number): Pt[] {
  const rand = rng(seed);
  const y = r.y + r.h + 3;
  const steps = Math.max(2, Math.round(r.w / 60));
  const out: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    out.push({ x: r.x - 3 + ((r.w + 8) * i) / steps, y: y + (rand() - 0.5) * 2.5 + (i / steps) * 1.5 });
  }
  return out;
}

/** Where a line from `from` towards the rect's centre crosses the rect's edge, pushed out by `gap`. */
export function edgePoint(from: Pt, r: Rect, gap = 8): Pt {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const dx = from.x - cx;
  const dy = from.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const hw = r.w / 2 + gap;
  const hh = r.h / 2 + gap;
  const k = Math.min(dx === 0 ? Infinity : hw / Math.abs(dx), dy === 0 ? Infinity : hh / Math.abs(dy));
  return k >= 1 ? { x: from.x, y: from.y } : { x: cx + dx * k, y: cy + dy * k };
}

/** An arrow's tail when the model gave none: off the rect's corner with the most room, inside the viewport. */
export function arrowStart(r: Rect, view: { w: number; h: number }, length = 120): Pt {
  const room = {
    left: r.x,
    right: view.w - (r.x + r.w),
    up: r.y,
    down: view.h - (r.y + r.h),
  };
  const sx = room.left > room.right ? -1 : 1;
  const sy = room.up > room.down ? -1 : 1;
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const x = cx + sx * (r.w / 2 + length * 0.8);
  const y = cy + sy * (r.h / 2 + length * 0.6);
  return { x: Math.max(12, Math.min(view.w - 12, x)), y: Math.max(12, Math.min(view.h - 12, y)) };
}

/** A bowed shaft from tail to tip and a two-stroke head, as SVG path data. */
export function arrowPaths(from: Pt, to: Pt, seed: number): { shaft: string; head: string } {
  const rand = rng(seed);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const bend = (rand() > 0.5 ? 1 : -1) * Math.min(40, len * 0.18);
  const mid = { x: (from.x + to.x) / 2 - (dy / len) * bend, y: (from.y + to.y) / 2 + (dx / len) * bend };
  const shaft = `M${r1(from.x)},${r1(from.y)} Q${r1(mid.x)},${r1(mid.y)} ${r1(to.x)},${r1(to.y)}`;
  // The head follows the curve's tangent at the tip (tip minus control point), not the straight line.
  const angle = Math.atan2(to.y - mid.y, to.x - mid.x);
  const size = Math.min(16, 6 + len * 0.08);
  const spread = 0.46;
  const a = { x: to.x - Math.cos(angle - spread) * size, y: to.y - Math.sin(angle - spread) * size };
  const b = { x: to.x - Math.cos(angle + spread) * size, y: to.y - Math.sin(angle + spread) * size };
  const head = `M${r1(a.x)},${r1(a.y)} L${r1(to.x)},${r1(to.y)} L${r1(b.x)},${r1(b.y)}`;
  return { shaft, head };
}

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Top-left for a note of the given size beside a rect: right, left, above, then below, taking the
 * first spot that stays on screen and clear of `avoid` (the bubble, earlier notes); the first
 * on-screen spot when nothing is clear.
 */
export function notePlacement(r: Rect, note: { w: number; h: number }, view: { w: number; h: number }, avoid: Rect[] = []): Pt {
  const gap = 12;
  const midY = r.y + r.h / 2 - note.h / 2;
  const clampY = (y: number) => Math.max(4, Math.min(view.h - note.h - 4, y));
  const clampX = (x: number) => Math.max(4, Math.min(view.w - note.w - 4, x));
  const spots: { at: Pt; fits: boolean }[] = [
    { at: { x: r.x + r.w + gap, y: clampY(midY) }, fits: r.x + r.w + gap + note.w <= view.w },
    { at: { x: r.x - gap - note.w, y: clampY(midY) }, fits: r.x - gap - note.w >= 0 },
    { at: { x: clampX(r.x), y: r.y - gap - note.h }, fits: r.y - gap - note.h >= 0 },
    { at: { x: clampX(r.x), y: clampY(r.y + r.h + gap) }, fits: true },
  ];
  const onScreen = spots.filter((s) => s.fits);
  const clear = onScreen.find((s) => !avoid.some((a) => overlaps({ ...s.at, w: note.w, h: note.h }, a)));
  return (clear ?? onScreen[0]!).at;
}

/** The y pixel of `price` on a chart, from two labelled prices on its axis (a straight line through them). */
export function priceToY(price: number, ticks: { price: number; y: number }[]): number | null {
  const [a, b] = ticks;
  if (!a || !b || a.price === b.price) return null;
  return a.y + ((price - a.price) * (b.y - a.y)) / (b.price - a.price);
}

/** The line through `p` and `q`, extended to the left and right edges of `r` (a trend line across a chart). */
export function extendAcross(p: Pt, q: Pt, r: Rect): [Pt, Pt] {
  if (Math.abs(q.x - p.x) < 1) return [p, q];
  const slope = (q.y - p.y) / (q.x - p.x);
  const at = (x: number) => ({ x, y: p.y + slope * (x - p.x) });
  return [at(r.x), at(r.x + r.w)];
}
