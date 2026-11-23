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

// ---------------------------------------------------------------------------
// fair-spot-v2. Written down 2026-11-22, before any replay of this rule, after
// an input audit of fair-spot. fair-spot's rule above is not edited.
//
// Bug found in fair-spot's inputs (basis): Kalshi's floorStrike is the 60-second
// average of CF Benchmarks' BRTI before the window opened, and settlement is the
// same average before close. fair-spot compares a Coinbase spot quote with that
// BRTI strike, so ln(S/K) carries the BRTI-vs-Coinbase basis. On 2026-11-22
// (08:30Z-14:00Z, 116 strikes and settlement values vs the matching Coinbase
// 1-minute candle) BRTI sat above Coinbase by a mean 1.3 bps (BTC), 2.9 bps
// (ETH) and 3.6 bps (SOL), up to 7 bps. With σ√T near 15-20 bps on a calm hour
// that is a 2¢-8¢ tilt toward NO, the same size as the 2¢ margin.
//
// Rules (fixed here; nothing below is searched on the journal or a holdout):
// 1. Same venue on both sides of the ratio. The anchor is the Coinbase price at
//    the window open: the mean of the closes of the 1-minute candles that start
//    120 s and 60 s before open (open = closeTime − 15 minutes). Both are needed.
//    fair = N(ln(S / anchor) / (σ √T)). K is used only as a sanity check: when
//    |ln(K / anchor)| > 20 bps the inputs disagree and the market is skipped.
// 2. S must be the Coinbase spot (pxSource 'Coinbase estimate') and the candles
//    must be 'Coinbase 1m'. A mixed OKX/Binance/Coinbase input is skipped.
// 3. T is measured from the time the spot was fetched (pxAt), not from the
//    Kalshi board time. T must still be 90 s or more.
// 4. σ is fair-spot's realizedSigmaPerMinute, unchanged.
// 5. Trade only when fair minus the ask clears the rounded taker fee plus a 3¢
//    margin (stricter than fair-spot's 2¢). $2 size. Weight pinned at 0.
// 6. addedAt is the merge time of this rule. No earlier row can promote it, and
//    it is not replayable from the journal (it needs pxSource and pxAt).
export const FAIR_V2_ADDED_AT = '2026-11-22T14:30:00.000Z';
export const FAIR_V2_MARGIN = 0.03;
export const FAIR_V2_MAX_BASIS = 0.002;
const WINDOW_MS = 15 * 60 * 1000;

export function openAnchor(closes, closeTime) {
  const close = Date.parse(closeTime || '');
  if (!Number.isFinite(close)) return null;
  const open = close - WINDOW_MS;
  const at = (t) => (closes || []).find((row) => Number(row.t) === t);
  const a = at(open - 120_000);
  const b = at(open - 60_000);
  const pa = Number(a?.px);
  const pb = Number(b?.px);
  if (!(pa > 0) || !(pb > 0)) return null;
  return (pa + pb) / 2;
}

// fair-spot-v2's yes probability for one market, before any edge check.
// Returns null when any input rule above fails. fairPickV2 and late-fair share it.
export function fairV2Prob(market, spots) {
  const base = FAIR_SERIES[market?.series];
  if (!base) return null;
  const spot = spots?.[base];
  if (!spot || spot.pxSource !== 'Coinbase estimate' || spot.source !== 'Coinbase 1m') return null;
  const px = Number(spot.px);
  const strike = Number(market?.floorStrike);
  const pxAt = Number(spot.pxAt);
  const close = Date.parse(market?.closeTime || '');
  if (!(px > 0) || !(strike > 0) || !Number.isFinite(pxAt) || !Number.isFinite(close)) return null;
  const secondsLeft = (close - pxAt) / 1000;
  if (!(secondsLeft >= FAIR_MIN_LEFT)) return null;
  const anchor = openAnchor(spot.closes, market.closeTime);
  if (!(anchor > 0)) return null;
  if (Math.abs(Math.log(strike / anchor)) > FAIR_V2_MAX_BASIS) return null;
  const now = Number.isFinite(spot.now) ? spot.now : pxAt;
  const sigma = realizedSigmaPerMinute(spot.closes || [], now);
  const fair = fairYes(px, anchor, sigma, secondsLeft);
  if (fair == null) return null;
  return { fair, sigma, anchor };
}

export function fairPickV2(market, spots) {
  const model = fairV2Prob(market, spots);
  if (!model) return null;
  const { fair, sigma, anchor } = model;
  const yes = Number(market.yesAsk);
  const no = Number(market.noAsk);
  const yesN = Math.floor(2 / yes);
  const noN = Math.floor(2 / no);
  if (yesN >= 1 && feeEdgeClears(fair, yes, yesN, FAIR_V2_MARGIN)) {
    return { side: 'yes', ask: yes, fair, sigma, pEst: fair, anchor };
  }
  if (noN >= 1 && feeEdgeClears(1 - fair, no, noN, FAIR_V2_MARGIN)) {
    return { side: 'no', ask: no, fair, sigma, pEst: 1 - fair, anchor };
  }
  return null;
}

// late-fair. Written down 2026-11-23, before any replay or forward row.
// Why: late-fee and scalp-fee priced their side with the quote mid. The mid is
// never above the ask, so mid - ask - fee - 1¢ is always below zero and they
// could not open a line (0 journal rows since 2026-11-20). fair-spot-v2 is the
// one model on the desk whose probabilities beat Kalshi's asks on Brier.
// Rule (fixed here; nothing is searched on the journal or a holdout):
// 1. The late-favorite pick, unchanged: the side with ask >= 0.85, 180 to 300 s left.
// 2. Only BTC, ETH and SOL, where fair-spot-v2's inputs exist (fairV2Prob).
// 3. Enter only when that model's probability for the picked side clears the ask
//    plus the rounded taker fee plus fair-spot-v2's 3¢ margin. $2 size.
// 4. Weight pinned at 0 until graduates() clears on its own forward rows.
//    addedAt is this rule's merge time, so no earlier row can promote it.
export const LATE_FAIR_ADDED_AT = '2026-11-23T14:30:00.000Z';
