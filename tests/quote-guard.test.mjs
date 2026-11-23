import test from 'node:test';
import assert from 'node:assert/strict';
import { saneQuote, isQuoteError, withoutQuoteErrors, QUOTE_MAX_RATIO } from '../engine/quote-guard.js';
import { stepMeme, watchExit, pricesFromDex } from '../engine/meme.js';
import { stepTrend, TREND_ID } from '../engine/trend.js';
import { repairGate, sleeveBenched } from '../engine/repair.js';
import { todayDoc } from '../engine/today.js';
import { todayHeaderHtml } from '../engine/today-view.js';

const PUMP = 'pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn';
// The three rows from data/meme-journal.jsonl on 2026-11-23 (entry, exitPx, pnl as recorded).
const bad = [
  { id: `trend-rotate:${PUMP}:a`, ca: PUMP, variant: 'trend-rotate', allocated: false, entry: 0.002720869052113425, exitPx: 11.95, pnl: 8500.368195616053, sizeUsd: 2, exit: 'take-profit', openedAt: '2026-11-23T14:35:28.405Z', settledAt: '2026-11-23T14:40:05.312Z' },
  { id: `trend-rotate:${PUMP}:b`, ca: PUMP, variant: 'trend-rotate', allocated: false, entry: 0.0027366602570376734, exitPx: 11.92, pnl: 8430.085534303911, sizeUsd: 2, exit: 'take-profit', openedAt: '2026-11-23T14:40:05.312Z', settledAt: '2026-11-23T14:44:08.461Z' },
  { id: `trend-rotate:${PUMP}:c`, ca: PUMP, variant: 'trend-rotate', allocated: false, entry: 0.002735756340918568, exitPx: 11.92, pnl: 8432.871572123157, sizeUsd: 2, exit: 'take-profit', openedAt: '2026-11-23T14:44:08.461Z', settledAt: '2026-11-23T14:48:15.052Z' },
];
const losers = Array.from({ length: 25 }, (_, i) => ({ id: `meme:L${i}`, ca: `L${i}`, variant: 'meme-safety', allocated: false, entry: 1, exitPx: 0.85, pnl: -0.35, sizeUsd: 2, exit: 'stop', openedAt: '2026-11-23T10:00:00Z', settledAt: '2026-11-23T10:05:00Z' }));

test('band is fixed at 100x up, with no floor so rugs stay real losses', () => {
  assert.equal(QUOTE_MAX_RATIO, 100);
  assert.equal(saneQuote(1, 7.5), true);
  assert.equal(saneQuote(1, 100), true);
  assert.equal(saneQuote(1, 100.01), false);
  assert.equal(saneQuote(1, 0.0001), true);
  assert.equal(isQuoteError({ entry: 0.0000017, exitPx: 6.569e-9, pnl: -2.02 }), false);
  assert.equal(saneQuote(0, 1), false);
  for (const row of bad) assert.equal(isQuoteError(row), true);
  assert.equal(isQuoteError(losers[0]), false);
  assert.equal(isQuoteError({ pnl: 1 }), false);
});

test('bad-quote rows cannot pass the coin repair gate or unbench the sleeve', () => {
  const rows = [...losers, ...bad];
  const gate = repairGate(rows);
  assert.equal(gate.pass, false);
  assert.equal(gate.n, 25);
  assert.ok(gate.mean < 0);
  assert.equal(sleeveBenched(rows).held, true);
  assert.equal(withoutQuoteErrors(rows).length, 25);
});

test('today header sets bad quotes aside and says so', () => {
  const now = Date.parse('2026-11-23T23:00:00Z');
  const doc = todayDoc({ memeRows: [...losers, ...bad], now, memeFetchedAt: '2026-11-23T22:59:00Z', kalshiFetchedAt: '2026-11-23T22:59:00Z' });
  assert.equal(doc.shadow.n, 25);
  assert.ok(doc.shadow.pnl < 0);
  assert.equal(doc.repair.pass, false);
  assert.equal(doc.repair.quarantined, 3);
  const html = todayHeaderHtml(doc, { now });
  assert.match(html, /3 bad-quote rows set aside/);
  assert.doesNotMatch(html, /Ready to resume/);
});

test('safety-sleeve exits do not touch a trend-rotate position', () => {
  const now = Date.parse('2026-11-23T15:20:00Z');
  const pos = { id: `${TREND_ID}:X:1`, ca: 'X', variant: TREND_ID, entry: 1, sizeUsd: 2, openedAt: '2026-11-23T14:48:00Z', allocated: false, family: 'meme' };
  // Up 40% and 32 minutes old: meme-safety would take profit or time-stop. Trend must not.
  const out = stepMeme({ coins: [{ ca: 'X', priceUsd: 1.4, pass: false, reasons: [] }], open: [pos], history: [], now });
  assert.equal(out.settled.length, 0);
  assert.ok(out.open.some((p) => p.id === pos.id));
});

test('a 4,400x tick is skipped and the position stays open', () => {
  const now = Date.parse('2026-11-23T14:40:00Z');
  const pos = { id: 'meme:P', ca: PUMP, variant: 'meme-safety', entry: 0.00272, sizeUsd: 2, openedAt: '2026-11-23T14:35:00Z', allocated: false };
  const out = stepMeme({ coins: [{ ca: PUMP, priceUsd: 11.95, pass: false, reasons: [] }], open: [pos], history: [], now });
  assert.equal(out.settled.length, 0);
  assert.ok(out.open.some((p) => p.id === 'meme:P'));
  assert.equal(watchExit(pos, 11.95, now), null);
  const trend = { ...pos, id: `${TREND_ID}:${PUMP}:1`, variant: TREND_ID, openedAt: '2026-11-23T13:00:00Z' };
  const step = stepTrend({ trending: [], open: [trend], history: [], now, prices: { [PUMP]: 11.95 } });
  assert.equal(step.settled.length, 0);
  assert.ok(step.open.some((p) => p.id === trend.id));
});

test('pricesFromDex falls back to the median when the deepest pool is off', () => {
  const pair = (px, liq) => ({ chainId: 'solana', baseToken: { address: PUMP }, pairAddress: `p${px}${liq}`, priceUsd: String(px), liquidity: { usd: liq } });
  const odd = pricesFromDex({ pairs: [pair(11.95, 9e7), pair(0.0025, 1.8e7), pair(0.00251, 1.4e6), pair(0.00252, 1.2e6)] }, [PUMP]);
  assert.equal(odd[PUMP], 0.00252);
  const normal = pricesFromDex({ pairs: [pair(0.002503, 1.8e7), pair(0.002517, 1.4e6), pair(0.002508, 1.2e6)] }, [PUMP]);
  assert.equal(normal[PUMP], 0.002503);
  const single = pricesFromDex({ pairs: [pair(0.5, 1e5)] }, [PUMP]);
  assert.equal(single[PUMP], 0.5);
});
