import type { z } from "zod";

/**
 * Structured outputs send a schema's limits (text length, list size, number range, nullable enums) to
 * the model only as hints in the field descriptions. The API doesn't enforce them, and the SDK's strict
 * parse throws the whole answer away when a model runs past one. Opus 5 rarely did; Haiku 4.5 and
 * Sonnet 5 do now and then (a 230-character `reason` cost a whole disambiguation on 18 Sep 2026).
 *
 * `fitToSchema` keeps the answer instead: text and lists are cut to their limit and numbers clamped
 * into range, using the positions zod reports. Anything else that doesn't match (a missing field, a
 * wrong type, an unknown enum value) still fails.
 */
export type Fitted<T> = { ok: true; data: T; clipped: string[] } | { ok: false; error: string };

export function fitToSchema<T>(schema: z.ZodType<T>, value: unknown): Fitted<T> {
  let v: unknown = structuredClone(value);
  const clipped: string[] = [];
  for (let pass = 0; pass < 4; pass++) {
    const r = schema.safeParse(v);
    if (r.success) return { ok: true, data: r.data, clipped };
    let fixed = false;
    for (const issue of r.error.issues) {
      const next = repair(issue as LooseIssue, getAt(v, issue.path));
      if (next === undefined) continue;
      v = setAt(v, issue.path, next);
      clipped.push(issue.path.map(String).join(".") || "(root)");
      fixed = true;
    }
    if (!fixed) return { ok: false, error: r.error.issues.map((i) => `${i.path.map(String).join(".")}: ${i.message}`).join("; ").slice(0, 500) };
  }
  return { ok: false, error: "still invalid after clipping" };
}

type LooseIssue = { code: string; origin?: string; maximum?: number | bigint; minimum?: number | bigint; inclusive?: boolean };

function repair(i: LooseIssue, cur: unknown): unknown {
  const numeric = i.origin === "number" || i.origin === "int";
  if (i.code === "too_big" && i.maximum !== undefined) {
    const max = Number(i.maximum);
    if (i.origin === "string" && typeof cur === "string") return clipText(cur, max);
    if (i.origin === "array" && Array.isArray(cur)) return cur.slice(0, max);
    if (numeric && typeof cur === "number" && i.inclusive !== false) return max;
  }
  if (i.code === "too_small" && i.minimum !== undefined && numeric && typeof cur === "number" && i.inclusive !== false) return Number(i.minimum);
  return undefined;
}

/**
 * Cut text to at most `max` characters, at the end of a sentence when one ends in the last 40%,
 * else at a word boundary, so a clipped spoken line still reads as a line.
 */
export function clipText(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sentence = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  if (sentence >= max * 0.6) return cut.slice(0, sentence + 1);
  const space = cut.lastIndexOf(" ");
  return (space >= max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:—–-]+$/, "");
}

function getAt(v: unknown, path: readonly PropertyKey[]): unknown {
  let cur = v;
  for (const k of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<PropertyKey, unknown>)[k];
  }
  return cur;
}

function setAt(v: unknown, path: readonly PropertyKey[], next: unknown): unknown {
  if (path.length === 0) return next;
  let cur = v as Record<PropertyKey, unknown>;
  for (const k of path.slice(0, -1)) cur = cur[k] as Record<PropertyKey, unknown>;
  cur[path[path.length - 1]!] = next;
  return v;
}
