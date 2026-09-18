/**
 * Skills: what Glance knows how to explain, kept as Markdown so anyone can add one without touching
 * code. Each skill is `skills/<name>/SKILL.md` with a short frontmatter (name, description, the words
 * that call for it, and optionally the sites it belongs to) and a body of instructions. They load at
 * start, reload when a file changes, and the ones that fit a question are added to the explain prompt.
 *
 *   ---
 *   name: candlestick-charts
 *   description: Reading price charts and drawing levels on them.
 *   when: chart, candle, support, resistance
 *   sites: tradingview.com
 *   ---
 *   # instructions…
 *
 *   # Naming a pattern
 *   when: flag, wedge, head and shoulders
 *   …only sent when one of these words is in the question or the page title.
 *
 * A top-level section (`# ` heading) whose next line is `when: …` is conditional: the skill is still
 * picked by any of its words, but that section is only sent when one of its own words came up, so a
 * large reference table costs tokens only on the questions that need it.
 */
import { existsSync, readdirSync, readFileSync, statSync, watch } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "../lib/log.js";

/** A top-level section of a skill; `when` empty means it is always sent with the skill. */
export interface SkillPart {
  when: string[];
  text: string;
}

export interface Skill {
  name: string;
  description: string;
  /** Every word that picks the skill: the frontmatter's `when` plus each conditional section's. */
  when: string[];
  sites: string[];
  /** The instructions sent: the whole body when loaded; after pickSkills, only the parts that fit the question. */
  body: string;
  parts: SkillPart[];
}

/** Split a body at `# ` headings; a heading followed (after blank lines) by `when: …` makes that section conditional. */
export function splitParts(body: string, list: (v: string | undefined) => string[]): SkillPart[] {
  const parts: { when: string[]; lines: string[] }[] = [{ when: [], lines: [] }];
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!/^# /.test(line)) {
      parts.at(-1)!.lines.push(line);
      continue;
    }
    let j = i + 1;
    while (j < lines.length && !lines[j]!.trim()) j++;
    const trigger = j < lines.length ? /^when:\s*(.*)$/i.exec(lines[j]!.trim()) : null;
    parts.push({ when: trigger ? list(trigger[1]) : [], lines: [line] });
    if (trigger) i = j;
  }
  return parts.map((p) => ({ when: p.when, text: p.lines.join("\n").trim() })).filter((p) => p.text);
}

export const SKILLS_DIR = process.env.GLANCE_SKILLS_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "../../skills");
/** At most this many skills, and this much of their text, go into one prompt. */
const MAX_SKILLS = 3;
// Sized so the three shipped skills fit together (skills.test.ts checks it): a skill over the budget is
// dropped without a word, so grow this with the skills rather than let one fall out.
const MAX_CHARS = 12_000;

/** Parse one SKILL.md; null (with the reason) when the frontmatter is missing or incomplete. */
export function parseSkill(text: string): Skill | { error: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { error: "no frontmatter" };
  const fields: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([a-z]+):\s*(.*)$/i.exec(line.trim());
    if (kv) fields[kv[1]!.toLowerCase()] = kv[2]!.trim();
  }
  const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!fields.name || !/^[a-z0-9-]{2,48}$/.test(fields.name)) return { error: "name must be kebab-case" };
  if (!fields.description) return { error: "description is required" };
  const raw = m[2]!.trim();
  if (!raw) return { error: "the body is empty" };
  const parts = splitParts(raw, list);
  const when = [...new Set([...list(fields.when), ...parts.flatMap((p) => p.when)])];
  return { name: fields.name, description: fields.description, when, sites: list(fields.sites), body: parts.map((p) => p.text).join("\n\n"), parts };
}

let cache: Skill[] | null = null;

export function loadSkills(dir = SKILLS_DIR): Skill[] {
  if (cache) return cache;
  const skills: Skill[] = [];
  if (existsSync(dir)) {
    for (const entry of readdirSync(dir)) {
      const file = join(dir, entry, "SKILL.md");
      if (!existsSync(file) || !statSync(file).isFile()) continue;
      const parsed = parseSkill(readFileSync(file, "utf8"));
      if ("error" in parsed) log.warn("skill skipped", { file, reason: parsed.error });
      else skills.push(parsed);
    }
  }
  cache = skills.sort((a, b) => a.name.localeCompare(b.name));
  return cache;
}

/** Edits to a skill apply to the next question without restarting the backend. */
export function watchSkills(dir = SKILLS_DIR) {
  if (!existsSync(dir)) return;
  try {
    watch(dir, { recursive: true }, () => {
      cache = null;
    }).unref();
  } catch (e) {
    log.warn("skills are not watched; restart to pick up edits", { err: String(e) });
  }
}

const words = (t: string) => ` ${t.toLowerCase().replace(/[^\p{L}\p{N}/.%]+/gu, " ").trim()} `;

/**
 * Skills that fit: trigger phrases in the question or the page title, plus a bonus on their own sites.
 * Each comes back with only the sections the question calls for (see splitParts).
 */
export function pickSkills(p: { question: string; title?: string; url: string }, skills = loadSkills()): Skill[] {
  const q = words(p.question);
  const title = words(p.title ?? "");
  let host = "";
  let path = "";
  try {
    const u = new URL(p.url);
    host = u.hostname.replace(/^www\./, "");
    path = `${host}${u.pathname}`;
  } catch {
    /* no url */
  }
  const said = (w: string) => q.includes(` ${w} `) || title.includes(` ${w} `);
  return skills
    .map((s) => {
      let score = 0;
      for (const w of s.when) {
        if (q.includes(` ${w} `)) score += 3;
        else if (title.includes(` ${w} `)) score += 1;
      }
      if (score > 0 && s.sites.some((site) => host === site || host.endsWith(`.${site}`) || path.startsWith(site))) score += 2;
      return { s, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_SKILLS)
    .map((x) => ({ ...x.s, body: x.s.parts.filter((p) => !p.when.length || p.when.some(said)).map((p) => p.text).join("\n\n") }))
    .filter((s) => s.body);
}

/**
 * The chosen skills as a prompt section, within the size budget. Skills are kept in the order given
 * (best match first) until the budget runs out, then written in name order, so the same set always
 * produces the same bytes and the explain prompt's cached prefix is reused.
 */
export function skillsPrompt(skills: Skill[]): string {
  const kept: { name: string; block: string }[] = [];
  let size = 0;
  for (const s of skills) {
    const block = `\n\n## Skill: ${s.name}\n${s.body}`;
    if (size + block.length > MAX_CHARS) break;
    size += block.length;
    kept.push({ name: s.name, block });
  }
  const out = kept
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((k) => k.block)
    .join("");
  return out ? `\n\nSkills for this answer (follow them):${out}` : "";
}
