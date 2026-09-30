import { readFileSync } from "node:fs";
import { CATALOG_FILE } from "../config/issuers.js";

/**
 * Curated resolver table (spec §9). `mint`/`issuer` are filled from the issuer
 * registry (src/config/issuers.*.json) at load time, so this file stays about
 * language: names, tickers, aliases, products, executives.
 *
 * Alias rules: lower-case, no punctuation. Keep aliases ≥ 3 chars and specific
 * enough not to fire on ordinary prose ("meta" and "apple" are handled by the
 * ambiguity list in match.ts).
 */
export interface CompanySeed {
  id: string;
  name: string;
  ticker: string;
  exchange: "NASDAQ" | "NYSE" | "OTC" | "ETF" | "LISTED" | "PRIVATE";
  aliases: string[];
  products: string[];
  execs: string[];
  /** The name alone is an ordinary word ("Target", "Crown"): it needs a capital letter or a second signal. */
  ambiguousName?: boolean;
  /** The ticker is also a word or a news acronym ("NOW", "AI"): a bare mention is weak. */
  ambiguousTicker?: boolean;
  /**
   * One plain line saying what the company does. Only private companies carry it, and only because their card has
   * nothing else on it: a tokenized company's card shows a price, a chart and its tokens, while a company Glance
   * cannot trade would otherwise be a name and two buttons. Kept to a single factual clause.
   */
  blurb?: string;
}

