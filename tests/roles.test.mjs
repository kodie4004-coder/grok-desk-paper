import test from 'node:test';
import assert from 'node:assert/strict';
import { onCooldown, shouldExit, settleExit, reviewRoles, COOLDOWN_WINDOWS } from '../engine/roles.js';
import { stepJournal, defaultBrain, filterLessons } from '../engine/learn.js';

const now = Date.parse('2026-11-20T12:00:00Z');

function liveMarket(over = {}) {
  return { ticker: 'KXBTC15M-T', series: 'KXBTC15M', title: 'BTC', yesAsk: 0.9, noAsk: 0.12, yesBid: 0.88, noBid: 0.1, closeTime: '2026-11-20T12:04:00Z', floorStrike: 100, result: '', ...over };
}

test('roles log a reason and a wide spread is a skipped signal', () => {
  const market = liveMarket({ yesBid: 0.7 });
  const next = stepJournal({ markets: [market], open: [], quotes: { 'KXBTC15M-T': { yesAsk: 0.8 } }, brain: defaultBrain(), existingIds: [], now: Date.parse('2026-11-20T12:01:00Z') });
  const skipped = next.open.filter((row) => row.skipped);
  assert.ok(skipped.length > 0);
  assert.ok(skipped.every((row) => row.allocated === false && row.sizeUsd === 2));
  assert.ok(skipped[0].roles.some((line) => line.role === 'risk' && /spread/.test(line.reason)));
  assert.ok(skipped[0].roles.some((line) => line.role === 'executor'));
});

test('a loss blocks the next two windows and not the third', () => {
  const loss = { allocated: true, pnl: -1, series: 'KXBTC15M', closeTime: '2026-11-20T12:00:00Z' };
  assert.equal(onCooldown([loss], 'KXBTC15M', '2026-11-20T12:15:00Z'), true);
  assert.equal(onCooldown([loss], 'KXBTC15M', '2026-11-20T12:30:00Z'), true);
  assert.equal(onCooldown([loss], 'KXBTC15M', '2026-11-20T12:45:00Z'), false);
  assert.equal(COOLDOWN_WINDOWS, 2);
  const decision = reviewRoles({
    variant: { id: 'late' },
    market: liveMarket({ closeTime: '2026-11-20T12:15:00Z' }),
    sig: { ask: 0.9, features: { secondsLeft: 200, spread: 0.02 } },
    quiet: false,
    settledRows: [loss],
    room: true,
  });
  assert.equal(decision.skipped, true);
  assert.match(decision.skipReason, /cooldown/);
});

test('a scalp take-profit sells the bid and pays a second fee', () => {
  const entry = { variant: 'scalp-tp', exit: 'tp', side: 'yes', ask: 0.5, contracts: 4, sizeUsd: 2, openedAt: new Date(now).toISOString(), closeTime: '2026-11-20T12:10:00Z', series: 'KXBTC15M' };
  assert.equal(shouldExit(entry, { yesBid: 0.52 }, now), null);
  const hit = shouldExit(entry, { yesBid: 0.54 }, now);
  assert.equal(hit.why, 'take-profit');
  const closed = settleExit(entry, hit.bid, hit.why, now);
  assert.equal(closed.sizeUsd, 2);
  assert.ok(closed.fees > 0);
  assert.ok(closed.pnl < 4 * (0.54 - 0.5));
  const champion = { ...entry, variant: 'scalp', exit: null };
  assert.equal(shouldExit(champion, { yesBid: 0.6 }, now), null);
});

test('a time-stop uses the bid, and filters say when a skip saved money', () => {
  const entry = { variant: 'scalp-time', exit: 'time', side: 'yes', ask: 0.4, contracts: 5, sizeUsd: 2, openedAt: new Date(now - 130000).toISOString(), closeTime: '2026-11-20T12:10:00Z' };
  const hit = shouldExit(entry, { yesBid: 0.41 }, now);
  assert.equal(hit.why, 'time-stop');
  const rows = Array.from({ length: 8 }, (_, i) => ({ skipped: true, pnl: -0.4, variant: 'late', ticker: 's' + i }));
  const lesson = filterLessons(rows)[0];
  assert.match(lesson.text, /saved/);
  assert.equal(lesson.saved, true);
});
