import test from 'node:test';
import assert from 'node:assert/strict';
import { feeRate, takerFee, resolutionPnl, favoriteEntry, longshotFade, yesWon, quoteInWindow, PREDICT_RULES } from '../engine/predict.js';

test('taker fee is zero when the market says fees are off', () => {
  assert.equal(feeRate({ feesEnabled: false, feeSchedule: { rate: 0.07 } }), 0);
  assert.equal(feeRate({ feesEnabled: true, feeSchedule: { rate: 0.04 } }), 0.04);
  assert.equal(feeRate({ feesEnabled: true }), 0.07);
});

test('a resolved favorite keeps the fee and the haircut', () => {
  const r = resolutionPnl(0.7, true, 0.04);
  assert.ok(Math.abs(r.cost - (0.7 + takerFee(0.7, 0.04) + 0.005)) < 1e-9);
  assert.ok(r.pnl > 0 && r.pnl < 0.3);
  const lost = resolutionPnl(0.7, false, 0.04);
  assert.ok(lost.pnl < -0.7);
});

test('favorite and longshot bands match the frozen cuts', () => {
  assert.equal(favoriteEntry(0.6).side, 'yes');
  assert.equal(favoriteEntry(0.8), null);
  assert.equal(favoriteEntry(0.4).side, 'no');
  assert.equal(favoriteEntry(0.2), null);
  assert.equal(longshotFade(0.85).side, 'yes');
  assert.equal(longshotFade(0.95).side, 'yes');
  assert.equal(longshotFade(0.96), null);
  assert.equal(longshotFade(0.05).side, 'no');
  assert.equal(longshotFade(0.04), null);
  assert.equal(yesWon('["1","0"]'), true);
  assert.equal(yesWon('["0","1"]'), false);
});

test('the late window is 36 hours to 12 hours before the end', () => {
  const end = Date.parse('2026-06-10T00:00:00Z');
  const late = PREDICT_RULES.find((r) => r.id === 'p3');
  assert.equal(quoteInWindow(late, end - 20 * 3600000, end), true);
  assert.equal(quoteInWindow(late, end - 2 * 3600000, end), false);
  assert.equal(quoteInWindow(late, end + 1000, end), false);
});
