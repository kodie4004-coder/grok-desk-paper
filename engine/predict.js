// Paper prediction rules from EVAL_PROTOCOL.md section v4. No orders, no keys.

export function feeRate(market) {
  if (!market || market.feesEnabled === false) return 0;
  const rate = market.feeSchedule?.rate;
  if (typeof rate === 'number' && Number.isFinite(rate)) return rate;
  return 0.07;
}

// Taker fee per share. Makers pay nothing; these paper fills take.
export function takerFee(price, rate) {
  const p = Math.min(0.999, Math.max(0.001, price));
  return rate * p * (1 - p);
}

// Half-spread haircut is 0.005 per share. Hold to resolution, so one side only.
export function resolutionPnl(price, won, rate) {
  const cost = price + takerFee(price, rate) + 0.005;
  const payout = won ? 1 : 0;
  const pnl = payout - cost;
  return { cost, pnl, perDollar: cost > 0 ? pnl / cost : 0 };
}

export function favoriteEntry(yesPrice) {
  if (yesPrice >= 0.60 && yesPrice < 0.80) return { side: 'yes', price: yesPrice };
  if (yesPrice > 0.20 && yesPrice <= 0.40) return { side: 'no', price: +(1 - yesPrice).toFixed(6) };
  return null;
}

export function longshotFade(yesPrice) {
  if (yesPrice >= 0.85 && yesPrice <= 0.95) return { side: 'yes', price: yesPrice };
  if (yesPrice >= 0.05 && yesPrice <= 0.15) return { side: 'no', price: +(1 - yesPrice).toFixed(6) };
  return null;
}

export function yesWon(outcomePrices) {
  const raw = Array.isArray(outcomePrices) ? outcomePrices : JSON.parse(outcomePrices || '[]');
  const yes = Number(raw[0]);
  if (yes === 1) return true;
  if (yes === 0) return false;
  return null;
}

export function quoteInWindow(rule, now, end) {
  if (!(end > now) || !(now > 0)) return false;
  return now >= end - rule.lo && now <= end - rule.hi;
}

export const PREDICT_RULES = [
  { id: 'p1', label: 'Favorite, one week out', pick: favoriteEntry, lo: 8 * 86400000, hi: 6 * 86400000 },
  { id: 'p2', label: 'Longshot fade, one week out', pick: longshotFade, lo: 8 * 86400000, hi: 6 * 86400000 },
  { id: 'p3', label: 'Late favorite', pick: favoriteEntry, lo: 36 * 3600000, hi: 12 * 3600000 },
];
