/**
 * The catalog: every tokenized stock Glance can recognise, price and trade on Solana, from the
 * issuers' own lists. Writes src/config/catalog.json, which the registry, the resolver's
 * dictionary and the price service read. Run it when an issuer lists something new.
 *
 *   pnpm script:refresh-catalog            # needs network; PYTH_API_KEY adds Pyth feed ids
 *
 * Sources: xStocks (api.backed.fi, ~930 Solana tokens), PreStocks (prestocks.com/api/prestocks),
 * Tessera T-tokens (rest-api.tessera.pe). Decimals, token program and the permanent delegate are
 * read from mainnet for each mint, so the vault's issuer rule matches what is really on chain.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { env } from "../config.js";

const MAINNET_RPC = process.env.MAINNET_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const OUT = new URL("../config/catalog.json", import.meta.url);

export interface CatalogListing {
  mint: string;
  /** The token's own symbol: AAPLx, OPENAI, T-OpenAI. */
  symbol: string;
  /** The company key shared by every token of one company: AAPL, OPENAI. */
  ticker: string;
  name: string;
  issuer: "xStocks" | "PreStocks" | "Tessera";
  kind: "stock" | "etf" | "pre-ipo";
  decimals: number;
  tokenProgram: "spl-token" | "token-2022";
  /** Token-2022 PermanentDelegate on mainnet, the vault's issuer rule; null = curation only. */
  issuerDelegate: string | null;
  pythFeedId?: string;
  pythTokenFeedId?: string;
  pythIndexFeedId?: string;
  /** The single name or the ticker is also an ordinary English word ("Target", "COST"). */
  ambiguousName?: boolean;
  ambiguousTicker?: boolean;
  about?: string;
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
    if (res.ok) return (await res.json()) as T;
    if (attempt < 3 && (res.status === 429 || res.status >= 500)) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      continue;
    }
    throw new Error(`${url} → ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
}

const ETF = /\b(ETF|ETN|Trust|Fund|SPDR|iShares|Invesco|Vanguard|ProShares|Direxion|Index|Treasury|Bond)\b/i;

function englishWords(): Set<string> {
  const file = "/usr/share/dict/words";
  if (!existsSync(file)) return new Set();
  return new Set(readFileSync(file, "utf8").split("\n").filter((w) => w && w === w.toLowerCase()));
}

async function mintFacts(mints: string[]) {
  const out = new Map<string, { decimals: number; tokenProgram: "spl-token" | "token-2022"; delegate: string | null }>();
  for (let i = 0; i < mints.length; i += 100) {
    const batch = mints.slice(i, i + 100);
    const body = { jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [batch, { encoding: "jsonParsed" }] };
    const r = await json<{ result: { value: ({ owner: string; data: { parsed?: { info: { decimals: number; extensions?: { extension: string; state: { delegate?: string } }[] } } } } | null)[] } }>(MAINNET_RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    r.result.value.forEach((acc, j) => {
      const info = acc?.data.parsed?.info;
      if (!acc || !info) return;
      const delegate = info.extensions?.find((e) => e.extension === "permanentDelegate")?.state.delegate ?? null;
      out.set(batch[j]!, { decimals: info.decimals, tokenProgram: acc.owner.startsWith("Tokenz") ? "token-2022" : "spl-token", delegate });
    });
    await new Promise((res) => setTimeout(res, 300));
  }
  return out;
}

async function pythFeeds(): Promise<Map<string, string>> {
  const bySymbol = new Map<string, string>();
  if (!env.PYTH_API_KEY) return bySymbol;
  for (const assetType of ["equity", "crypto"]) {
    const feeds = await json<{ id: string; attributes: { symbol: string } }[]>(`${env.PYTH_HERMES_URL}/v2/price_feeds?asset_type=${assetType}`, { headers: { authorization: `Bearer ${env.PYTH_API_KEY}` } });
    for (const f of feeds) bySymbol.set(f.attributes.symbol.toUpperCase(), f.id);
  }
  return bySymbol;
}

async function main() {
  const words = englishWords();
  const [backed, prestocks, tessera, pyth] = await Promise.all([
    json<{ nodes: { symbol: string; name: string; underlyingSymbol: string | null; isTradingHalted?: boolean; deployments?: { network: string; address: string }[] }[] }>("https://api.backed.fi/api/v1/token"),
    json<{ name: string; symbol: string; description: string; contract_address: string }[]>("https://prestocks.com/api/prestocks"),
    json<{ name: string; code: string; mint: string; sector: string }[]>("https://rest-api.tessera.pe/v1/public/token-details"),
    pythFeeds().catch((e) => {
      console.warn("pyth catalog unavailable:", String(e).slice(0, 120));
      return new Map<string, string>();
    }),
  ]);

  type Draft = Omit<CatalogListing, "decimals" | "tokenProgram" | "issuerDelegate">;
  const drafts: Draft[] = [];
  for (const n of backed.nodes) {
    const dep = n.deployments?.find((d) => d.network.toLowerCase() === "solana" && d.address.startsWith("svm:"));
    // bTSLA-style tokens are Backed's older series, superseded by the xStock (TSLAx) of the same stock.
    if (!dep || n.isTradingHalted || !n.underlyingSymbol || /^b[A-Z]/.test(n.symbol)) continue;
    const name = n.name.replace(/\s*xStocks?$/i, "").trim();
    drafts.push({ mint: dep.address.slice(4), symbol: n.symbol, ticker: n.underlyingSymbol.toUpperCase(), name, issuer: "xStocks", kind: ETF.test(name) ? "etf" : "stock" });
  }
  for (const p of prestocks) {
    const name = p.name.replace(/\s*PreStocks?$/i, "").trim();
    drafts.push({ mint: p.contract_address, symbol: p.symbol, ticker: p.symbol.toUpperCase(), name, issuer: "PreStocks", kind: "pre-ipo", about: p.description.split("\n")[0]!.trim() });
  }
  for (const t of tessera) {
    const name = t.name.replace(/^T-/, "");
    drafts.push({ mint: t.mint, symbol: t.name, ticker: name.toUpperCase().replace(/[^A-Z0-9]/g, ""), name, issuer: "Tessera", kind: "pre-ipo", about: `${t.sector}.` });
  }

  // A private company that has since listed (SpaceX) is one company: its pre-IPO tokens take the public ticker.
  const publicTicker = new Map(drafts.filter((d) => d.issuer === "xStocks").map((d) => [d.name.toLowerCase(), d.ticker]));
  for (const d of drafts) {
    const listed = d.kind === "pre-ipo" ? publicTicker.get(d.name.toLowerCase()) : undefined;
    if (listed) d.ticker = listed;
  }

  const facts = await mintFacts(drafts.map((d) => d.mint));
  const listings: CatalogListing[] = [];
  for (const d of drafts) {
    const f = facts.get(d.mint);
    if (!f) {
      console.warn(`skipped ${d.symbol}: mint ${d.mint} not found on mainnet`);
      continue;
    }
    const pythTicker = d.ticker.replace(/\./g, ".");
    const equity = pyth.get(`EQUITY.US.${pythTicker}/USD`);
    const token = pyth.get(`CRYPTO.${d.symbol.toUpperCase()}/USD`);
    const index = pyth.get(`PYTH.INDEX.${d.ticker}/USD`);
    const single = d.name.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
    listings.push({
      ...d,
      decimals: f.decimals,
      tokenProgram: f.tokenProgram,
      issuerDelegate: f.delegate,
      ...(equity ? { pythFeedId: equity } : {}),
      ...(token && d.issuer === "xStocks" ? { pythTokenFeedId: token } : {}),
      ...(index ? { pythIndexFeedId: index } : {}),
      ...(!single.includes(" ") && words.has(single) ? { ambiguousName: true } : {}),
      ...(d.ticker.length >= 2 && words.has(d.ticker.toLowerCase()) ? { ambiguousTicker: true } : {}),
    });
  }
  listings.sort((a, b) => a.ticker.localeCompare(b.ticker) || a.issuer.localeCompare(b.issuer));
  const counts = listings.reduce<Record<string, number>>((m, l) => ((m[l.issuer] = (m[l.issuer] ?? 0) + 1), m), {});
  writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), counts, listings }, null, 1) + "\n");
  console.log(`wrote ${listings.length} listings`, counts, `pyth: ${listings.filter((l) => l.pythFeedId).length} equity, ${listings.filter((l) => l.pythTokenFeedId).length} token, ${listings.filter((l) => l.pythIndexFeedId).length} index feeds`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
