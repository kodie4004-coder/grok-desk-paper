import test from 'node:test';
import assert from 'node:assert/strict';
import { stepJournal, defaultBrain, replayAllocated, feeVeto, evidenceWeights } from '../engine/learn.js';

const now = Date.parse('2026-11-19T18:00:00Z');

test('a benched variant and the coin-flip control get zero allocation', () => {
  const brain = { ...defaultBrain(), shadow: ['revert-wide'], shadowSince: { 'revert-wide': '2026-11-19' } };
  const market = {
    ticker: 'KXBTC15M-T', series: 'KXBTC15M', title: 'BTC', yesAsk: 0.2, noAsk: 0.82, yesBid: 0.18, noBid: 0.8,
    closeTime: new Date(now + 700000).toISOString(), floorStrike: 100, result: '',
  };
  const next = stepJournal({ markets: [market], open: [], quotes: {}, brain, existingIds: [], settledRows: [], spots: {}, now });
  const taken = next.open.filter((row) => row.allocated);
  assert.equal(taken.some((row) => row.variant === 'revert-wide'), false);
  assert.equal(taken.some((row) => row.variant === 'flip'), false);
  assert.ok(next.open.some((row) => row.variant === 'flip' && row.allocated === false));
  assert.ok(next.open.some((row) => row.variant === 'revert-wide' && row.allocated === false));
});

test('a shadow mean that does not clear the fee is vetoed and journaled', () => {
  const shadows = Array.from({ length: 8 }, (_, i) => ({ variant: 'late', allocated: false, pnl: -0.2, openedAt: `2026-11-19T10:0${i}:00Z` }));
  const veto = feeVeto('late', { ask: 0.5, features: { spread: 0.02 } }, shadows);
  assert.match(veto, /does not clear/);
  const market = {
    ticker: 'KXBTC15M-T', series: 'KXBTC15M', yesAsk: 0.9, noAsk: 0.12, yesBid: 0.88, closeTime: new Date(now + 200000).toISOString(), floorStrike: 1, result: '',
  };
  const next = stepJournal({ markets: [market], open: [], quotes: {}, brain: defaultBrain(), existingIds: [], settledRows: shadows, now });
  const late = next.open.find((row) => row.variant === 'late');
  assert.equal(late.skipped, true);
  assert.equal(late.allocated, false);
});

test('weights stay at zero when the lower bound is not positive, and a losing day does not raise them', () => {
  const rows = Array.from({ length: 8 }, (_, i) => ({ variant: 'mom', allocated: true, pnl: -0.2, settledAt: '2026-11-19T12:00:00Z', window: '2026-11-19', openedAt: `2026-11-19T11:0${i}:00Z` }));
  const weights = evidenceWeights(rows, { weights: { mom: 0.2 } }, now, 30);
  assert.equal(weights.mom, 0);
  assert.equal(weights.flip, 0);
});

test('an in-sample replay drops controls and does not claim a new holdout', () => {
  const rows = [
    { variant: 'flip', allocated: true, pnl: -1, openedAt: '2026-11-19T05:00:00Z', settledAt: '2026-11-19T05:10:00Z', window: '2026-11-19' },
    { variant: 'mom', allocated: true, pnl: 0.4, openedAt: '2026-11-19T05:01:00Z', settledAt: '2026-11-19T05:11:00Z', window: '2026-11-19' },
  ];
  const replay = replayAllocated(rows);
  assert.equal(replay.inSample, true);
  assert.ok(replay.before < replay.after);
  assert.equal(replay.nAfter, 1);
});
