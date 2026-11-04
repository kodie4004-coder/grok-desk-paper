# live_execution: DISABLED (not built)

This project is paper only. There is no wallet connection, no private key handling, no transaction
signing and no order-routing code anywhere in it. The `live_execution` switch in Settings is a
disabled placeholder.

## What going live would actually require (a separate project)

1. Wallet: a dedicated hot wallet holding only money you can lose, signing in a secure context
   (never a key in a browser tab, in localStorage, or in this repo).
2. Swap routing: Jupiter Swap API (quote -> swap transaction -> sign -> send), with slippage limits per trade.
3. Execution realities paper mode ignores: priority fees, failed/dropped transactions, MEV/sandwiching,
   fills far worse than the mid price on thin pools, tokens that can't be sold (honeypots, freeze authority).
4. Safety: hard daily loss cap enforced server-side, max position size, kill switch, an allow-list of
   what the bot may sign, and logs of every signature.
5. Evidence first: several weeks of paper results that stay positive after fees, checked with the
   calibration table, before any real money.

## Approval

Live trading must not be enabled without Kodie's separate, explicit approval for that specific step.
Nothing in this repo can do it on its own.
