import test from 'node:test';
import assert from 'node:assert/strict';
import { FOCUS_BENCHED, FOCUS_BENCHED_IDS, NEAR_WINNERS, BENCH_RULE, meetsBench } from '../engine/focus-plan.js';
import { benchScan, focusDoc } from '../engine/focus.js';
import { focusCardHtml } from '../engine/focus-view.js';
import { VARIANTS, stepJournal, defaultBrain, reviewBrain } from '../engine/learn.js';

test('the bench rule is n 40+ with the 90% high below zero, and every frozen entry met it', () => {
  assert.deepEqual({ ...BENCH_RULE }, { minN: 40, hiBelow: 0 });
  for (const row of FOCUS_BENCHED) {
    assert.ok(meetsBench(row), row.id);
    assert.ok(row.mean < 0, row.id);
  }
  assert.equal(meetsBench({ n: 39, hi: -1 }), false);
  assert.equal(meetsBench({ n: 40, hi: 0 }), false);
});

test('no near-winner and no control is benched', () => {
  for (const id of NEAR_WINNERS) assert.equal(FOCUS_BENCHED_IDS.has(id), false, id);
  for (const v of VARIANTS.filter((x) => x.role === 'control')) assert.equal(FOCUS_BENCHED_IDS.has(v.id), false);
  for (const id of NEAR_WINNERS) assert.ok(VARIANTS.some((v) => v.id === id), id);
});

test('a benched book opens no new line and carries weight 0; its open line still settles', () => {
  const now = Date.parse('2026-11-22T12:00:00Z');
  const close = new Date(now + 400000).toISOString();
  const markets = [
    { ticker: 'KXBTC15M-J', series: 'KXBTC15M', title: 'BTC', yesAsk: 0.5, yesBid: 0.49, noAsk: 0.51, noBid: 0.5, closeTime: close, floorStrike: 100, result: '' },
  ];
  const quotes = { 'KXBTC15M-J': { yesAsk: 0.44, yesBid: 0.43, samples: [0.44] } };
  const next = stepJournal({ markets, open: [], quotes, brain: defaultBrain(), existingIds: [], settledRows: [], now });
  for (const row of next.open) assert.equal(FOCUS_BENCHED_IDS.has(row.variant), false, row.variant);
  for (const id of FOCUS_BENCHED_IDS) if (VARIANTS.some((v) => v.id === id)) assert.equal(next.brain.weights[id], 0, id);
  const openScalp = { id: 'scalp:KXBTC15M-J', variant: 'scalp', family: 'scalp', ticker: 'KXBTC15M-J', side: 'yes', ask: 0.5, contracts: 4, sizeUsd: 2, fee: 0.07, openedAt: new Date(now).toISOString(), closeTime: close, exit: null, allocated: false };
  const settled = stepJournal({ markets: [{ ...markets[0], result: 'yes' }], open: [openScalp], quotes: {}, brain: defaultBrain(), existingIds: [], settledRows: [], now: now + 500000 });
  assert.equal(settled.settled.length, 1);
  assert.equal(settled.settled[0].variant, 'scalp');
  const brain = reviewBrain(defaultBrain(), [], now, { iters: 10 });
  for (const id of FOCUS_BENCHED_IDS) if (VARIANTS.some((v) => v.id === id)) assert.equal(brain.weights[id], 0, id);
});

test('benchScan applies the rule to forward rows and never benches the control', () => {
  const mk = (variant, pnl, n) => Array.from({ length: n }, (_, i) => ({ variant, pnl: pnl + (i % 2 ? 0.01 : -0.01), series: `S${i % 6}`, ticker: `${variant}-${i}` }));
  const rows = [...mk('scalp', -0.3, 50), ...mk('flip', -0.3, 50), ...mk('late-loose', -0.3, 20), { variant: 'scalp', pnl: 9, skipped: true, series: 'S0' }];
  const scan = new Map(benchScan(rows, []).map((r) => [r.id, r]));
  assert.equal(scan.get('scalp').meets, true);
  assert.equal(scan.get('scalp').n, 50);
  assert.equal(scan.get('flip').meets, false);
  assert.equal(scan.get('flip').control, true);
  assert.equal(scan.get('late-loose').meets, false);
});

test('the focus doc lists only near-winners with gate progress, and the card collapses the bench', () => {
  const rows = Array.from({ length: 25 }, (_, i) => ({ variant: 'late-loose', pnl: 0.02, window: '2026-11-19', series: `S${i % 4}`, ticker: `L${i}`, closeTime: '2026-11-19T12:00:00Z' }));
  const doc = focusDoc({ rows, memeRows: [], backtest: { generatedAt: 'x', reports: [{ id: 'late-loose', mode: 'replay', cut: 'c', inSample: { n: 5, mean: 0.01 }, outSample: { hidden: true, n: 3 } }] }, now: Date.parse('2026-11-21T08:00:00Z') });
  assert.deepEqual(doc.near.map((r) => r.id), NEAR_WINNERS);
  assert.equal(doc.liveExecution, false);
  assert.equal(doc.sizeUsd, 2);
  const loose = doc.near.find((r) => r.id === 'late-loose');
  assert.equal(loose.n, 25);
  assert.equal(loose.weight, null);
  assert.equal(loose.gate.need, 3);
  assert.equal(loose.backtest.outSample, null);
  assert.equal(doc.benched.length, FOCUS_BENCHED.length);
  const html = focusCardHtml(doc);
  assert.match(html, /<h2[^>]*>Focus<\/h2>/);
  assert.match(html, /<details class="focus-bench"><summary>Benched \(11\)<\/summary>/);
  assert.doesNotMatch(html, /<details[^>]* open/);
  assert.match(html, /Gate 0\/3 days/);
  const weighted = focusDoc({ rows, brain: { weights: { 'late-loose': 0, 'scalp-95': 0 } }, now: 0 });
  assert.equal(weighted.near.find((r) => r.id === 'late-loose').weight, 0);
  assert.match(html, /never counts/);
  for (const id of NEAR_WINNERS) assert.ok(html.includes(doc.near.find((r) => r.id === id).label.replace('¢', '¢')));
  assert.match(focusCardHtml(null, { state: 'error' }), /did not load/);
});
