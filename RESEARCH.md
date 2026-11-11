# How other trading bots actually work

Notes for this paper desk. Sources are public docs and write-ups, checked November 2026. Marketing pages are labeled as marketing. Nothing here is a claim that this desk has an edge.

## What has evidence, and what does not

| Idea | What is actually known | What is marketing |
|---|---|---|
| Dry-run before live, fees in the backtest, a fixed stake | Freqtrade's own docs require this. Fees are applied on the way in and the way out. Hyperopt can fit noise. | A backtest screenshot with no holdout |
| Market making is spread capture minus inventory losses | Hummingbot's pure market making quotes both sides and skews size when inventory drifts. The spread has to be wider than adverse selection or the inventory trend pays you to hold the wrong coin. | "Grid bots print every day" |
| Look-ahead bias is a real way to fake a backtest | Jesse's docs exist largely to stop higher-timeframe candles from leaking the future into the signal | Leaderboard PnL with no method |
| Solana snipers and copy bots are a latency contest | The leader buys first. Copiers buy after, at a worse price. Trojan's own docs say a copied sniper often makes you the exit liquidity. | "Smart money", "sub-500 ms", "1% fee and you're the house" |
| Prediction-market APIs are public reads | Polymarket's Gamma API serves markets with no key. That is data, not an edge. | Bots that "arb every Kalshi-Polymarket gap" without showing failed hedges |

This desk copies the process (separate strategies, fees, a holdout, a kill switch) and does not copy the advertised returns.

## Freqtrade, Hummingbot, Jesse

**Freqtrade** is the clearest open-source spot framework. A strategy implements indicators, entry, and exit. The backtester includes the exchange fee on both sides, and you can override it with `--fee` as a ratio applied twice. Dry-run is the supported way to see behavior without capital. Stake size is configured (`stake_amount`), and `max_open_trades` caps how many positions exist at once. Hyperopt searches parameters against history, which will overfit if you then judge it on that same history.

