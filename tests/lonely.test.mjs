import test from 'node:test';
import assert from 'node:assert/strict';
import { isLonely, lonelyBook, stampLonely, emitLonely, LONELY_ID, LONELY_GAP_MS, LONELY_ADDED_AT } from '../engine/lonely.js';
import { stepMeme, MEME_SIZE } from '../engine/meme.js';
import { openEarly, EARLY_ID } from '../engine/early.js';

test('lonely-entry uses a frozen 5-minute gap and is not a second $2 line', () => {
  assert.equal(LONELY_ID, 'lonely-entry');
  assert.equal(LONELY_GAP_MS, 5 * 60 * 1000);
  assert.equal(LONELY_ADDED_AT, '2026-11-22T08:45:00.000Z');
  assert.equal(MEME_SIZE, 2);
});

test('isLonely is true only when no earlier coin entry sits inside the gap', () => {
  const t0 = Date.parse('2026-11-22T12:00:00Z');
  const rows = [
    { variant: 'meme-safety', openedAt: new Date(t0).toISOString(), id: 'a', ca: 'A' },
    { variant: 'early-entry', openedAt: new Date(t0 + 60_000).toISOString(), id: 'b', ca: 'B' },
    { variant: 'meme-safety', openedAt: new Date(t0 + 6 * 60_000).toISOString(), id: 'c', ca: 'C' },
  ];
  assert.equal(isLonely(t0, []), true);
  assert.equal(isLonely(t0 + 60_000, rows.slice(0, 1)), false);
  assert.equal(isLonely(t0 + 6 * 60_000, rows.slice(0, 2)), true);
  assert.equal(isLonely(t0 + 30_000, [{ variant: 'early-exit-fast', openedAt: new Date(t0).toISOString() }]), true);
});

test('lonelyBook keeps only settled source rows that pass the filter, using dropped rows as the clock', () => {
  const t0 = Date.parse('2026-11-22T12:00:00Z');
  const row = (id, min, pnl, variant = 'meme-safety') => ({
    id, variant, ca: id, openedAt: new Date(t0 + min * 60_000).toISOString(), pnl, sizeUsd: 2, paper: true,
  });
  const book = lonelyBook([
    row('a', 0, 0.1),
    row('b', 2, -0.2),
    row('c', 6, 0.3),
    { ...row('d', 7, 0.4), skipped: true },
    row('e', 12, 0.5, 'early-entry'),
  ]);
  // b is dropped but still crowds c (only 4 minutes later). e is 10 minutes after b.
  assert.deepEqual(book.map((r) => r.ca), ['a', 'e']);
  assert.ok(book.every((r) => r.variant === LONELY_ID && r.allocated === false && r.shadow === true && r.sizeUsd === 2));
  assert.equal(book[0].pnl, 0.1);
  assert.equal(book[1].pnl, 0.5);
});

test('stepMeme stamps eligibility and emits a shadow row only when the parent settles', () => {
  const now = Date.parse('2026-11-23T12:00:00Z');
  const coin = { ca: 'Mint1', symbol: 'AAA', name: 'Aaa', priceUsd: 1, pass: true };
  const opened = stepMeme({ coins: [coin], open: [], history: [], now });
  const pos = opened.open.find((p) => p.variant === 'meme-safety');
  assert.ok(pos);
  assert.equal(pos.lonelyEligible, true);
  assert.equal(opened.shadows.some((r) => r.variant === LONELY_ID), false);
  const later = now + 60_000;
  const settled = stepMeme({
    coins: [{ ...coin, priceUsd: 1.3 }],
    open: [pos],
    history: [],
    now: later,
  });
  const parent = settled.settled.find((r) => r.variant === 'meme-safety');
  const shadow = settled.shadows.find((r) => r.variant === LONELY_ID);
  assert.ok(parent);
  assert.ok(shadow);
  assert.equal(shadow.pnl, parent.pnl);
  assert.equal(shadow.sizeUsd, 2);
  assert.equal(shadow.allocated, false);
  assert.equal(settled.open.some((p) => p.variant === LONELY_ID), false);
});

test('a crowded safety open is not lonely, and early-entry is stamped from open history', () => {
  const now = Date.parse('2026-11-23T13:00:00Z');
  const prior = { variant: 'early-entry', openedAt: new Date(now - 60_000).toISOString(), ca: 'Old', id: 'early-entry:Old', skipped: false };
  const opened = stepMeme({
    coins: [{ ca: 'Mint2', symbol: 'BBB', name: 'Bbb', priceUsd: 1, pass: true }],
    open: [],
    history: [prior],
    now,
  });
  const pos = opened.open.find((p) => p.variant === 'meme-safety');
  assert.equal(pos.lonelyEligible, false);
  const early = openEarly({
    decisions: [{ action: 'enter', ca: 'Mint3', symbol: 'CCC', name: 'Ccc', priceUsd: 1, slip: 0.02, sizeUsd: 2 }],
    open: opened.open,
    history: [prior],
    now,
  });
  assert.equal(early[0].variant, EARLY_ID);
  assert.equal(early[0].lonelyEligible, false);
  assert.equal(stampLonely({ openedAt: new Date(now + 10 * 60_000).toISOString(), variant: 'meme-safety' }, [prior], now + 10 * 60_000).lonelyEligible, true);
  assert.equal(emitLonely([{ ...pos, lonelyEligible: false, pnl: 1 }]).length, 0);
});
