---
name: classical-chart-patterns
description: Identify, classify, and explain classical chart and candlestick patterns (flags, wedges, triangles, double/triple tops and bottoms, head and shoulders, Wyckoff, engulfing, harami, three methods, island reversal, etc.) as bullish/bearish and reversal/continuation. Use whenever the user shares a price chart, screenshot, OHLC data, or describes price action; asks "what pattern is this", "is this bullish or bearish", "where's the breakout/entry/stop/target"; wants a pattern cheat sheet or quiz; or is coding a pattern detector or scanner — even if they never say "pattern".
---

# Classical Chart Patterns

Pattern = (prior trend) + (structure) + (trigger). No trigger, no signal.

## Workflow
1. **Prior trend**: up, down, or range. Reversals need a trend to reverse; continuations need one to continue.
2. **Match structure** in the tables. Multi-bar shapes first, then 1–5 candle formations at the key level.
3. **Check trigger**: close beyond neckline/trendline/range, not a wick. Unconfirmed = "forming".
4. **Report**: name · bias · R/C · confirmed or forming · trigger level · invalidation · target · confidence + what would change the read.

Defaults: target = pattern height projected from breakout (flags/pennants: pole length). Invalidation = close back inside the pattern / beyond its far side. Volume expanding on breakout strengthens; candle patterns matter most at support/resistance and on higher timeframes. If two patterns fit, say so and name the level that decides. Patterns are probabilistic — frame as education, not trade advice.

Legend: R = reversal, C = continuation. Structure is written for the bullish side; invert for the bear mirror. `*` = mirror not in source PDF, standard TA.

## Multi-bar shapes
| Bullish | Bear mirror | Type | Structure (bullish) | Trigger |
|---|---|---|---|---|
| Bull Flag | Bear Flag | C | Steep pole up, then tight down-sloping parallel channel | Close above channel top |
| Bull Pennant | Bear Pennant | C | Steep pole, then small converging triangle | Close above upper line |
| Ascending Triangle | Descending Triangle | C | Flat resistance, rising lows | Close above flat line |
| Symmetrical Triangle (up) | Symmetrical Triangle (down) | C | Lower highs + higher lows converging inside a trend | Break in prior trend direction |
| Bullish Rectangle | Bearish Rectangle* | C | Sideways between horizontal S/R after an advance | Close above range top |
| Falling Wedge | Rising Wedge | R (sometimes C) | Both lines slope down and converge, after a decline | Close above upper line |
| Double Bottom (W) | Double Top (M) | R | Two lows near same support; neckline = peak between | Close above neckline |
| Triple Bottom | Triple Top | R | Three lows near same level under a resistance neckline | Close above neckline |
| Inverse Head & Shoulders | Head & Shoulders | R | Three troughs, middle deepest; neckline joins the two peaks | Close above neckline |
| Rounding Bottom (saucer, U) | Rounding Top | R | Gradual curved shift from selling to buying | Close above neckline at U's rim |
| Wyckoff Accumulation | Wyckoff Distribution | R | Post-decline range where large players absorb supply; often a false break ("spring") below support | Close above range top |
| Bullish Divergence | Bearish Divergence* | R | Price lower low while RSI/MACD makes higher low | Price structure break; divergence alone is a warning |
| Bullish Island Reversal | Bearish Island Reversal | R | Gap down, candle cluster, gap up — island left isolated | The second gap holding |
| Ascending Channel* | Descending Channel | C | Parallel rising highs and lows | Trade with slope; close through the far line = reversal |
| — | Parabolic Arc (bear only) | R | Accelerating curved advance in ~3 steepening bases | Break of the curve; expect sharp unwind |

## Candle formations
| Bullish | Bear mirror | n | Type | Structure (bullish) |
|---|---|---|---|---|
| Bullish Engulfing | Bearish Engulfing | 2 | R | Small bearish body, then bullish body fully engulfing it |
| Bullish Harami | Bearish Harami* | 2 | R | Long bearish candle, then small bullish body inside its body |
| Piercing Line | Dark Cloud Cover* | 2 | R | Long bearish, then bullish opens lower and closes above 50% of prior body |
| Tweezer Bottom* | Tweezer Top | 2 | R | Two adjacent candles with matching lows (tops: matching highs) |
| Bullish Separating Line | Bearish Separating Line* | 2 | C | In uptrend: bearish candle, then bullish candle opening at the same open and running higher |
| Three White Soldiers | Three Black Crows | 3 | R | Three consecutive long bullish candles, each closing higher, after a decline |
| Abandoned Baby (bull) | Abandoned Baby (bear)* | 3 | R | Long bearish, doji gapped below, bullish gapped above the doji |
| Three Inside Up | Three Inside Down* | 3 | R | Long bearish, bullish closing ≥50% into it (harami), third closes above candle 2 |
| Upside Gap Three Methods | Downside Gap Three Methods | 3 | C | Two bullish candles with a gap between; third bearish closes into the gap; trend resumes |
| 3 Bar Play | 3 Bar Play (down) | 3 | C | Wide igniting candle, small resting candle near its extreme, breakout candle through it |
| Rising Three Methods | Falling Three Methods | 5 | C | Long bullish, three small bearish held within its range, long bullish to new closing high |
| Bullish Mat Hold | Bearish (inverted) Mat Hold | 5 | C | Long bullish, gap up, three small candles drifting down above candle 1's low, long bullish to new high |
| Bullish Breakaway | Bearish Breakaway | 5 | R | Long bearish, gap down, two more small lower candles, long bullish closing into the gap |
| Inside Day | Inside Day | 2 | neutral | Bar's high/low within prior bar's range; trade the break of the mother bar |

## Source errata (use the tables above, not the PDF)
- "Three Inside Up" text is labelled "three inside down"; it is the bullish version.
- Bear Pennant entry reuses the symmetrical-triangle text and engulfing image.
- "Bearish Wyckoff" describes accumulation; the bearish form is distribution (range after an advance, break below support).
- Double bottom "neckline" is the resistance between the lows, not the support under them.
- Bearish engulfing image shows bull-coloured second candle; the second candle is bearish.
- Source palette: green = bullish, blue = bearish.

## Coding detectors
Define each pattern as trend filter + geometric rule + trigger. Use swing pivots (N-bar fractals) for shapes; tolerance bands (e.g. ±0.5 ATR) for "same level"; body/range ratios for candles (long ≥ ~1.5× avg body, doji ≤ ~10% of range). Emit `forming` vs `confirmed` separately, and backtest — hit rates vary widely by market and timeframe.