import { z } from "zod";

try {
  process.loadEnvFile(".env");
} catch {
  /* no .env: rely on the environment */
}

const Env = z.object({
  PORT: z.coerce.number().default(8787),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  DATABASE_URL: z.string().default("postgres://localhost:5432/glance"),

  SOLANA_CLUSTER: z.enum(["devnet", "mainnet-beta"]).default("devnet"),
  SOLANA_RPC_URL: z.string().url().default("https://api.devnet.solana.com"),
  USDC_MINT: z.string().default("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"),

  /** Anchor program id of the vault. */
  VAULT_PROGRAM_ID: z.string().default("DP7QYPQZh2XqMREGWQ5MNo1vgGUSZbfAzJu3uRQATnmy"),
  /** The delegated signer. Its only capability is execute_swap_* inside each user's on-chain policy. */
  AGENT_KEYPAIR: z.string().default("./.keys/agent.json"),
  DESK_KEYPAIR: z.string().default("./.keys/desk.json"),
  /** HS256 secret for session JWTs issued after a wallet signature. */
  SESSION_SECRET: z.string().default("dev-only-change-me-dev-only-change-me"),
  /** Origin of the Phantom-facing web console (sign-in, create account, deposit, withdraw, pause). */
  WEB_CONSOLE_URL: z.string().url().default("http://localhost:5173"),

  // Swap V1 is unmaintained but live with no sunset date; V2 (/swap/v2/order+execute) is the migration target.
  JUPITER_API_URL: z.string().url().default("https://api.jup.ag/swap/v1"),
  JUPITER_PRICE_URL: z.string().url().default("https://api.jup.ag/price/v3"),
  JUPITER_API_KEY: z.string().optional(),
  JUPITER_PROGRAM_ID: z.string().default("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"),

  // Hermes and Benchmarks require a bearer key since 2026-08-26 (Pyth Core upgrade).
  PYTH_HERMES_URL: z.string().url().default("https://pyth.dourolabs.app/hermes"),
  PYTH_BENCHMARKS_URL: z.string().url().default("https://benchmarks.pyth.network"),
  PYTH_API_KEY: z.string().optional(),
  /** auto = Pyth when PYTH_API_KEY is set, else Jupiter Price v3 (on-chain token price, keyless). */
  PRICE_SOURCE: z.enum(["auto", "pyth", "jupiter"]).default("auto"),
  /** Which Pyth feed to prefer per mint: the 24/7 token feed (Crypto.AAPLX/USD) or the market-hours equity feed. */
  PYTH_FEED_PREFERENCE: z.enum(["token", "equity"]).default("token"),

  PRICE_MAX_DEVIATION_BPS: z.coerce.number().default(100),
  PRICE_MAX_AGE_SEC: z.coerce.number().default(300),
  PRICE_STALE_POLICY: z.enum(["reject", "widen"]).default("widen"),
  PRICE_STALE_DEVIATION_BPS: z.coerce.number().default(300),
  FEE_TOLERANCE_BPS: z.coerce.number().default(100),
  MAX_USER_LAMPORTS_SPEND: z.coerce.bigint().default(15_000_000n),
  ISSUER_MODE: z.enum(["mock", "registry"]).default("mock"),

  DEFAULT_DAILY_CAP_USD: z.coerce.number().default(20),
  DEFAULT_PER_TX_CAP_USD: z.coerce.number().default(20),
  DEFAULT_MAX_SLIPPAGE_BPS: z.coerce.number().default(100),
  SESSION_TTL_DAYS: z.coerce.number().default(7),

  ANTHROPIC_API_KEY: z.string().optional(),
  /** Default model (Sonnet 5 since 18 Sep 2026; Opus 5 before, see doc/cost-reduction-todo.md). */
  LLM_MODEL: z.string().default("claude-sonnet-5"),
  /** Model for "show me" (a screenshot, page coordinates, drawing). Defaults to LLM_MODEL. */
  LLM_VISION_MODEL: z.string().optional(),
  /** Model for the screenshot fallback: reads a page's headline, text and companies from a screenshot when its HTML has none. No drawing, so a small model does. */
  LLM_READ_MODEL: z.string().default("claude-haiku-4-5"),
  /** Model for the short text jobs: disambiguation, "why", counter-view, voice commands the grammar missed. */
  LLM_FAST_MODEL: z.string().default("claude-haiku-4-5"),
  /** Effort for "show me", on models that take it. Every other call runs at low. */
  LLM_VISION_EFFORT: z.enum(["low", "medium", "high"]).default("low"),
  /** Thinking for "show me" on models that think by default (Sonnet 5, Opus 5). "off" cuts output tokens; replay captures before turning it off. */
  LLM_VISION_THINKING: z.enum(["on", "off"]).default("on"),
  /** Dev only: save every POST /explain request (question, page map, screenshot) and answer here for the "show me" eval. Unset = nothing kept. */
  EVAL_CAPTURE_DIR: z.string().optional(),
  NEWS_API_KEY: z.string().optional(),
  /** Fish Audio text-to-speech for the bubble's voice (spec §7.1). Empty → the extension uses the browser's local voice. */
  FISH_AUDIO_API_KEY: z.string().optional(),
  /** Fish Audio voice model id. Default: the official "Ethan" voice. */
  FISH_AUDIO_VOICE_ID: z.string().default("536d3a5e000945adb7038665781a4aca"),
  FISH_AUDIO_MODEL: z.string().default("s1"),
});

export type Env = z.infer<typeof Env>;
// `KEY=` in a .env file means "use the default", not "empty string".
const rawEnv = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined && v.trim() !== ""));
export const env: Env = Env.parse(rawEnv);

/** Read an optional env var, treating empty as unset. For the few reads that bypass the schema. */
export function optionalEnv(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== "" ? v : undefined;
}

export const PROGRAM_IDS = {
  system: "11111111111111111111111111111111",
  token: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  token2022: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  ata: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  computeBudget: "ComputeBudget111111111111111111111111111111",
  jupiter: env.JUPITER_PROGRAM_ID,
} as const;

/** Spec §8.2: the only programs a delegated transaction may target at the top level. */
export const ALLOWED_TOP_LEVEL_PROGRAMS: ReadonlySet<string> = new Set([
  PROGRAM_IDS.jupiter,
  PROGRAM_IDS.token,
  PROGRAM_IDS.token2022,
  PROGRAM_IDS.ata,
  PROGRAM_IDS.system,
  PROGRAM_IDS.computeBudget,
]);