const CURATED: CompanySeed[] = [
  { id: "aapl", name: "Apple", ticker: "AAPL", exchange: "NASDAQ", aliases: ["apple inc", "apple computer", "cupertino"], products: ["iphone", "ipad", "macbook", "imac", "mac mini", "apple watch", "airpods", "vision pro", "app store", "ios", "macos", "apple intelligence", "siri", "icloud", "apple tv", "apple arcade", "apple music", "apple pay"], execs: ["tim cook", "steve jobs"] },
  { id: "msft", name: "Microsoft", ticker: "MSFT", exchange: "NASDAQ", aliases: ["microsoft corp", "redmond"], products: ["windows", "windows 11", "windows 12", "azure", "xbox", "office 365", "microsoft 365", "copilot", "github", "linkedin", "surface", "teams"], execs: ["satya nadella", "bill gates"] },
  { id: "nvda", name: "Nvidia", ticker: "NVDA", exchange: "NASDAQ", aliases: ["nvidia corp"], products: ["geforce", "rtx", "cuda", "blackwell", "hopper", "h100", "h200", "b200", "gb200", "rubin", "dgx"], execs: ["jensen huang"] },
  { id: "amzn", name: "Amazon", ticker: "AMZN", exchange: "NASDAQ", aliases: ["amazon com", "amazon inc"], products: ["aws", "amazon web services", "prime video", "amazon prime", "alexa", "kindle", "whole foods", "twitch"], execs: ["andy jassy", "jeff bezos"] },
  { id: "googl", name: "Alphabet", ticker: "GOOGL", exchange: "NASDAQ", aliases: ["google", "alphabet inc", "mountain view"], products: ["gemini", "android", "youtube", "google search", "chrome", "pixel", "waymo", "deepmind", "google cloud", "tensor"], execs: ["sundar pichai", "larry page", "sergey brin", "demis hassabis"] },
  { id: "meta", name: "Meta", ticker: "META", exchange: "NASDAQ", aliases: ["meta platforms", "facebook"], products: ["instagram", "whatsapp", "threads", "oculus", "quest", "llama", "ray ban meta", "reality labs"], execs: ["mark zuckerberg", "zuckerberg", "zuck"] },
  { id: "tsla", name: "Tesla", ticker: "TSLA", exchange: "NASDAQ", aliases: ["tesla inc", "tesla motors"], products: ["model 3", "model y", "model s", "model x", "cybertruck", "cybercab", "robotaxi", "optimus", "powerwall", "megapack", "full self driving", "fsd", "supercharger"], execs: ["elon musk", "musk"] },
  { id: "nflx", name: "Netflix", ticker: "NFLX", exchange: "NASDAQ", aliases: [], products: ["squid game", "stranger things"], execs: ["ted sarandos", "reed hastings"] },
  { id: "coin", name: "Coinbase", ticker: "COIN", exchange: "NASDAQ", aliases: ["coinbase global"], products: ["base chain", "coinbase wallet", "coinbase prime"], execs: ["brian armstrong"] },
  { id: "mstr", name: "Strategy", ticker: "MSTR", exchange: "NASDAQ", aliases: ["microstrategy", "strategy inc"], products: [], execs: ["michael saylor", "saylor", "phong le"] },
  { id: "nvo", name: "Novo Nordisk", ticker: "NVO", exchange: "NYSE", aliases: ["novo", "novonordisk"], products: ["ozempic", "wegovy", "rybelsus", "semaglutide", "cagrisema", "amycretin"], execs: ["lars fruergaard jorgensen", "mike doustdar"] },
  { id: "lly", name: "Eli Lilly", ticker: "LLY", exchange: "NYSE", aliases: ["lilly", "eli lilly and company"], products: ["mounjaro", "zepbound", "tirzepatide", "orforglipron", "retatrutide", "trulicity"], execs: ["david ricks"] },
  { id: "jpm", name: "JPMorgan Chase", ticker: "JPM", exchange: "NYSE", aliases: ["jpmorgan", "jp morgan", "chase bank"], products: [], execs: ["jamie dimon"] },
  { id: "v", name: "Visa", ticker: "V", exchange: "NYSE", aliases: ["visa inc"], products: [], execs: ["ryan mcinerney"] },
  { id: "ma", name: "Mastercard", ticker: "MA", exchange: "NYSE", aliases: [], products: [], execs: ["michael miebach"] },
  { id: "wmt", name: "Walmart", ticker: "WMT", exchange: "NYSE", aliases: ["wal mart"], products: ["sams club"], execs: ["doug mcmillon"] },
  { id: "cost", name: "Costco", ticker: "COST", exchange: "NASDAQ", aliases: ["costco wholesale"], products: ["kirkland signature"], execs: ["ron vachris"] },
  { id: "xom", name: "ExxonMobil", ticker: "XOM", exchange: "NYSE", aliases: ["exxon", "exxon mobil"], products: [], execs: ["darren woods"] },
  { id: "jnj", name: "Johnson & Johnson", ticker: "JNJ", exchange: "NYSE", aliases: ["johnson and johnson", "j and j", "jnj"], products: ["tylenol", "band aid"], execs: ["joaquin duato"] },
  { id: "pfe", name: "Pfizer", ticker: "PFE", exchange: "NYSE", aliases: [], products: ["paxlovid", "comirnaty"], execs: ["albert bourla"] },
  { id: "intc", name: "Intel", ticker: "INTC", exchange: "NASDAQ", aliases: ["intel corp"], products: ["core ultra", "xeon", "gaudi", "arc gpu", "18a"], execs: ["lip bu tan", "pat gelsinger"] },
  { id: "amd", name: "AMD", ticker: "AMD", exchange: "NASDAQ", aliases: ["advanced micro devices"], products: ["ryzen", "radeon", "epyc", "instinct", "mi300", "mi350", "mi400"], execs: ["lisa su"] },
  { id: "avgo", name: "Broadcom", ticker: "AVGO", exchange: "NASDAQ", aliases: [], products: ["vmware", "tomahawk"], execs: ["hock tan"] },
  { id: "orcl", name: "Oracle", ticker: "ORCL", exchange: "NYSE", aliases: ["oracle corp"], products: ["oracle cloud", "oci", "java", "mysql"], execs: ["larry ellison", "safra catz", "clay magouyrk", "mike sicilia"] },
  { id: "crm", name: "Salesforce", ticker: "CRM", exchange: "NYSE", aliases: [], products: ["slack", "tableau", "agentforce", "mulesoft"], execs: ["marc benioff"] },
  { id: "adbe", name: "Adobe", ticker: "ADBE", exchange: "NASDAQ", aliases: [], products: ["photoshop", "premiere pro", "acrobat", "firefly", "creative cloud", "lightroom"], execs: ["shantanu narayen"] },
  { id: "pltr", name: "Palantir", ticker: "PLTR", exchange: "NASDAQ", aliases: ["palantir technologies"], products: ["foundry", "gotham", "aip"], execs: ["alex karp", "peter thiel"] },
  { id: "uber", name: "Uber", ticker: "UBER", exchange: "NYSE", aliases: ["uber technologies"], products: ["uber eats"], execs: ["dara khosrowshahi"] },
  { id: "abnb", name: "Airbnb", ticker: "ABNB", exchange: "NASDAQ", aliases: [], products: [], execs: ["brian chesky"] },
  { id: "pypl", name: "PayPal", ticker: "PYPL", exchange: "NASDAQ", aliases: [], products: ["venmo", "pyusd", "braintree"], execs: ["alex chriss"] },
  { id: "shop", name: "Shopify", ticker: "SHOP", exchange: "NASDAQ", aliases: [], products: ["shop pay"], execs: ["tobi lutke", "tobias lutke"] },
  { id: "hood", name: "Robinhood", ticker: "HOOD", exchange: "NASDAQ", aliases: ["robinhood markets"], products: ["robinhood gold", "robinhood legend"], execs: ["vlad tenev"] },
  { id: "gme", name: "GameStop", ticker: "GME", exchange: "NYSE", aliases: ["game stop"], products: [], execs: ["ryan cohen"] },
  { id: "dis", name: "Disney", ticker: "DIS", exchange: "NYSE", aliases: ["walt disney", "the walt disney company"], products: ["disney plus", "disney+", "espn", "pixar", "marvel studios", "hulu", "disneyland", "disney world"], execs: ["bob iger"] },
  { id: "nke", name: "Nike", ticker: "NKE", exchange: "NYSE", aliases: ["nike inc"], products: ["air jordan", "jordan brand", "air max"], execs: ["elliott hill"] },
  { id: "sbux", name: "Starbucks", ticker: "SBUX", exchange: "NASDAQ", aliases: [], products: ["pumpkin spice latte", "frappuccino"], execs: ["brian niccol"] },
  { id: "mcd", name: "McDonald's", ticker: "MCD", exchange: "NYSE", aliases: ["mcdonalds", "mcdonald s"], products: ["big mac", "mcnuggets", "happy meal"], execs: ["chris kempczinski"] },
  { id: "ba", name: "Boeing", ticker: "BA", exchange: "NYSE", aliases: ["boeing co"], products: ["737 max", "787 dreamliner", "777x", "starliner"], execs: ["kelly ortberg"] },
  { id: "f", name: "Ford", ticker: "F", exchange: "NYSE", aliases: ["ford motor", "ford motor company"], products: ["f 150", "f150", "mustang", "mustang mach e", "bronco"], execs: ["jim farley"] },
  { id: "gm", name: "General Motors", ticker: "GM", exchange: "NYSE", aliases: ["gm"], products: ["chevrolet", "chevy", "cadillac", "gmc", "cruise", "silverado"], execs: ["mary barra"] },
  { id: "rivn", name: "Rivian", ticker: "RIVN", exchange: "NASDAQ", aliases: ["rivian automotive"], products: ["r1t", "r1s", "r2", "r3"], execs: ["rj scaringe"] },
  { id: "rddt", name: "Reddit", ticker: "RDDT", exchange: "NYSE", aliases: ["reddit inc"], products: ["subreddit"], execs: ["steve huffman"] },
  { id: "snap", name: "Snap", ticker: "SNAP", exchange: "NYSE", aliases: ["snap inc", "snapchat"], products: ["snapchat", "spectacles", "snap map"], execs: ["evan spiegel"] },
  { id: "spot", name: "Spotify", ticker: "SPOT", exchange: "NYSE", aliases: ["spotify technology"], products: ["spotify wrapped"], execs: ["daniel ek"] },
  { id: "baba", name: "Alibaba", ticker: "BABA", exchange: "NYSE", aliases: ["alibaba group"], products: ["taobao", "tmall", "aliexpress", "alipay", "qwen", "alibaba cloud"], execs: ["eddie wu", "jack ma", "joe tsai"] },
  { id: "tsm", name: "TSMC", ticker: "TSM", exchange: "NYSE", aliases: ["taiwan semiconductor", "taiwan semi"], products: ["n2", "n3", "3nm", "2nm", "cowos"], execs: ["c c wei"] },
  { id: "asml", name: "ASML", ticker: "ASML", exchange: "NASDAQ", aliases: ["asml holding"], products: ["euv", "high na"], execs: ["christophe fouquet"] },
  { id: "crcl", name: "Circle", ticker: "CRCL", exchange: "NYSE", aliases: ["circle internet", "circle internet group"], products: ["usdc", "euroc", "cctp", "arc"], execs: ["jeremy allaire"] },
  { id: "mara", name: "MARA", ticker: "MARA", exchange: "NASDAQ", aliases: ["marathon digital", "mara holdings"], products: [], execs: ["fred thiel"] },
  { id: "unh", name: "UnitedHealth", ticker: "UNH", exchange: "NYSE", aliases: ["unitedhealth group", "united healthcare", "unitedhealthcare"], products: ["optum"], execs: ["stephen hemsley"] },
  { id: "brk", name: "Berkshire Hathaway", ticker: "BRK.B", exchange: "NYSE", aliases: ["berkshire"], products: ["geico", "bnsf"], execs: ["warren buffett", "buffett", "greg abel"] },
  { id: "hims", name: "Hims & Hers", ticker: "HIMS", exchange: "NYSE", aliases: ["hims and hers", "hims"], products: [], execs: ["andrew dudum"] },
  { id: "app", name: "AppLovin", ticker: "APP", exchange: "NASDAQ", aliases: ["applovin"], products: ["axon"], execs: ["adam foroughi"] },
  { id: "crwd", name: "CrowdStrike", ticker: "CRWD", exchange: "NASDAQ", aliases: ["crowdstrike holdings"], products: ["falcon"], execs: ["george kurtz"] },
  { id: "spy", name: "S&P 500", ticker: "SPY", exchange: "ETF", aliases: ["s and p 500", "s&p 500", "sp500", "s p 500", "the s p", "spdr s p 500"], products: [], execs: [] },
  { id: "qqq", name: "Nasdaq 100", ticker: "QQQ", exchange: "ETF", aliases: ["nasdaq 100", "invesco qqq", "the qs"], products: [], execs: [] },
  { id: "gld", name: "Gold", ticker: "GLD", exchange: "ETF", aliases: ["spdr gold", "gold etf"], products: [], execs: [] },
  { id: "tlt", name: "20+ Year Treasuries", ticker: "TLT", exchange: "ETF", aliases: ["long bonds", "treasury bond etf"], products: [], execs: [] },
];

