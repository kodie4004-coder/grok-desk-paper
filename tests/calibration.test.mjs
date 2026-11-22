import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { modelCalibration, calibrationRows, calibrationLine } from '../engine/calibration.js';
import { lessonsDocument, lessonsMarkdown, morningReport, defaultBrain, variantAddedAt, VARIANTS, signal, LEARN_SIZE } from '../engine/learn.js';
import { fairPickV2, openAnchor, FAIR_V2_MARGIN, FAIR_MARGIN, FAIR_V2_ADDED_AT, FAIR_ADDED_AT } from '../engine/fair.js';
import { replayable } from '../engine/backtest.js';

const row = (over) => ({
  variant: 'model-a', paper: true, skipped: false, ask: 0.2, pEst: 0.3, won: false, pnl: -2.1,
  openedAt: '2026-11-22T10:00:00.000Z', settledAt: '2026-11-22T10:16:00.000Z', closeTime: '2026-11-22T10:15:00Z', ticker: 'T1', ...over,
});

test('the audit computes n, wins, sums, both Brier scores and the after-fee mean from rows', () => {
  const rows = [
    row({ ask: 0.2, pEst: 0.3, won: false, pnl: -2.1 }),
    row({ ask: 0.4, pEst: 0.5, won: true, pnl: 2.9, closeTime: '2026-11-22T10:30:00Z' }),
    row({ ask: 0.9, pEst: 0.99, won: false, pnl: -2.05, closeTime: '2026-11-22T10:45:00Z' }),
  ];
  const [a] = modelCalibration(rows, {});
  assert.equal(a.id, 'model-a');
  assert.equal(a.n, 3);
  assert.equal(a.wins, 1);
  assert.equal(a.windows, 3);
  assert.equal(a.sumAsk, 1.5);
  assert.equal(a.sumPEst, 1.79);
  const bModel = (0.3 ** 2 + 0.5 ** 2 + 0.99 ** 2) / 3;
  const bMarket = (0.2 ** 2 + 0.6 ** 2 + 0.9 ** 2) / 3;
  assert.equal(a.brierModel, Math.round(bModel * 1000) / 1000);
  assert.equal(a.brierMarket, Math.round(bMarket * 1000) / 1000);
  assert.equal(a.beatsMarket, bModel < bMarket);
  assert.equal(a.net, -1.25);
  assert.equal(a.mean, Math.round((-1.25 / 3) * 100) / 100);
  assert.equal(a.small, true);
  assert.match(a.text, /model-a's prices were less accurate than Kalshi's own \(Brier 0\.\d{3} vs 0\.\d{3}\)/);
  assert.match(a.text, /won 1 of 3/);
});

test('only settled paper rows with a pEst on or after addedAt count', () => {
  const rows = [
    row({ openedAt: '2026-11-22T08:00:00.000Z' }), // before addedAt
    row({ skipped: true }),
    row({ won: null, pnl: null, result: 'missing' }),
    row({ pEst: undefined }),
    row({ paper: false }),
    row({ settledAt: undefined }),
    row({ variant: 'other' }),
    row({ won: true, pnl: 6 }),
  ];
  const kept = calibrationRows(rows, 'model-a', '2026-11-22T09:00:00.000Z');
  assert.equal(kept.length, 1);
  const out = modelCalibration(rows, { 'model-a': '2026-11-22T09:00:00.000Z' });
  assert.deepEqual(out.map((r) => r.id), ['model-a', 'other']);
  assert.equal(out[0].n, 1);
  assert.equal(modelCalibration([], {}).length, 0);
});

test('the plain line says more accurate when the model beats the ask', () => {
  const text = calibrationLine({ id: 'x', n: 40, wins: 30, sumAsk: 25, sumPEst: 29, brierModel: 0.15, brierMarket: 0.18, mean: 0.4, small: false });
  assert.match(text, /x's prices were more accurate than Kalshi's own \(Brier 0\.150 vs 0\.180\)/);
  assert.doesNotMatch(text, /Small sample/);
});

