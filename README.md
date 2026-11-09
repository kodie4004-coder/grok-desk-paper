# Grok Desk (paper)

A phone-first Solana memecoin trading desk that trades **fake money on live market data**.
It has no wallet, keys or order code, so it can't move real funds.

It copies the features shown in five X promo videos (@0xboan, @veyro_xbt, @nazik2053, @0xtenzo,
@0xnevsky). Those videos are motion-graphics mockups, and their returns ($100 → $7,533, etc.) are
not real results. This app copies the features and ignores the numbers.

## Open it

- Phone: open the GitHub Pages URL (if published) and use "Add to Home Screen".
- Local: `python3 -m http.server 8765` in this folder, then open http://localhost:8765.
- `?replay=1` starts the recorded replay. `?tab=agents` opens a tab directly.

## What is real vs simulated

| Part | Real or simulated |
|---|---|
| Market data (pools, prices, trades, holders) | **Real**: live public APIs. Discovery about every 60 s. Open positions reprice about every 15 s |
| Money, balance, positions, P&L | **Simulated** (paper). Fills use the live mid price ± your fee/slippage assumption |
| Fees/slippage | Assumed, 1% round trip by default, plus a size/liquidity impact capped at 3 percentage points. Real fills on thin pools can still be worse |
| JUDGE probabilities | Deterministic rule-based scores from real data. **Not calibrated**: that's what the calibration table is for |
| Wallet stats for copy trading | **Approximate**, built only from trades this desk has observed (see limits) |
| Replay | A recording of a real paper session's API responses, replayed through the same engine. Labelled REPLAY everywhere |
| Live execution | **Not built.** See `LIVE_EXECUTION.md` |

## Data sources (free, no keys, all send CORS headers)

- GeckoTerminal API v2: `new_pools`, `trending_pools`, `pools/{pool}/trades` (trades ≥ $20, with maker
  address), `tokens/{token}/info` (holder count, top-10 share, dev holding %, mint/freeze authority, honeypot flag).
  The free tier allows about 30 calls a minute, so the engine waits at least 3 s between calls and backs off on 429s (in browsers a 429 shows up as a CORS failure, so it is retried the same way).
- DexScreener `tokens/v1/solana/{addresses}` gives mark-to-market prices from the deepest pair.
- Jupiter `lite-api.jup.ag/price/v3` is the fallback price source.

## The six agents (one pass per tick)

1. **Scout** pulls new and trending Solana pools and pool trades. "Signals" = pools seen + new trades seen.
2. **Filter** drops pools with liquidity below $40k, no trades in the last 5 minutes (dead), or 1h volume below $5k (cold).
3. **Copy**: when 2+ followed wallets buy the same token within 10 minutes, it checks that top-10 holders are under 30%, that the price is up no more than 15% since the wallets' entry, and the LP status (unknown from free data, shown as "missing"). Size is 0.25× the wallets' average buy, capped at 8% of the bank. The position exits when a copied wallet sells.
4. **Own (JUDGE)** asks four closed questions per lead:
   - organic yes/no with p
   - late yes/no with p
   - exit_risk 1–5
   - action buy/watch/pass with p

   The gate buys only if action=buy p ≥ 0.70, organic=yes p ≥ 0.65, late=no and exit_risk ≤ 3. On watch, it re-asks once after 30 minutes, and a second watch is a pass. A missing field is written as "missing" and the lead is a pass. No answer is also a pass. Every verdict is logged with its lead id and the answer that killed it. Confidence never changes position size.
