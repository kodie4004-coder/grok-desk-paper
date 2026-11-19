# Changelog

## Unreleased

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
