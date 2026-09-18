---
name: candlestick-charts
description: Reading price charts (candlesticks, bars, lines), naming classic chart and candle patterns, and drawing levels, zones, trend lines and patterns on them.
when: chart, charts, candle, candles, candlestick, candlesticks, wick, support, resistance, trend, trendline, breakout, breakdown, range, consolidation, price action, higher highs, lower lows, gap
sites: tradingview.com, finance.yahoo.com, google.com/finance, investing.com, stockanalysis.com, birdeye.so
---
# Reading a price chart

Explain what the chart shows before what it might mean, in words a newcomer follows.

- A candle is one period (one day on a daily chart). The body runs from the open to the close; green or hollow means it closed higher than it opened, red or filled means lower. The thin wicks reach the high and the low of that period. Long upper wicks mean sellers pushed the price back down; long lower wicks mean buyers stepped in. A doji (open and close nearly equal) shows indecision.
- Say which period each candle covers, and the time span of the chart, from the date labels on the time axis.
- Support is a price the stock fell to and bounced from more than once; resistance is a price it rose to and turned back from more than once. Name the price and how many times it was tested.
- A trend is a run of higher highs and higher lows (up) or lower highs and lower lows (down). Draw the trend line through the swing lows of an uptrend, or the swing highs of a downtrend.
- A breakout is a close above resistance; a breakdown is a close below support. One candle poking through with a wick is not a close.

# Naming a pattern
when: pattern, patterns, double top, double bottom, triple top, triple bottom, head and shoulders, neckline, flag, pennant, wedge, triangle, rectangle, channel, rounding bottom, rounding top, saucer, wyckoff, island reversal, divergence, engulfing, harami, doji, piercing line, dark cloud, tweezer, three white soldiers, three black crows, abandoned baby, three methods, mat hold, three bar play, inside day

A pattern is a prior trend, a shape and a trigger. Without the trigger it is only forming.

1. Prior trend: up, down or sideways. A reversal needs a trend to reverse; a continuation needs one to continue.
2. Shape: match the lists below, the big shapes first, then candle patterns at a key level.
3. Trigger: a close beyond the neckline, trend line or range, not a wick. Until then, say it is forming.

Say the name, why the candles fit, whether it is confirmed or forming, and the price that would confirm it or cancel it. If two patterns fit, say so and name the price that decides. Patterns are shapes traders watch, not promises: say so once, and never make one a reason to buy or sell. The textbook measured move (the pattern's height projected from the break; for flags and pennants, the pole) can be mentioned as what chart readers project, not as a target. A breakout on rising volume is read as stronger. Candle patterns matter most at support or resistance and on longer timeframes.

Shapes, bullish name first, then its bearish mirror (the same picture upside down). R = reversal, C = continuation.
- Bull / bear flag (C): a steep pole, then a tight channel sloping against it; confirmed on a close out of the channel.
- Bull / bear pennant (C): a steep pole, then a small converging triangle; a close through its far line.
- Ascending / descending triangle (C): a flat line with rising lows (falling highs); a close through the flat line.
- Symmetrical triangle (C): lower highs and higher lows converging inside a trend; a break in the trend's direction.
- Bullish / bearish rectangle (C): sideways between flat support and resistance after a move; a close out of the range.
- Falling / rising wedge (R, sometimes C): both lines slope the same way and converge; a close through the line against the slope.
- Double bottom W / double top M (R): two lows (highs) near one price; the neckline is the peak (trough) between; a close through the neckline.
- Triple bottom / triple top (R): three lows (highs) near one price; a close through the neckline.
- Inverse head and shoulders / head and shoulders (R): three troughs (peaks), the middle one deepest (highest); the neckline joins the two in between; a close through it.
- Rounding bottom / top (R): a slow curved turn; a close through the rim.
- Wyckoff accumulation / distribution (R): a range after a long move, often with a false break the wrong way (a spring); a close out of the range the other way.
- Bullish / bearish divergence (R): price makes a lower low (higher high) while RSI or MACD does not; only a warning until price breaks structure.
- Island reversal (R): a gap, a cluster of candles, then a gap back the other way; the second gap has to hold.
- Ascending / descending channel (C): parallel rising (falling) highs and lows; a close through the far line ends it.
- Parabolic arc (R, bearish only): an ever-steeper curved rise; a break of the curve, usually sharp.

Candle patterns, number of candles, bullish first then the mirror.
- Engulfing, 2 (R): a small body, then an opposite body that fully covers it.
- Harami, 2 (R): a long candle, then a small opposite body inside its body.
- Piercing line / dark cloud cover, 2 (R): a long candle, then an opposite one opening beyond its end and closing past the middle of its body.
- Tweezer bottom / top, 2 (R): two neighbouring candles with matching lows (highs).
- Separating lines, 2 (C): in a trend, a counter candle, then one opening at the same open and running with the trend.
- Three white soldiers / three black crows, 3 (R): three long candles each closing further, after a move the other way.
- Abandoned baby, 3 (R): a long candle, a doji gapped beyond it, then a candle gapped back the other way.
- Three inside up / down, 3 (R): a harami, then a third candle closing beyond the second.
- Upside / downside gap three methods, 3 (C): two trend candles with a gap between, a third closing into the gap, then the trend resumes.
- Three bar play, 3 (C): a wide igniting candle, a small resting one near its end, then a candle breaking through it.
- Rising / falling three methods, 5 (C): a long candle, three small counter candles inside its range, then a long candle to a new close.
- Mat hold, 5 (C): like three methods, with a gap after the first candle and the small candles held above (below) its far end.
- Breakaway, 5 (R): a long candle, a gap, two more small candles the same way, then a long candle back into the gap.
- Inside day, 2 (neutral): a candle inside the previous one's range; what matters is which side it breaks.

# Drawing on the chart

The chart is usually a canvas or an image, so it has no elements inside it: draw in screenshot pixels, and pin the price axis first.

- Set `chart`: `plot` is the rectangle the candles sit in (not the axis labels), and `ticks` are two labelled prices on the price axis, far apart, each with the y pixel of the centre of its label. Every price you draw is placed from these two, so read them carefully; if a label is an element in the map, use its box.
- `level`: a horizontal line across the plot at `price` (support, resistance, a neckline, a recent high, today's price). Label it with `text` such as "support $170" or "neckline".
- `zone`: a band from `price` to `price2` across the plot, for an area rather than a single price.
- `trend`: a line through two swing points given in `points`; it is extended across the plot. Use two per triangle, wedge, flag or channel, each through two touches.
- `box` on a candle or a group of candles (a candle pattern, or a pattern's area), `note` at a point with `points` [the spot] for a pattern's name, and `arrow` with `points` [from, to] to point at one candle.
- Draw one idea per segment: first the levels, then the trend, then one pattern. Two or three marks on a chart is plenty.
- Never draw a level or zone as if it predicts where the price will go. Describe what has happened.
