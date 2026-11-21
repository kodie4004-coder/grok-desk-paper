import test from 'node:test';
import assert from 'node:assert/strict';
import { ageLabel, feedAge, isAllocatedRow, isShadowRow, repairProgress, STALE_MS, OLD_MS, todayBooks, todayDoc } from '../engine/today.js';
import { todayHeaderHtml, money } from '../engine/today-view.js';
import { REPAIR_MIN_N, REPAIR_SIZE_USD } from '../engine/repair.js';

const day = '2026-11-21';
const now = Date.parse('2026-11-21T14:08:00Z');

const row = (over) => ({
  pnl: 0.2,
  fees: 0.05,
  allocated: true,
  variant: 'mom',
  settledAt: `${day}T12:00:00Z`,
  ...over,
});

test('feed age is plain words, amber at 20 minutes, red at 60 minutes or missing', () => {
  assert.equal(feedAge('2026-11-21T14:05:00Z', now).label, 'updated 3 min ago');
  assert.equal(feedAge('2026-11-21T14:05:00Z', now).tone, 'fresh');
  assert.equal(feedAge('2026-11-21T14:05:00Z', now).stale, false);
  const almost = feedAge(now - (STALE_MS - 1), now);
  assert.equal(almost.tone, 'fresh');
  assert.equal(almost.stale, false);
  const amber = feedAge(now - STALE_MS, now);
  assert.equal(amber.tone, 'stale');
  assert.equal(amber.stale, true);
  assert.equal(amber.label, 'updated 20 min ago');
  const red = feedAge(now - OLD_MS, now);
  assert.equal(red.tone, 'old');
  assert.equal(red.label, 'updated 1 hr ago');
  const missing = feedAge(null, now);
  assert.equal(missing.tone, 'old');
  assert.equal(missing.stale, true);
  assert.equal(missing.label, 'no update time');
  assert.equal(ageLabel(0), 'updated just now');
  assert.equal(ageLabel(59 * 1000), 'updated just now');
  assert.equal(ageLabel(90 * 60 * 1000), 'updated 1 hr 30 min ago');
  assert.equal(ageLabel(26 * 60 * 60 * 1000), 'updated 1 day ago');
});

test('today books split allocated from shadow the way PR #27 does, and ignore other days', () => {
  const rows = [
    row({ pnl: 1.25, fees: 0.1, allocated: true, variant: 'meme-safety' }),
    row({ pnl: -0.4, fees: 0.05, allocated: false, variant: 'meme-safety' }),
    row({ pnl: 0.5, fees: 0.02, allocated: false, variant: 'early-entry' }),
    row({ pnl: 9, fees: 0, allocated: false, variant: 'flip', settledAt: '2026-11-20T12:00:00Z' }),
    row({ pnl: -0.2, fees: 0.01, allocated: true, variant: 'early-exit-fast' }),
  ];
  assert.equal(isAllocatedRow(rows[0]), true);
  assert.equal(isShadowRow(rows[0]), false);
  assert.equal(isAllocatedRow(rows[1]), false);
  assert.equal(isShadowRow(rows[1]), true);
  assert.equal(isAllocatedRow(rows[4]), false);
  assert.equal(isShadowRow(rows[4]), true);
  const books = todayBooks(rows, day);
  assert.equal(books.allocated.n, 1);
  assert.equal(books.allocated.pnl, 1.25);
  assert.equal(books.allocated.fees, 0.1);
  assert.equal(books.shadow.n, 3);
  assert.equal(books.shadow.pnl, -0.1);
  assert.equal(books.shadow.fees, 0.08);
});

test('repair progress counts only safety-sleeve shadows and needs 20 with a positive mean', () => {
  const early = Array.from({ length: 20 }, (_, i) => row({ pnl: 0.4, allocated: false, variant: 'early-entry', settledAt: `${day}T0${i % 10}:00:00Z` }));
  const safety = Array.from({ length: 12 }, (_, i) => row({ pnl: -0.1, allocated: false, variant: 'meme-safety', settledAt: `${day}T01:0${i % 10}:00Z` }));
  const mixed = repairProgress([...early, ...safety, row({ pnl: 0.5, allocated: true, variant: 'meme-safety' })]);
  assert.equal(mixed.n, 12);
  assert.equal(mixed.need, REPAIR_MIN_N);
  assert.equal(mixed.sizeUsd, REPAIR_SIZE_USD);
  assert.equal(mixed.pass, false);
  assert.ok(mixed.mean < 0);
  const ready = repairProgress(Array.from({ length: 20 }, () => row({ pnl: 0.2, allocated: false, variant: 'meme-safety' })));
  assert.equal(ready.pass, true);
  assert.equal(ready.n, 20);
  const enoughButDown = repairProgress(Array.from({ length: 20 }, () => row({ pnl: -0.05, allocated: false, variant: 'meme-safety' })));
  assert.equal(enoughButDown.pass, false);
  assert.equal(enoughButDown.n, 20);
});

test('the Today header shows freshness, both books, and the repair bar from the fixture, and invents no numbers while loading', () => {
  const doc = todayDoc({
    kalshiRows: [row({ pnl: -0.5, allocated: true, variant: 'late-loose', fees: 0.07 })],
    memeRows: [
      row({ pnl: -0.2, allocated: false, variant: 'meme-safety', fees: 0.04 }),
      row({ pnl: 0.1, allocated: false, variant: 'early-entry', fees: 0.03 }),
    ],
    kalshiFetchedAt: '2026-11-21T14:05:00Z',
    memeFetchedAt: '2026-11-21T13:40:00Z',
    now,
  });
  assert.equal(doc.liveExecution, false);
  assert.equal(doc.paper, true);
  assert.equal(doc.allocated.n, 1);
  assert.equal(doc.allocated.pnl, -0.5);
  assert.equal(doc.shadow.n, 2);
  assert.equal(doc.shadow.pnl, -0.1);
  assert.equal(doc.repair.n, 1);
  assert.equal(doc.feeds.kalshi.label, 'updated 3 min ago');
  assert.equal(doc.feeds.meme.tone, 'stale');
  const html = todayHeaderHtml(doc, { now });
  assert.match(html, /<h2[^>]*>Today<\/h2>/);
  assert.match(html, /Kalshi snapshot/);
  assert.match(html, /updated 3 min ago/);
  assert.match(html, /Coin feed/);
  assert.match(html, /updated 28 min ago/);
  assert.match(html, /is-fresh/);
  assert.match(html, /is-stale/);
  assert.match(html, /Allocated/);
  assert.match(html, /−\$0\.50/);
  assert.match(html, /1 trade</);
  assert.match(html, /Shadow/);
  assert.match(html, /−\$0\.10/);
  assert.match(html, /2 trades/);
  assert.match(html, /Coin repair/);
  assert.match(html, /1 of 20/);
  assert.match(html, /Needs 20 shadow trades with a positive mean/);
  assert.match(html, /Size stays \$2/);
  assert.match(html, /live_execution stays off/);
  assert.match(html, /After fees, so far today/);
  assert.equal(money(0), '$0.00');
  const loading = todayHeaderHtml(null, { state: 'loading' });
  assert.match(loading, /Loading today's paper numbers/);
  assert.doesNotMatch(loading, /\$0\.00/);
  assert.match(todayHeaderHtml(null, { state: 'error' }), /did not load/);
  const staleDay = todayHeaderHtml({ ...doc, day: '2026-11-20' }, { now });
  assert.match(staleDay, /After fees on 2026-11-20 \(UTC\)/);
  assert.match(staleDay, /has not landed yet/);
});
