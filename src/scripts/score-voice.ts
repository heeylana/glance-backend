/**
 * Score the voice LLM fallback (doc/cost-reduction-todo.md 2.0) on spoken phrasings the grammar in
 * services/voice.ts can't place, the only ones that reach the model in real use. Each fixture says what
 * the command should be; a run goes through the same path as POST /voice: grammar, then the LLM
 * (`interpretCommand` on LLM_FAST_MODEL), then `sanitize`.
 *
 *   pnpm script:score-voice               # about a tenth of a cent a phrase on Haiku 4.5
 *   pnpm script:score-voice --offline     # no network: lists fixtures the grammar now handles itself
 *   pnpm script:score-voice --trials 3    # repeat each phrase to see the noise
 *   LLM_FAST_MODEL=claude-opus-5 pnpm script:score-voice    # the same set on another model
 *
 * Fixtures live in src/services/fixtures/voice-commands.json. `expect` lists only the fields that
 * matter for that phrase; `note: true` means "some note", not an exact text.
 */
import { readFileSync } from "node:fs";
import { interpret, parseCommand, type VoiceCommand, type VoiceContext } from "../services/voice.js";
import { lastUsage } from "../services/llm.js";

type Expect = Partial<Omit<VoiceCommand, "note">> & { kind: VoiceCommand["kind"]; note?: true };
type Fixture = { id: string; screen: keyof typeof SCREENS; text: string; expect: Expect };

const apple = { companyId: "aapl", name: "Apple", ticker: "AAPL" };
const nvidia = { companyId: "nvda", name: "Nvidia", ticker: "NVDA" };
const alphabet = { companyId: "googl", name: "Alphabet", ticker: "GOOGL" };
const rivian = { companyId: "rivn", name: "Rivian", ticker: "RIVN" };

const SCREENS = {
  card: { view: "company", entities: [apple], current: apple, amountUsd: 10 },
  choice: { view: "choice", entities: [apple, nvidia, alphabet], current: null, amountUsd: null },
  closed: { view: "closed", entities: [], current: null, amountUsd: null },
  sell: { view: "sell", entities: [apple], current: apple, amountUsd: 10 },
  done: { view: "done", entities: [apple], current: apple, amountUsd: 10 },
  untokenized: { view: "untokenized", entities: [rivian], current: rivian, amountUsd: null },
  explain: { view: "explain", entities: [], current: null, amountUsd: null },
} satisfies Record<string, VoiceContext>;

const FIXTURES = new URL("../services/fixtures/voice-commands.json", import.meta.url);

function parseArgs(argv: string[]) {
  const a = { offline: false, trials: 1 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    if (k === "--offline") a.offline = true;
    else if (k === "--trials") a.trials = Math.max(1, Number(argv[++i] ?? 1));
    else throw new Error(`unknown flag ${k}`);
  }
  return a;
}

/** Which expected fields the command got wrong; empty when it matches. */
function mismatches(got: VoiceCommand, want: Expect): string[] {
  const bad: string[] = [];
  for (const [k, v] of Object.entries(want)) {
    const g = got[k as keyof VoiceCommand];
    if (k === "note" ? !g : g !== v) bad.push(`${k}=${JSON.stringify(g)} (want ${JSON.stringify(v)})`);
  }
  return bad;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const fixtures: Fixture[] = JSON.parse(readFileSync(FIXTURES, "utf8"));
  const forLlm = fixtures.filter((f) => parseCommand(f.text, SCREENS[f.screen]) === null);
  const byGrammar = fixtures.filter((f) => !forLlm.includes(f));
  for (const f of byGrammar) console.log(`grammar handles "${f.text}" (${f.id}): drop it from the set or keep it as a grammar check`);
  if (args.offline) {
    console.log(`\n${forLlm.length}/${fixtures.length} fixtures reach the LLM`);
    return;
  }

  let right = 0;
  let total = 0;
  let usd = 0;
  let model = "";
  const w = Math.max(...forLlm.map((f) => f.id.length));
  for (let t = 1; t <= args.trials; t++) {
    for (const f of forLlm) {
      const before = lastUsage("interpretCommand");
      const { command, via } = await interpret(f.text, SCREENS[f.screen]);
      const u = lastUsage("interpretCommand");
      if (u && u !== before) {
        usd += u.usd ?? 0;
        model = u.model;
      }
      const bad = via === "none" ? ["no answer from the model"] : mismatches(command, f.expect);
      total += 1;
      if (bad.length === 0) right += 1;
      console.log(`${bad.length ? "MISS" : "ok  "} ${args.trials > 1 ? `t${t} ` : ""}${f.id.padEnd(w)} ${command.kind.padEnd(9)} ${bad.join(", ")}`);
    }
  }
  console.log(`\n${right}/${total} right (${((right / total) * 100).toFixed(0)}%) on ${model || "no model"} · ${byGrammar.length} fixture(s) handled by the grammar, not scored · $${usd.toFixed(4)}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
