# Walk-forward paper study

Collected 2026-11-09T05:09:15.504Z. Protocol `ohlcv-walkforward-v1` in `EVAL_PROTOCOL.md`, executed by `engine/eval.js`. Paper only. This is not a claim of live profitability.

Pools 23, minute bars 35717. Holdout starts 2026-11-08T21:12:00.000Z (last 8 hours before 2026-11-09T05:12:00.000Z). Primary cost: 1% round trip, conservative stop fills.

Study verdict: **no-edge**. Desk prior (what sizes live paper entries): **no-edge**. Volatility gate adopted: **no**.

## Holdout (unseen tail)

| Rule | Trades | Pools | Net | Expectancy | 90% interval | Profit factor | Win rate | Cost drag | Drawdown | Avg extra past stop |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| no-trade | 0 | 0 | $0.00 | $0.00 | $0.00 .. $0.00 | – | 0.0% | – | $0.00 | – |
| random | 30 | 17 | -$26.63 | -$0.89 | -$1.32 .. -$0.38 | 0.26 | 13.3% | – | $28.62 | 2.09% |
| momentum | 22 | 11 | -$18.29 | -$0.83 | -$1.19 .. -$0.38 | 0.33 | 22.7% | – | $21.53 | 2.10% |
| momentum-vol | 25 | 13 | -$8.15 | -$0.33 | -$0.63 .. $0.05 | 0.44 | 20.0% | – | $9.52 | 0.94% |
| buy-and-hold | 23 | 23 | $107562.32 | $4676.62 | $1.20 .. $14000.33 | 3629.99 | 34.8% | 1.0% | $69.74 | – |

## Train (earlier bars, same rules, not used to pick a winner)

| Rule | Trades | Pools | Net | Expectancy | 90% interval | Profit factor | Win rate | Cost drag | Drawdown | Avg extra past stop |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| no-trade | 0 | 0 | $0.00 | $0.00 | $0.00 .. $0.00 | – | 0.0% | – | $0.00 | – |
| random | 84 | 17 | -$36.70 | -$0.44 | -$0.68 .. -$0.24 | 0.39 | 16.7% | – | $39.36 | 1.91% |
| momentum | 78 | 14 | -$23.60 | -$0.30 | -$0.59 .. -$0.04 | 0.50 | 20.5% | – | $25.21 | 1.68% |
| momentum-vol | 113 | 16 | -$49.10 | -$0.43 | -$0.60 .. -$0.27 | 0.30 | 12.4% | – | $49.10 | 1.16% |
| buy-and-hold | 19 | 19 | $1164.82 | $61.31 | $0.43 .. $174.64 | 21.86 | 52.6% | 1.4% | $1063.39 | – |

## What the desk does with this

Default paper entries are off. On this holdout, random entries netted -$26.63 over 30 trades (90% interval -$1.32 to -$0.38 per trade) and the momentum rule netted -$18.29 over 22 trades (interval -$1.19 to -$0.38). No-trade netted $0.00. The desk's default is the no-trade number. That is a risk control, not a new entry formula.

The range filter was not turned on. Holdout mean -$0.33 versus momentum -$0.83; train mean -$0.43 versus momentum -$0.30. Adoption required the filter to be better on the holdout and no worse on the train. It was better on the holdout and worse on the train.

Stops in the conservative run fill at the bar low whenever the low is through the stop, so "gapped" is true by construction. The amount past the stop is the measurement: about 2.09% extra on random stops and 2.10% on momentum stops. The optimistic table fills those stops at the stop price. Random and momentum intervals stay below zero there too, so the loss is not only the harsh fill.

JUDGE weights were not changed. The candle rules are a proxy: free history has no holder counts, top-10 share, mint authority, or wallet paths, so the live gate cannot be replayed bar by bar.

## Sensitivity (not used for the decision)

Optimistic stops (fill at the stop price, not the low), same 1% cost, holdout:

| Rule | Trades | Pools | Net | Expectancy | 90% interval | Profit factor | Win rate | Cost drag | Drawdown | Avg extra past stop |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| random | 30 | 17 | -$16.47 | -$0.55 | -$0.89 .. -$0.14 | 0.37 | 13.3% | – | $18.67 | – |
| momentum | 22 | 11 | -$9.85 | -$0.45 | -$0.84 .. -$0.07 | 0.49 | 22.7% | – | $13.87 | – |
| momentum-vol | 25 | 13 | -$6.17 | -$0.25 | -$0.55 .. $0.14 | 0.53 | 20.0% | fees > gross | $8.07 | – |

Conservative stops, 2% round trip, holdout:

| Rule | Trades | Pools | Net | Expectancy | 90% interval | Profit factor | Win rate | Cost drag | Drawdown | Avg extra past stop |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| random | 30 | 17 | -$33.83 | -$1.13 | -$1.56 .. -$0.62 | 0.19 | 13.3% | – | $35.08 | 2.09% |
| momentum | 22 | 11 | -$23.58 | -$1.07 | -$1.43 .. -$0.63 | 0.24 | 22.7% | – | $25.30 | 2.10% |
| momentum-vol | 25 | 13 | -$14.29 | -$0.57 | -$0.87 .. -$0.20 | 0.28 | 12.0% | – | $14.29 | 0.94% |

## Buy-and-hold contributors (holdout, not a candidate)

Equal-weight dollar P&L is not a typical-pool result. Largest positions:

- XTruth Oil: $107257.07 (493382.5% on its slice, 99.7% of the buy-and-hold total)
- NVIDIH: $248.92 (1145.0% on its slice, 0.2% of the buy-and-hold total)
- BTC: $40.71 (187.3% on its slice, 0.0% of the buy-and-hold total)
- 牛逼: $25.91 (119.2% on its slice, 0.0% of the buy-and-hold total)
- 牛逼: $17.06 (78.5% on its slice, 0.0% of the buy-and-hold total)

## Limitations

- Survivorship: the universe is pools that still had a GeckoTerminal page when the collector ran, and that cleared a $40k liquidity snapshot taken at the end, not at each bar. Dead pools are missing. Results are biased toward looking better than a live scout would.
- One holdout slice, three active rules. The decision rule was frozen, but the sample is still one window of meme-coin time.
- Bootstrap resamples pools that traded. If only a few pools trade, the interval is too tight. The edge rule requires 8 pools for that reason.
- Buy-and-hold deploys the whole bank and is not an entry candidate. A single new pool whose first prints jump by orders of magnitude can dominate the dollar total. See the contributor list under the tables. Do not read that total as an edge.
- Live paper fills open positions at the polled price (every 15s when a position is open). This study fills stops at the minute low, which is worse. A live gain is not a study gain.
- The recorded 50-minute session (RESULTS.md) is a separate, smaller sample: 7 trades, net +$1.76, fees $1.78, one stop filled at −10.6% against a −4% level. It is not confirmation.
- No live trading, no wallet, no claim that the next session makes money.
