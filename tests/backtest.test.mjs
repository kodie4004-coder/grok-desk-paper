import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { replayVariant, backtestVariant, splitTime, summarize, breakEven, compactSnapshot, resultsFrom, OOS_FRACTION } from '../engine/backtest.js';
import { kalshiTakerFee } from '../engine/kalshi.js';
import { VARIANTS, SCALP95_ADDED_AT, LEARN_SIZE, pinCleared, stepJournal, defaultBrain, reviewBrain } from '../engine/learn.js';
import { graduates } from '../engine/strategies.js';

const scalp95 = VARIANTS.find((v) => v.id === 'scalp-95');
const T0 = Date.parse('2026-11-19T12:00:00Z');
const at = (min) => new Date(T0 + min * 60000).toISOString();
// [ticker, series, closeTime, yesBid, yesAsk, noBid, noAsk, floorStrike]
const row = (ticker, closeMin, yesBid, yesAsk, series = 'KXBTC15M') => [ticker, series, at(closeMin), yesBid, yesAsk, +(1 - yesAsk).toFixed(4), +(1 - yesBid).toFixed(4), 100];

function tape() {
  return {
    snapshots: [
      // A closes at minute 15. 10 min left at minute 5: yes ask 0.96, the pocket fires.
      { t: at(5), m: [row('A', 15, 0.95, 0.96), row('B', 15, 0.02, 0.03), row('C', 15, 0.94, 0.95), row('D', 15, 0.97, 0.98)] },
      // Minute 7: A again (must not open a second line), B now with NO ask 0.97.
      { t: at(7), m: [row('A', 15, 0.96, 0.97), row('B', 15, 0.02, 0.03), row('E', 15, 0.97, 0.98)] },
      // Minute 12: 3 min left, outside the 5 to 10 minute window.
      { t: at(12), m: [row('F', 15, 0.98, 0.99)] },
      // Wide spread on G: risk veto.
      { t: at(20), m: [row('G', 30, 0.80, 0.97)] },
    ],
    results: { A: 'yes', B: 'yes', C: 'yes', D: 'no', F: 'yes', G: 'yes' },
  };
}

test('scalp-95 was written down with the plan parameters, weight pinned at 0', () => {
  assert.equal(scalp95.askAbove, 0.95);
  assert.equal(scalp95.minLeft, 300);
  assert.equal(scalp95.maxLeft, 600);
  assert.equal(scalp95.pinZero, true);
  assert.equal(scalp95.role, 'challenger');
  assert.equal(scalp95.addedAt, SCALP95_ADDED_AT);
  assert.equal(SCALP95_ADDED_AT, '2026-11-21T07:10:00.000Z');
  assert.equal(LEARN_SIZE, 2);
});

test('replay buys once per ticker at the recorded ask with the exact taker fee, holds to the result', () => {
  const { trades, vetoed, unresolved } = replayVariant(scalp95, tape());
  const ids = trades.map((t) => t.ticker).sort();
  // C at exactly 0.95 is not above 0.95. F is outside 5 to 10 minutes. G is vetoed. E has no result.
  assert.deepEqual(ids, ['A', 'B', 'D']);
  assert.equal(vetoed, 1);
  assert.equal(unresolved, 1);
  const a = trades.find((t) => t.ticker === 'A');
  assert.equal(a.side, 'yes');
  assert.equal(a.ask, 0.96);
  assert.equal(a.contracts, 2);
  assert.equal(a.sizeUsd, 2);
  assert.equal(a.fees, kalshiTakerFee(0.96, 2));
  assert.equal(a.fees, 0.01);
  assert.ok(Math.abs(a.pnl - (2 - 1.92 - 0.01)) < 1e-9);
  const b = trades.find((t) => t.ticker === 'B');
  assert.equal(b.side, 'no');
  assert.equal(b.ask, 0.98);
  assert.equal(b.won, false);
  assert.ok(Math.abs(b.pnl - (-1.96 - 0.01)) < 1e-9);
  const d = trades.find((t) => t.ticker === 'D');
  assert.equal(d.won, false);
  assert.ok(breakEven(a) > a.ask);
  assert.ok(Math.abs(breakEven(a) - (0.96 + 0.005)) < 1e-9);
});

test('a scalp exit sells at the recorded bid and pays two taker fees', () => {
  const tp = VARIANTS.find((v) => v.id === 'scalp-tp');
  const t = {
    snapshots: [
      { t: at(0), m: [row('S', 15, 0.40, 0.42)] },
      { t: at(1), m: [row('S', 15, 0.46, 0.47)] },
      { t: at(2), m: [row('S', 15, 0.51, 0.52)] },
    ],
    results: { S: 'no' },
  };
  const { trades } = replayVariant(tp, t);
  assert.equal(trades.length, 1);
  const s = trades[0];
  assert.equal(s.ask, 0.47);
  assert.equal(s.exit, 'take-profit');
  assert.equal(s.exitPx, 0.51);
  const c = Math.floor(2 / 0.47);
  assert.ok(Math.abs(s.pnl - (c * 0.51 - c * 0.47 - kalshiTakerFee(0.47, c) - kalshiTakerFee(0.51, c))) < 1e-9);
});

