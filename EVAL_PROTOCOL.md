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

## v3 windows (frozen before any new slice)

The v2 holdout is already seen. It ran from 2026-11-11T07:28:00.000Z to the collection at 2026-11-11T15:23:00.853Z. That interval is reported again only as a reference. It cannot graduate a slot.

New minute bars are cut into non-overlapping 8-hour blocks, newest block ending at the last bar. A block that overlaps the seen interval is labeled seen. Every other block is unseen. Costs and fills stay as in v2: 1% round trip plus snapshot liquidity impact, stop at the bar low, entry on the next open within 3 minutes, incomplete trades dropped.

Diagnostics, not candidates. These tables can explain the momentum sign flip. They cannot change a size:

- Chain (solana, base, eth, bsc, arbitrum).
- Snapshot liquidity buckets: under $100k, $100k–$500k, $500k and above.
- Pool age at the signal: under 6 hours, 6 hours and older. Missing `createdAt` is its own row.
- Clock: 13:00–21:00 UTC versus the other hours. One split, not a search over hours.

Candidates, the whole family. Nothing else may be added after the tables are computed.

- **V0.** The four v2 slots, unchanged.
- **V1. Liquidity floor.** Momentum entries only on pools whose snapshot liquidity is at least $100,000. Same exits as momentum. Snapshot liquidity is not the liquidity at the bar. That bias is a reason to distrust V1, not a reason to ignore a loss.
- **V2. Not a new pool.** Momentum entries only when `createdAt` is known and the pool is at least 6 hours old at the signal bar. Pools with no `createdAt` are skipped.
- **V3. Tighter momentum.** 60-minute return from 5% to 15%, 6-hour return still under 80%. Same stop, target, and hold as momentum. Fewer trades on purpose.
- **V4. Trail.** Momentum entries unchanged. No fixed +12% target. After the high has reached +6% from the entry open, sell when price falls 4% from the peak since entry, filling at the lower of that trail and the bar low. Until then, the −4% stop and the 120-minute time stop still apply.

Graduation. A candidate graduates only if at least three unseen blocks each have 20 or more trades, and in every one of those blocks the mean expectancy is positive and the 90% bootstrap lower bound is above zero. One good block is not enough. V0 slots use the same rule, separately from v2's single holdout. A graduate may use the normal 5% paper size. Every other slot stays at 1%. No size is raised because a window was red. If none graduate, the live rules do not change.

## v4 prediction markets and liquid majors (frozen before testing)

The v2 and v3 coin windows are already seen for the four meme slots. They are not reused to pass those slots. The rules below are new. Their parameters are not searched. A rule graduates only if at least three non-overlapping windows each have 20 or more trades, a positive mean, and a 90% bootstrap lower bound above zero. Otherwise it stays at 1% of the paper bank. A loss never raises size. `live_execution` stays off.

### Prediction markets

