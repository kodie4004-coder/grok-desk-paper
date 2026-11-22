// Quote lead-lag across the BTC, ETH and SOL 15-minute Kalshi books. Paper only.
// Rules were written down before any replay of this book. They are not searched
// on the held-back stretch. A backtest cannot graduate this challenger.

import { feeEdgeClears } from './kalshi.js';
export const PAIRS_SERIES = Object.freeze(['KXBTC15M', 'KXETH15M', 'KXSOL15M']);
export const PAIRS_ADDED_AT = '2026-11-22T08:45:00.000Z';
// Leader must have moved at least 6 cents of mid since the previous board.
// The laggard must trail that move by at least 4 cents. Both are larger than
// a typical 1-cent spread. The 2¢ fee margin is the same buffer as fair-spot.
// Asks outside 10¢–90¢ are skipped (longshots lose after fees in public studies).
export const PAIRS_LEADER_MOVE = 0.06;
export const PAIRS_LAG = 0.04;
export const PAIRS_MARGIN = 0.02;
export const PAIRS_MIN_ASK = 0.10;
export const PAIRS_MAX_ASK = 0.90;
export const PAIRS_MIN_LEFT = 120;
export const PAIRS_MAX_LEFT = 720;

function midOf(quote) {
  const bid = Number(quote?.yesBid);
  const ask = Number(quote?.yesAsk);
  if (bid > 0 && ask > 0 && ask >= bid) return (bid + ask) / 2;
  if (ask > 0 && ask < 1) return ask;
  return null;
}

function quoteOf(market) {
  return { yesBid: market?.yesBid, yesAsk: market?.yesAsk, noAsk: market?.noAsk, series: market?.series, ticker: market?.ticker, closeTime: market?.closeTime };
}

// Peers are the other two books with the same closeTime. All three must be
// present, and each must have a previous mid, or there is no trade.
export function pairsPick(market, ctx = {}) {
  if (!PAIRS_SERIES.includes(market?.series)) return null;
  const board = (ctx.board || []).filter((row) => PAIRS_SERIES.includes(row?.series) && row?.closeTime === market.closeTime);
  if (board.length < 3) return null;
  const prev = ctx.quotes || {};
  const rows = [];
  for (const row of board) {
    const nowMid = midOf(quoteOf(row));
    const was = midOf(prev[row.ticker] || {});
    if (nowMid == null || was == null) return null;
    rows.push({ market: row, mid: nowMid, prev: was, delta: nowMid - was });
  }
  let leader = null;
  for (const row of rows) {
    if (!leader || Math.abs(row.delta) > Math.abs(leader.delta)) leader = row;
  }
  if (!leader || Math.abs(leader.delta) < PAIRS_LEADER_MOVE) return null;
  const self = rows.find((row) => row.market.ticker === market.ticker);
  if (!self || self.market.ticker === leader.market.ticker) return null;
  const lag = leader.delta - self.delta;
  if (Math.sign(lag) !== Math.sign(leader.delta) && lag !== 0) return null;
  if (Math.abs(lag) < PAIRS_LAG) return null;
  const buyYes = leader.delta > 0;
  const ask = Number(buyYes ? market.yesAsk : market.noAsk);
  if (!(ask > PAIRS_MIN_ASK && ask < PAIRS_MAX_ASK)) return null;
  const contracts = Math.floor(2 / ask);
  if (contracts < 1) return null;
  const fair = buyYes ? leader.mid : 1 - leader.mid;
  if (!feeEdgeClears(fair, ask, contracts, PAIRS_MARGIN)) return null;
  return { side: buyYes ? 'yes' : 'no', ask, fair, pEst: fair, lag: +lag.toFixed(4) };
}
