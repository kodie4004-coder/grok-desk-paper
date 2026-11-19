import test from 'node:test';
import assert from 'node:assert/strict';
import { kalshiTakerFee, favoriteSide, candleInWindow, asksFromCandle, settlePnl, coinFlipSide, liveK1, K1, loadKalshiBoard, reviewKalshi, quoteAge } from '../engine/kalshi.js';

test('taker fee matches the one-contract column of the July 2026 schedule', () => {
  assert.equal(kalshiTakerFee(0.5, 1), 0.02);
  assert.equal(kalshiTakerFee(0.1, 1), 0.01);
  assert.equal(kalshiTakerFee(0.2, 1), 0.02);
  assert.equal(kalshiTakerFee(0.5, 100), 1.75);
  assert.equal(kalshiTakerFee(0.1, 100), 0.63);
});

test('favorite is the side offered at 85c or more', () => {
  assert.deepEqual(favoriteSide(0.9, 0.12), { side: 'yes', ask: 0.9 });
  assert.equal(favoriteSide(0.9, 0.12).side, 'yes');
  assert.equal(favoriteSide(0.4, 0.62), null);
  assert.equal(favoriteSide(0.9, 0.91), null);
  assert.equal(favoriteSide(0, 0.2), null);
});

test('the entry candle is the one nearest four minutes before the close', () => {
  const close = Date.parse('2026-11-18T04:15:00Z');
  const at = (secBefore) => ({ end_period_ts: (close - secBefore * 1000) / 1000, yes_ask: { close_dollars: '0.9000' }, yes_bid: { close_dollars: '0.8800' } });
  const picked = candleInWindow([at(2 * 60), at(4 * 60 + 20), at(6 * 60), at(3 * 60 + 30)], close);
  assert.equal(picked.end_period_ts, (close - (4 * 60 + 20) * 1000) / 1000);
  const asks = asksFromCandle(picked);
  assert.equal(asks.yesAsk, 0.9);
  assert.ok(Math.abs(asks.noAsk - 0.12) < 1e-9);
});

test('a winning favorite keeps the fee and a loser pays the cost', () => {
  const win = settlePnl(0.9, true);
  const lose = settlePnl(0.9, false);
  assert.ok(win.contracts >= 1);
  assert.equal(win.fee, kalshiTakerFee(0.9, win.contracts));
  assert.ok(win.pnl > 0 && win.pnl < win.contracts * 0.1);
  assert.ok(lose.pnl < -lose.cost);
  assert.equal(coinFlipSide('KXBTC15M-ABC'), coinFlipSide('KXBTC15M-ABC'));
});

test('live K1 waits for a fresh quote inside the last three to five minutes', () => {
  const now = Date.parse('2026-11-18T04:26:00Z');
  const market = { closeTime: '2026-11-18T04:30:00Z', yesAsk: 0.9, noAsk: 0.12, ticker: 'T' };
  assert.equal(liveK1(market, now, now - 10 * 60 * 1000).action, 'skip');
  assert.equal(liveK1(market, now, now).action, 'take');
  assert.equal(liveK1({ ...market, closeTime: '2026-11-18T05:00:00Z' }, now, now).action, 'skip');
  assert.equal(liveK1({ ...market, yesAsk: 0.5, noAsk: 0.52 }, now, now).action, 'skip');
  assert.ok(K1.minAsk === 0.85);
});

test('a Kalshi quote older than 15 minutes is stale', () => {
  const now = Date.parse('2026-11-18T12:40:00Z');
  const fresh = quoteAge('2026-11-18T12:30:00Z', now);
  const stale = quoteAge('2026-11-18T09:39:46Z', now);
  assert.equal(fresh.stale, false);
  assert.equal(fresh.label, '10m');
  assert.equal(stale.stale, true);
  assert.equal(stale.label, '3h 0m');
  assert.equal(quoteAge('', now).stale, true);
});

test('a blocked browser falls back to the snapshot and a paper bet stays out of the coin book', async () => {
  const board = {
    fetchedAt: '2026-11-18T04:26:00.000Z',
    markets: [{ ticker: 'T1', title: 'BTC up', yesAsk: 0.9, noAsk: 0.11, closeTime: '2026-11-18T04:30:00Z', result: '', status: 'active' }],
  };
  const fetchImpl = async (url) => {
    if (String(url).includes('kalshi.com')) throw new Error('CORS');
    return { ok: true, json: async () => board };
  };
  const loaded = await loadKalshiBoard(fetchImpl);
  assert.equal(loaded.via, 'snapshot');
  const st = { closed: [], edgeBook: [] };
  const now = Date.parse('2026-11-18T04:26:00Z');
  reviewKalshi(st, loaded, now);
  assert.equal(st.kalshiOpen.length, 1);
  assert.equal(st.kalshiOpen[0].sizeUsd, 5);
  assert.equal(st.closed.length, 0);
  assert.equal(st.kalshiOpen[0].fee, kalshiTakerFee(0.9, st.kalshiOpen[0].contracts));
  reviewKalshi(st, { fetchedAt: loaded.fetchedAt, markets: [{ ...board.markets[0], result: 'yes' }] }, now + 60000);
  assert.equal(st.kalshiOpen.length, 0);
  assert.equal(st.kalshiClosed[0].won, true);
  assert.equal(st.closed.length, 0);
});
