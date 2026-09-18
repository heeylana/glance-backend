import { describe, expect, it } from "vitest";
import { noteCompanies } from "./remember.js";

describe("noteCompanies", () => {
  it("maps the names the model gave to dictionary ids, first", () => {
    expect(noteCompanies(["Nvidia", "Broadcom"], "Chip stocks", "A quiet day.").map((c) => c.ticker)).toEqual(["NVDA", "AVGO"]);
  });
  it("adds a company the page is confidently about, once", () => {
    const got = noteCompanies(["Nvidia"], "Nvidia shares jump after Blackwell demand", "Nvidia said Blackwell demand outruns supply. Jensen Huang spoke.");
    expect(got.map((c) => c.companyId)).toEqual(["nvda"]);
    expect(got[0]).toEqual({ companyId: "nvda", name: "Nvidia", ticker: "NVDA" });
  });
  it("is empty for a page about no company", () => {
    expect(noteCompanies([], "Apple pie recipe", "Peel six apples, add cinnamon, and bake for forty minutes.")).toEqual([]);
  });
});
