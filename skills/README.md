# Glance skills

A skill teaches Glance how to explain something: a kind of chart, an indicator, a financial table, a site's layout. When a spoken question matches a skill, its instructions are added to the "show me" prompt (`POST /explain`), and the card shows "Using: …".

## Add one

1. Make a folder named after the skill, with a `SKILL.md` inside: `skills/options-chains/SKILL.md`.
2. Start the file with frontmatter, then write the instructions in Markdown:

```md
---
name: options-chains
description: Reading an options chain: strikes, expiries, calls and puts, open interest.
when: options, option chain, calls, puts, strike, expiry, open interest, implied volatility
sites: finance.yahoo.com, nasdaq.com
---
# Reading an options chain

Plain-language rules for explaining it, and what to draw (see candlestick-charts for the mark kinds).
```

- `name`: kebab-case, the folder name.
- `description`: one line; `GET /skills` lists it.
- `when`: comma-separated words and phrases. A match in the question counts most, in the page title less.
- `sites` (optional): hosts where the skill is preferred when it already matches.

### Sections that load only when asked

A long reference part (a table of patterns, a glossary) can carry its own trigger line right under its `# ` heading. The skill is still picked by any of its words, but that section is sent only when one of its own words is in the question or the page title:

```md
# Naming a pattern
when: pattern, flag, wedge, head and shoulders, engulfing

…the pattern catalogue…
```

Sections without a `when:` line are always sent with the skill. In `candlestick-charts`, "what does this chart show?" sends the reading and drawing sections (836 tokens) and "is this a bull flag?" adds the pattern catalogue (2,428 in all). Put words that are specific to the section there, not broad ones like "bullish", which would load it for questions about an analyst's view.

The backend picks at most three skills per question and reloads them when a file changes, so no restart is needed. Together the picked skills must fit 12,000 characters, or the lowest-scoring one is dropped without a word; `skills.test.ts` checks the shipped ones fit together, so run `pnpm test` after growing one. A skill without `when` is never picked. Every chart question pays for a skill's size in tokens (cheap when the prompt cache is warm, about 0.25¢ per 1,000 tokens when it isn't), so prefer lists to tables and leave out anything the model can't use on a page. A skill that fails to parse is skipped with a `skill skipped` line in the log. Keep instructions short and concrete: what to say, in what order, and what to draw. The base prompt already forbids advice and actions that spend or submit; a skill cannot lift those rules, and the extension enforces the click rules itself.
