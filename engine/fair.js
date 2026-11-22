// Spot-implied fair value for Kalshi 15-minute crypto binaries. Paper only.
// Rules were written down before any replay of this book. They are not searched
// on the held-back stretch. A backtest cannot graduate this challenger.

import { feeEdgeClears } from './kalshi.js';
import { normalCdf } from './upgrades.js';
// BTC, ETH and SOL only: the liquid 15-minute books with a free Coinbase (or
// OKX) one-minute candle. Other series are skipped.
export const FAIR_SERIES = Object.freeze({
  KXBTC15M: 'BTC',
  KXETH15M: 'ETH',
  KXSOL15M: 'SOL',
});

// Written down 2026-11-22, before the first fair-spot replay.
// Driftless digital (cash-or-nothing) fair value: N(ln(S/K) / (σ √T)), the
// short-horizon form in JS Financials (June 2026). σ is the standard deviation
// of 1-minute log returns over the last 60 minutes, needing at least 45
// consecutive-or-near-minute returns (gaps longer than 90 seconds are dropped,
// not filled). T is minutes left. No drift and no σ²/2 convexity term.
// Last 90 seconds are skipped because Kalshi settles on a 60-second average.
// First 3 minutes of the 15-minute window are skipped (maxLeft 720).
// Trade only when model probability minus the ask clears the rounded taker fee
// plus a 2¢ margin. The margin is a fat-tail buffer, not a search.
export const FAIR_ADDED_AT = '2026-11-22T08:45:00.000Z';
export const FAIR_MARGIN = 0.02;
export const FAIR_LOOKBACK_MS = 60 * 60 * 1000;
export const FAIR_MIN_RETURNS = 45;
export const FAIR_MAX_GAP_MS = 90 * 1000;
export const FAIR_MIN_LEFT = 90;
export const FAIR_MAX_LEFT = 720;

export function realizedSigmaPerMinute(closes, now) {
  const rows = (closes || [])
    .map((row) => ({ t: Number(row.t), px: Number(row.px) }))
    .filter((row) => row.px > 0 && Number.isFinite(row.t) && row.t + 60_000 <= now && now - row.t <= FAIR_LOOKBACK_MS)
    .sort((a, b) => a.t - b.t);
  const rets = [];
  for (let i = 1; i < rows.length; i += 1) {
    const dt = rows[i].t - rows[i - 1].t;
    if (dt <= 0 || dt > FAIR_MAX_GAP_MS) continue;
    const r = Math.log(rows[i].px / rows[i - 1].px);
    if (Number.isFinite(r)) rets.push(r);
  }
  if (rets.length < FAIR_MIN_RETURNS) return null;
  const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
  const varSum = rets.reduce((s, x) => s + (x - mean) ** 2, 0) / (rets.length - 1);
  const sigma = Math.sqrt(varSum);
  return sigma > 0 ? sigma : null;
}

// Driftless N(d2) with d2 = ln(S/K) / (σ_1min × √minutesLeft).
export function fairYes(spot, strike, sigmaMin, secondsLeft) {
  if (!(spot > 0) || !(strike > 0) || !(sigmaMin > 0) || !(secondsLeft > 0)) return null;
  const vol = sigmaMin * Math.sqrt(secondsLeft / 60);
  if (!(vol > 0)) return null;
  return normalCdf(Math.log(spot / strike) / vol);
}

export function fairPick(market, spots, secondsLeft) {
  const base = FAIR_SERIES[market?.series];
  if (!base) return null;
  const spot = spots?.[base];
  const px = Number(spot?.px);
  const strike = Number(market?.floorStrike);
  const now = Number.isFinite(spot?.now) ? spot.now : Date.parse(spot?.t || '') || null;
  const sigma = realizedSigmaPerMinute(spot?.closes || [], now ?? Date.now());
  const fair = fairYes(px, strike, sigma, secondsLeft);
  if (fair == null) return null;
  const yes = Number(market.yesAsk);
  const no = Number(market.noAsk);
  const yesN = Math.floor(2 / yes);
  const noN = Math.floor(2 / no);
  if (yesN >= 1 && feeEdgeClears(fair, yes, yesN, FAIR_MARGIN)) {
    return { side: 'yes', ask: yes, fair, sigma, pEst: fair };
  }
  if (noN >= 1 && feeEdgeClears(1 - fair, no, noN, FAIR_MARGIN)) {
    return { side: 'no', ask: no, fair, sigma, pEst: 1 - fair };
  }
  return null;
}
