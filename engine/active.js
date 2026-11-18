// Active mode is a separate exploration book. It does not feed the edge gate or graduation.
// Size is fixed. A loss never raises it. Thresholds here are for visible paper activity.
import { tradePnl } from './core.js';
import { takerFee } from './predict.js';

export const ACTIVE = Object.freeze({
  tickSec: 15,
  sizeUsd: 5,
  maxOpen: 12,
  dayLossUsd: 25,
  ruleGapMs: 3 * 60 * 1000,
  holdMin: 20,
  stopPct: 3,
  takeProfitPct: 4,
  feePct: 1,
  predictHoldMin: 30,
});

export const ACTIVE_COIN_RULES = ['meanrev', 'breakout', 'momentum', 'grid'];
export const ACTIVE_PREDICT_RULES = ['p1', 'p2', 'p3'];

const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);

export function activeSignals(pool) {
  const out = [];
  const liq = num(pool.liq) || 0;
  if (!(pool.priceUsd > 0) || liq < 15000) return out;
  const h1 = num(pool.pc?.h1);
  const m5 = num(pool.pc?.m5);
  const h6 = num(pool.pc?.h6);
  if (h1 != null && h1 <= -1.5 && h1 >= -30) out.push({ slot: 'meanrev', reason: `loose dip, 1h ${h1}%` });
  if (m5 != null && m5 >= 0.4 && (h1 == null || h1 <= 40)) out.push({ slot: 'breakout', reason: `loose push, 5m ${m5}%` });
  if (h1 != null && h1 >= -1 && h1 <= 40 && (h6 == null || h6 < 120)) out.push({ slot: 'momentum', reason: `loose trend, 1h ${h1}%` });
  if (h1 != null && Math.abs(h1) <= 8 && liq >= 50000) out.push({ slot: 'grid', reason: `loose range, 1h ${h1}%` });
  return out;
}

export function activePredictPicks(market, now) {
  const yes = num(market.price);
  if (!(yes > 0.02 && yes < 0.98)) return [];
  const hoursLeft = market.end ? (market.end - now) / 3600000 : null;
  const out = [];
  if (yes >= 0.55 && yes < 0.85) out.push({ rule: 'p1', side: 'yes', price: yes, reason: `loose favorite ${yes.toFixed(3)}` });
  if ((yes >= 0.03 && yes <= 0.22) || (yes >= 0.78 && yes <= 0.97)) {
    const side = yes <= 0.22 ? 'no' : 'yes';
    out.push({ rule: 'p2', side, price: side === 'yes' ? yes : +(1 - yes).toFixed(6), reason: `loose longshot fade, YES ${yes.toFixed(3)}` });
  }
  if (yes >= 0.55 && yes < 0.85 && hoursLeft != null && hoursLeft > 0 && hoursLeft <= 96) {
    out.push({ rule: 'p3', side: 'yes', price: yes, reason: `loose late favorite, ${Math.round(hoursLeft)}h left` });
  }
  return out;
}

export function dayKey(now) {
  return new Date(now).toISOString().slice(0, 10);
}

export function flatFee(sizeUsd, feePct) {
  return tradePnl({ entryMid: 1, exitMid: 1, sizeUsd, feePct }).fees;
}

export function predictRoundTrip(entry, exit, sizeUsd, rate) {
  const entryPx = Math.min(0.98, Math.max(0.02, entry));
  const exitPx = Math.min(0.98, Math.max(0.02, exit));
  const buyCost = entryPx + takerFee(entryPx, rate) + 0.005;
  const sellValue = Math.max(0, exitPx - takerFee(exitPx, rate) - 0.005);
  const shares = sizeUsd / buyCost;
  return {
    pnl: shares * sellValue - sizeUsd,
    fees: shares * ((buyCost - entryPx) + (exitPx - sellValue)),
  };
}

export function activePace() {
  const perHour = 60 / (ACTIVE.ruleGapMs / 60000);
  const rules = ACTIVE_COIN_RULES.length + ACTIVE_PREDICT_RULES.length;
  const steady = ACTIVE.maxOpen * (60 / ACTIVE.holdMin);
  return {
    tickSec: ACTIVE.tickSec,
    rules,
    uncappedPerHour: perHour * rules,
    steadyPerHour: steady,
  };
}
