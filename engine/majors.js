// Liquid-major rules from EVAL_PROTOCOL.md section v4. Hourly bars.

export const MAJOR_SYMBOLS = ['SOL', 'WSOL', 'WETH', 'ETH', 'WBTC', 'BTC', 'CBBTC'];
export const MAJOR_MIN_LIQ = 2_000_000;
export const MAJOR_FEE = 0.30;

export function isMajor(pool) {
  const sym = String(pool.symbol || '').toUpperCase();
  return MAJOR_SYMBOLS.includes(sym) && (pool.liq || 0) >= MAJOR_MIN_LIQ;
}

function lastAt(bars, t) {
  let lo = 0, hi = bars.length - 1, ans = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (bars[m].t <= t) { ans = m; lo = m + 1; }
    else hi = m - 1;
  }
  return ans;
}

function retSince(bars, i, ms, slack) {
  const back = lastAt(bars, bars[i].t - ms);
  if (back < 0 || !(bars[back].c > 0) || !(bars[i].c > 0)) return null;
  if (Math.abs(bars[back].t - (bars[i].t - ms)) > slack) return null;
  return (bars[i].c / bars[back].c - 1) * 100;
}

export function trendDayPlan(bars, i) {
  const r = retSince(bars, i, 24 * 3600000, 3 * 3600000);
  if (r == null || !(bars[i].v > 0)) return false;
  if (!(r >= 1 && r <= 8)) return false;
  return { enter: true, stopPct: 4, takeProfitPct: 1000, maxHoldMin: 24 * 60 };
}

export function quietRangePlan(bars, i) {
  const from = bars[i].t - 48 * 3600000;
  let hi = -Infinity, lo = Infinity, n = 0;
  for (let k = i; k >= 0 && bars[k].t >= from; k--) {
    hi = Math.max(hi, bars[k].h);
    lo = Math.min(lo, bars[k].l);
    n++;
  }
  if (n < 24 || !(hi > lo) || !(bars[i].c > 0)) return false;
  const mid = (hi + lo) / 2;
  const rangePct = ((hi - lo) / mid) * 100;
  if (!(rangePct < 6)) return false;
  const pos = (bars[i].c - lo) / (hi - lo);
  if (pos > 0.25) return false;
  const bounce = (mid / bars[i].c - 1) * 100;
  if (bounce < 1.5) return false;
  return { enter: true, stopPct: 3, takeProfitPct: bounce, maxHoldMin: 48 * 60 };
}

export function slowBreakPlan(bars, i) {
  const r = retSince(bars, i, 4 * 3600000, 2 * 3600000);
  if (r == null || !(r >= 0.5 && r <= 3)) return false;
  const vols = [];
  const from = bars[i].t - 24 * 3600000;
  for (let k = i - 1; k >= 0 && bars[k].t >= from; k--) vols.push(bars[k].v || 0);
  if (vols.length < 12) return false;
  const s = [...vols].sort((a, b) => a - b);
  const med = s[Math.floor(s.length / 2)];
  if (!(bars[i].v > med)) return false;
  return { enter: true, stopPct: 2, takeProfitPct: 3, maxHoldMin: 12 * 60 };
}

export const MAJOR_RULES = [
  { id: 'c1', label: 'Major trend, one day', plan: trendDayPlan },
  { id: 'c2', label: 'Major quiet range, two days', plan: quietRangePlan },
  { id: 'c3', label: 'Major slow breakout', plan: slowBreakPlan },
];
