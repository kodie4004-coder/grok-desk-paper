import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BENCH_RULE, FOCUS_BENCHED, FOCUS_BENCHED_IDS, isFocusBenched, rollBench, rollingBench, setRollingBench, meetsBench } from '../engine/focus-plan.js';
import { rollingBenchDoc, rollingScan, applyRollingBench, focusDoc } from '../engine/focus.js';
import { focusCardHtml } from '../engine/focus-view.js';
import { VARIANTS, stepJournal, defaultBrain } from '../engine/learn.js';
import { openEarly, EARLY_ID } from '../engine/early.js';
import { readRollingBench, updateRollingBench } from '../runner/rolling-bench.mjs';

const NOW = Date.parse('2026-11-22T12:00:00Z');
// Kalshi rows: six series clusters, mean around pnl, tight spread.
const mk = (variant, pnl, n) => Array.from({ length: n }, (_, i) => ({ variant, pnl: pnl + (i % 2 ? 0.01 : -0.01), series: `S${i % 6}`, ticker: `${variant}-${i}`, window: '2026-11-21', closeTime: '2026-11-21T12:00:00Z' }));
const memeMk = (variant, pnl, n) => Array.from({ length: n }, (_, i) => ({ variant, pnl: pnl + (i % 2 ? 0.01 : -0.01), ca: `C${i % 8}`, id: `${variant}:C${i}` }));
const reset = () => setRollingBench([]);

test('rule constants are unchanged and frozen', () => {
  assert.deepEqual({ ...BENCH_RULE }, { minN: 40, hiBelow: 0 });
  assert.ok(Object.isFrozen(BENCH_RULE));
  assert.equal(FOCUS_BENCHED.length, 11);
  assert.equal(meetsBench({ n: 39, hi: -1 }), false);
  assert.equal(meetsBench({ n: 40, hi: 0 }), false);
  assert.equal(meetsBench({ n: 40, hi: -0.001 }), true);
});

test('a book that meets the rule is benched with the time and the evidence', () => {
  reset();
  const doc = rollingBenchDoc({ rows: mk('mom', -0.3, 60), memeRows: memeMk('early-entry', -0.3, 50), now: NOW });
  const mom = doc.books.find((r) => r.id === 'mom');
  assert.ok(mom);
  assert.equal(mom.book, 'kalshi');
  assert.equal(mom.benchedAt, new Date(NOW).toISOString());
  assert.equal(mom.n, 60);
  assert.ok(mom.mean < 0 && mom.hi < 0);
  const early = doc.books.find((r) => r.id === 'early-entry');
  assert.equal(early.book, 'early');
  assert.equal(early.n, 50);
  assert.deepEqual(doc.added.sort(), ['early-entry', 'mom']);
  assert.equal(doc.liveExecution, false);
  assert.deepEqual(doc.rule, { minN: 40, hiBelow: 0 });
  applyRollingBench(doc.books);
  assert.equal(isFocusBenched('mom'), true);
  assert.equal(isFocusBenched('early-entry'), true);
  assert.equal(isFocusBenched('mom-strict'), false);
  reset();
});

test('n under 40 is not benched, and a 90% high at or above zero is not benched', () => {
  reset();
  const doc = rollingBenchDoc({ rows: [...mk('mom', -0.3, 39), ...mk('revert-wide', 0.05, 80)], now: NOW });
  assert.equal(doc.books.length, 0);
  assert.equal(isFocusBenched('mom'), false);
});

test('the coin-flip control is never benched, even if a file lists it', () => {
  reset();
  const doc = rollingBenchDoc({ rows: mk('flip', -0.5, 200), prev: [{ id: 'flip', book: 'kalshi', n: 1, mean: -1, hi: -1 }], now: NOW });
  assert.equal(doc.books.some((r) => r.id === 'flip'), false);
  const flipScan = rollingScan(mk('flip', -0.5, 200)).find((r) => r.id === 'flip');
  assert.equal(flipScan.control, true);
  assert.equal(rollBench([flipScan], [], NOW).books.length, 0);
  applyRollingBench([{ id: 'flip' }]);
  for (const v of VARIANTS.filter((x) => x.role === 'control')) assert.equal(isFocusBenched(v.id), false);
  reset();
});

