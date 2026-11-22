import test from 'node:test';
import assert from 'node:assert/strict';
import { pairsPick, PAIRS_LEADER_MOVE, PAIRS_LAG, PAIRS_MARGIN, PAIRS_MIN_LEFT, PAIRS_MAX_LEFT, PAIRS_ADDED_AT, PAIRS_SERIES } from '../engine/pairs.js';
import { VARIANTS, stepJournal, defaultBrain, pinCleared, LEARN_SIZE, signal } from '../engine/learn.js';
import { replayVariant } from '../engine/backtest.js';

const pairs = VARIANTS.find((v) => v.id === 'pairs-lag');
const T0 = Date.parse('2026-11-23T12:00:00Z');
const close = new Date(T0 + 400000).toISOString();

function mkt(series, ticker, yesBid, yesAsk) {
  return { ticker, series, title: series, yesBid, yesAsk, noBid: +(1 - yesAsk).toFixed(4), noAsk: +(1 - yesBid).toFixed(4), closeTime: close, floorStrike: 100, result: '' };
}

test('pairs-lag is pre-registered with frozen move, lag, margin and window', () => {
  assert.equal(pairs.kind, 'pairs');
  assert.equal(pairs.pinZero, true);
  assert.equal(pairs.addedAt, PAIRS_ADDED_AT);
  assert.equal(PAIRS_ADDED_AT, '2026-11-22T08:45:00.000Z');
  assert.equal(PAIRS_LEADER_MOVE, 0.06);
  assert.equal(PAIRS_LAG, 0.04);
  assert.equal(PAIRS_MARGIN, 0.02);
  assert.equal(pairs.minLeft, PAIRS_MIN_LEFT);
  assert.equal(pairs.maxLeft, PAIRS_MAX_LEFT);
  assert.deepEqual([...PAIRS_SERIES], ['KXBTC15M', 'KXETH15M', 'KXSOL15M']);
  assert.equal(LEARN_SIZE, 2);
});

test('pairsPick buys the laggard in the leader\'s direction when the gap clears the fee', () => {
  const board = [
    mkt('KXBTC15M', 'BTC1', 0.69, 0.70),
    mkt('KXETH15M', 'ETH1', 0.51, 0.52),
    mkt('KXSOL15M', 'SOL1', 0.51, 0.52),
  ];
  const quotes = {
    BTC1: { yesBid: 0.49, yesAsk: 0.50 },
    ETH1: { yesBid: 0.49, yesAsk: 0.50 },
    SOL1: { yesBid: 0.49, yesAsk: 0.50 },
  };
  const eth = pairsPick(board[1], { board, quotes });
  assert.equal(eth.side, 'yes');
  assert.equal(eth.ask, 0.52);
  assert.ok(eth.lag >= 0.04);
  assert.equal(pairsPick(board[0], { board, quotes }), null); // leader does not buy itself
  const small = [
    mkt('KXBTC15M', 'BTC1', 0.52, 0.53),
    mkt('KXETH15M', 'ETH1', 0.51, 0.52),
    mkt('KXSOL15M', 'SOL1', 0.51, 0.52),
  ];
  assert.equal(pairsPick(small[1], { board: small, quotes }), null);
});

test('the journal opens pairs-lag as a $2 shadow line with weight 0', () => {
  const board = [
    mkt('KXBTC15M', 'BTC1', 0.69, 0.70),
    mkt('KXETH15M', 'ETH1', 0.51, 0.52),
    mkt('KXSOL15M', 'SOL1', 0.51, 0.52),
  ];
  const quotes = {
    BTC1: { yesBid: 0.49, yesAsk: 0.50 },
    ETH1: { yesBid: 0.49, yesAsk: 0.50 },
    SOL1: { yesBid: 0.49, yesAsk: 0.50 },
  };
  const next = stepJournal({ markets: board, open: [], quotes, brain: defaultBrain(), existingIds: [], settledRows: [], now: T0 });
  const line = next.open.find((r) => r.variant === 'pairs-lag');
  assert.ok(line);
  assert.equal(line.allocated, false);
  assert.equal(line.sizeUsd, 2);
  assert.equal(line.side, 'yes');
  assert.ok(line.ticker === 'ETH1' || line.ticker === 'SOL1');
  assert.equal(next.brain.weights['pairs-lag'], 0);
  assert.equal(pinCleared(pairs, []), false);
});

test('replay uses the previous board\'s mid and holds to the result', () => {
  const at = (ms) => new Date(T0 + ms).toISOString();
  const pack = (btc, eth, sol, closeMs = 400000) => [
    ['BTC1', 'KXBTC15M', at(closeMs), btc - 0.01, btc, +(1 - btc).toFixed(4), +(1 - (btc - 0.01)).toFixed(4), 100],
    ['ETH1', 'KXETH15M', at(closeMs), eth - 0.01, eth, +(1 - eth).toFixed(4), +(1 - (eth - 0.01)).toFixed(4), 100],
    ['SOL1', 'KXSOL15M', at(closeMs), sol - 0.01, sol, +(1 - sol).toFixed(4), +(1 - (sol - 0.01)).toFixed(4), 100],
  ];
  const tape = {
    snapshots: [
      { t: at(0), m: pack(0.50, 0.50, 0.50) },
      { t: at(15_000), m: pack(0.70, 0.52, 0.52) },
    ],
    results: { BTC1: 'yes', ETH1: 'yes', SOL1: 'yes' },
  };
  const { trades } = replayVariant(pairs, tape);
  const ids = trades.map((t) => t.ticker).sort();
  assert.deepEqual(ids, ['ETH1', 'SOL1']);
  assert.ok(trades.every((t) => t.side === 'yes' && t.ask === 0.52 && t.sizeUsd === 2 && t.won === true));
});
