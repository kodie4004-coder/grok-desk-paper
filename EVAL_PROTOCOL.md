# Evaluation protocol (frozen before the study run)

This file is the decision rule for `runner/walkforward.mjs`. Thresholds are not retuned after seeing results. A bugfix in the simulator (crash, lookahead, a bad fill) may be rerun; changing a threshold and rerunning is not allowed.

Paper only. The study does not authorize live trading.

## Question

Do any predeclared entry rules make money after a 1% round-trip cost and conservative stop fills, on a time holdout, relative to taking no trades?

## Data

- Source: GeckoTerminal public pool lists and 1-minute USD OHLCV. No key, no wallet, read-only.
- Universe at collection time: up to 22 trending Solana pools with liquidity at least $40k, plus up to 14 new pools with the same liquidity floor.
- Two pages of up to 1000 minute bars each. Empty minutes are whatever the API omits.
- Survivorship: pools that no longer exist at collection time are absent. That biases every active rule upward. A loss on this sample is stronger evidence than a gain.

## Costs and fills (primary)

- Bank $500, 5% per entry, at most 5 open positions, 120 minute max hold, stop 4% below the entry open, take-profit 12% above it.
- Round-trip cost 1%, split across the two fills the same way as `tradePnl` in `engine/core.js`.
- Signal on a bar close. Entry is the next bar's open, and only if that bar starts within 3 minutes.
- Stop and take-profit both touched in one bar: stop fills first.
- Conservative stop fill: the bar's low. Optimistic sensitivity (not used for the decision): the stop price.
- Take-profit fill: the target price. The optimistic sensitivity may fill at the close when the close is better, capped at the high.
- A trade that would still be open at the end of its window is dropped, not marked at the last price. That avoids the session-end exits that dominated the recorded 50-minute run.
- Same cutoff for every pool: last 8 hours of the newest bar in the file is the holdout. Earlier bars are the train window. Indicator lookback may use train bars; trades may not cross the cutoff.

## Rules (predeclared)

1. **no-trade** — net zero. This is the hurdle.
2. **random** — probability 0.01 per observed minute bar, seed `20261109`, pools in address order. Same exits.
3. **momentum** — 60-minute return from 0% to +25%, 360-minute return below +80%, bar volume greater than 0. Reference bars must sit within 3 minutes of the 60-minute mark and within 10 minutes of the 360-minute mark.
4. **momentum-vol** — momentum, and the high-low range of prints in the last 5 minutes is below `0.75 × stop` (3%). At least 3 prints in that window.
5. **buy-and-hold** — equal-weight the pools that have bars in the window, one round trip. This deploys the whole bank. It is a baseline, not a candidate for adoption. Survivorship hits it directly.

Active candidates for the verdict are random, momentum, and momentum-vol only.

## Statistics

- Expectancy is mean net dollars per trade the account actually took (cash and the 5-position cap can skip signals).
- Uncertainty is a cluster bootstrap: resample pools with replacement, keep their trades, 2000 times, seed 7, 5th and 95th percentiles (90% interval).
- Profit factor, win rate, fees, cost drag (fees / gross when gross is positive), and mark-to-market drawdown are reported and are not selection criteria.
- Sensitivity, reported and ignored by the decision: optimistic stops, and a 2% round-trip cost.

## Decision

Implemented in `judgeStudy` / `deskPriorFromStudy` in `engine/eval.js`.

A candidate **shows an edge** only if holdout trades ≥ 30, pools traded ≥ 8, and the bootstrap lower bound is above zero.

- Study verdict `edge` if any candidate shows an edge.
- Study verdict `inconclusive` if none shows an edge and some candidate has at least 30 trades with positive mean expectancy.
- Study verdict `no-edge` otherwise.

The live desk does **not** switch to whichever candle rule won. JUDGE's weights stay where they are. `RESEARCH_PRIOR.verdict`, which sizes live paper entries, is:

- `no-edge` when the study verdict is `no-edge` (default entries off),
- `inconclusive` when the study verdict is `inconclusive` or `edge` (half size until this desk's own closed trades clear the local bar).

An edge on a candle proxy is not treated as an edge for JUDGE. Full size happens only when this desk's own sample has at least 30 closed trades and the normal 80% lower bound of its expectancy is above zero. A non-positive local expectancy with that many trades turns entries off, including when exploratory mode is on. The scale is only 0, 0.5, or 1, and it never rises because a loss happened.

**Volatility gate adoption** (the only entry filter the study may turn on by default): holdout mean of momentum-vol is greater than holdout mean of momentum, holdout n ≥ 20, holdout pools ≥ 5, and the train mean of momentum-vol is at least the train mean of momentum.

## What ships regardless of the tables

These are not alpha claims:

- Open positions are repriced every 15 seconds (discovery stays on the slower scout cadence, because GeckoTerminal's free tier is about 30 calls a minute).
- The recorded session filled a 4% stop at about −10.6% on a 60 second poll. Faster marks shrink that window. The study's stop fill is harsher (bar low) than the live poll.
- Size/liquidity impact is added on top of the flat fee, capped at 3 percentage points.
- If the prior says no edge, the desk does not force trades.

## v2 slots (frozen before the multi-strategy run)

Four slots, defined in `engine/strategies.js`. Same fill rule as v1: signal on the close, enter the next open if it prints within 3 minutes, stop fills at the bar low, a trade that would still be open at the window edge is dropped. Round trip cost is 1% plus `roundTripImpactPct` on a $25 trade using the pool's liquidity snapshot. Holdout is the last 8 hours. Train is everything earlier. Parameters below are not searched.

- **meanrev.** Close at least 4% under the 30-minute average, and none of the last three bars fell 2% or more. Stop 4%, target 4%, hold 90 minutes.
- **breakout.** Close above the prior 20-minute high, and this bar's volume is at least 1.5× the median of those 20 bars. Stop 4%, target 8%, hold 120 minutes.
- **momentum.** Same 60-minute and 6-hour bounds as v1 (0–25% and under 80%). Stop 4%, target 12%, hold 120 minutes.
- **grid.** Last 60 minutes range between 3% and 8%, close in the bottom quarter, and the middle of the range is at least 3% above the close. Target that middle. Stop 3%. Hold 180 minutes.

A slot has an edge only if the holdout has at least 30 trades from at least 8 pools and the 90% bootstrap lower bound is above zero, and the train has at least 20 trades, a positive mean, and a lower bound above zero. Anything else is exploration size (1% of the bank). A slot whose own closed trades reach 15 with a non-positive expectancy turns off. Size never goes above the normal 5% paper stake, and a loss never raises it.

Live quotes use the snapshot cousins of these rules (1-hour and 5-minute changes, liquidity, volume). They are not a second fit. Prediction markets are displayed and not traded.

## What would falsify a cheerful reading

- Train looks good and holdout does not.
- The interval includes zero.
- The only live paper session (see `RESULTS.md`) is a handful of trades.
- Buy-and-hold of surviving pools is not evidence of a trading rule.