test('an already benched book stays benched when its numbers recover, and static books are not listed twice', () => {
  reset();
  const first = rollingBenchDoc({ rows: mk('mom', -0.3, 60), now: NOW });
  assert.ok(first.books.some((r) => r.id === 'mom'));
  const later = rollingBenchDoc({ rows: mk('mom', 0.5, 300), prev: first.books, now: NOW + 86400000 });
  const mom = later.books.find((r) => r.id === 'mom');
  assert.ok(mom, 'never auto-unbench');
  assert.equal(mom.benchedAt, new Date(NOW).toISOString());
  assert.equal(mom.n, 60);
  assert.deepEqual(later.added, []);
  const withStatic = rollingBenchDoc({ rows: mk('scalp', -0.3, 60), now: NOW });
  assert.equal(withStatic.books.some((r) => r.id === 'scalp'), false);
  assert.ok(FOCUS_BENCHED_IDS.has('scalp') && isFocusBenched('scalp'));
});

test('forward rows only: a Kalshi book does not count rows on or before its added day', () => {
  reset();
  const old = mk('late-fee', -0.3, 60).map((r) => ({ ...r, window: '2026-11-20', closeTime: '2026-11-20T12:00:00Z' }));
  const doc = rollingBenchDoc({ rows: old, now: NOW });
  assert.equal(doc.books.some((r) => r.id === 'late-fee'), false);
});

test('a rolling-benched book opens no new Kalshi line, carries weight 0, and stops early entries', () => {
  reset();
  applyRollingBench([{ id: 'mom', book: 'kalshi', label: 'Momentum vs target', benchedAt: new Date(NOW).toISOString(), n: 60, mean: -0.3, hi: -0.2 }, { id: EARLY_ID, book: 'early' }]);
  const close = new Date(NOW + 400000).toISOString();
  const markets = [{ ticker: 'KXBTC15M-J', series: 'KXBTC15M', title: 'BTC', yesAsk: 0.5, yesBid: 0.49, noAsk: 0.51, noBid: 0.5, closeTime: close, floorStrike: 100, result: '' }];
  const next = stepJournal({ markets, open: [], quotes: { 'KXBTC15M-J': { yesAsk: 0.44, yesBid: 0.43, samples: [0.44] } }, brain: defaultBrain(), existingIds: [], settledRows: [], spots: { BTC: { px: 101 } }, now: NOW });
  for (const row of next.open) assert.notEqual(row.variant, 'mom');
  assert.equal(next.brain.weights.mom, 0);
  const added = openEarly({ decisions: [{ action: 'enter', ca: 'X', priceUsd: 1, slip: 0.01, sizeUsd: 2 }], open: [], now: NOW });
  assert.deepEqual(added, []);
  reset();
  assert.equal(openEarly({ decisions: [{ action: 'enter', ca: 'X', priceUsd: 1, slip: 0.01, sizeUsd: 2 }], open: [], now: NOW }).length, 1);
});

test('the file only grows, and the Focus card shows rolled books in the collapsed bench', () => {
  reset();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roll-'));
  const file = path.join(dir, 'rolling-bench.json');
  assert.deepEqual(readRollingBench(file).books, []);
  const a = updateRollingBench({ rows: mk('mom', -0.3, 60), memeRows: [], now: NOW, file });
  assert.deepEqual(a.added, ['mom']);
  const b = updateRollingBench({ rows: mk('mom', 0.4, 80), memeRows: [], now: NOW + 1000, file });
  assert.deepEqual(b.books.map((r) => r.id), ['mom']);
  assert.deepEqual(readRollingBench(file).books.map((r) => r.id), ['mom']);
  assert.equal(isFocusBenched('mom'), true);
  assert.deepEqual(rollingBench().map((r) => r.id), ['mom']);
  const doc = focusDoc({ rows: mk('mom', -0.3, 60), now: NOW });
  assert.equal(doc.rolled.length, 1);
  const html = focusCardHtml(doc);
  assert.match(html, /<details class="focus-bench"><summary>Benched \(12\)<\/summary>/);
  assert.doesNotMatch(html, /<details[^>]* open/);
  assert.match(html, /Rolled onto the bench 2026-11-22/);
  assert.match(html, /Momentum vs target/);
  assert.match(html, /n 60/);
  reset();
  fs.rmSync(dir, { recursive: true, force: true });
});
