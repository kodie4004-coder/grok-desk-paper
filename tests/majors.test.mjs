import test from 'node:test';
import assert from 'node:assert/strict';
import { trendDayPlan, quietRangePlan, slowBreakPlan, isMajor } from '../engine/majors.js';
import { simulateTrades, PROTOCOL } from '../engine/eval.js';

function hours(n, fn) {
  const t0 = Date.parse('2026-06-01T00:00:00Z');
  return Array.from({ length: n }, (_, i) => {
    const c = fn(i);
    return { t: t0 + i * 3600000, o: c, h: c * 1.002, l: c * 0.998, c, v: 10 };
  });
}

test('only deep majors qualify', () => {
  assert.equal(isMajor({ symbol: 'SOL', liq: 2_000_000 }), true);
  assert.equal(isMajor({ symbol: 'sol', liq: 9_000_000 }), true);
  assert.equal(isMajor({ symbol: 'SOL', liq: 1_000_000 }), false);
  assert.equal(isMajor({ symbol: 'BONK', liq: 9_000_000 }), false);
});

test('one-day trend takes a 2% rise and skips a 20% spike', () => {
  const calm = hours(30, (i) => 100 * (1 + 0.02 * Math.min(i, 24) / 24));
  assert.equal(trendDayPlan(calm, 24).enter, true);
  assert.equal(trendDayPlan(calm, 24).maxHoldMin, 24 * 60);
  const spike = hours(30, (i) => (i < 24 ? 100 : 130));
  assert.equal(trendDayPlan(spike, 24), false);
});

test('quiet range buys the bottom of a narrow book', () => {
  const series = hours(50, () => 100);
  series[49] = { ...series[49], o: 96.4, h: 96.5, l: 96, c: 96.2, v: 10 };
  const plan = quietRangePlan(series, 49);
  assert.equal(plan.enter, true);
  assert.ok(plan.takeProfitPct >= 1.5);
});

test('slow breakout needs a modest push and heavier volume', () => {
  const series = hours(30, (i) => 100 + (i > 26 ? (i - 26) * 0.4 : 0));
  series[29] = { ...series[29], v: 50 };
  assert.equal(slowBreakPlan(series, 29).enter, true);
  series[29] = { ...series[29], v: 1 };
  assert.equal(slowBreakPlan(series, 29), false);
});

test('a 24-hour cooldown blocks a second entry on the next bar', () => {
  const series = hours(10, () => 100);
  const cfg = { ...PROTOCOL, maxHoldMin: 60, stopPct: 50, takeProfitPct: 50, maxEntryGapMs: 2 * 3600000, cooldownMs: 24 * 3600000, sizeUsd: 25 };
  const once = simulateTrades(series, () => true, cfg);
  const many = simulateTrades(series, () => true, { ...cfg, cooldownMs: 0 });
  assert.equal(once.length, 1);
  assert.ok(many.length > 1);
});
