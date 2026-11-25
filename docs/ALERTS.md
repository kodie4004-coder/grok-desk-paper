# Alerts

The bell in the header opens the alerts inbox and rules.

## What works now (in the app)

Rules are kept on this device (localStorage) and checked every 15 seconds
while Grok Desk is open:

| Rule | Fires when |
| --- | --- |
| Price level | BTC, ETH, SOL (Coinbase) or a watched coin (DexScreener) crosses above or below a level. Fires on the crossing, not on every check. |
| Window closing soon | The next BTC 15-minute window is within 1–10 minutes of locking. Once per window. |
| Bot flip | A bot's recent form flips to rising or fading. |
| New coin pick | A new coin pick scores at or above a minimum. |
| Daily recap | Once a day after a chosen hour: today's after-fee paper net at the recorded $2 size. |

Alerts land in the in-app inbox (last 100). If the browser allows
notifications, an alert also shows as a system notification while the app is
open but not in front. At most 12 alerts an hour. Alerts never place, size,
or block a bet.

## What would need the NTFY workflow edit (not done)

Push with the app closed or the phone asleep cannot come from the browser.
It would need:

1. The rules saved to a committed file (for example `data/alert-rules.json`,
   written with the same download-and-commit flow as `data/settings.json`;
   there is no browser write path to GitHub).
2. A runner step that reads that file each run and evaluates the same rules
   with `evaluateAlerts()` from `engine/user-alerts.js`.
3. A workflow edit so that step runs with the `NTFY_TOPIC` secret and posts
   to ntfy. The push token used for this repo has no `workflow` scope, so
   `.github/workflows/*` was not changed. The topic stays a secret and is
   never printed or committed.