Sources: [Strategy customization](https://www.freqtrade.io/en/stable/strategy-customization/), [Backtesting](https://www.freqtrade.io/en/stable/backtesting/), [Bot basics](https://www.freqtrade.io/en/stable/bot-basics/).

**Hummingbot** pure market making places bids and asks around mid, refreshes them on a timer, and can skew the order size so inventory stays near a target base percentage. That is the opposite of a sniper: you want to get filled both ways, and you lose when price runs one direction and you are left holding the bag. A grid is the same shape with fixed rungs instead of a moving mid. It earns in a range and gives it back in a trend.

Sources: [Pure market making](https://hummingbot.org/strategies/v1-strategies/pure-market-making/), [Inventory skew](https://hummingbot.org/strategies/v1-strategies/strategy-configs/inventory-skew/).

**Jesse** treats a route as exchange + symbol + timeframe + strategy, and it spends extra work so a higher timeframe cannot see a candle that has not closed yet. Its backtest notes call out look-ahead bias and overfitting, and tell you to validate on a period you did not fit. Published example backtests (Donchian on 2019–2021 altcoins, for instance) are not evidence for meme coins in 2026.

Sources: [Routing and look-ahead](https://docs.jesse.trade/docs/routes.html), [Backtesting notes](https://deepwiki.com/jesse-ai/docs/7-backtesting).

What we took from this group: one function per strategy, fees on both sides, a position cap, no parameter search after seeing the holdout, and a range strategy only on pools that are actually ranging.

## Solana meme snipers and copy bots

Photon, Trojan, BullX, BonkBot, and GMGN are commercial terminals. Comparison articles describe them as fast manual or semi-automatic buyers of new Solana pools, often with a bot fee around 1% and a hot wallet the bot can sign. Those articles are reviews and affiliate-style roundups, not audited track records. Treat their latency tables as advertising.

Trojan's copy-trade documentation is more useful because it states the failure mode: you cannot usefully copy a sniper. The sniper buys in the first block. You buy the top of that candle. The sniper sells into you. It also refuses custom programs because a fake swap can bait copy bots. A separate 2026 explainer of Solana copy trading describes the same delay: the bot sees the leader's transaction only after it lands, then sends its own swap into the price the leader just moved.

Sources: [Trojan copy trade](https://docs.trojanonsolana.com/telegram-bot-user-guide/copy-trading-crypto), [Copy trading Solana wallets](https://solbotrank.com/guides/copy-trading-solana-wallets-explained), [Bot roundup (marketing)](https://screenerbot.io/blog/solana-trading-bots-compared-2026), [Safety notes](https://solbotrank.com/guides/are-solana-trading-bots-safe).

What we took: do not add a sniper and do not pretend copy-trading works on free data. This desk already cannot see wallet history. The new "momentum" slot is a slow, filtered version of "a new or hot pool that is not already extended", paper-sized as exploration unless the holdout says otherwise. It is not a same-block snipe.

## Grids and market making

A grid buys weakness and sells strength inside a band. Hummingbot's inventory skew is the professional version of the same idea: if you accumulate the coin, stop buying it. On a DEX the spread is the fee plus price impact, and a one-minute bar can jump the whole grid. So the paper grid here only arms when the last hour of bars is a tight range, the bounce to the middle of the range is at least 3% (enough to matter after a 1% round trip), and the pool is liquid. That is a hypothesis, not a result.

## Prediction markets

Polymarket's Gamma API lists markets with no API key. A request from this environment returned live markets and `access-control-allow-origin: *`, so a static page can read them. The docs still show `GET /markets`; the response we got also carried a deprecation warning pointing at `/markets/keyset`. We read and display. We do not trade them, because we have no historical tape and no holdout.

Kalshi's docs describe unauthenticated reads at `https://external-api.kalshi.com/trade-api/v2` and `https://api.elections.kalshi.com/trade-api/v2`. Both returned HTTP 403 from this network (CloudFront). The desk will try and, if refused, say so. It will not invent Kalshi prices.

Sources: [Polymarket public API](https://docs.polymarket.com/getting-started/api), [List markets](https://docs.polymarket.com/api-reference/markets/list-markets), [Kalshi market data](https://docs.kalshi.com/getting_started/quick_start_market_data).

## Data feeds and rate limits

DexScreener's reference puts pair, token, and search calls at 300 requests per minute, and token profiles, boosts, and orders at 60 per minute. There is no historical candle endpoint. Boost lists are paid promotion, so they are a discovery feed, not a reason to buy. Responses we checked sent `access-control-allow-origin: *`.

GeckoTerminal's API docs say the public API is about 10 calls per minute and can move with traffic. CoinGecko's keyless page says about 5 per minute for the same host. An older support article still says 30. We aim under the stricter current doc: one GeckoTerminal call on most scans, a gap of at least 7 seconds, and backoff on 429. Candles for the study still come from GeckoTerminal, slowly. DexScreener carries the frequent multi-chain scan (Solana, Ethereum, Base, BSC, and whatever else is in the boost list).

Jupiter's lite price API remains the Solana fallback when DexScreener has no price.

Sources: [DexScreener API reference](https://docs.dexscreener.com/api/reference), [GeckoTerminal API](https://api.geckoterminal.com/docs/index.html), [CoinGecko keyless limits](https://docs.coingecko.com/docs/keyless-public-api), [Older 30/min note](https://support.coingecko.com/articles/6867086195-does-geckoterminal-have-an-api).

## What this desk will and will not copy

Taken: separate strategy slots, a fixed small stake, fees and impact on every fill, stops filled at the worse price in the bar, a holdout that is not used to retune, a cap on open positions, and a per-slot stop when that slot's own trades are not making money.

Left behind: same-block sniping, copy-trading wallets, martingale, raising size after a loss, and any prediction-market order. Live execution stays off.
