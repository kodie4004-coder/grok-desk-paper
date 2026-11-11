// Pre-declared paper strategies. Thresholds are not retuned after a holdout.
// See EVAL_PROTOCOL.md section "v2 slots" and RESEARCH.md.
import { strategyHealth } from './core.js';

export const SLOT_IDS = ['meanrev', 'breakout', 'momentum', 'grid'];

export const SLOT_SPEC = Object.freeze({
  meanrev: {
    label: 'Mean reversion',
    blurb: 'Buy a liquid dip of 4% under the 30-minute average. Target +4%. Stop −4%.',
    stopPct: 4, takeProfitPct: 4, maxHoldMin: 90, dipPct: 4, lookback: 30,
  },
  breakout: {
    label: 'Breakout',
    blurb: 'Buy a close through the prior 20-minute high if volume is 1.5× the recent median. Target +8%. Stop −4%.',
    stopPct: 4, takeProfitPct: 8, maxHoldMin: 120, lookback: 20, volMult: 1.5,
  },
  momentum: {
    label: 'Momentum',
    blurb: 'The previous study rule: 60-minute return 0–25% and 6-hour return under 80%. Target +12%. Stop −4%.',
    stopPct: 4, takeProfitPct: 12, maxHoldMin: 120,
    ret60Lo: 0, ret60Hi: 25, ret360Hi: 80,
  },
  grid: {
    label: 'Grid / range',
    blurb: 'Only in a tight range. Buy the bottom quarter if the middle is at least 3% away. Target the middle. Stop −3%.',
    stopPct: 3, takeProfitPct: 2, maxHoldMin: 180, lookback: 60, maxRangePct: 8, minBouncePct: 3,
  },
});

const plan = (spec, extra = {}) => ({ enter: true, stopPct: spec.stopPct, takeProfitPct: spec.takeProfitPct, maxHoldMin: spec.maxHoldMin, ...extra });

function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function smaClose(bars, i, n) {
  if (i + 1 < n) return null;
  let s = 0;
  for (let k = i - n + 1; k <= i; k++) s += bars[k].c;
  return s / n;
}

export function meanrevPlan(bars, i) {
  const spec = SLOT_SPEC.meanrev;
  const avg = smaClose(bars, i, spec.lookback);
  if (!(avg > 0) || !(bars[i].c > 0) || !(bars[i].v > 0)) return false;
  if (bars[i].c > avg * (1 - spec.dipPct / 100)) return false;
  if (i < 3) return false;
  for (let k = 0; k < 3; k++) {
    const prev = bars[i - k - 1].c;
    const cur = bars[i - k].c;
    if (!(prev > 0) || (cur / prev - 1) * 100 <= -2) return false;
  }
  return plan(spec);
}

export function breakoutPlan(bars, i) {
  const spec = SLOT_SPEC.breakout;
  const n = spec.lookback;
  if (i < n || !(bars[i].c > 0)) return false;
  let priorHigh = -Infinity;
  const vols = [];
  for (let k = i - n; k < i; k++) {
    priorHigh = Math.max(priorHigh, bars[k].h);
    vols.push(bars[k].v || 0);
  }
  if (!(bars[i].c > priorHigh)) return false;
  const med = median(vols);
  if (!(med > 0) || !(bars[i].v > med * spec.volMult)) return false;
  return plan(spec);
}

export function momentumPlan(bars, i) {
  return momentumBounds(bars, i, SLOT_SPEC.momentum);
}

export function momentumTightPlan(bars, i) {
  return momentumBounds(bars, i, { ...SLOT_SPEC.momentum, ret60Lo: 5, ret60Hi: 15 });
}

function momentumBounds(bars, i, spec) {
  const t = bars[i].t;
  if (!(bars[i].c > 0) || !(bars[i].v > 0)) return false;
  const i60 = lastAt(bars, t - 60 * 60000);
  const i360 = lastAt(bars, t - 360 * 60000);
  if (i60 < 0 || i360 < 0) return false;
  if (Math.abs(bars[i60].t - (t - 60 * 60000)) > 3 * 60000) return false;
  if (Math.abs(bars[i360].t - (t - 360 * 60000)) > 10 * 60000) return false;
  if (!(bars[i60].c > 0) || !(bars[i360].c > 0)) return false;
  const r60 = (bars[i].c / bars[i60].c - 1) * 100;
  const r360 = (bars[i].c / bars[i360].c - 1) * 100;
  if (!(r60 >= spec.ret60Lo && r60 <= spec.ret60Hi)) return false;
  if (!(r360 < spec.ret360Hi)) return false;
  return plan(spec);
}

export function momentumTrailPlan(bars, i) {
  const hit = momentumPlan(bars, i);
  if (!hit) return false;
  return { ...hit, takeProfitPct: 1000, trailActivatePct: 6, trailPct: 4 };
}

export function gridPlan(bars, i) {
  const spec = SLOT_SPEC.grid;
  const n = spec.lookback;
  if (i + 1 < n || !(bars[i].c > 0) || !(bars[i].v > 0)) return false;
  let hi = -Infinity, lo = Infinity;
  for (let k = i - n + 1; k <= i; k++) {
    hi = Math.max(hi, bars[k].h);
    lo = Math.min(lo, bars[k].l);
  }
  const mid = (hi + lo) / 2;
  if (!(mid > 0) || !(hi > lo)) return false;
  const rangePct = ((hi - lo) / mid) * 100;
  if (rangePct > spec.maxRangePct || rangePct < spec.minBouncePct) return false;
  const pos = (bars[i].c - lo) / (hi - lo);
  if (pos > 0.25) return false;
  const bounce = (mid / bars[i].c - 1) * 100;
  if (bounce < spec.minBouncePct) return false;
  return plan(spec, { takeProfitPct: bounce });
}

