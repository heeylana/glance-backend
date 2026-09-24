import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { env } from "./config.js";
import { GuardError, GuardCode, userMessage } from "./lib/errors.js";
import { log } from "./lib/log.js";
import { loadRegistry } from "./config/issuers.js";
import { agentKeypair, deskKeypair } from "./services/keys.js";
import { authPrivateRoutes, authPublicRoutes } from "./routes/auth.js";
import { routeProvider } from "./services/route.js";
import { sampleAllPrices } from "./services/prices.js";
import { ttsEnabled } from "./services/tts.js";
import glanceRoutes from "./routes/glance.js";
import tradeRoutes from "./routes/trade.js";
import sessionRoutes from "./routes/session.js";
import portfolioRoutes from "./routes/portfolio.js";
import journalRoutes from "./routes/journal.js";
import watchlistRoutes from "./routes/watchlist.js";
import whyRoutes from "./routes/why.js";
import adviceRoutes from "./routes/advice.js";
import counterViewRoutes from "./routes/counter-view.js";
import ttsRoutes from "./routes/tts.js";
import dictionaryRoutes from "./routes/dictionary.js";
import voiceRoutes from "./routes/voice.js";
import explainRoutes from "./routes/explain.js";
import rememberRoutes from "./routes/remember.js";
import { loadSkills, watchSkills } from "./services/skills.js";

const app = new Hono();

// The extension's origin is chrome-extension://<id>; set ALLOWED_ORIGINS to lock this down.
const allowed = (process.env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
app.use(
  "*",
  cors({
    origin: (origin) => (allowed.length === 0 ? origin || "*" : allowed.includes(origin) ? origin : ""),
    allowHeaders: ["authorization", "content-type"],
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  }),
);
app.use("*", logger((s) => log.debug(s)));

app.onError((err, c) => {
  if (err instanceof GuardError) {
    if (err.status >= 500) log.error("guard error", { code: err.code, msg: err.message });
    else {
      // For a rejected body, which fields failed (paths and zod codes only, never the values).
      const detail = (err.ctx as { detail?: { path: PropertyKey[]; code: string; message?: string }[] }).detail;
      const fields = Array.isArray(detail) ? detail.slice(0, 5).map((i) => `${i.path.map(String).join(".")}: ${i.code}`) : undefined;
      log.info("guard rejected", { code: err.code, path: c.req.path, ...(fields ? { fields } : {}) });
    }
    return c.json(err.toResponse(), err.status as 400);
  }
  const cause = (err as { cause?: unknown }).cause;
  log.error("unhandled", { err: String(err), cause: cause ? String(cause) : undefined, path: c.req.path, stack: (err as Error).stack?.split("\n").slice(0, 4).join(" | ") });
  return c.json({ ok: false, code: "INTERNAL", message: userMessage(GuardCode.SUBMIT_FAILED) }, 500);
});

app.get("/health", (c) => {
  const reg = loadRegistry();
  return c.json({
    ok: true,
    cluster: env.SOLANA_CLUSTER,
    route: routeProvider().name,
    issuerMode: reg.mode,
    mints: reg.byMint.size,
    catalog: reg.listings.size,
    vaultProgram: env.VAULT_PROGRAM_ID,
    agent: agentKeypair().publicKey.toBase58(),
    console: env.WEB_CONSOLE_URL,
    // The Fish model when a key is set, false when the extension will fall back to the browser voice.
    voice: ttsEnabled() ? env.FISH_AUDIO_MODEL : false,
  });
});

app.route("/", authPublicRoutes);
// Public routes go before the first router that installs `auth` on "*": in Hono that middleware then
// guards every route mounted after it, which had put the passive dictionary behind sign-in.
app.route("/", dictionaryRoutes);
app.route("/", authPrivateRoutes);

app.route("/", glanceRoutes);
app.route("/", tradeRoutes);
app.route("/", sessionRoutes);
app.route("/", portfolioRoutes);
app.route("/", journalRoutes);
app.route("/", watchlistRoutes);
app.route("/", whyRoutes);
app.route("/", adviceRoutes);
app.route("/", counterViewRoutes);
app.route("/", ttsRoutes);
app.route("/", voiceRoutes);
app.route("/", explainRoutes);
app.route("/", rememberRoutes);

function checkConfig() {
  // Without its agent key the backend can't trade, and a new key would orphan every vault that names the
  // old one, so refuse to start instead (services/keys.ts). The error names the variable, never the key.
  try {
    agentKeypair();
  } catch (e) {
    log.error("no agent key: refusing to start", { err: (e as Error).message, fix: "set AGENT_KEYPAIR to the key file's path or its contents (doc/how-to-deploy.md 5.3)" });
    process.exit(1);
  }
  if (routeProvider().name === "desk") {
    try {
      deskKeypair();
    } catch (e) {
      log.error("no desk key: every devnet buy and sell will fail", { err: (e as Error).message });
    }
  }
  const reg = loadRegistry();
  if (!reg.stableMints.includes(env.USDC_MINT)) {
    log.error("USDC_MINT is not in the issuer registry's stable mints; buys will be rejected as INPUT_MINT_NOT_STABLE", {
      USDC_MINT: env.USDC_MINT,
      registryStableMints: reg.stableMints,
      fix: reg.mode === "mock" ? `set USDC_MINT=${reg.stableMints[0]} (the mock USDC created by setup-devnet.ts)` : "set USDC_MINT to mainnet USDC",
    });
  }
  if (env.SOLANA_CLUSTER === "devnet" && routeProvider().name === "jupiter") {
    log.error("ROUTE_PROVIDER=jupiter on devnet: Jupiter has no devnet deployment. Set ROUTE_PROVIDER=desk (or leave it empty).");
  }
  if (reg.byMint.size === 0) log.error("issuer registry has no mints", { file: reg.file });
}

if (process.env.NODE_ENV !== "test") {
  checkConfig();
  watchSkills();
  log.info("skills loaded", { skills: loadSkills().map((s) => s.name) });
  serve({ fetch: app.fetch, port: env.PORT }, (info) => {
    log.info("glance backend listening", { port: info.port, cluster: env.SOLANA_CLUSTER, route: routeProvider().name, agent: agentKeypair().publicKey.toBase58(), vaultProgram: env.VAULT_PROGRAM_ID });
  });
  // Spec §9 price-at-timestamp indexer: one sample per mint per hour, so "since this was published" has data.
  const sample = () =>
    // Tradable tokens and every pre-IPO token: the ones a "since this was published" delta is asked of most.
    sampleAllPrices([...loadRegistry().byMint.values(), ...[...loadRegistry().listings.values()].filter((l) => l.kind === "pre-ipo")])
      .then((n) => log.debug("price samples written", { n }))
      .catch((e) => log.warn("price sampling failed", { err: String(e) }));
  setTimeout(sample, 5_000);
  setInterval(sample, 3_600_000).unref();
}

export default app;
