import { describe, expect, it } from "vitest";
import { readOverview, readSeries } from "./birdeye.js";
import { spokenUsd, tradingSentence, stockLine } from "./glance.js";
import type { TokenMarket } from "./birdeye.js";

/** A slice of a real /defi/token_overview answer for NVDAx (21 Sep 2026). */
const overview = {
  address: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh",
  symbol: "NVDAx",
  price: 224.6135,
  priceChange24hPercent: 1.9723,
  liquidity: 5216728.5755,
  marketCap: 33838550.86,
  holder: 98880,
  trade24h: 103836,
  v24hUSD: 7224204.2438,
  numberMarkets: 843,
};

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

describe("reading Birdeye", () => {
  it("takes the fields the card uses out of a token overview", () => {
    expect(readOverview(overview)).toEqual({
      priceUsd: 224.6135,
      change24hPct: 1.9723,
      volume24hUsd: 7224204.2438,
      liquidityUsd: 5216728.5755,
      marketCapUsd: 33838550.86,
      holders: 98880,
      trades24h: 103836,
      markets: 843,
    });
  });

  it("leaves out anything the answer doesn't carry, rather than guessing a zero", () => {
    const thin = readOverview({ price: 12.5, v24hUSD: null, liquidity: "lots" });
    expect(thin.priceUsd).toBe(12.5);
    expect(thin.volume24hUsd).toBeNull();
    expect(thin.liquidityUsd).toBeNull();
    expect(thin.holders).toBeNull();
  });

  it("orders the price path oldest first and drops points with no price", () => {
    const points = readSeries({
      items: [
        { unixTime: 300, value: 3 },
        { unixTime: 100, value: 1 },
        { unixTime: 200, value: null },
        { unixTime: 250, value: 0 },
      ],
    });
    expect(points).toEqual([
      { t: 100, usd: 1 },
      { t: 300, usd: 3 },
    ]);
  });

  it("survives an answer with no items at all", () => {
    expect(readSeries({})).toEqual([]);
    expect(readSeries({ items: "nope" })).toEqual([]);
  });
});

describe("what Glance says about how a stock is trading", () => {
  it("says money the way a person says it", () => {
    expect(spokenUsd(7_224_204)).toBe("$7.2 million");
    expect(spokenUsd(1_500_000_000)).toBe("$1.5 billion");
    expect(spokenUsd(940_000)).toBe("$940,000");
    expect(spokenUsd(2_400)).toBe("$2,400");
    expect(spokenUsd(2_345)).toBe("$2,300");
    expect(spokenUsd(820)).toBe("$820");
    expect(spokenUsd(12_000_000)).toBe("$12 million");
  });

  it("reports the day's trading, with the holders behind it", () => {
    expect(tradingSentence(market())).toBe("$7.2 million changed hands today, across 99,000 holders.");
  });

  it("warns when the book is thin enough that a buy would move the price", () => {
    expect(tradingSentence(market({ volume24hUsd: 12_000 }))).toContain("thinly traded");
    expect(tradingSentence(market({ volume24hUsd: null, liquidityUsd: 9_000 }))).toContain("small");
  });

  it("says nothing at all when Birdeye has nothing", () => {
    expect(tradingSentence(null)).toBe("");
    expect(tradingSentence(market({ volume24hUsd: null, liquidityUsd: null }))).toBe("");
  });

  it("adds the trading sentence to the spoken answer, and manages without it", () => {
    const entity = { companyId: "nvda", name: "Nvidia", ticker: "NVDA", confidence: 1, evidence: [], tokenized: true, priceUsd: 224.61, changeTodayPct: 1.97 };
    expect(stockLine(entity, market())).toBe("Nvidia is $225 on-chain, up 2.0% today. $7.2 million changed hands today, across 99,000 holders.");
    expect(stockLine(entity, null)).toBe("Nvidia is $225 on-chain, up 2.0% today.");
    // Birdeye's day move stands in when the price feed has none.
    expect(stockLine({ ...entity, changeTodayPct: null }, market({ change24hPct: -3.4 }))).toContain("down 3.4% today");
  });
});
