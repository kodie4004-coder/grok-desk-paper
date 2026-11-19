# Changelog

## Unreleased

- Every scanned coin shows its logo, name, ticker, and mint address, with copy and links to pump.fun, fomo, DexScreener, and Solscan. A tap opens the safety checklist. Controls and benched bots get no allocated paper. A variant with 30 allocated losses whose 90% upper bound is below zero goes to shadow.
- Tab changes, cards, the coin sheet, and the copy confirmation move with transform and opacity. Loading coins uses a shimmer. P&amp;L counts up only after the first number is on screen. Reduced motion turns the motion off. Icon and splash slots are ready for later artwork.
- First-run onboarding, a light theme, pull-to-refresh, an offline note, and a Pro screen that stores an optional email only on the phone. No payment is collected.
- A Coins tab lists Solana meme signals from DexScreener and GeckoTerminal. A paper buy shows the contract address, a copy button, and links to pump.fun, fomo, and DexScreener. The app does not hold a key or send an order.
- The snapshot journal runs scanner, analyst, brain, executor, and risk, and each writes a reason. A blocked signal stays in the journal so a lesson can say whether the filter saved or cost money. Scalp challengers can take profit, stop, or time-stop at the bid after a second fee. A losing series sits out the next two windows. Home shows the morning report and the heartbeat.
- A bot that loses $6 of its own allocated paper goes to shadow and keeps a log. The other bots keep trading. There is no desk-wide daily halt. One snapshot can open at most 8 allocated bets. Mean revert gained a challenger that skips asks under 0.40 after the 2026-11-19 journal. Lessons run from the snapshot chain once per UTC day, and the cron stays a backup.
- Paper bots keep an append-only journal from the Kalshi snapshot, a nightly lesson file, and challengers that can replace a champion only on a holdout they have not been judged on before. Losing variants can be benched. Size stays $2. The edge gate is unchanged.
- The Kalshi snapshot chain dispatches the next run unless another one is already active, and the job fails when that dispatch does not stick. A follow-up workflow restarts the chain if the dispatch was missed. The 15-minute cron stays a last resort.
- Paper cockpit on the home screen: live bets, today's after-fee P&L, level, streak, and the next window.
- Design tokens for color, type, spacing, radius, elevation, and motion. Tab and chip targets are at least 44px. Win and loss use an arrow as well as color. Motion respects `prefers-reduced-motion`.
- Paper history schema version 2, with JSON and CSV export and JSON import.
- CI runs the unit tests and a mobile Playwright smoke test.
- Arena, scalpers, maker quotes, and the Berkshire filing copy stay on the frozen gate. None are ready for real money.

## 2026-11-18

- Kalshi 15-minute board, K1, and the snapshot fallback because browser origins are refused.
- Active mode, separate from the edge gate.
