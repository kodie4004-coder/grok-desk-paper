import test from 'node:test';
import assert from 'node:assert/strict';
import { stepJournal, reviewBrain, featureLessons, gateProgress, settleRow, LEARN_SIZE, defaultBrain } from '../engine/learn.js';
import { graduates } from '../engine/strategies.js';

const now = Date.parse('2026-11-20T12:00:00Z');

function market(over) {
  return { ticker: 'KXBTC15M-T', series: 'KXBTC15M', title: 'BTC', yesAsk: 0.9, noAsk: 0.12, yesBid: 0.88, noBid: 0.1, closeTime: '2026-11-20T12:05:00Z', floorStrike: 100, result: '', ...over };
}

function row(variant, window, pnl, extra = {}) {
  return { variant, family: variant.split('-')[0] === 'late' ? 'late' : variant, window, pnl, series: 'KXBTC15M', ticker: variant + window + pnl, sizeUsd: 2, closeTime: window + 'T12:00:00Z', ...extra };
}

test('a settled paper trade stays $2 and keeps the taker fee', () => {
  const entry = { id: 'late:T', side: 'yes', ask: 0.9, contracts: 2, sizeUsd: 2, closeTime: '2026-11-19T00:00:00Z' };
  const won = settleRow(entry, 'yes', now);
  assert.equal(won.sizeUsd, LEARN_SIZE);
  assert.ok(won.fees > 0);
  assert.ok(won.pnl < 2 * 0.1);
  const lost = settleRow(entry, 'no', now);
  assert.equal(lost.sizeUsd, 2);
  assert.ok(lost.pnl < 0);
  assert.throws(() => settleRow({ ...entry, sizeUsd: 4 }, 'yes', now), /fixed at \$2/);
});

test('the journal records entry features and does not double-count a ticker', () => {
  const first = stepJournal({ markets: [market()], open: [], quotes: {}, brain: defaultBrain(), existingIds: [], now: Date.parse('2026-11-20T12:02:00Z') });
  const late = first.open.find((r) => r.variant === 'late');
  assert.ok(late);
  assert.equal(late.sizeUsd, 2);
  assert.equal(late.price, 0.9);
  assert.ok(late.secondsLeft > 0);
  assert.equal(late.momentum, null);
  const again = stepJournal({ markets: [market({ result: 'no' })], open: first.open, quotes: first.quotes, brain: defaultBrain(), existingIds: [], now });
  assert.equal(again.settled.filter((r) => r.variant === 'late').length, 1);
  assert.equal(again.settled.find((r) => r.variant === 'late').won, false);
  const third = stepJournal({ markets: [market({ result: 'no' })], open: [], quotes: {}, brain: defaultBrain(), existingIds: again.settled.map((r) => r.id), now });
  assert.equal(third.settled.length, 0);
});

test('a challenger that only wins the holdout wait, and a judged holdout is not reused', () => {
  const train = Array.from({ length: 20 }, (_, i) => row('late', '2026-11-17', -0.05, { family: 'late' }));
  const holdChamp = Array.from({ length: 20 }, (_, i) => row('late', '2026-11-18', -0.02, { family: 'late' }));
  const holdChallenger = Array.from({ length: 20 }, (_, i) => row('late-tight', '2026-11-18', 0.04, { family: 'late' }));
  const brain = reviewBrain(defaultBrain(), [...train, ...holdChamp, ...holdChallenger], now, { iters: 40 });
  assert.equal(brain.champions.late, 'late-tight');
  assert.ok(brain.judged.includes('2026-11-18'));
  const again = reviewBrain(brain, [...train, ...holdChamp, ...holdChallenger], now, { iters: 40 });
  assert.equal(again.champions.late, 'late-tight');
  assert.match(again.decisions[0], /already judged/);
});

test('train losses bench a bot and do not raise its paper size', () => {
  const train = Array.from({ length: 20 }, () => row('late-loose', '2026-11-17', -0.08, { family: 'late', sizeUsd: 2 }));
  const hold = [row('late', '2026-11-18', -0.01, { family: 'late' })];
  const brain = reviewBrain(defaultBrain(), [...train, ...hold], now, { iters: 40 });
  assert.ok(brain.benched.includes('late-loose'));
  assert.equal(brain.weights['late-loose'], 0);
  const next = stepJournal({
    markets: [market()],
    open: [],
    quotes: {},
    brain,
    existingIds: [],
    now: Date.parse('2026-11-20T12:02:00Z'),
  });
  assert.equal(next.open.some((r) => r.variant === 'late-loose'), false);
  assert.ok(next.open.filter((r) => r.family === 'late').every((r) => r.sizeUsd === 2));
});

test('a good train and a bad holdout does not replace the champion', () => {
  const train = Array.from({ length: 20 }, () => row('late-early', '2026-11-17', 0.05, { family: 'late' }));
  const holdChamp = Array.from({ length: 20 }, () => row('late', '2026-11-18', 0.03, { family: 'late' }));
  const holdBad = Array.from({ length: 20 }, () => row('late-early', '2026-11-18', -0.04, { family: 'late' }));
  const brain = reviewBrain(defaultBrain(), [...train, ...holdChamp, ...holdBad], now, { iters: 40 });
  assert.equal(brain.champions.late, 'late');
});

test('a $20 allocated paper loss pauses new lines without raising size', () => {
  const settledRows = [{ allocated: true, settledAt: '2026-11-20T01:00:00Z', window: '2026-11-20', pnl: -20, sizeUsd: 2 }];
  const next = stepJournal({ markets: [market()], open: [], quotes: {}, brain: defaultBrain(), existingIds: [], settledRows, now: Date.parse('2026-11-20T12:02:00Z') });
  assert.equal(next.open.length, 0);
});

test('feature lessons wait for 8 trades and the gate still needs three windows', () => {
  const few = Array.from({ length: 7 }, () => ({ family: 'late', price: 0.96, secondsLeft: 60, pnl: -0.1 }));
  assert.equal(featureLessons(few).length, 0);
  const enough = Array.from({ length: 8 }, () => ({ family: 'late', price: 0.96, secondsLeft: 60, pnl: -0.1 }));
  const lesson = featureLessons(enough)[0];
  assert.match(lesson.text, /above 0.95/);
  assert.match(lesson.text, /under 2 minutes/);
  assert.match(lesson.text, /after fees/);
  const oneWindow = Array.from({ length: 20 }, (_, i) => ({ variant: 'late', window: '2026-11-18', pnl: 0.01, series: 'KXBTC15M', ticker: 't' + i, closeTime: '2026-11-18T00:00:00Z' }));
  assert.equal(gateProgress(oneWindow, 30).graduated, false);
  assert.equal(graduates([{ n: 20, mean: 0.1, lo: 0.01, seen: false }, { n: 20, mean: 0.1, lo: 0.01, seen: false }]), false);
});
