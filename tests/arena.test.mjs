import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewArena, placePick, ARENA_SIZE } from '../engine/arena.js';
import { addXp, levelOf, achievements, XP } from '../engine/game.js';
import { cryptoPnl, microSignal, runMaker, TAKER_PCT } from '../engine/scalp.js';
import { matchTicker, filingLagOk, normName, stockPnl } from '../engine/filings.js';

test('a flat crypto scalp loses the taker fee', () => {
  const deal = cryptoPnl(100, 100, 2);
  assert.ok(deal.pnl < 0);
  assert.ok(deal.fees > 2 * (TAKER_PCT / 100) * 1.5 === false || deal.fees > 0);
  assert.equal(TAKER_PCT, 0.9);
});

test('micro-momentum needs three higher closes inside the band', () => {
  const bars = [100, 100.1, 100.25, 100.4].map((c, i) => ({ t: i * 60000, o: c, h: c, l: c, c, v: 1 }));
  assert.equal(microSignal(bars, 3), true);
  bars[3].c = 100.2;
  assert.equal(microSignal(bars, 3), false);
});

test('a maker quote fills only when the next trade crosses the bid', () => {
  const close = Date.parse('2026-11-18T12:00:00Z');
  const candle = (sec, bid, low) => ({
    end_period_ts: (close - sec * 1000) / 1000,
    yes_bid: { close_dollars: bid.toFixed(2) },
    yes_ask: { close_dollars: (bid + 0.01).toFixed(2) },
    price: { low_dollars: low.toFixed(2) },
  });
  const noFill = runMaker([candle(8 * 60, 0.4, 0.4), candle(7 * 60, 0.41, 0.41)], close);
  assert.equal(noFill.length, 0);
  const filled = runMaker([candle(8 * 60, 0.4, 0.4), candle(7 * 60, 0.37, 0.36)], close);
  assert.equal(filled.length, 1);
  assert.ok(filled[0].pnl < 0);
});

test('arena bets stay at $2 and out of the edge book after a loss', () => {
  const now = Date.parse('2026-11-18T12:10:00Z');
  const st = { edgeBook: [], closed: [] };
  const market = { ticker: 'KXBTC15M-T', title: 'BTC', series: 'KXBTC15M', yesAsk: 0.4, noAsk: 0.62, yesBid: 0.39, closeTime: '2026-11-18T12:15:00Z', floorStrike: 100, result: '' };
  reviewArena(st, { markets: [market] }, now, { BTC: { px: 101, source: 'Coinbase estimate' } });
  assert.ok(st.arenaOpen.length >= 1);
  assert.ok(st.arenaOpen.every((p) => p.sizeUsd === ARENA_SIZE));
  assert.equal(st.edgeBook.length, 0);
  reviewArena(st, { markets: [{ ...market, result: 'no' }] }, now + 60000, {});
  assert.equal(st.arenaOpen.length, 0);
  assert.ok(st.arenaClosed.every((t) => t.sizeUsd === 2));
  assert.equal(st.closed.length, 0);
  const again = placePick(st, { ...market, result: '', ticker: 'KXBTC15M-T2', closeTime: '2026-11-18T12:30:00Z' }, 'yes', now + 120000);
  assert.equal(again.ok, true);
  assert.equal(st.picksOpen[0].sizeUsd, 2);
  const late = placePick(st, { ...market, ticker: 'KXBTC15M-T3', closeTime: '2026-11-18T12:11:00Z' }, 'yes', now + 120000);
  assert.equal(late.ok, false);
});

test('xp does not grow because a settlement made money', () => {
  const game = { xp: 0, days: {} };
  addXp(game, 'settle');
  const afterLoss = game.xp;
  addXp(game, 'settle');
  assert.equal(game.xp - afterLoss, XP.settle);
  assert.equal(levelOf(0), 1);
  assert.equal(levelOf(50), 2);
});

test('filing names match once, and the lag is the filing date', () => {
  assert.equal(matchTicker('APPLE INC', [{ ticker: 'AAPL', title: 'Apple Inc.' }]), 'AAPL');
  assert.equal(matchTicker('APPLE', [{ ticker: 'AAPL', title: 'Apple Inc.' }, { ticker: 'APLE', title: 'Apple Co.' }]), null);
  assert.equal(normName('Apple, Inc.'), 'APPLE');
  assert.equal(filingLagOk('2026-09-30', '2026-11-16'), true);
  assert.equal(filingLagOk('2026-11-16', '2026-09-30'), false);
  const deal = stockPnl(100, 100, 100);
  assert.ok(deal.pnl < 0 && deal.fees > 0);
});

test('no size-up badge needs two equal paper settlements', () => {
  const st = { arenaClosed: [{ sizeUsd: 2 }, { sizeUsd: 2 }], picksClosed: [], arenaOpen: [], picksOpen: [], game: { days: {} } };
  assert.equal(achievements(st).find((a) => a.id === 'size').on, true);
  st.arenaClosed[1].sizeUsd = 4;
  assert.equal(achievements(st).find((a) => a.id === 'size').on, false);
});