5. **Risk** sets the stop before the buy. It blocks entries when:
   - the position would exceed 8% of the bank
   - max open positions is reached
   - the token is already held
   - there isn't enough cash
   - the loss cap was hit
   - the edge gate is flat (the holdout study and this desk's own sample do not show a positive expectancy). Exploratory mode, off by default when the study says no edge, allows half size so a sample can be collected. Full size requires 30 closed trades whose 80% lower bound is above zero. The scale is only 0, ½, or 1. A loss never increases it. One lead's confidence never changes it.
   - the 5-minute trade range is at least ¾ of the stop, when that filter is on. It ships on only if the study's adoption rule says so. See `EVAL_PROTOCOL.md` and `EVAL_REPORT.md`.
6. **Banker** marks positions to the live price and exits on stop (−4%), take profit (+12%), the optional trailing exit, max hold time (120 min) or the copied wallet exiting. It then records the trade and applies the firing rule.

**Firing rule:** each copied loss adds a strike to the wallets behind it (0/2 → 1/2), and a win resets the count. Two losses in a row unfollows the wallet and shows an UNFOLLOWED card.

**Rules never loosen mid-session:** Settings are locked while a session runs, and the engine refuses changes too.

## No "make it back" mode, on purpose

One video's bot is told "if you lose my money, make it back." That's loss-chasing: bigger or looser bets after
losses, which is the fastest way to drain an account. This desk does the opposite. When realized session losses
reach the loss cap (10% of the bank by default), **new entries halt for the rest of the session** and the reason is shown.

## Calibration ("Sunday check")

The Agents tab groups JUDGE buys into p buckets (0.70–0.79, 0.80–0.89, 0.90+) and shows how many closed green.
It also logs every pass with its price and checks it 24 h later: "would this pass have been green after fees?"
The 24 h check only happens while the desk is running at that time.

## Headless runner (keeps going when the phone sleeps)

Browser tabs sleep, so the app only trades while it is open. The same engine runs headless with Node 18+:

```
node runner/headless.mjs --minutes 60 --out runner/state.json                          # paper session
node runner/headless.mjs --minutes 60 --out runner/session-state.json --tape replay/tape.json   # + record a replay tape
node runner/replay-check.mjs replay/tape.json                                           # replay in Node, prints the recap
node runner/collect-ohlcv.mjs                                                           # refresh the public minute-bar sample
node runner/walkforward.mjs                                                             # rerun the frozen study
```

The runner writes a JSON state file. The phone app doesn't read that file, because they are separate sessions.

## Tests

`npm test` (Node's built-in test runner, no dependencies) covers:
- the JUDGE gate: every threshold, missing → pass, no answer → pass, watch/second-watch
- fees
- stop, take-profit, trailing and time exits
- 8% position cap
- loss cap halt
- firing rule
- settings lock
- wallet stats and selection
- copy signal filters
- calibration buckets
- an end-to-end engine tick with a fake source
- strategy health, the edge gate (flat / half / full), the range gate, liquidity impact
- the walk-forward decision rule on synthetic bars, including a gapped stop filling at the low
- the recorded tape still replays to net +$1.76

## Known limits (read these)

- **No 30-day wallet history from free APIs.** Pool trades only cover recent trades in pools this desk looks at. The video's rules (55%+ win rate, 30+ trades in 30 days, average hold over 10 minutes, positive 30-day P&L) are applied to *observed* round trips instead, with the trade-count rule changed to "≥ 5 observed round trips". Early in a session, few or no wallets qualify, so Copy often shows 0. That's expected and honest. Getting real wallet history would need a paid indexer (Birdeye, Helius, etc.), which this build doesn't use.
- **LP lock/burn status isn't in the free data.** It's shown as "missing" and doesn't block, because the spec says "if known".
- **Holders now vs 1 hour ago** comes from the desk's own snapshots. GeckoTerminal refreshes holder counts slowly, so this is often "missing". It's an optional input.
- **Social/mention proxy** is weak: it only checks whether the token lists a Twitter, Telegram or website.
- **Fills** happen at the polled price. Open positions are checked about every 15 s, and discovery stays slower because GeckoTerminal's free tier is about 30 calls a minute. A −4% stop can still fill much lower if the price gaps between checks. The walk-forward study is harsher: it fills those stops at the minute bar's low. See `EVAL_REPORT.md`.
- **No demonstrated edge means no new trades.** Home shows expectancy, an 80% interval, profit factor, realized drawdown, sample size, and cost drag. If the study and the local sample don't support an entry, the desk stays flat instead of forcing trades. Turning on "Allow exploratory entries" is an explicit choice and still uses half size.
- **Rate limits:** if GeckoTerminal returns 429, the engine backs off and logs an ERR line. Two copies running at once from one IP share the limit.
- **Data and timing:** all data stays in this browser (IndexedDB), with no account and no sync. The app runs only while the page is open.
- The JUDGE weights are hand-set heuristics, not trained. Treat its p values as scores until the calibration table says otherwise.

## Results

See `RESULTS.md`, which has only numbers from sessions that actually ran.

Not financial advice. Paper only.