Motivation, not a result: sports and horse-racing prices have a favorite-longshot bias, where longshots win less often than their price and favorites win more often (Snowberg and Wolfers, Journal of Political Economy, 2010, https://www.jstor.org/stable/10.1086/656518). That is not evidence it exists on Polymarket. These tests ask that question. Polymarket taker fees are `C × rate × p × (1 − p)` with category rates, makers pay zero, and geopolitics is fee-free (https://docs.polymarket.com/trading/fees). Kalshi's July 2026 taker fee is `round up(0.07 × C × P × (1 − P))` (https://kalshi.com/docs/kalshi-fee-schedule.pdf). Manifold mana cannot be cashed out (https://docs.manifold.markets/faq), so Manifold is not a USD strategy.

Data:

- Polymarket Gamma for resolved binary markets. Resolution is the final outcome-price pair `["1","0"]` (YES) or `["0","1"]` (NO).
- End is the UMA resolution time when one is published, otherwise the scheduled end. The public trade list for a busy market does not page back to the window, so the entry is the last CLOB prices-history point inside the window. If that window has no point, the market is skipped. The price after the window is not used except the resolution.
- Kalshi's public API returned HTTP 403 from this network. The cross-venue rule is registered and is not tested unless that API answers. An untested rule cannot graduate.
- Manifold is shown as play-money context. It cannot graduate a USD size.

Costs, taker, no rebate:

- Fee rate is the market's published `feeSchedule.rate` when fees are enabled. If fees are enabled and the rate is missing, use 0.07. If fees are disabled, use 0.
- Add 0.005 per share as a half-spread haircut. The history point is a sampled price, not a free lift of the book.
- Hold to resolution. Payout is 1 or 0. Expectancy is profit per $1 of entry cost.

- **P1 Favorite, one week out.** Window is 8 days to 6 days before the end. Buy the side priced in `[0.60, 0.80)`. YES in that band buys YES. YES in `(0.20, 0.40]` buys NO.
- **P2 Longshot fade, one week out.** Same window. Buy YES if YES is in `[0.85, 0.95]`. Buy NO if YES is in `[0.05, 0.15]`.
- **P3 Late favorite.** Window is 36 hours to 12 hours before the end. Same favorite band as P1.
- **P4 Cross-venue.** If Kalshi and Polymarket both quote the same question and the YES prices differ by more than both taker fees plus 0.02, buy the cheaper YES and hold to resolution. Not run if Kalshi does not answer.

Windows are ISO weeks of the market end time. The family is P1–P3, plus P4 only if it can be run. No other band is added after the table exists. The sample is the 120 highest-volume resolved binary markets Gamma returns with an end date on or after 2026-01-01. There is no other volume cutoff.

### Liquid majors

Hypothesis: the meme slots lose because a 1% round trip is large next to a short move. Deep majors cost less, and a hold of hours to days gives the move room. This is a hypothesis.

Universe: base symbol is one of SOL, WSOL, WETH, ETH, WBTC, BTC, cbBTC, CBBTC, and snapshot liquidity is at least $2,000,000. Hourly bars. Entry on the next hour's open. Stop fills at the bar low. At most one entry per pool per 24 hours.

Primary cost, chosen now: 0.30% round trip plus the same liquidity impact used elsewhere. A 1% stress is reported and cannot graduate a rule. 0.30% is two 0.15% AMM-style sides, not a number picked after seeing profits.

- **C1 Trend, one day.** 24-hour close-to-close return from +1% to +8%. No take-profit. Stop −4%. Hold 24 hours, then exit at the close.
- **C2 Quiet range, two days.** Last 48 hours' high-low range is under 6% of the mid, the close is in the bottom quarter, and the mid is at least 1.5% above the close. Target the mid. Stop −3%. Hold up to 48 hours.
- **C3 Slow breakout, half a day.** 4-hour return from +0.5% to +3%, and this hour's volume is above the median of the prior 24 hours. Stop −2%. Target +3%. Hold up to 12 hours.

Windows are non-overlapping 7-day blocks. Same graduation rule. Live majors use the 24-hour price-change field as the stand-in for C1's close-to-close return, the same 0.30% cost, and exploration size unless that rule graduated.

## v5 Kalshi 15-minute late favorite (frozen before testing)

This rule is K1. It is not Polymarket P3 and it is not the cross-venue rule. Active mode is still not a study. Parameters below are fixed before the backfill runs.

The browser cannot read `api.elections.kalshi.com`: a request with a page Origin is HTTP 403, and a browser User-Agent with no Origin returns `access-control-allow-origin: https://kalshi.com` only. The desk shows a same-origin snapshot. The backfill below is collected from this environment with a browser User-Agent and no Origin, which returns 200.

Sample, frozen now:

- Series, and only these: KXBTC15M, KXETH15M, KXSOL15M, KXXRP15M, KXDOGE15M, KXBNB15M, KXHYPE15M, KXZEC15M, KXNEAR15M, KXGOLD15M, KXSILVER15M, KXPLATINUM15M, KXPALLADIUM15M, KXCOPPER15M, KXWTI15M, KXBRENT15M, KXNATGAS15M, KXEURUSD15M, KXGBPUSD15M, KXUSDJPY15M, KXUSDCAD15M, KXAUDUSD15M, KXCRYPTOLEAD15M.
- Settled markets with `close_time` on or after 2026-11-15T00:00:00Z, at most the 200 most recent per series.
- Price is the 1-minute candle whose end is closest to 4 minutes before `close_time`. That end must sit inside the window from 5 minutes before close to 3 minutes before close. If no such candle exists, the market is skipped.
- YES ask is that candle's `yes_ask.close_dollars`. NO ask is one minus that candle's `yes_bid.close_dollars`. Both quotes must be strictly between 0 and 1.

K1 buys the favorite at its ask when that ask is at least 0.85. If both asks are at least 0.85, or neither is, there is no trade. Hold to the published `result`. Settlement pays 1 or 0 per contract and charges no second fee. Contracts are `floor(5 / ask)`, and a trade needs at least one contract.

Fee, taker, from the Kalshi fee schedule effective 7 July 2026 (`fees = round up(0.07 × C × P × (1 − P))`, https://kalshi.com/docs/kalshi-fee-schedule.pdf). This paper account is not a direct member, so the fee is rounded up to the next $0.01, which matches the schedule's one-contract column and the non-direct balance grid (https://docs.kalshi.com/getting_started/fee_rounding).

Windows are UTC days of `close_time`. A day graduates only with at least 20 trades, a positive mean, and a 90% cluster-bootstrap lower bound above zero, clustered by series. K1 graduates only if at least three such days all clear. Otherwise it stays at the fixed $5. The bootstrap is not retuned.

Controls, same candle, not K1, and they cannot graduate: always buy YES at the YES ask; a coin-flip side is YES when the first byte of the ticker's character codes sums even, otherwise NO, bought at that side's ask.

Live K1 uses the same favorite cut and the same fee. It may bet only when the snapshot is at most 120 seconds old and time left is between 180 and 300 seconds. One bet per ticker.

## v6 arena, scalpers, maker, and filings (frozen before testing)

These rules are new. They are not K1 and they are not the meme-coin slots. Live arena bets are exploration at a fixed $2. They do not enter the edge book. A rule graduates only from the backtest below. Live execution stays off either way.

Graduation, except the filings rule: at least three non-overlapping windows, each with 20 or more trades, a positive mean after costs, and a 90% cluster-bootstrap lower bound above zero. Otherwise the Ready panel says not ready.

Costs chosen now:

- Crypto uses the US Coinbase Advanced intro taker fee, 0.90% of notional on the way in and 0.90% on the way out, effective 16 September 2026 (https://help.coinbase.com/en/coinbase/trading-and-funding/advanced-trade/advanced-trade-fees). A new account is not assumed to have a volume discount. Each fill also pays 1 basis point for the spread.
- Kalshi taker fees stay the July 2026 formula rounded up to the next cent. A maker entry on a standard series pays no fee and no rebate. The exit, if it lifts the bid, pays the taker fee.
- Stock copies pay no commission and 5 basis points per side. That spread was chosen before the results.

### S1 Crypto micro-momentum

BTC-USD, ETH-USD, and SOL-USD, one-minute Coinbase candles from 2026-11-17T00:00:00Z. A signal needs the three-minute return in [0.20%, 1.00%] and each of the last three closes at or above the prior close. Enter the next minute's open. Stop 0.30%. Take-profit 0.45%. Hold at most 5 minutes. If stop and target print in one bar, the stop fills. One position per product, then a 5-minute cooldown. Windows are 12-hour blocks.

### S2 Crypto mean-reversion to VWAP

Same bars and costs. The VWAP is the last 30 minutes of typical price, weighted by volume. Enter when the close is 0.40% to 1.50% under that VWAP and the target back to VWAP is at least 0.30%. Stop 0.50%. Hold at most 15 minutes. Same windows.

### S3 Book imbalance

Coinbase's public level-2 book is live only. This sample has no historical book, so S3 cannot graduate. A live paper quote may still be shown and labeled as exploration.

### S4 Kalshi intra-window scalp

Series KXBTC15M, KXETH15M, and KXSOL15M. Settled markets with close_time on or after 2026-11-17T00:00:00Z, at most 40 per series. Buy YES at the ask when the ask is at least 4 cents above the ask two minutes earlier and the spread is 3 cents or less. Sell at the bid when the bid is at least 3 cents above the entry ask, or when the bid is 4 cents under it, or on the candle that ends two minutes before the close. Two taker fees. Size is $2. Windows are UTC days.

### S5 Maker, quote the spread

Same Kalshi sample. One attempt per market, on the candle nearest eight minutes before the close and inside six to ten minutes before it. The paper bid is that candle's YES bid. It fills only if the next candle's low trade price is at or below that bid. The exit sells at the next candle's YES bid and pays the taker fee. No maker rebate. This is the adverse-selection rule. It is not a claim that quoting is profitable.

### F1 Berkshire 13F

CIK 0001067983. The four 13F-HR filings dated 2026-02-17, 2026-05-15, 2026-08-14, and 2026-11-16. Entry is the close on the filing date, or the next session if that date is closed. Never the quarter's report date. Duplicate CUSIPs are summed. Only common stock. A name is used only when it matches one SEC company-ticker title after stripping punctuation and the suffixes INC, CORP, CO, LTD, PLC, SA, and AG. The 25 largest by reported value. Each is a $100 paper position. Exit on the next filing date, and the last filing exits on the latest close. Benchmarks are SPY and QQQ over the same dates and the same 5 basis point sides. A window is one filing, not a day. It still needs 20 matched names, a positive mean, and a lower bound above zero, and three filings must clear.

### F2 Congressional disclosures

The House annual disclosure index has member filings, not periodic trades. The periodic-transaction zip for 2025 returned HTTP 404. Senate eFD is an HTML search, not a trade file. F2 is registered and is not tested. It cannot graduate.

### What the live arena is allowed to do

The phone may paper-trade these ideas at $2 between snapshots, including a Coinbase spot estimate versus a Kalshi strike. Those fills are exploration. They are not added to the windows above. Binance returned HTTP 451 from this network. Bybit returned HTTP 403. OKX's ticker allows this page's origin, and it is only a backup estimate if Coinbase fails. Yahoo daily bars are end-of-day and are used for F1, not for a stock scalp.

## Active mode is not a study

Active mode loosens live thresholds so the phone shows paper trades, skips, and exits. Those fills live in their own book, labeled Active (exploration), at a fixed $5. They are not added to slot books, the edge book, or this protocol's graduation rule. A busy Active feed is not evidence of an edge.

## v7 paper learning loop (frozen before any journal settlement)

The phone journal in `data/journal.jsonl` is append-only and is written by the snapshot job, not by a threshold search. These paper variants are fixed before that file has any settlements:

- Late favorite stays ask at least 0.85 with 180 to 300 seconds left. Challengers are ask 0.80 in that same window, ask 0.90 with 180 to 360 seconds, and ask 0.85 with 300 to 480 seconds.
- Momentum vs target stays any side of the strike with 120 to 600 seconds left. The challenger requires the spot to be at least 0.05% past the strike. This is not a change to the S1 crypto study.
- Mean revert stays YES ask 0.15 to 0.40 or 0.60 to 0.85, with 360 to 720 seconds left. The wider challenger is 0.10 to 0.45 or 0.55 to 0.90. After the 2026-11-19 journal, a third challenger skips any buy whose ask is under 0.40. That day described the loss. It is not allowed to promote the new challenger.
- The scalp stays a 4 cent ask jump and a spread of 3 cents or less. The challenger requires a 6 cent jump and a 2 cent spread.
- The coin-flip control is not promoted and is not benched.

A finished UTC day is the holdout once, then it becomes train. A challenger replaces the champion only when both have at least 20 holdout trades and the challenger's mean after fees is positive and higher. Weights and the permanent bench use train days only. A variant with 20 train trades, a mean that is not positive, and a 90% lower bound that is not positive is benched. Separately, a bot whose own allocated paper is down $6 in a UTC day goes to shadow: it keeps a log and gets $0 of new bets, and the other bots keep trading. There is no desk-wide daily halt. A snapshot may open at most 8 allocated bets and 16 lines. One variant still bets a market at most once. A shadow bot returns only when a later finished train day, not the holdout, has at least 8 trades and a positive mean. Size stays $2. The v6 gate in `graduates()` is unchanged. Clearing it still does not enable `live_execution`.

## v8 paper roles (frozen before testing these rules)

These rules were written down before any run that uses them. They do not change the v6 gate or the holdout rule. Size stays $2. `live_execution` stays off.

The snapshot journal passes each candidate through five roles. Each role writes a reason:

- Scanner keeps a market only when it has no result yet and the close is still in the future.
- Analyst scores the frozen variant. No match means there was no signal.
- Brain allocates $2 or $0. $0 is a shadow. The size never rises.
- Executor fills a paper bet at the ask and charges the Kalshi taker fee. A veto is not a fill.
- Risk can block any entry and can exit an open scalp. It blocks a spread wider than 0.10. It blocks the same series for the next 2 windows of 15 minutes after an allocated loss. It blocks a new allocated line once the snapshot has 8 allocated bets or 16 lines that are not control or shadow logs. A coin-flip control and a bot already in shadow are still logged, and those logs do not spend either cap. A blocked signal is still journaled as a skip and settled later, so a lesson can say whether the filter saved or cost money. The bet-cap skip is only the allocated pick that arrived after the 8 bets were open.

Scalp exits are challengers. They use the champion's entry, a 4 cent ask jump and a spread of 3 cents or less. They sell at the bid and pay a second taker fee:

- Take-profit when the bid is at least 3 cents above the entry ask.
- Stop when the bid is at least 4 cents below the entry ask.
- Time-stop when 120 seconds have passed and a bid exists.
- The champion scalp still holds to the Kalshi result.

A loss does not raise size. The next two 15-minute windows of that series take no new allocated bet.

## v9 meme signals (frozen before a live pass)

Solana meme coins come from DexScreener's public boost list and pair data, plus newer Solana mints from DexScreener profiles and GeckoTerminal's new-pool list. The scan keeps every boosted mint that fits and reserves up to 8 spots for those newer mints, capped at 24 so the public RPC stays small. pump.fun's API is not used when it answers with a challenge.

Mint authority and freeze authority are read from the mint account (`getMultipleAccounts`, jsonParsed). Null means the authority is off. A pubkey means it is on, and the coin fails. Top 10 holder share is the sum of the ten largest token accounts (`getTokenLargestAccounts`) divided by the mint supply. That supply is the same amount `getTokenSupply` returns, so the snapshot does not make a second call for it. The pool vault is left out when its token-account owner is the pair address, or when the account address is the pair address. If that owner is missing, one account is left out only when it matches the pair's token reserve within 3% and no second account is that close. If the vault cannot be identified it stays in the top 10, which can only make the share higher. Holder calls are paced at about one every 700ms so a public rate limit does not fail the rest of the list. The lookup stops at its time budget instead of holding the snapshot chain.

A lookup that times out, is rate limited, or returns no mint fails that check. The screen names the failure. It is not a pass. The public endpoint that answers `getTokenLargestAccounts` is tried first. The official mainnet endpoint is the fallback. It currently refuses that method with HTTP 429 even on a first call. GeckoTerminal's token info is not the source for these three checks: the old snapshot asked it for at most four coins, and its holder share can stay stale for hours after a pool migrates.

A coin is a paper buy only when every check below is true:

- Liquidity at least $20,000.
- 24 hour volume at least $5,000.
- Pair age at least 30 minutes and at most 14 days.
- Quote asset is SOL, WSOL, USDC, or USDT.
- Top 10 holders are 40% or less. Missing holder data is a fail.
- Mint authority is off. Missing is a fail.
- Freeze authority is off. Missing is a fail.
- One hour move is between -80% and +400% when the field exists.
- Fully diluted value over liquidity is at most 50 when both exist. Missing does not block.
- Dev wallet share is unknown. It does not count as a pass and it does not block the coin. GeckoTerminal's developer percentage can sit for hours after migration, and walking the mint's signatures back to the creator would stall the snapshot. No free source here is current enough to use as a bar.

The paper fill is $2. The buy price is marked up 1% and the sell price is marked down 1%. Each side pays 1.25%, the public pump.fun early-trade fee. A flat price is a loss. Exits are a 15% stop, a 25% take-profit, or 30 minutes, using the next observed price. The position does not get larger after a loss. These trades are their own journal. They use the same `graduates()` gate and do not change it. The app never holds a key, connects a wallet, or sends an order. The person copies the contract address and buys in their own pump.fun or fomo account.

## v10 allocation (frozen before the replay)

These rules do not change `graduates()` or the holdout. A loss does not raise size.

- A control, including the coin-flip, is shadow forever. It is logged and never allocated.
- A variant already in the shadow or benched list gets $0 on every new entry. The flag is applied after every other decision, so a weight or a cap cannot turn it back on. That $0 line does not spend the snapshot's allocated-bet cap.
- A variant whose own allocated paper is down $6 on the current UTC day goes to shadow.
- A variant whose last 30 allocated trades have a negative mean and a 90% upper bound below zero goes to shadow. The line is logged.
- It returns only when the last 30 non-skipped shadow practice trades opened after that bench have a positive mean. Vetoed skips are not those trades. A finished day already cleared by that test is not put back into shadow. The holdout is not used for this.
- If a variant has at least 8 shadow trades, a new allocated entry is vetoed when their mean after fees does not exceed this contract's taker fee plus half the spread in dollars. The veto is journaled as a skip.
- Allocation weight is the 90% lower bound in dollars divided by $0.50, capped at 1 and floored at 0. With fewer than 8 allocated trades the weight is 0.25. If that variant's allocated paper is down today, the weight is not raised above the previous weight.

## v11 fast stops, resting orders, and the settlement average (frozen before the shadow numbers)

These three checks do not change `graduates()`, the v6 edge gate, the holdout rule, or the $2 size. `live_execution` stays off. A challenger is promoted only by the v7 rule already in `reviewBrain`: both sides need at least 20 holdout trades, and the challenger's after-fee mean has to be positive and higher. A short sample cannot do that. Parameters below were written before the candle replay was scored.

### Fast meme stops

The meme rule is unchanged: exit at 15% down, 25% up, or 30 minutes, on a $2 paper fill. The snapshot job was the only checker, so a stop could fill well past 15%. A separate public-repo Actions pass reads open paper positions and asks DexScreener every 4 seconds, one batched call for the whole book, while a position is open. That is about 15 calls a minute. The pairs limit is 300 a minute. It sells when the observed price crosses the stop or the target, and it records that fill as `watch`. It does not open coins and it does not change the stop. If two jobs exit the same coin, the earlier fill is kept. The before sample is every stop without `watch`. The after sample is stops with `watch`. An empty after sample is reported as empty.

### Resting maker

Family `maker`, variant `rest-maker`, role challenger. Crypto 15-minute series only. With 120 to 600 seconds left, if the yes spread is from 1 cent to 10 cents, rest a yes bid at the current bid. Fee on that resting order is zero. The paper order joins last in the queue at that price. A later trade that only touches the bid fills someone ahead of us and is not our fill. We fill only when a later trade prints strictly below the bid, or the ask drops strictly below it. The fill price is still the bid. There is no assumed price improvement. If the market resolves with no such cross, the order is not a trade and it is left out of the maker mean. The taker comparison buys the same candle's ask, pays `0.07 × C × P × (1 − P)` rounded up to the next cent, and holds to the same result. On the stored 1-minute candles the attempt is the bar closest to five minutes before the close, inside two to ten minutes. Unfilled attempts stay in the taker mean and stay out of the maker mean. A first pass that counted a touch as a fill is not the rule. It filled 119 of 120 and was replaced by this stricter fill before any weight changed.

### Settlement average

Variant `mom-settle`, family `mom`, role challenger. Same 120 to 600 second window as momentum. Kalshi settles the 60-second average of the index before the close against the average before the open. The open average in this paper book is the published strike. The close average is estimated from the trailing 60 seconds of public Coinbase trades, or OKX trades when Coinbase has fewer than two prints in that minute. One last tick is not the input. Before the final minute, the expected settlement level is that trailing average. Inside the final minute, the part already printed is locked. The probability uses a normal curve whose one-minute scale is 0.05%, the same gap already frozen for mom-strict. It is not estimated from this sample. The challenger buys a side only when its fair value clears the ask by the unrounded taker fee `0.07 × P × (1 − P)`. A missing average is no trade. It does not replace momentum unless the v7 holdout says so.

## v12 Jev meme check (frozen before any Jev shadow number)

This does not change `graduates()`, the v6 edge gate, the holdout rule, the meme safety bars, or the $2 size. `live_execution` stays off. The variant id is `jev-check`. It is a shadow challenger. It does not open a trade and it does not block one.

The snapshot asks TypeSafe System One, `POST https://api.typesafe.ai/v1/systemone`, model id `jev-1.14.0`, only for a coin the baseline meme filter already passed. The state is the name, ticker, description, websites, and social links. Price, size, and the contract address are not sent. One request asks three yes/no questions (linked X account plausibly the real project, copycat or impersonation, obvious rug flag in the description) and one choice whose only answers are `pass`, `flag`, and `unknown`. The stored verdict is that choice. A yes/no probability is not a second cutoff. A response that is not that shape is `unknown` and is not cached. Each contract address is asked at most once, except the one-time re-ask in v14. A run asks at most 20 new coins, retries a transport failure once, and stops after 35 seconds. A missing `TYPESAFE_API_KEY` asks nothing. The key is an environment variable on the meme snapshot step and is not written to the log or the repo.

On the settled paper trades that carry a verdict, the baseline mean keeps every trade. The veto mean drops `flag` and keeps `unknown`. Both means are after the meme fee and slippage already on the row. Weight is 0 unless `graduates()` is true on the veto book's day windows, using the same 90% lower bound the bot gate already uses. Clearing that gate still does not place or block a trade. The day the verdicts were first logged cannot be used to retune the questions.

## v13 early-entry shadow (frozen before any early-entry trade)

This does not change `graduates()`, the v6 edge gate, the holdout rule, the v9 meme safety bars, or the $2 size. `live_execution` stays off. The variant id is `early-entry`. It is a shadow challenger. Weight is 0 unless `graduates()` is true on its own day windows. Weight does not allocate a trade and does not turn the safety sleeve back on.

The safety sleeve stays in repair once it has logged a shadow trade, until 20 of those shadow trades have a positive after-fee mean. An early-entry shadow is a different book and does not count toward that repair. A loss does not raise size.

Discovery runs inside the meme snapshot, which the Kalshi chain already starts. It does not add a cron. GitHub cron cannot run faster than every 5 minutes, and the 5-minute meme kick has been dropped before, so that cron is not the detection path. A coin waits for the next chain pass. On the 377 committed boards through 2026-11-20 the gap between boards had a median of 3.8 minutes.

Sources, each optional. A failure is logged and the others are kept:

- DexScreener `token-boosts/latest/v1` and `token-profiles/latest/v1`. Both answered JSON from this environment.
- DexScreener `latest/dex/pairs/solana`. This returned HTTP 404. It is still requested and ignored when it is not JSON.
- GeckoTerminal `networks/solana/new_pools`. It answered JSON, including `pool_created_at` and reserve.
- pump.fun `frontend-api-v3.pump.fun/coins/latest`. It returned a Cloudflare challenge, HTTP 403, with no key. The scan continues without it.

Hard kills, in order, before any soft pass:

- Mint authority is not revoked, or the lookup is missing.
- Freeze authority is not revoked, or the lookup is missing.
- RugCheck's public summary (`/v1/tokens/{mint}/report/summary`) reports `lpLockedPct` under 50. At or above 90 is locked. A missing value, or a value from 50 up to but not including 90, is not known and does not kill. The 90 line is the summary field on a pool whose own market report said 100% locked and whose summary printed 93.7.
- Top 10 holders are over 40%, the same bar as v9. Missing is a kill.
- Liquidity is under $1,000 or missing. The v9 floor stays $20,000. This sleeve is the book for pools that floor does not take.
- The modeled $2 round trip does not clear the existing 25% take-profit. Slippage is the larger of the flat 1% and the constant-product impact `2 × $2 / liquidity`, plus the 1.25% fee on each side. The existing `memeTargetClearsFees()` check still applies.

A coin at least 30 minutes old is a pass, not an entry. The v9 rule already owns that window. A coin under 60 minutes whose 1 hour change is already 3× or more is a pass: chase, not early. That multiple is not a search. A hard kill still wins over the chase pass.

The same Jev check runs on coins that would enter, after the baseline coins, on the same cache. The run still asks at most 20 new coins. A flag does not block the shadow entry.

The paper fill is $2. The stop, the 25% take-profit, and the 30 minute time stop are the v9 rules. The stop watcher prices the position with the slip stored at entry. The row is `allocated: false`. These trades use `graduates()` and do not change it. The day they are first logged cannot retune the thresholds. The age audit in `data/early-audit.json` was measured before this sleeve and was not used to pick the numbers above.

The fast scan runs these same frozen checks. It does not change a threshold, `graduates()`, the $2 size, or the edge gate. One Actions job loops about every 60 seconds for 5 hours 50 minutes. A new run is scheduled every 6 hours, and the Kalshi chain starts one with `workflow_dispatch` when none is running. One concurrency group allows a single run and does not cancel the run that is already going. The board and the log are committed at most every 5 minutes, with the same rebase retry as the snapshot. DexScreener, GeckoTerminal, and RugCheck back off on 429. Jev keeps the 20-call run cap, the cache, and a UTC-day cap of 100 calls shared with the snapshot. A phone push fires only when the hard kills and the RugCheck check pass and the Jev verdict is not `flag`. The push says the signal has not passed the edge gate. The topic is an Actions secret. It is not written to the site or the log. A missing secret sends nothing.

## v14 Jev context and early exit shadows (frozen before the new shadow numbers)

This does not change `graduates()`, the v6 edge gate, the holdout rule, the v9 meme safety bars, the v13 early hard kills, or the $2 size. `live_execution` stays off. New books stay at weight 0. `graduates()` is not applied to the exit variants.

The Jev state now also includes age, liquidity, a RugCheck summary, public X profile facts, and similar names and tickers from the current meme and early boards. Price, size, and the contract address are still not sent. The choice verdict still has a confidence from 0 to 1. RugCheck's public summary often omits mint, freeze, and top holders, so the summary in the prompt is built from `GET /v1/tokens/{mint}/report`. The X facts come from `syndication.twitter.com` with no API key: followers, account age, and bio. If that page does not parse, the profile is left out and the ask still happens. An address cached as `unknown` with no `context-v2` prompt is asked once more. That re-ask counts toward the same 20-call cap. A `pass` or a `flag` is not asked again. An `unknown` stored with `context-v2` is not asked again.

The 30 minute time stop is applied on the 4 second watcher, not only when the snapshot sees the coin on the safety board. Early coins were missing from that board, so a flat position never aged out, the four open slots stayed full, and later enter lines were logged without a position. The snapshot also prices an open mint that is not on the board before it runs the same rule.

Three exit books use the same early entries and the same stored slip. They were written down before any of their results:

- `early-exit-fast`: the 15% stop and the 25% take-profit, with a 10 minute time stop.
- `early-exit-half`: sell half of the $2 only when the print is at least 12% above entry and that half's after-fee P&L is positive. The other half trails 15% off the peak after the half sale. If the half never clears, the whole $2 uses the 15% stop or the 30 minute time stop.
- `early-exit-trail`: sell the $2 when the print is 15% off the highest price the 4 second watcher has seen. The 15% figure is the existing stop distance. A 30 minute time stop still closes a trail that never ratchets down.

If the baseline position hits its 25% take-profit while a trail is still open, a paper shell keeps that mint on the watcher until the shadow book closes. The shell does not take an early-entry slot and it is not an allocated trade. Weight on all three books stays 0.

## v15 fee-aware challengers (frozen before any fee-aware trade)

This does not change `graduates()`, the v6 edge gate, the holdout rule, the loss cap, or the $2 size. `live_execution` stays off. A challenger is promoted only by the v7 rule already in `reviewBrain`: both sides need at least 20 holdout trades, and the challenger's after-fee mean has to be positive and higher. Rows from the added day or earlier are not that sample.

The journal had already described late favorites and intra-window scalps losing after fees. That description picked the question. It did not pick the margin below.

Variants, role challenger, same entry window as the champion in that family:

- `late-fee`. Ask at least 0.85, 180 to 300 seconds left. Same favorite rule as `late`.
- `scalp-fee`. A 4 cent ask jump and a spread of 3 cents or less, with more than 120 seconds left. Same entry as `scalp`. It holds to the result. It does not take the scalp exit challengers.

Neither bot publishes a win probability. The 0.85 cut is a price filter. The 4 cent jump is a price change. The proxy, chosen before any trade from these variants, is the quote mid of the side being bought. YES uses `(yes bid + yes ask) / 2`. NO uses one minus that mid. A missing bid, a bid outside (0, 1), or a bid above the ask is no estimate and no trade. The mid was not fit to past win rates.

Entry also requires `p − ask > feePerContract + 0.01`. `feePerContract` is `kalshiTakerFee(ask, contracts) / contracts` with `contracts = floor(2 / ask)`. The fee is the July 2026 Kalshi taker schedule, `round up(0.07 × C × P × (1 − P))` to the next cent (https://kalshi.com/docs/kalshi-fee-schedule.pdf), the same function already in `engine/kalshi.js`. The margin is 0.01, one cent per contract, because that is the unit the fee rounds to. A smaller margin would treat rounding dust as an edge. It is not a search. The v4 half-spread haircut of 0.005 is a different cost and is not reused here.

On a normal book the YES mid is at or below the YES ask, so a YES buy does not clear a positive fee. `scalp-fee` buys YES only, so it stands aside on a normal book. `late-fee` can buy NO when the YES mid says that NO ask is cheap by more than the fee plus one cent. Standing aside is the rule, not a missing implementation.

`addedAt` is `2026-11-20T23:20:00.000Z`, stored on the variant. A holdout day on or before 2026-11-20 cannot promote either variant. The same days cannot bench them. A later finished day uses the existing holdout gate. The edge gate is not part of that promotion.

## v16 offline backtest, scalp-95, and the focus bench (frozen before the out-of-sample replay)

This does not change `graduates()`, the v6 edge gate, the holdout rule, the loss cap, or the $2 size. `live_execution` stays off.

**A backtest never graduates a strategy.** It never sets a weight, promotes a champion, or counts toward `graduates()`. Only forward paper rows in `data/journal.jsonl` (or the meme journal) that pass `graduates()` can move a weight. `engine/backtest.js` does not import `graduates`, and `pinCleared()` reads only journal rows after the variant's added UTC day.

Backtester (`engine/backtest.js`, `runner/backtest.mjs`, `npm run backtest`):

- Tape: every committed version of `data/kalshi-15m.json` in git history (`npm run backtest-tape` rebuilds `data/backtest-tape.json`). Open markets become quotes. Settled markets, plus journal rows with a yes/no result, give the result map.
- Rules: the live `signal()` from `engine/learn.js`, with the previous board's quote for the same ticker as `prev`, exactly as `stepJournal` does. One line per variant per ticker, at the first board where the rule fires. The live risk spread veto (0.10) applies. The cooldown applies only to allocated losses, so it does not apply to a $0 replay line.
- Fills: buy at the recorded ask, `floor(2 / ask)` contracts, taker fee `round up(0.07 × C × P × (1 − P))` from `kalshiTakerFee`, maker fee 0. Hold to the result. A scalp exit variant sells at the recorded bid through `roles.shouldExit` and `roles.settleExit`, paying a second taker fee. A line whose market never shows a result is counted as unresolved and is not a trade.
- Rules that need spot prints (momentum, the 60-second settlement bot) or trade prints (the resting maker) cannot be replayed from the board. They are reported from their recorded forward journal rows and labelled `recorded`.
- Stats: n, after-fee mean, win rate, break-even win rate (ask plus fee per contract, held lines only), and a 90% cluster bootstrap by Kalshi series (2,000 draws, seed 7). Out-of-sample is the most recent 30% of the tape's time span. It is never used to choose a parameter. The runner prints out-of-sample numbers only with `--oos`.

`scalp-95` (role challenger, family `scalp95`, `pinZero`): buy the side whose ask is above 0.95 and below 1, with 300 to 600 seconds left in the 15-minute window, $2, held to the result. The parameters come from the focus plan, not from a search. `addedAt` is `2026-11-21T07:10:00.000Z`, committed before the out-of-sample replay was run. Its weight is 0 and it logs as a shadow line until `graduates()` clears on its own forward rows after 2026-11-21.

Focus bench (`engine/focus-plan.js`): a book with at least 40 settled forward rows whose 90% cluster-bootstrap upper bound of the after-fee mean is below zero opens no new paper line. Its history stays in the journal and on the page. Open lines still settle. Controls are not benched. `node runner/backtest.mjs --bench` prints the rule on the current journal. The frozen list is in `FOCUS_BENCHED` with the evidence at registration. Early exit books still close their legs so the parent position can finish, but write no new row.

## What would falsify a cheerful reading

- Train looks good and holdout does not.
- The interval includes zero.
- The only live paper session (see `RESULTS.md`) is a handful of trades.
- Buy-and-hold of surviving pools is not evidence of a trading rule.
