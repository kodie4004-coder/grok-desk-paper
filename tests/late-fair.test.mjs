import test from 'node:test';
import assert from 'node:assert/strict';
import { VARIANTS, signal, stepJournal, defaultBrain, reviewBrain, sideWinProb, lateFairPick, FEE_EDGE_MARGIN, LEARN_SIZE } from '../engine/learn.js';
import { fairV2Prob, fairPickV2, LATE_FAIR_ADDED_AT, FAIR_V2_MARGIN } from '../engine/fair.js';
import { feeEdgeClears } from '../engine/kalshi.js';
import { replayable } from '../engine/backtest.js';
import { RESEARCH_SHADOWS } from '../engine/focus-plan.js';

const lateFair = VARIANTS.find((v) => v.id === 'late-fair');

function v2Spots({ now, openPx = 100, spot = 100, close }) {
  const open = Date.parse(close) - 15 * 60_000;
  const closes = [];
  for (let t = now - 61 * 60_000; t + 60_000 <= now; t += 60_000) {
    const tm = Math.floor(t / 60_000) * 60_000;
    closes.push({ t: tm, px: (tm === open - 120_000 || tm === open - 60_000) ? openPx : openPx + ((tm / 60_000) % 2 ? 0.02 : 0) });
  }
  return { BTC: { px: spot, pxSource: 'Coinbase estimate', pxAt: now, source: 'Coinbase 1m', closes, now } };
}

const close = '2026-11-23T15:15:00.000Z';
const now = Date.parse(close) - 240_000;
const fav = (over = {}) => ({ ticker: 'KXBTC15M-LF', series: 'KXBTC15M', title: 'BTC', floorStrike: 100, yesAsk: 0.86, noAsk: 0.15, yesBid: 0.85, noBid: 0.14, closeTime: close, result: '', ...over });

test('late-fair is a $2 shadow, pinned at 0, written down before any row, and not replayable', () => {
  assert.ok(lateFair);
  assert.equal(lateFair.kind, 'latefair');
  assert.equal(lateFair.family, 'fair');
  assert.equal(lateFair.role, 'challenger');
  assert.equal(lateFair.pinZero, true);
  assert.equal(lateFair.minAsk, 0.85);
  assert.equal(lateFair.minLeft, 180);
  assert.equal(lateFair.maxLeft, 300);
  assert.equal(lateFair.feeMargin, FAIR_V2_MARGIN);
  assert.equal(lateFair.addedAt, LATE_FAIR_ADDED_AT);
  assert.equal(LATE_FAIR_ADDED_AT, '2026-11-23T14:30:00.000Z');
  assert.equal(replayable(lateFair), false);
  assert.ok(RESEARCH_SHADOWS.some((row) => row.id === 'late-fair'));
});

test('the quote-mid proxy can never clear the fee filter on a consistent book', () => {
  for (let bid = 1; bid < 99; bid += 1) {
    for (let ask = bid; ask < 100; ask += 1) {
      const m = { yesBid: bid / 100, yesAsk: ask / 100, noAsk: 1 - bid / 100 };
      for (const side of ['yes', 'no']) {
        const p = sideWinProb(m, side);
        const price = side === 'yes' ? m.yesAsk : m.noAsk;
        const n = Math.floor(LEARN_SIZE / price);
        if (p == null || n < 1) continue;
        assert.equal(feeEdgeClears(p, price, n, FEE_EDGE_MARGIN), false, bid + '/' + ask + ' ' + side);
      }
    }
  }
});

test('late-fee and scalp-fee are retired: no signal and weight 0', () => {
  for (const id of ['late-fee', 'scalp-fee']) {
    const v = VARIANTS.find((row) => row.id === id);
    assert.equal(v.retired, true);
    assert.equal(signal(v, fav(), now, { spots: v2Spots({ now, spot: 101, close }) }), null);
  }
  const brain = reviewBrain(defaultBrain(), [], Date.parse('2026-11-24T00:00:00Z'), { iters: 20 });
  assert.equal(brain.weights['late-fee'], 0);
  assert.equal(brain.weights['scalp-fee'], 0);
});

test('late-fair keeps the favorite only when the same-venue model clears ask, fee and 3 cents', () => {
  const up = v2Spots({ now, openPx: 100, spot: 101, close });
  const model = fairV2Prob(fav(), up);
  assert.ok(model && model.fair > 0.95);
  const pick = lateFairPick(fav(), up, 0.85);
  assert.equal(pick.side, 'yes');
  assert.equal(pick.ask, 0.86);
  assert.ok(Math.abs(pick.pEst - model.fair) < 1e-12);
  // Flat spot: the model says 0.5, so a 0.86 favorite does not clear, and it does not flip to the cheap side.
  assert.equal(lateFairPick(fav(), v2Spots({ now, spot: 100, close }), 0.85), null);
  // Model agrees, but the favorite is under 0.85.
  assert.equal(lateFairPick(fav({ yesAsk: 0.80, yesBid: 0.79, noAsk: 0.21 }), up, 0.85), null);
  // No model inputs outside BTC/ETH/SOL.
  assert.equal(lateFairPick(fav({ series: 'KXDOGE15M' }), up, 0.85), null);
  // The time window is the late-favorite window.
  assert.equal(signal(lateFair, fav(), Date.parse(close) - 400_000, { spots: up }), null);
  const sig = signal(lateFair, fav(), now, { spots: up });
  assert.equal(sig.side, 'yes');
  assert.ok(sig.features.pEst > 0.95);
});

test('fair-spot-v2 picks are unchanged by the shared probability helper', () => {
  const spots = v2Spots({ now: Date.parse('2026-11-23T12:07:00.000Z'), close: '2026-11-23T12:15:00.000Z' });
  const market = { series: 'KXBTC15M', floorStrike: 100.05, yesAsk: 0.40, noAsk: 0.42, yesBid: 0.39, noBid: 0.41, closeTime: '2026-11-23T12:15:00.000Z' };
  const pick = fairPickV2(market, spots);
  assert.equal(pick.side, 'yes');
  assert.ok(Math.abs(pick.fair - 0.5) < 1e-9);
  assert.equal(pick.pEst, pick.fair);
});

test('the journal opens late-fair as a $2 shadow line and nothing for the retired bots', () => {
  const next = stepJournal({ markets: [fav()], open: [], quotes: {}, brain: defaultBrain(), existingIds: [], settledRows: [], spots: v2Spots({ now, spot: 101, close }), now });
  const line = next.open.find((r) => r.variant === 'late-fair');
  assert.ok(line);
  assert.equal(line.allocated, false);
  assert.equal(line.sizeUsd, 2);
  assert.equal(line.side, 'yes');
  assert.equal(next.brain.weights['late-fair'], 0);
  assert.equal(next.brain.weights['late-fee'], 0);
  assert.equal(next.brain.weights['scalp-fee'], 0);
  assert.equal(next.open.some((r) => r.variant === 'late-fee' || r.variant === 'scalp-fee'), false);
});

