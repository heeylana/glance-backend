import { describe, expect, it } from "vitest";
import { mapFinnhub, mentions, withinWindow, type FinnhubItem } from "./news.js";

const NOW = Date.parse("2026-09-15T14:00:00Z");
const at = (minutesAgo: number) => Math.floor((NOW - minutesAgo * 60_000) / 1000);
const items: FinnhubItem[] = [
  { datetime: at(30), headline: "Apple shares rise as iPhone 18 pre-order wait times climb", source: "MarketWatch", url: "https://mw/1", summary: "Apple…" },
  { datetime: at(30), headline: "Apple shares rise as iPhone 18 pre-order wait times climb", source: "Yahoo", url: "https://y/1" }, // syndicated copy
  { datetime: at(300), headline: "Amazon could buy $60B from Qualcomm just as Apple brings modems in-house", source: "Yahoo", url: "https://y/2" },
  { datetime: at(2000), headline: "Widow's Bay wins big at the Emmys", source: "Yahoo", url: "https://y/3", summary: "Apple TV's comedy…" },
  { datetime: at(5), headline: "", source: "Yahoo", url: "https://y/4" },
];

describe("mapFinnhub", () => {
  it("maps, sorts newest first, and drops duplicates and empties", () => {
    const h = mapFinnhub(items);
    expect(h.map((x) => x.url)).toEqual(["https://mw/1", "https://y/2", "https://y/3"]);
    expect(h[0]).toEqual({ title: "Apple shares rise as iPhone 18 pre-order wait times climb", source: "MarketWatch", url: "https://mw/1", publishedAt: new Date(at(30) * 1000).toISOString() });
  });
});

describe("withinWindow", () => {
  it("cuts to the last N minutes", () => {
    const h = mapFinnhub(items);
    expect(withinWindow(h, 60, NOW).map((x) => x.url)).toEqual(["https://mw/1"]);
    expect(withinWindow(h, 1440, NOW).map((x) => x.url)).toEqual(["https://mw/1", "https://y/2"]);
  });
});

describe("mentions", () => {
  const apple = { ticker: "AAPL", name: "Apple" };
  it("matches the company name or ticker as a whole word, in title or summary", () => {
    expect(mentions({ title: "Apple shares rise" }, apple)).toBe(true);
    expect(mentions({ title: "AAPL breaks out" }, apple)).toBe(true);
    expect(mentions({ title: "Emmys night", summary: "Apple TV's comedy wins" }, apple)).toBe(true);
    expect(mentions({ title: "Pineapple prices fall" }, apple)).toBe(false);
  });
  it("uses the first word of a long name and tolerates the ampersand", () => {
    expect(mentions({ title: "Novo cuts Wegovy price" }, { ticker: "NVO", name: "Novo Nordisk" })).toBe(true);
    expect(mentions({ title: "S&P 500 closes at a record" }, { ticker: "SPY", name: "S&P 500" })).toBe(true);
    expect(mentions({ title: "Berkshire trims Apple stake" }, { ticker: "BRK.B", name: "Berkshire Hathaway" })).toBe(true);
  });
});
