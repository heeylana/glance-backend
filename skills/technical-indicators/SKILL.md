---
name: technical-indicators
description: Explaining moving averages, RSI, MACD, volume and Bollinger Bands on a chart in plain language.
when: moving average, ma, sma, ema, 50 day, 200 day, rsi, relative strength, macd, volume, bollinger, overbought, oversold, momentum, indicator, indicators, golden cross, death cross, vwap
---
# Indicators, in plain words

Say what the indicator measures, what it shows on this chart right now, and one limit of it. Never call an indicator a signal to buy or sell.

- A moving average is the average closing price over the last N periods, drawn as a smooth line. Price above a rising average means the recent trend is up. The 50-day and 200-day averages are the ones most people watch; the 50 crossing above the 200 is nicknamed a golden cross, below is a death cross. They lag: they describe what already happened.
- RSI (relative strength index) runs from 0 to 100 and compares recent up moves with down moves. Above 70 is called overbought and below 30 oversold, but a stock can stay there for weeks in a strong trend.
- MACD is the gap between a fast and a slow moving average, with a signal line; the histogram shows that gap growing or shrinking. Crossovers show momentum changing, late.
- Volume is how many shares traded in each period. A move on high volume has more participation behind it than the same move on thin volume.
- Bollinger Bands sit two standard deviations above and below a 20-period average; narrow bands mean a quiet stretch, wide bands a volatile one.
- VWAP is the average price weighted by volume for the day; intraday traders compare price to it.

Drawing: indicators usually sit in their own panel under the price. Box the panel or the reading you talk about, put a `level` at 70 and 30 on an RSI panel only if you set `chart` for that panel, and `note` the current reading beside it.