test('lessons, LESSONS.md and the morning report carry the audit from the data', () => {
  const rows = [
    row({ variant: 'fair-spot', openedAt: FAIR_ADDED_AT, ask: 0.15, pEst: 0.21, won: false, pnl: -2.07, window: '2026-11-22' }),
    row({ variant: 'fair-spot', openedAt: '2026-11-22T07:00:00.000Z', ask: 0.5, pEst: 0.9, won: true, pnl: 1.9, window: '2026-11-22' }),
  ];
  const now = Date.parse('2026-11-23T00:00:00Z');
  const doc = lessonsDocument(rows, null, defaultBrain(), now);
  assert.equal(doc.calibration.length, 1);
  assert.equal(doc.calibration[0].id, 'fair-spot');
  assert.equal(doc.calibration[0].n, 1, 'rows before fair-spot addedAt are not counted');
  assert.equal(doc.calibration[0].brierModel, 0.044);
  assert.equal(doc.calibration[0].brierMarket, 0.023);
  const md = lessonsMarkdown(doc);
  assert.match(md, /## Model vs market/);
  assert.match(md, /fair-spot's prices were less accurate than Kalshi's own \(Brier 0\.044 vs 0\.023\)/);
  const morning = morningReport(rows, defaultBrain(), doc.summary, now);
  assert.equal(morning.modelVsMarket.length, 1);
  assert.match(morning.modelVsMarket[0], /less accurate/);
  assert.equal(variantAddedAt()['fair-spot'], FAIR_ADDED_AT);
});

test('the app renders a Model vs market card from today.json or lessons.json, with no hard-coded Brier', () => {
  const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  assert.match(app, /function modelMarketCard\(doc, today\)/);
  assert.match(app, /freshCalibration\(doc, today\)/);
  assert.match(app, /Model vs market/);
  assert.doesNotMatch(app, /0\.208|0\.177/);
});

// fair-spot-v2 ---------------------------------------------------------------

const v2 = VARIANTS.find((v) => v.id === 'fair-spot-v2');

test('fair-spot-v2 is a separate $2 shadow, pinned at 0, with a stricter margin and a later addedAt', () => {
  assert.ok(v2);
  assert.equal(v2.kind, 'fair2');
  assert.equal(v2.role, 'challenger');
  assert.equal(v2.pinZero, true);
  assert.equal(v2.addedAt, FAIR_V2_ADDED_AT);
  assert.ok(Date.parse(FAIR_V2_ADDED_AT) > Date.parse(FAIR_ADDED_AT));
  assert.ok(FAIR_V2_MARGIN >= FAIR_MARGIN);
  assert.equal(v2.feeMargin, FAIR_V2_MARGIN);
  assert.equal(LEARN_SIZE, 2);
  assert.equal(replayable(v2), false, 'v2 needs live spot venue and time, so no backtest can promote it');
  const v1 = VARIANTS.find((v) => v.id === 'fair-spot');
  assert.equal(v1.kind, 'fair');
  assert.equal(v1.feeMargin, 0.02);
});

function v2Spots({ now, openPx = 100, spot = 100, pxSource = 'Coinbase estimate', source = 'Coinbase 1m', close }) {
  const open = Date.parse(close) - 15 * 60_000;
  const closes = [];
  for (let t = now - 61 * 60_000; t + 60_000 <= now; t += 60_000) {
    const tm = Math.floor(t / 60_000) * 60_000;
    closes.push({ t: tm, px: (tm === open - 120_000 || tm === open - 60_000) ? openPx : openPx + ((tm / 60_000) % 2 ? 0.02 : 0) });
  }
  return { BTC: { px: spot, pxSource, pxAt: now, source, closes, now } };
}

test('v2 prices against the Coinbase price at the open, not the BRTI strike', () => {
  const close = '2026-11-23T12:15:00.000Z';
  const now = Date.parse('2026-11-23T12:07:00.000Z');
  // BRTI strike sits 5 bps above the Coinbase open; Coinbase spot is flat on its own open.
  const market = { series: 'KXBTC15M', floorStrike: 100.05, yesAsk: 0.40, noAsk: 0.42, yesBid: 0.39, noBid: 0.41, closeTime: close };
  const spots = v2Spots({ now, openPx: 100, spot: 100, close });
  assert.equal(openAnchor(spots.BTC.closes, close), 100);
  const pick = fairPickV2(market, spots);
  // fair is 0.5 on the same venue, so the 0.40 yes ask clears; v1 would have leaned NO.
  assert.equal(pick.side, 'yes');
  assert.ok(Math.abs(pick.fair - 0.5) < 1e-9);
  assert.equal(pick.anchor, 100);
});

test('v2 skips mixed venues, a missing open anchor, a wide basis, and a short clock from the spot time', () => {
  const close = '2026-11-23T12:15:00.000Z';
  const now = Date.parse('2026-11-23T12:07:00.000Z');
  const market = { series: 'KXBTC15M', floorStrike: 100, yesAsk: 0.40, noAsk: 0.42, closeTime: close };
  assert.equal(fairPickV2(market, v2Spots({ now, close, pxSource: 'OKX estimate' })), null);
  assert.equal(fairPickV2(market, v2Spots({ now, close, source: 'Binance 1m' })), null);
  assert.equal(fairPickV2({ ...market, floorStrike: 100.5 }, v2Spots({ now, close })), null);
  const gap = v2Spots({ now, close });
  gap.BTC.closes = gap.BTC.closes.filter((row) => row.t !== Date.parse(close) - 15 * 60_000 - 60_000);
  assert.equal(fairPickV2(market, gap), null);
  const late = v2Spots({ now, close });
  late.BTC.pxAt = Date.parse(close) - 80_000;
  assert.equal(fairPickV2(market, late), null);
  assert.equal(fairPickV2({ ...market, series: 'KXDOGE15M' }, v2Spots({ now, close })), null);
});

test('v2 goes through signal() as a $2 line with pEst', () => {
  const close = '2026-11-23T12:15:00.000Z';
  const now = Date.parse('2026-11-23T12:07:00.000Z');
  const market = { ticker: 'KXBTC15M-X', series: 'KXBTC15M', floorStrike: 100.05, yesAsk: 0.40, noAsk: 0.62, yesBid: 0.39, noBid: 0.59, closeTime: close };
  const sig = signal(v2, market, now, { spots: v2Spots({ now, close }) });
  assert.equal(sig.side, 'yes');
  assert.ok(Math.abs(sig.features.pEst - 0.5) < 1e-9);
});

test('freshCalibration prefers the per-snapshot audit when it is newer than the nightly one', async () => {
  const { freshCalibration } = await import('../engine/calibration.js');
  const lessons = { generatedAt: '2026-11-22T15:16:36.896Z', calibration: [{ id: 'old', n: 5 }] };
  const today = { calibrationAt: '2026-11-22T23:07:55.751Z', calibration: [{ id: 'new', n: 63 }] };
  assert.equal(freshCalibration(lessons, today).rows[0].id, 'new');
  assert.equal(freshCalibration(lessons, today).source, 'snapshot');
  const stale = { calibrationAt: '2026-11-22T10:00:00.000Z', calibration: [{ id: 'new' }] };
  assert.equal(freshCalibration(lessons, stale).rows[0].id, 'old');
  assert.equal(freshCalibration(lessons, null).source, 'nightly');
  assert.equal(freshCalibration(null, today).rows[0].id, 'new');
  assert.equal(freshCalibration(null, null).rows, null);
  assert.equal(freshCalibration({ calibration: [] }, null).rows.length, 0);
});

test('writeTodayFile writes the Model vs market audit on every snapshot', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { writeTodayFile } = await import('../runner/write-today.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'today-cal-'));
  const prev = process.cwd();
  try {
    process.chdir(dir);
    const rows = [row({ variant: 'fair-spot-v2', openedAt: '2026-11-22T20:00:00.000Z', settledAt: '2026-11-22T20:16:00.000Z' })];
    const out = writeTodayFile({ now: Date.parse('2026-11-22T23:00:00Z'), kalshiRows: rows, memeRows: [] });
    assert.ok(Array.isArray(out.calibration));
    assert.equal(out.calibration.find((r) => r.id === 'fair-spot-v2').n, 1);
    assert.equal(out.calibrationAt, out.generatedAt);
    assert.equal(out.liveExecution, false);
    const disk = JSON.parse(fs.readFileSync('data/today.json', 'utf8'));
    assert.equal(disk.calibration.length, out.calibration.length);
  } finally {
    process.chdir(prev);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
