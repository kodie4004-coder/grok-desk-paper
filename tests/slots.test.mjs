import test from 'node:test';
import assert from 'node:assert/strict';
import { meanrevPlan, breakoutPlan, gridPlan, liveSignals, slotStatus, slotEdge } from '../engine/strategies.js';
import { simulateTrades } from '../engine/eval.js';
import { newState, startSession, tick } from '../engine/engine.js';
import * as C from '../engine/core.js';

function bars(n, fn) {
  const out = [];
  let t = 0;
  for (let i = 0; i < n; i++) out.push({ t: t += 60000, ...fn(i) });
  return out;
}

test('mean reversion buys a 4% dip and skips a freefall', () => {
  const flat = bars(40, () => ({ o: 1, h: 1.002, l: 0.998, c: 1, v: 10 }));
  const dip = [0.985, 0.97, 0.955, 0.94];
  dip.forEach((c, k) => { flat[36 + k] = { ...flat[36 + k], o: c, h: c * 1.002, l: c * 0.998, c, v: 10 }; });
  assert.equal(meanrevPlan(flat, 39).enter, true);
  const crash = bars(40, (i) => {
    const c = i < 36 ? 1 : 1 - (i - 35) * 0.03;
    return { o: c, h: c, l: c * 0.99, c, v: 10 };
  });
  assert.equal(meanrevPlan(crash, 39), false);
});

test('breakout needs a new high and heavier volume', () => {
  const quiet = bars(25, () => ({ o: 1, h: 1.01, l: 0.99, c: 1, v: 10 }));
  assert.equal(breakoutPlan(quiet, 24), false);
  const up = bars(25, (i) => ({ o: 1, h: 1.01, l: 0.99, c: 1, v: i === 24 ? 40 : 10 }));
  up[24] = { t: up[24].t, o: 1.02, h: 1.05, l: 1.01, c: 1.04, v: 40 };
  assert.equal(breakoutPlan(up, 24).enter, true);
  assert.equal(breakoutPlan(up, 24).takeProfitPct, 8);
});

test('grid only buys the bottom of a tight range when the bounce clears 3%', () => {
  const w = bars(60, () => ({ o: 1, h: 1.01, l: 0.98, c: 1, v: 5 }));
  w[59] = { ...w[59], o: 0.945, h: 0.95, l: 0.94, c: 0.945, v: 5 };
  const g = gridPlan(w, 59);
  assert.equal(g.enter, true);
  assert.ok(g.takeProfitPct >= 3);
  const wide = bars(60, (i) => ({ o: 1 + i * 0.01, h: 1 + i * 0.01, l: 1 + i * 0.01, c: 1 + i * 0.01, v: 5 }));
  assert.equal(gridPlan(wide, 59), false);
});

test('a planned trade uses its own stop and target', () => {
  const series = bars(10, () => ({ o: 1, h: 1, l: 1, c: 1, v: 1 }));
  series[2] = { ...series[2], o: 1, h: 1.1, l: 0.9, c: 0.95, v: 1 };
  const tr = simulateTrades(series, (b, i) => (i === 1 ? { enter: true, stopPct: 4, takeProfitPct: 8, maxHoldMin: 5 } : false), {
    stopPct: 99, takeProfitPct: 99, maxHoldMin: 5, sizeUsd: 25, feePct: 1, fill: 'conservative', maxEntryGapMs: 180000,
  });
  assert.equal(tr[0].kind, 'stop');
  assert.ok(Math.abs(tr[0].exitMid - 0.9) < 1e-9);
});

test('slot status turns off a loser and never sizes up because of it', () => {
  const losses = Array.from({ length: 15 }, () => ({ pnl: -1, fees: 0.2, sizeUsd: 5 }));
  const off = slotStatus(losses, { slotKillN: 15, edgeMinN: 30 });
  assert.equal(off.mode, 'off');
  const wins = Array.from({ length: 30 }, () => ({ pnl: 1, fees: 0.1, sizeUsd: 5 }));
  assert.equal(slotStatus(wins, { slotKillN: 15, edgeMinN: 30 }).mode, 'promoted');
  assert.equal(slotEdge({ n: 40, nPools: 10, lo: 0.1, mean: 0.2 }, { n: 30, mean: 0.1, lo: 0.02 }), true);
  assert.equal(slotEdge({ n: 40, nPools: 10, lo: 0.1, mean: 0.2 }, { n: 30, mean: -0.1, lo: -0.2 }), false);
  assert.equal(slotEdge({ n: 10, nPools: 2, lo: 1, mean: 1 }, { n: 30, mean: 1, lo: 1 }), false);
});

test('live snapshot signals stay inside the pre-declared buckets', () => {
  const dip = liveSignals({ priceUsd: 1, liq: 100000, pc: { h1: -6, m5: 0.2, h6: -5 }, vol: { h1: 10000, m5: 1000 }, tx: { m5: { b: 8, s: 6 } } });
  assert.ok(dip.some((s) => s.slot === 'meanrev'));
  assert.equal(liveSignals({ priceUsd: 1, liq: 1000, pc: { h1: -6 } }).length, 0);
});

test('a strategy slot can paper-buy while JUDGE stays flat', async () => {
  let t = 1_000_000_000_000;
  const pool = { pool: 'P1', token: 'TK', symbol: 'DIP', chain: 'base', dex: 'x', createdAt: t - 3600e3, priceUsd: 1, liq: 300000, fdv: 1e6, pc: { m5: 0, h1: -6, h6: -4, h24: -8 }, tx: { m5: { b: 20, s: 8 }, h1: { b: 100, s: 40 } }, vol: { m5: 2000, h1: 80000, h24: 1e6 } };
  const src = {
    newPools: async () => [pool], trendingPools: async () => [],
    tokenInfo: async () => ({ holders: 5000, top10: 15, dev: 1, mintAuthority: false, freezeAuthority: false, honeypot: false, social: true }),
    poolTrades: async () => [],
    prices: async (toks) => Object.fromEntries(toks.map((k) => [k, 1])),
  };
  const st = newState({ ...C.DEFAULT_SETTINGS, bank: 500, edgeGate: true, allowExplore: false, impactModel: false, strategySlots: true, fastScan: false, edgePrior: { verdict: 'no-edge', summary: 'no' } }, t);
  startSession(st, t);
  await tick(st, src, t);
  const slot = st.open.find((p) => p.slot === 'meanrev');
  assert.ok(slot, JSON.stringify(st.log.slice(-4)));
  assert.equal(slot.bucket, 'exploration');
  assert.equal(slot.sizeUsd, 5);
  assert.equal(st.open.filter((p) => p.source === 'own').length, 0);
});
