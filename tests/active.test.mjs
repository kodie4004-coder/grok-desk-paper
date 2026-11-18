import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../engine/core.js';
import { newState, startSession, tick } from '../engine/engine.js';
import { activeSignals, activePredictPicks, activePace, ACTIVE } from '../engine/active.js';

function pool(sym, pc, liq = 200000) {
  return {
    pool: sym, token: sym, symbol: sym, chain: 'solana', priceUsd: 1, liq,
    pc, tx: { m5: { b: 12, s: 4 } }, vol: { m5: 2000, h1: 80000 },
  };
}

test('loose active signals can light every coin slot', () => {
  const names = new Set();
  for (const p of [
    pool('A', { h1: -4, m5: 0, h6: -1 }),
    pool('B', { h1: 6, m5: 1.2, h6: 4 }),
    pool('C', { h1: 0.4, m5: 0, h6: 1 }, 400000),
  ]) for (const s of activeSignals(p)) names.add(s.slot);
  assert.deepEqual([...names].sort(), ['breakout', 'grid', 'meanrev', 'momentum']);
  const picks = activePredictPicks({ price: 0.62, end: Date.now() + 48 * 3600000 }, Date.now()).map((p) => p.rule);
  assert.ok(picks.includes('p1') && picks.includes('p3'));
  assert.ok(activePredictPicks({ price: 0.08 }, Date.now()).some((p) => p.rule === 'p2'));
  assert.equal(activePace().tickSec, 15);
  assert.ok(activePace().steadyPerHour >= 20);
});

test('active fills stay out of the gated book and never size up', async () => {
  let t = Date.parse('2026-11-18T15:00:00Z');
  let price = 1;
  const pools = [
    pool('DIP', { h1: -4, m5: 0.1, h6: -2 }),
    pool('POP', { h1: 5, m5: 1.5, h6: 8 }),
    pool('FLAT', { h1: 0.3, m5: 0, h6: 0.4 }, 500000),
    pool('RUN', { h1: 2, m5: 0.8, h6: 3 }),
  ];
  const src = {
    discover: async () => ({ pools, predictions: [{ venue: 'Polymarket', id: 'm1', title: 'Test market', price: 0.08, end: t + 10 * 86400000, feeRate: 0.04 }], feed: [] }),
    newPools: async () => [], trendingPools: async () => [],
    tokenInfo: async () => ({ holders: 10, top10: 10, dev: 0 }),
    poolTrades: async () => [],
    prices: async (toks) => Object.fromEntries(toks.map((k) => [k, price])),
  };
  const st = newState({
    ...C.DEFAULT_SETTINGS,
    activeMode: true,
    strategySlots: false,
    majorsPaper: false,
    fastScan: true,
    edgeGate: true,
    allowExplore: false,
    copyEnabled: false,
    impactModel: false,
    edgePrior: { verdict: 'no-edge', summary: 'no' },
  }, t);
  startSession(st, t);
  await tick(st, src, t);
  assert.equal(st.open.length, 0);
  assert.equal(st.closed.length, 0);
  assert.ok(st.activeOpen.length >= 4, JSON.stringify(st.activeFeed.slice(-6)));
  assert.ok(st.activeOpen.every((p) => p.sizeUsd === ACTIVE.sizeUsd && p.bucket === 'Active (exploration)'));
  assert.ok(st.activeFeed.some((f) => f.kind === 'entry' && String(f.text).includes('fee $')));
  const rules = new Set(st.activeOpen.map((p) => p.rule));
  for (const id of ['meanrev', 'breakout', 'momentum', 'grid', 'p2']) assert.ok(rules.has(id), [...rules].join(','));
  price = 0.9;
  t += 60000;
  await tick(st, src, t);
  assert.equal(st.closed.length, 0);
  assert.ok(st.activeClosed.length >= 1);
  assert.ok(st.activeClosed.every((p) => p.fees > 0 && p.sizeUsd === ACTIVE.sizeUsd));
  assert.equal(st.edgeBook.length, 0);
  t += ACTIVE.ruleGapMs + 1000;
  price = 1;
  await tick(st, src, t);
  assert.ok(st.activeOpen.every((p) => p.sizeUsd === ACTIVE.sizeUsd));
});

test('a daily drawdown pauses active entries without touching the gated book', async () => {
  const t = Date.parse('2026-11-18T16:00:00Z');
  const src = {
    discover: async () => ({ pools: [pool('DIP', { h1: -4, m5: 1, h6: 0 })], predictions: [], feed: [] }),
    prices: async (toks) => Object.fromEntries(toks.map((k) => [k, 1])),
    newPools: async () => [], trendingPools: async () => [], tokenInfo: async () => ({}), poolTrades: async () => [],
  };
  const st = newState({ ...C.DEFAULT_SETTINGS, activeMode: true, strategySlots: false, majorsPaper: false, fastScan: true, copyEnabled: false, edgeGate: true, allowExplore: false }, t);
  startSession(st, t);
  st.activePausedDay = '2026-11-18';
  st.activeDayKey = '2026-11-18';
  st.activeDayStart = 500;
  st.activeCash = 470;
  await tick(st, src, t);
  assert.equal(st.activeOpen.length, 0);
  assert.ok(st.activeFeed.some((f) => /Paused for the day/.test(f.text)));
  assert.equal(st.closed.length, 0);
});
