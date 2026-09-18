import { describe, expect, it } from "vitest";
import { TtlCache } from "./ttl-cache.js";

describe("TtlCache", () => {
  it("returns a value until it is older than the limit", () => {
    const c = new TtlCache<string>(1000);
    c.set("a", "x", 0);
    expect(c.get("a", 999)).toBe("x");
    expect(c.get("a", 1000)).toBeUndefined();
    expect(c.size).toBe(0);
  });
  it("drops the oldest entry when full", () => {
    const c = new TtlCache<number>(60_000, 2);
    c.set("a", 1, 0);
    c.set("b", 2, 1);
    c.set("c", 3, 2);
    expect(c.get("a", 3)).toBeUndefined();
    expect(c.get("b", 3)).toBe(2);
    expect(c.get("c", 3)).toBe(3);
  });
  it("treats a rewrite as new", () => {
    const c = new TtlCache<number>(60_000, 2);
    c.set("a", 1, 0);
    c.set("b", 2, 1);
    c.set("a", 10, 2);
    c.set("c", 3, 3);
    expect(c.get("b", 4)).toBeUndefined();
    expect(c.get("a", 4)).toBe(10);
  });
});