export const PLANNERS = Object.freeze({
  meanrev: meanrevPlan,
  breakout: breakoutPlan,
  momentum: momentumPlan,
  grid: gridPlan,
});

function lastAt(bars, t) {
  let lo = 0, hi = bars.length - 1, ans = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (bars[m].t <= t) { ans = m; lo = m + 1; }
    else hi = m - 1;
  }
  return ans;
}

const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);

// Snapshot rules for the live scan. They are the same ideas as the candle plans,
// using the fields a free quote actually returns. They are not a second optimization.
export function liveSignals(pool, now = Date.now()) {
  const out = [];
  const liq = num(pool.liq) || 0;
  const h1 = num(pool.pc?.h1);
  const h6 = num(pool.pc?.h6);
  const m5 = num(pool.pc?.m5);
  const volH1 = num(pool.vol?.h1) || 0;
  const volM5 = num(pool.vol?.m5) || 0;
  const buys = pool.tx?.m5?.b;
  const sells = pool.tx?.m5?.s;
  const ageMin = pool.createdAt ? (now - pool.createdAt) / 60000 : null;
  if (!(pool.priceUsd > 0) || !(liq >= 40000)) return out;

  if (liq >= 80000 && h1 != null && h1 <= -4 && h1 >= -12 && (m5 == null || m5 > -1) && (h6 == null || h6 > -40)) {
    out.push({ slot: 'meanrev', reason: `1h ${h1}% under the recent run, 5m ${m5 ?? 'n/a'}%` });
  }
  if (m5 != null && m5 >= 3 && h1 != null && h1 >= 2 && h1 <= 25 && volH1 > 0 && volM5 > volH1 / 12 && (buys == null || sells == null || buys > sells)) {
    out.push({ slot: 'breakout', reason: `5m ${m5}% with 1h ${h1}% and a volume burst` });
  }
  if (h1 != null && h1 >= 0 && h1 <= 25 && (h6 == null || h6 < 80) && (ageMin == null || ageMin < 360) && (buys == null || sells == null || buys >= sells)) {
    out.push({ slot: 'momentum', reason: `1h ${h1}% and not already extended` });
  }
  if (liq >= 250000 && h1 != null && Math.abs(h1) < 3 && (h6 == null || Math.abs(h6) < 8) && volH1 >= 20000) {
    out.push({ slot: 'grid', reason: `liquid range, 1h ${h1}%` });
  }
  return out;
}

// Scale is only 0 or 1, and 1 never means "bigger than the slot's assigned bucket".
// A non-positive sample turns the slot off. It does not raise size.
export function slotStatus(book, settings = {}) {
  const h = strategyHealth(book);
  const killN = settings.slotKillN || 15;
  const promoteN = settings.edgeMinN || 30;
  if (h.n >= killN && !(h.expectancy > 0)) {
    return { mode: 'off', reason: `This slot's own ${h.n} trades have expectancy ${h.expectancy.toFixed(2)} per trade, which is not positive. The slot is off. Size is not increased.` };
  }
  if (h.n >= promoteN && h.ci80 && h.ci80[0] > 0) {
    return { mode: 'promoted', reason: `This slot's own ${h.n} trades have an 80% lower bound above zero. It may use the normal paper size, not more.` };
  }
  return { mode: 'assigned', reason: h.n ? `${h.n} closed paper trades on this slot. Still the assigned size.` : 'No closed trades on this slot yet.' };
}

// Both windows have to clear the bar. One lucky holdout is not an edge.
export function slotEdge(hold, train) {
  if (!hold || !train) return false;
  const holdOk = hold.n >= 30 && hold.nPools >= 8 && hold.lo != null && hold.lo > 0;
  const trainOk = train.n >= 20 && train.mean > 0 && train.lo != null && train.lo > 0;
  return holdOk && trainOk;
}

// At least three unseen windows, each with 20 trades and a 90% lower bound above zero.
export function graduates(windows) {
  const unseen = (windows || []).filter((w) => w && !w.seen && w.n >= 20);
  if (unseen.length < 3) return false;
  return unseen.every((w) => w.mean > 0 && w.lo != null && w.lo > 0);
}

export function backoffMs(attempt, status) {
  const base = status === 429 ? 4000 : 2000;
  return Math.min(status === 429 ? 45000 : 20000, base * 2 ** attempt);
}

export function momentumAllowed(pool, graduated, now = Date.now()) {
  if (!graduated) return true;
  if (graduated === 'liq100') return (pool.liq || 0) >= 100000;
  if (graduated === 'age6h') return !!pool.createdAt && now - pool.createdAt >= 6 * 3600000;
  if (graduated === 'tight') {
    const h1 = pool.pc?.h1;
    return typeof h1 === 'number' && h1 >= 5 && h1 <= 15;
  }
  return true;
}

export function emptySlots() {
  return Object.fromEntries(SLOT_IDS.map((id) => [id, { book: [], off: false, offReason: null }]));
}