/**
 * Private companies with pre-IPO tokens (PreStocks, Tessera). Tickers are the tokens' company keys;
 * SpaceX has since listed, so it uses its public ticker and its pre-IPO tokens group under it.
 */
const PRIVATE: CompanySeed[] = [
  { id: "openai", name: "OpenAI", ticker: "OPENAI", exchange: "PRIVATE", aliases: ["open ai"], products: ["chatgpt", "gpt 5", "gpt 4o", "gpt 4", "sora", "dall e", "openai o3"], execs: ["sam altman", "greg brockman", "fidji simo"], blurb: "The lab behind ChatGPT." },
  { id: "anthropic", name: "Anthropic", ticker: "ANTHROPIC", exchange: "PRIVATE", aliases: ["anthropic pbc"], products: ["claude", "claude code", "claude opus", "claude sonnet", "claude haiku"], execs: ["dario amodei", "daniela amodei"], blurb: "The lab behind Claude." },
  { id: "spcx", name: "SpaceX", ticker: "SPCX", exchange: "LISTED", aliases: ["space x", "space exploration technologies"], products: ["starlink", "starship", "falcon 9", "falcon heavy", "crew dragon", "starbase"], execs: ["gwynne shotwell"] },
  { id: "anduril", name: "Anduril", ticker: "ANDURIL", exchange: "PRIVATE", aliases: ["anduril industries"], products: ["roadrunner", "ghost shark", "altius"], execs: ["palmer luckey", "brian schimpf"], blurb: "Defence hardware and autonomous systems." },
  { id: "neuralink", name: "Neuralink", ticker: "NEURALINK", exchange: "PRIVATE", aliases: [], products: ["blindsight", "telepathy implant"], execs: [], blurb: "Brain-computer implants." },
  { id: "figureai", name: "Figure AI", ticker: "FIGUREAI", exchange: "PRIVATE", aliases: ["figure robotics"], products: ["figure 02", "figure 03", "helix vla"], execs: ["brett adcock"], blurb: "Humanoid robots." },
  { id: "kalshi", name: "Kalshi", ticker: "KALSHI", exchange: "PRIVATE", aliases: [], products: [], execs: ["tarek mansour", "luana lopes lara"], blurb: "A regulated prediction market." },
  { id: "polymarket", name: "Polymarket", ticker: "POLYMARKET", exchange: "PRIVATE", aliases: [], products: [], execs: ["shayne coplan"], blurb: "A prediction market." },

  /**
   * Private companies with no token behind them, and the reason they are here: without an entry, a page about one of
   * them resolves to whichever company Glance does know that the article happens to mention. A Stripe story naming
   * OpenAI as a customer resolved to OpenAI, confidently and wrongly, which is the worst answer Glance can give.
   *
   * With an entry, the ticker matches nothing in the issuer registry, so `tokenized` is false and the existing
   * "waiting on the headline" path takes over (routes/watchlist.ts, spec §7.7): Glance names the right company, says
   * it cannot be bought yet, and offers to say when it can. Being right and unable to trade beats being wrong.
   *
   * Names that are ordinary words ("stripe", "discord", "perplexity") carry ambiguousName, so a bare lower-case
   * mention is not enough to fire. Executives shared with a listed company are left out: "elon musk" belongs to Tesla
   * in this table, and giving him to xAI as well would make every Tesla story ambiguous.
   */
  { id: "stripe", name: "Stripe", ticker: "STRIPE", exchange: "PRIVATE", aliases: ["stripe inc"], products: ["stripe checkout", "stripe connect", "stripe atlas", "stripe radar", "stripe terminal"], execs: ["patrick collison", "john collison"], ambiguousName: true, blurb: "Payments infrastructure for internet businesses." },
  { id: "databricks", name: "Databricks", ticker: "DATABRICKS", exchange: "PRIVATE", aliases: [], products: ["mosaicml", "unity catalog", "delta lake"], execs: ["ali ghodsi"], blurb: "A data and AI platform." },
  { id: "xai", name: "xAI", ticker: "XAI", exchange: "PRIVATE", aliases: ["x ai"], products: ["grok", "colossus"], execs: [], ambiguousTicker: true, blurb: "The lab behind Grok." },
  { id: "bytedance", name: "ByteDance", ticker: "BYTEDANCE", exchange: "PRIVATE", aliases: [], products: ["tiktok", "douyin", "capcut"], execs: ["liang rubo", "zhang yiming"], blurb: "The company behind TikTok." },
  { id: "canva", name: "Canva", ticker: "CANVA", exchange: "PRIVATE", aliases: [], products: ["canva magic studio"], execs: ["melanie perkins"], blurb: "Design software in the browser." },
  { id: "klarna", name: "Klarna", ticker: "KLARNA", exchange: "PRIVATE", aliases: [], products: [], execs: ["sebastian siemiatkowski"], blurb: "Buy now, pay later payments." },
  { id: "epicgames", name: "Epic Games", ticker: "EPICGAMES", exchange: "PRIVATE", aliases: [], products: ["fortnite", "unreal engine"], execs: ["tim sweeney"], blurb: "Fortnite and the Unreal Engine." },
  { id: "discord", name: "Discord", ticker: "DISCORD", exchange: "PRIVATE", aliases: [], products: [], execs: ["jason citron", "humam sakhnini"], ambiguousName: true, blurb: "A chat platform for communities." },
  { id: "perplexity", name: "Perplexity", ticker: "PERPLEXITY", exchange: "PRIVATE", aliases: ["perplexity ai"], products: ["comet browser"], execs: ["aravind srinivas"], ambiguousName: true, blurb: "An AI search engine." },
  { id: "mistral", name: "Mistral", ticker: "MISTRAL", exchange: "PRIVATE", aliases: ["mistral ai"], products: ["le chat"], execs: ["arthur mensch"], ambiguousName: true, blurb: "Open-weight AI models." },
  { id: "scaleai", name: "Scale AI", ticker: "SCALEAI", exchange: "PRIVATE", aliases: ["scale ai"], products: [], execs: [], ambiguousName: true, blurb: "Training data for AI models." },
];

