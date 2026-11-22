import test from 'node:test';
import assert from 'node:assert/strict';
import { fairYes, fairPick, realizedSigmaPerMinute, FAIR_MARGIN, FAIR_MIN_RETURNS, FAIR_MIN_LEFT, FAIR_MAX_LEFT, FAIR_ADDED_AT, FAIR_SERIES } from '../engine/fair.js';
import { VARIANTS, signal, stepJournal, defaultBrain, pinCleared, LEARN_SIZE } from '../engine/learn.js';
import { feeEdgeClears } from '../engine/kalshi.js';
import { replayVariant, attachSpots } from '../engine/backtest.js';

const fair = VARIANTS.find((v) => v.id === 'fair-spot');

test('fair-spot is pre-registered, pinned at 0, and uses the frozen fee margin', () => {
  assert.equal(fair.kind, 'fair');
  assert.equal(fair.role, 'challenger');
  assert.equal(fair.pinZero, true);
  assert.equal(fair.minLeft, FAIR_MIN_LEFT);
  assert.equal(fair.maxLeft, FAIR_MAX_LEFT);
  assert.equal(fair.feeMargin, FAIR_MARGIN);
  assert.equal(FAIR_MARGIN, 0.02);
  assert.equal(FAIR_MIN_LEFT, 90);
  assert.equal(FAIR_MAX_LEFT, 720);
  assert.equal(FAIR_ADDED_AT, '2026-11-22T08:45:00.000Z');
  assert.equal(fair.addedAt, FAIR_ADDED_AT);
  assert.deepEqual(Object.keys(FAIR_SERIES), ['KXBTC15M', 'KXETH15M', 'KXSOL15M']);
  assert.equal(LEARN_SIZE, 2);
});

test('driftless fair value is N(ln(S/K)/(σ√T)) and skips thin history', () => {
  // 1% above strike, 1% per-minute sigma, 1 minute left → z = ln(1.01)/0.01 ≈ 0.995
  const p = fairYes(101, 100, 0.01, 60);
  assert.ok(p > 0.83 && p < 0.85);
  assert.ok(Math.abs(fairYes(100, 100, 0.01, 60) - 0.5) < 1e-6);
  const closes = Array.from({ length: 40 }, (_, i) => ({ t: i * 60_000, px: 100 + i * 0.01 }));
  assert.equal(realizedSigmaPerMinute(closes, 40 * 60_000), null);
});

test('fairPick only fires when the gap clears the fee plus the 2¢ margin', () => {
  const now = 60 * 60_000;
  const closes = [];
  let px = 100;
  for (let i = 0; i <= 60; i += 1) {
    // tiny noise so sigma is small and a large spot gap is extreme
    px = 100 + (i % 2 ? 0.01 : 0);
    closes.push({ t: i * 60_000, px });
  }
  const spots = { BTC: { px: 110, closes, now } };
  const market = { series: 'KXBTC15M', floorStrike: 100, yesAsk: 0.70, noAsk: 0.32, yesBid: 0.69, noBid: 0.31 };
  const hit = fairPick(market, spots, 300);
  assert.equal(hit.side, 'yes');
  assert.equal(hit.ask, 0.70);
  assert.ok(hit.fair > 0.9);
  assert.equal(feeEdgeClears(hit.fair, 0.70, Math.floor(2 / 0.70), FAIR_MARGIN), true);
  const tight = fairPick({ ...market, yesAsk: 0.99, noAsk: 0.02 }, spots, 300);
  assert.equal(tight, null);
  assert.equal(fairPick({ ...market, series: 'KXDOGE15M' }, spots, 300), null);
});

test('the journal opens fair-spot as a $2 shadow line with weight 0', () => {
  const now = Date.parse('2026-11-23T12:00:00Z');
  const closes = Array.from({ length: 61 }, (_, i) => ({ t: now - (61 - i) * 60_000, px: 100 + (i % 2 ? 0.01 : 0) }));
  const market = { ticker: 'KXBTC15M-F', series: 'KXBTC15M', title: 'BTC', yesAsk: 0.60, noAsk: 0.41, yesBid: 0.59, noBid: 0.40, closeTime: new Date(now + 300000).toISOString(), floorStrike: 100, result: '' };
  const next = stepJournal({ markets: [market], open: [], quotes: {}, brain: defaultBrain(), existingIds: [], settledRows: [], spots: { BTC: { px: 110, closes, now } }, now });
  const line = next.open.find((r) => r.variant === 'fair-spot');
  assert.ok(line);
  assert.equal(line.allocated, false);
  assert.equal(line.sizeUsd, 2);
  assert.equal(line.side, 'yes');
  assert.equal(next.brain.weights['fair-spot'], 0);
  assert.equal(pinCleared(fair, []), false);
});

test('replay with attached candles buys at the recorded ask and does not look ahead', () => {
  const t0 = Date.parse('2026-11-19T12:00:00Z');
  const at = (ms) => new Date(t0 + ms).toISOString();
  const row = (yesAsk, closeMs = 600000) => ['KXBTC15M-A', 'KXBTC15M', at(closeMs), yesAsk - 0.01, yesAsk, 1 - yesAsk, 1 - (yesAsk - 0.01), 100];
  const closes = { BTC: Array.from({ length: 80 }, (_, i) => ({ t: t0 - (80 - i) * 60_000, px: 100 })) };
  closes.BTC.push({ t: t0, px: 110 }); // the 12:00 candle has not closed at 12:00; must not be used
  closes.BTC.push({ t: t0 + 120_000, px: 110 });
  const tape = attachSpots({
    snapshots: [
      { t: at(0), m: [row(0.55)] },
      { t: at(30_000), m: [row(0.55)] },
    ],
    results: { 'KXBTC15M-A': 'yes' },
  }, closes);
  // Both boards are still inside the 12:00 minute, so the 12:00 close is unknown.
  assert.equal(tape.snapshots[0].s.BTC.px, 100);
  assert.equal(tape.snapshots[1].s.BTC.px, 100);
  const { trades } = replayVariant(fair, tape);
  assert.equal(trades.length, 0);
  const sig = signal(fair, { ticker: 'KXBTC15M-A', series: 'KXBTC15M', yesAsk: 0.55, noAsk: 0.46, yesBid: 0.54, noBid: 0.45, closeTime: at(600000), floorStrike: 100 }, t0, { spots: tape.snapshots[0].s });
  assert.equal(sig, null);
});
