import test from 'node:test';
import assert from 'node:assert/strict';
import { simulateTrades, runAccount, judgeStudy, deskPriorFromStudy, volGateAdopted, runStudy, mulberry32 } from '../engine/eval.js';

const base = {
  stopPct: 4, takeProfitPct: 12, maxHoldMin: 30, sizeUsd: 25, feePct: 1,
  fill: 'conservative', maxEntryGapMs: 180000, tradeFrom: null, tradeTo: null,
};

function flatBars(n, px = 1) {
  const bars = [];
  let t = 0;
  for (let i = 0; i < n; i++) bars.push({ t: t += 60000, o: px, h: px * 1.005, l: px * 0.995, c: px, v: 10 });
  return bars;
}

test('entry is the next open, and a flat hold loses the fee', () => {
  const bars = [];
  let t = 0;
  for (let i = 0; i < 20; i++) bars.push({ t: t += 60000, o: 1, h: 1, l: 1, c: 1, v: 10 });
  for (let i = 6; i < bars.length; i++) bars[i] = { ...bars[i], o: 1.11, h: 1.11, l: 1.11, c: 1.11 };
  const tr = simulateTrades(bars, (_b, i) => i === 5, { ...base, maxHoldMin: 5 });
  assert.equal(tr[0].entryMid, 1.11);
  assert.equal(tr[0].entryT, bars[6].t);
  assert.equal(tr[0].kind, 'time');
  assert.ok(tr[0].pnl < 0);
});

test('a stop that gaps fills at the low, and both targets in one bar take the stop', () => {
  const bars = flatBars(8);
  bars[2] = { t: bars[2].t, o: 1, h: 1.2, l: 0.8, c: 0.9, v: 10 };
  const gap = simulateTrades(bars, (_b, i) => i === 1, base);
  assert.equal(gap[0].kind, 'stop');
  assert.ok(Math.abs(gap[0].exitMid - 0.8) < 1e-9);
  assert.ok(gap[0].gap > 0);
  const opt = simulateTrades(bars, (_b, i) => i === 1, { ...base, fill: 'optimistic' });
  assert.ok(Math.abs(opt[0].exitMid - 0.96) < 1e-9);
});

test('account respects max open positions', () => {
  const trades = [0, 1, 2].map((i) => ({
    pool: 'P' + i, entryT: 1000 + i, exitT: 5000, sizeUsd: 25, pnl: 1, fees: 0.2, gross: 1.2,
  }));
  const acct = runAccount(trades, { bank: 500, maxOpen: 2 });
  assert.equal(acct.taken.length, 2);
  assert.equal(acct.skipped, 1);
});

test('study verdict rule and desk prior stay conservative', () => {
  const edge = { n: 40, nPools: 10, mean: 0.2, lo: 0.05, hi: 0.4 };
  const soft = { n: 40, nPools: 10, mean: 0.05, lo: -0.1, hi: 0.2 };
  const bad = { n: 40, nPools: 10, mean: -0.2, lo: -0.4, hi: -0.05 };
  const tiny = { n: 4, nPools: 1, mean: 5, lo: 5, hi: 5 };
  assert.equal(judgeStudy([edge]), 'edge');
  assert.equal(judgeStudy([soft, bad]), 'inconclusive');
  assert.equal(judgeStudy([bad, tiny]), 'no-edge');
  assert.equal(deskPriorFromStudy('edge'), 'inconclusive');
  assert.equal(deskPriorFromStudy('no-edge'), 'no-edge');
  assert.equal(deskPriorFromStudy('inconclusive'), 'inconclusive');
  assert.equal(volGateAdopted({ mean: 0.2, n: 25, nPools: 6 }, { mean: 0.1, n: 30, nPools: 8 }, { mean: 0.1 }, { mean: 0.05 }), true);
  assert.equal(volGateAdopted({ mean: 0.2, n: 25, nPools: 6 }, { mean: 0.1 }, { mean: 0.01 }, { mean: 0.05 }), false);
});

test('runStudy is deterministic on a synthetic book', () => {
  const rng = mulberry32(3);
  const pools = [0, 1, 2].map((k) => {
    const bars = [];
    let px = 1, t = Date.parse('2026-11-01T00:00:00Z');
    for (let i = 0; i < 900; i++) {
      const shock = (rng() - 0.48) * 0.02;
      const o = px;
      px = Math.max(0.05, px * (1 + shock));
      const h = Math.max(o, px) * 1.01, l = Math.min(o, px) * 0.99;
      bars.push({ t, o, h, l, c: px, v: 100 + rng() * 50 });
      t += 60000;
    }
    return { pool: 'P' + k, symbol: 'S' + k, bars };
  });
  const a = runStudy(pools, { bootstrapIters: 40, holdoutMs: 6 * 3600000 });
  const b = runStudy(pools, { bootstrapIters: 40, holdoutMs: 6 * 3600000 });
  assert.equal(a.primary.holdout.momentum.summary.net, b.primary.holdout.momentum.summary.net);
  assert.equal(a.primary.holdout['no-trade'].summary.net, 0);
  assert.ok(['edge', 'inconclusive', 'no-edge'].includes(a.verdict));
  assert.ok(['edge', 'inconclusive', 'no-edge'].includes(a.studyVerdict));
});