/** News acronyms that are also tickers: bare in caps they are almost never the company. */
const ACRONYM_TICKERS = new Set(["AI", "IT", "ON", "NOW", "ALL", "KEY", "LOW", "CAT", "DOC", "HAS", "WELL", "AMP", "CEO", "IPO", "FDA", "SEC", "USA", "GDP", "ETF", "EPS", "EV", "USD", "UK", "EU", "API"]);
const SUFFIX = /,?\s+(inc\.?|incorporated|corp\.?|corporation|co\.?|company|plc|ltd\.?|limited|holdings|group|n\.?v\.?|s\.?a\.?|ag|se)$/i;

interface CatalogRow {
  ticker: string;
  name: string;
  kind: "stock" | "etf" | "pre-ipo";
  ambiguousName?: boolean;
  ambiguousTicker?: boolean;
}

/** Every other company in the catalog, named as the issuer names it with legal suffixes trimmed. */
function fromCatalog(known: Set<string>): CompanySeed[] {
  let rows: CatalogRow[];
  try {
    rows = (JSON.parse(readFileSync(CATALOG_FILE, "utf8")) as { listings: CatalogRow[] }).listings;
  } catch {
    return [];
  }
  const out: CompanySeed[] = [];
  const seen = new Set(known);
  for (const r of rows) {
    if (seen.has(r.ticker)) continue;
    seen.add(r.ticker);
    let name = r.name.replace(/^the\s+/i, "");
    for (let i = 0; i < 2; i++) name = name.replace(SUFFIX, "").trim();
    const aliases = [...new Set([r.name, r.name.replace(/^the\s+/i, "")].filter((a) => a.toLowerCase() !== name.toLowerCase()))];
    out.push({
      id: r.ticker.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      name,
      ticker: r.ticker,
      exchange: r.kind === "etf" ? "ETF" : r.kind === "pre-ipo" ? "PRIVATE" : "LISTED",
      aliases,
      products: [],
      execs: [],
      ...(r.ambiguousName || (!name.includes(" ") && name.length <= 4 && name === name.toUpperCase()) ? { ambiguousName: true } : {}),
      ...(r.ambiguousTicker || ACRONYM_TICKERS.has(r.ticker) ? { ambiguousTicker: true } : {}),
    });
  }
  return out;
}

const hand = [...CURATED, ...PRIVATE];
export const COMPANIES: CompanySeed[] = withTokenSymbols([...hand, ...fromCatalog(new Set(hand.map((c) => c.ticker)))]);

/**
 * Token symbols as aliases: trading pages name the token, not the share ("MSFTx/USD" on birdeye,
 * "T-OpenAI" on Tessera), and a symbol like "msftx" is never an ordinary word.
 */
function withTokenSymbols(companies: CompanySeed[]): CompanySeed[] {
  let rows: { ticker: string; symbol: string }[];
  try {
    rows = (JSON.parse(readFileSync(CATALOG_FILE, "utf8")) as { listings: { ticker: string; symbol: string }[] }).listings;
  } catch {
    return companies;
  }
  const symbols = new Map<string, string[]>();
  for (const r of rows) {
    const s = r.symbol.toLowerCase();
    if (s.length >= 4 && s !== r.ticker.toLowerCase()) symbols.set(r.ticker, [...(symbols.get(r.ticker) ?? []), s]);
  }
  return companies.map((c) => (symbols.has(c.ticker) ? { ...c, aliases: [...new Set([...c.aliases, ...symbols.get(c.ticker)!])] } : c));
}
