import { describe, expect, it } from "vitest";
import { loadSkills, parseSkill, pickSkills, skillsPrompt, SKILLS_DIR, type Skill } from "./skills.js";

const skill = (over: Partial<Skill>): Skill => {
  const body = over.body ?? "b";
  return { name: "x", description: "d", when: [], sites: [], body, parts: [{ when: [], text: body }], ...over };
};

describe("parseSkill", () => {
  it("reads the frontmatter and the body", () => {
    expect(parseSkill("---\nname: rsi-basics\ndescription: RSI.\nwhen: RSI, overbought ,\nsites: tradingview.com\n---\n# Body\ntext")).toEqual({
      name: "rsi-basics",
      description: "RSI.",
      when: ["rsi", "overbought"],
      sites: ["tradingview.com"],
      body: "# Body\ntext",
      parts: [{ when: [], text: "# Body\ntext" }],
    });
  });
  it("reads a section's own trigger line and adds its words to the skill's", () => {
    const s = parseSkill("---\nname: charts\ndescription: d\nwhen: chart\n---\n# Reading\nbasics\n\n# Patterns\n\nwhen: flag, head and shoulders\ntable\n\n# Drawing\nmarks");
    expect("error" in s).toBe(false);
    if ("error" in s) return;
    expect(s.when).toEqual(["chart", "flag", "head and shoulders"]);
    expect(s.parts).toEqual([
      { when: [], text: "# Reading\nbasics" },
      { when: ["flag", "head and shoulders"], text: "# Patterns\ntable" },
      { when: [], text: "# Drawing\nmarks" },
    ]);
    expect(s.body).not.toContain("when:");
  });
  it("says what is wrong", () => {
    expect(parseSkill("# no frontmatter")).toEqual({ error: "no frontmatter" });
    expect(parseSkill("---\nname: Bad Name\ndescription: x\n---\nbody")).toEqual({ error: "name must be kebab-case" });
    expect(parseSkill("---\nname: ok\ndescription: x\n---\n")).toEqual({ error: "the body is empty" });
  });
});

describe("pickSkills", () => {
  const charts = skill({ name: "charts", when: ["chart", "support", "candlestick"], sites: ["tradingview.com"] });
  const earnings = skill({ name: "earnings", when: ["revenue", "eps", "quarterly"] });
  it("matches whole trigger words in the question first, the title second, and favours its own sites", () => {
    expect(pickSkills({ question: "what does this chart show", url: "https://example.com" }, [charts, earnings]).map((s) => s.name)).toEqual(["charts"]);
    expect(pickSkills({ question: "walk me through this", title: "Q3 quarterly revenue", url: "https://example.com" }, [charts, earnings]).map((s) => s.name)).toEqual(["earnings"]);
    expect(pickSkills({ question: "charting a course", url: "https://example.com" }, [charts, earnings])).toEqual([]);
    expect(pickSkills({ question: "where is support and what is the eps", url: "https://www.tradingview.com/x" }, [earnings, charts]).map((s) => s.name)).toEqual(["charts", "earnings"]);
  });
  it("sends a conditional section only when one of its words comes up", () => {
    const s = parseSkill("---\nname: charts\ndescription: d\nwhen: chart\n---\n# Reading\nbasics\n\n# Patterns\nwhen: flag, wedge\ntable\n\n# Drawing\nmarks");
    if ("error" in s) throw new Error(s.error);
    const plain = pickSkills({ question: "what does this chart show", url: "https://x.com" }, [s])[0]!;
    expect(plain.body).toBe("# Reading\nbasics\n\n# Drawing\nmarks");
    const flag = pickSkills({ question: "is this a bull flag", url: "https://x.com" }, [s])[0]!;
    expect(flag.body).toBe("# Reading\nbasics\n\n# Patterns\ntable\n\n# Drawing\nmarks");
    const byTitle = pickSkills({ question: "what does this chart show", title: "Falling wedge breakout", url: "https://x.com" }, [s])[0]!;
    expect(byTitle.body).toContain("# Patterns");
  });
});

describe("skillsPrompt", () => {
  it("is empty without skills and names each one it includes", () => {
    expect(skillsPrompt([])).toBe("");
    expect(skillsPrompt([skill({ name: "charts", body: "Read the axis." })])).toBe("\n\nSkills for this answer (follow them):\n\n## Skill: charts\nRead the axis.");
  });
  it("writes the same set in the same order whatever the match order, so the prompt cache is reused", () => {
    const charts = skill({ name: "charts", body: "Read the axis." });
    const earnings = skill({ name: "earnings", body: "Start with revenue." });
    expect(skillsPrompt([earnings, charts])).toBe(skillsPrompt([charts, earnings]));
    expect(skillsPrompt([earnings, charts]).indexOf("## Skill: charts")).toBeLessThan(skillsPrompt([earnings, charts]).indexOf("## Skill: earnings"));
  });
  it("keeps the best matches when the budget runs out", () => {
    const big = (name: string) => skill({ name, body: "x".repeat(4000) });
    const out = skillsPrompt([big("zeta"), big("beta"), big("alpha")]);
    expect(out).toContain("## Skill: zeta");
    expect(out).toContain("## Skill: beta");
    expect(out).not.toContain("## Skill: alpha");
  });
});

describe("the shipped skills", () => {
  it("all parse", () => {
    expect(loadSkills(SKILLS_DIR).map((s) => s.name)).toEqual(expect.arrayContaining(["candlestick-charts", "earnings-tables", "technical-indicators"]));
  });
  it("name chart and candle patterns through the chart skill, and send the catalogue only then", () => {
    const shipped = loadSkills(SKILLS_DIR);
    const url = "https://birdeye.so/token/x";
    const chart = (q: string) => pickSkills({ question: q, url }, shipped).find((s) => s.name === "candlestick-charts");
    for (const q of ["is this a bull flag?", "is that a bearish engulfing candle", "where is the neckline of this head and shoulders"]) expect(chart(q)?.body, q).toContain("# Naming a pattern");
    expect(chart("what does this chart show?")?.body).not.toContain("# Naming a pattern");
    expect(chart("what does this chart show?")?.body).toContain("# Drawing on the chart");
    expect(pickSkills({ question: "walk me through these earnings", url }, shipped).map((s) => s.name)).toEqual(["earnings-tables"]);
  });
  it("all fit in one prompt together, so none is silently dropped", () => {
    const shipped = loadSkills(SKILLS_DIR);
    const out = skillsPrompt(shipped);
    for (const s of shipped) expect(out, s.name).toContain(`## Skill: ${s.name}`);
  });
});
