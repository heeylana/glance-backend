import { describe, expect, it } from "vitest";
import { DISCLAIMER, SPOKEN_DISCLAIMER, factsFor, linesOf } from "./advice.js";
import type { GlanceEntity } from "./glance.js";
import type { TokenMarket } from "./birdeye.js";

const entity = (over: Partial<GlanceEntity> = {}): GlanceEntity => ({
  companyId: "nvda",
  name: "Nvidia",
  ticker: "NVDA",
  confidence: 1,
  evidence: ["asked"],
  tokenized: true,
  kind: "stock",
  priceUsd: 224.61,
  changeTodayPct: 1.97,
  listings: [{ mint: "M", symbol: "NVDAx", issuer: "xStocks", kind: "stock", tokenUsd: 224.61, markUsd: 223.5, premiumPct: 0.5, liquidityUsd: 5_216_728 }],
  ...over,
});

const market = (over: Partial<TokenMarket> = {}): TokenMarket => ({
  priceUsd: 224.61,
  change24hPct: 1.97,
  volume24hUsd: 7_224_204,
  liquidityUsd: 5_216_728,
  marketCapUsd: 33_838_550,
  holders: 98_880,
  trades24h: 103_836,
  markets: 843,
  ...over,
});

describe("the facts a read is built from", () => {
  it("gives the model the price, the day, the premium and the token's own market", () => {
    const facts = factsFor(entity(), market());
    expect(facts).toContain("Price on-chain: $224.61");
    expect(facts).toContain("Move today: up 2.0%");
    expect(facts.join("\n")).toContain("0.5% above the issuer's own mark");
    expect(facts.join("\n")).toContain("Traded in the last day: $7.2 million");
    expect(facts.join("\n")).toContain("Holders: 98,880");
  });

  it("warns the model itself when the token is thin", () => {
    expect(factsFor(entity(), market({ volume24hUsd: 9_000 })).join("\n")).toContain("thinly traded");
    expect(factsFor(entity(), market()).join("\n")).not.toContain("thinly traded");
  });

  it("says when the company is private, and when several issuers tokenize it", () => {
    const facts = factsFor(
      entity({ kind: "pre-ipo", listings: [entity().listings![0]!, { ...entity().listings![0]!, symbol: "T-OPENAI", issuer: "Tessera" }] }),
      null,
    );
    expect(facts.join("\n")).toContain("pre-IPO token for a private company");
    expect(facts.join("\n")).toContain("2 different issuers");
  });

  it("claims nothing it doesn't have", () => {
    const facts = factsFor(entity({ priceUsd: null, changeTodayPct: null, listings: [] }), null);
    expect(facts.join("\n")).not.toContain("Price on-chain");
    expect(facts.join("\n")).not.toContain("Move today");
    expect(facts).toEqual([]);
  });
});

describe("the shape of a read", () => {
  const read = { now: "Nvidia is up 2% today after a China licence report.", forIt: "Data centre demand is still growing.", against: "One analyst calls the valuation stretched.", watch: "Next week's earnings." };

  it("says what is happening and both sides, in order", () => {
    expect(linesOf(read)).toEqual([read.now, read.forIt, read.against, read.watch]);
  });

  it("drops the parts the model had nothing for, rather than saying an empty sentence", () => {
    expect(linesOf({ ...read, forIt: "", against: "   ", watch: "" })).toEqual([read.now]);
  });

  it("has a disclaimer that names what Glance is not, and sends the user elsewhere", () => {
    for (const line of [DISCLAIMER, SPOKEN_DISCLAIMER]) {
      expect(line).toMatch(/not an analyst/i);
      expect(line).toMatch(/own research/i);
    }
    expect(DISCLAIMER).toMatch(/isn't financial advice/i);
  });
});
