# Live readiness

Grok Desk runs on paper money only. This page lists what has to be true
before any real money is used, and how the code is set up so that switching
is one reviewed change, not a rewrite.

**Status: paper only. Live trading is hard-disabled.**

## What exists now

| Piece | Where | What it does |
| --- | --- | --- |
| Trading mode | `engine/mode.js` | `MODES = paper \| live`. `LIVE_ENABLED` is a constant `false`. `tradingMode()` always returns `paper`; `resolveMode('live')` refuses with a reason. There is no setting, file, or network value that can change it. |
| Risk and limits | `engine/risk.js` | One `riskCheck()` for every size and stop rule: kill switch, paused bot, size caps ($0.50–$50 on screen; the runner always records $2), daily loss cap, max open. Used by the paper sim (`simulate`), the runner's guard on new paper lines (`guardNewOpens`), and the ticket. |
| Kill switch | Buy-ins & limits sheet, `data/settings.json` | `killSwitch: true` stops every new paper line, on the device and in the runner once the file is committed. It can only stop lines. |
| Pre-trade check | `engine/ticket.js` | `preTradeCheck()` sizes a Kalshi line (contracts = floor(stake / ask)), prices the taker fee (round up 0.07 × C × P × (1 − P)), and returns break-even, max win, max loss, after-fee EV and the risk result. `preTradeCoin()` does the same for coins (1.25% each way plus slippage). The same check sizes the trainer and the call-it card. |

What does **not** exist, on purpose:

- No order-placing function anywhere (no Kalshi order endpoint, no wallet, no
  signer). A test (`tests/r6.test.mjs`) fails the build if one appears in the
  app or engine.
- No keys in the repo, the app, the browser, or localStorage.
- No path from the browser to any exchange account.

## The checklist

Every item must be true, in this order. The Settings tab shows the same list
(`liveReadiness()` in `engine/mode.js`). It never reports "ready": the last
items need work outside this app.

1. **Forward paper proof, after fees.** At least **300** counted forward
   paper lines for the one bot being considered, after the real fees (Kalshi
   taker fee; coins 1.25% each way plus slippage), over at least **14 days**.
   Recorded at the $2 runner size. Backtests do not count.
2. **A real edge.** After-fee mean above $0 and the 90% lower bound above $0
   on those forward lines.
3. **The edge gate.** The bot passes the existing gate: every holdout window
   profitable, 3 or more windows. The gate is not loosened and nothing is
   retuned on holdout to get there.
4. **Kodie's explicit yes in chat**, naming the bot, the market, and the
   first size. A setting, a file, or an earlier general instruction is not a
   yes.
5. **Keys server-side only.** Exchange API keys live in a server-side secret
   store (for example a GitHub Actions secret used by a separate job, or a
   small server), never in this app, the repo, a browser, or a chat. The
   browser never holds a key and never sends an order.
6. **Small first size.** The first live step uses the smallest size the
   exchange allows (or about $1–$2 a line), with a hard daily loss cap and a
   max-open limit enforced server-side, plus the kill switch. Size only grows
   after more forward results, never after a loss.
7. **Order code in its own reviewed change.** Order placement is written,
   reviewed and tested in a separate pull request, behind `riskCheck()` and
   `preTradeCheck()`, with dry-run first. That change is where
   `LIVE_ENABLED` would stop being a constant `false`.

## Rules that do not change for live

- No loss-chasing: no "make it back", no size up after a loss.
- After-fee numbers only.
- The runner stays at $2 for the paper record; buy-ins on screen are a view.
- Size controls never feed strategy logic or gates.
