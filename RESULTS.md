# Results (real paper sessions only)

## Headless paper session, Nov 4 2026, recorded to replay/tape.json.gz

Default settings: $500 bank, 5% own size, -4% stop, +12% TP, 1% round-trip fees. The engine and data are live, and the money is fake. Session-end exits are marked at the last live price.

- Session Smw2onzao: 5:23 PM ET → 6:13 PM ET, 44 market checks, 1 gap(s) totalling 7 min while the box was suspended
- Bank $500 → equity $501.78 · closed trades 7 (3 green / 4 red) · open at end 0
- Realized after fees $1.76 · before fees $3.54 · fees/slippage $1.78
- Funnel: 18700 signals → 629 filtered → 60 judged → 10 JUDGE buys → 0 copied / 7 own → 3 risk-blocked → 7 closed
- Wallets followed at end: 0 · fired: 0 · data errors: 0 · halted: false
- What killed leads: action=pass p=# ×31; action=watch p=# ×7; action=buy p=# < # ×7; missing: top#, top# ×3; organic=yes p=# < # ×1; second watch ×1

| Trade | Source | Entry→exit | Exit reason | P&L after fees |
|---|---|---|---|---|
| AMD | own | 0.0007383 → 0.0006667 | STOP -4% | $-2.65 (-10.6%) |
| CHOO | own | 0.003326 → 0.003865 | TAKE PROFIT +12% | $3.76 (15.05%) |
| Dacity | own | 0.008915 → 0.009528 | SESSION END | $1.45 (5.81%) |
| GATO | own | 0.01061 → 0.01091 | SESSION END | $0.45 (1.8%) |
| STONK | own | 0.1277 → 0.1278 | SESSION END | $-0.23 (-0.92%) |
| SPX | own | 0.3886 → 0.3825 | SESSION END | $-0.64 (-2.55%) |
| TROLL | own | 0.02929 → 0.02914 | SESSION END | $-0.38 (-1.5%) |

| JUDGE buy p | Buys | Closed | Green |
|---|---|---|---|
| 0.70-0.79 | 3 | 3 | 0 |
| 0.80-0.89 | 4 | 4 | 3 |
| 0.90+ | 0 | 0 | 0 |

Passes logged: 43; checked after 24h: 0 (needs the desk running 24h later).

Copy path: 0 wallets met the follow rule (≥5 observed round trips etc.) in 50 minutes, so 0 copy trades happened. That's expected with free data; see README limits.

`node runner/replay-check.mjs` reproduces this recap exactly (net +$1.76, 7 trades), which shows the replay runs the same engine on the same data.

This is one 50-minute sample with 7 trades. It says nothing about whether the strategy has an edge.

## Walk-forward study, 9 Nov 2026 (not a live session)

`EVAL_REPORT.md` is the holdout test. It is not another paper session. Same costs as this desk's 1% round trip, stops filled at the minute low, rules frozen in `EVAL_PROTOCOL.md` before the run.

On the last 8 hours of 23 pools (35,717 minute bars), which the rules had not been fit to:

| Rule | Trades | Net on a $500 bank | Expectancy | 90% interval |
|---|---:|---:|---:|---|
| No trade | 0 | $0.00 | $0.00 | $0 to $0 |
| Random entries, same exits | 30 | -$26.63 | -$0.89 | -$1.32 to -$0.38 |
| Momentum (the candle proxy for "not late") | 22 | -$18.29 | -$0.83 | -$1.19 to -$0.38 |
| Momentum plus a 5-minute range filter | 25 | -$8.15 | -$0.33 | -$0.63 to +$0.05 |

The same ordering shows up on the earlier bars: random -$36.70, momentum -$23.60, range filter -$49.10. The range filter looked less bad on the holdout and worse on the train, so it was not turned on.

Filling stops at the stop price instead of the low still left the random and momentum intervals below zero. The recorded −10.6% stop is a real gap. It is not the whole reason these rules lose.

Buy-and-hold of the same survivor list prints a huge dollar gain. 99.7% of it is one new pool (`XTruth Oil`) going from its first tiny print to the last. That is not a trading rule and it is not in the verdict.

Verdict used by the desk: **no edge**. New paper entries stay off unless exploratory mode is turned on, and that mode is half size. JUDGE's weights were not changed. This does not prove the next live hour loses. It is evidence that forcing these entries, after costs, lost on data they were not tuned on, including an optimistic survivor sample.