test('out-of-sample is the last 30% of time and stays hidden unless asked', () => {
  assert.equal(OOS_FRACTION, 0.3);
  const t = tape();
  const cut = splitTime(t);
  assert.equal(cut, new Date(T0 + (5 + 0.7 * 15) * 60000).toISOString());
  const hidden = backtestVariant(scalp95, t, { iters: 50 });
  assert.equal(hidden.outSample.hidden, true);
  assert.equal(hidden.mode, 'replay');
  const shown = backtestVariant(scalp95, t, { showOos: true, iters: 50 });
  assert.equal(shown.inSample.n + shown.outSample.n, 3);
  assert.match(shown.note, /never graduate/);
});

test('rules that need spot prints use recorded forward rows, and skipped rows are not trades', () => {
  const settle = VARIANTS.find((v) => v.id === 'mom-settle');
  const recorded = [
    { variant: 'mom-settle', pnl: 0.1, openedAt: at(1), series: 'KXBTC15M', ask: 0.5, contracts: 4, result: 'yes' },
    { variant: 'mom-settle', pnl: -0.5, openedAt: at(1), series: 'KXBTC15M', skipped: true },
    { variant: 'mom', pnl: 1, openedAt: at(1), series: 'KXBTC15M' },
  ];
  const r = backtestVariant(settle, tape(), { recorded, showOos: true, iters: 50 });
  assert.equal(r.mode, 'recorded');
  assert.equal(r.inSample.n + r.outSample.n, 1);
});

test('summary reports win rate against break-even and a 90% bootstrap band', () => {
  const trades = [
    { pnl: 0.07, ask: 0.96, contracts: 2, result: 'yes', series: 'A' },
    { pnl: -1.93, ask: 0.96, contracts: 2, result: 'no', series: 'B' },
    { pnl: 0.07, ask: 0.96, contracts: 2, result: 'yes', series: 'C' },
  ];
  const s = summarize(trades, { iters: 200 });
  assert.equal(s.n, 3);
  assert.ok(Math.abs(s.mean - (-1.79 / 3)) < 1e-9);
  assert.ok(Math.abs(s.winRate - 2 / 3) < 1e-9);
  assert.ok(Math.abs(s.breakEven - 0.965) < 1e-9);
  assert.ok(s.lo <= s.mean && s.mean <= s.hi);
});

test('compact snapshots keep open quotes and the results map keeps settled ones', () => {
  const doc = { fetchedAt: at(5), markets: [
    { ticker: 'A', series: 'X', closeTime: at(15), yesBid: 0.5, yesAsk: 0.51, noBid: 0.49, noAsk: 0.5, floorStrike: 1, result: '' },
    { ticker: 'Z', series: 'X', closeTime: at(0), yesBid: 0, yesAsk: 1, result: 'no' },
  ] };
  const snap = compactSnapshot(doc);
  assert.equal(snap.m.length, 1);
  assert.equal(snap.m[0][0], 'A');
  assert.deepEqual(resultsFrom(doc), { Z: 'no' });
});

test('a backtest cannot lift the pin: only forward rows after the added day through graduates()', () => {
  const backtestRows = replayVariant(scalp95, tape()).trades.map((t) => ({ ...t, pnl: 0.5, window: '2026-11-19' }));
  assert.equal(pinCleared(scalp95, backtestRows), false);
  const day = (d) => Array.from({ length: 20 }, (_, i) => ({ variant: 'scalp-95', pnl: 0.05 + (i % 3) * 0.01, window: d, series: `S${i % 5}`, ticker: `${d}-${i}`, sizeUsd: 2, closeTime: `${d}T12:00:00Z` }));
  const sameDay = day('2026-11-21');
  assert.equal(pinCleared(scalp95, sameDay), false);
  const forward = [...day('2026-11-22'), ...day('2026-11-23'), ...day('2026-11-24')];
  assert.equal(pinCleared(scalp95, forward), true);
  const brain = reviewBrain(defaultBrain(), sameDay, Date.parse('2026-11-25T00:00:00Z'), { iters: 20 });
  assert.equal(brain.weights['scalp-95'], 0);
});

test('the journal opens scalp-95 as a $2 shadow line with weight 0', () => {
  const now = Date.parse('2026-11-22T12:00:00Z');
  const market = { ticker: 'KXBTC15M-P', series: 'KXBTC15M', title: 'BTC', yesAsk: 0.97, noAsk: 0.04, yesBid: 0.96, noBid: 0.03, closeTime: new Date(now + 420000).toISOString(), floorStrike: 100, result: '' };
  const next = stepJournal({ markets: [market], open: [], quotes: {}, brain: defaultBrain(), existingIds: [], settledRows: [], now });
  const line = next.open.find((r) => r.variant === 'scalp-95');
  assert.ok(line);
  assert.equal(line.allocated, false);
  assert.equal(line.sizeUsd, 2);
  assert.equal(line.side, 'yes');
  assert.equal(next.brain.weights['scalp-95'], 0);
});

test('graduates() and live execution are untouched by the backtester', () => {
  const src = readFileSync(new URL('../engine/backtest.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /import[^;]*graduates/);
  assert.doesNotMatch(src, /weights\[/);
  assert.equal(graduates([{ seen: false, n: 20, mean: 1, lo: 0.1 }, { seen: false, n: 20, mean: 1, lo: 0.1 }]), false);
});
