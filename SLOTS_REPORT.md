# Slot holdout

Collected 2026-11-11T15:23:00.853Z. 16 pools, holdout starts 2026-11-11T07:28:00.000Z. Cost is 1% round trip plus the liquidity impact on a $25 paper trade. Stops fill at the bar low. Thresholds were not changed after this run.

| Slot | Holdout n | Pools | Net | Expectancy | 90% interval | Win rate | Drawdown | Train mean | Edge |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| meanrev | 33 | 9 | -$9.56 | -$0.29 | -$0.75 .. $0.21 | 60.6% | $9.53 | -$0.32 | no |
| breakout | 35 | 12 | -$13.99 | -$0.40 | -$0.82 .. $0.03 | 34.3% | $16.14 | -$0.43 | no |
| momentum | 42 | 11 | $21.28 | $0.51 | $0.02 .. $0.89 | 47.6% | $8.89 | -$0.43 | no |
| grid | 7 | 6 | -$0.28 | -$0.04 | -$0.40 .. $0.33 | 57.1% | $1.82 | -$0.35 | no |

No pre-declared slot cleared both windows after costs. Every slot stays in the exploration bucket at 1% of the bank until its own trades say otherwise.

momentum: the holdout lower bound was above zero (0.02 per trade) and the train mean was -0.43. The rule needs both windows, so this slot stays at exploration size.

A slot is an edge only when the holdout has at least 30 trades, at least 8 pools, and a 90% lower bound above zero, and the train also has at least 20 trades, a positive mean, and a lower bound above zero. Otherwise it is exploration size.
