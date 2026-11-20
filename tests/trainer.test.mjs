import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { kalshiTakerFee } from '../engine/kalshi.js';
import {
  TRAINER_STAKE, emptyTrainer, yesProbability, marketYesProb, brierScore, trainerDeal,
  placeTrainerCall, settleTrainer, lessonText, trainerReady, calibrationBuckets,
  trainerStats, brierVerdict, trainerTips, hitStreak,
} from '../engine/trainer.js';

const now = Date.parse('2026-11-18T12:10:00Z');

function market(extra = {}) {
  return {
    ticker: 'KXBTC15M-T',
    series: 'KXBTC15M',
    title: 'BTC price up in next 15 mins?',
    floorStrike: 100,
    yesBid: 0.46,
    yesAsk: 0.52,
    noBid: 0.48,
    noAsk: 0.54,
    closeTime: '2026-11-18T12:15:00Z',
    result: '',
    ...extra,
  };
}

function ctx(extra = {}) {
  return { fetchedAt: new Date(now).toISOString(), spots: {}, prev: {}, ...extra };
}

test('the paper fee is the Kalshi taker formula and the stake stays $2', () => {
  const deal = trainerDeal(0.52);
  const contracts = Math.floor(TRAINER_STAKE / 0.52);
  assert.equal(deal.contracts, contracts);
  assert.equal(deal.sizeUsd, 2);
  assert.equal(deal.fee, kalshiTakerFee(0.52, contracts));
  assert.equal(deal.fee, Math.ceil((0.07 * contracts * 0.52 * (1 - 0.52) - 1e-9) * 100) / 100);
  assert.ok(kalshiTakerFee(0.5, 1) > kalshiTakerFee(0.9, 1));
  assert.ok(kalshiTakerFee(0.5, 1) > kalshiTakerFee(0.1, 1));
  assert.ok(0.5 * 0.5 > 0.9 * 0.1);
});

test('confidence becomes a YES probability and the quote uses the mid', () => {
  assert.equal(yesProbability('yes', 70), 0.7);
  assert.equal(yesProbability('no', 70), 0.3);
  assert.equal(yesProbability('yes', 50), null);
  assert.equal(yesProbability('yes', 100), null);
  assert.equal(yesProbability('yes', 70.5), null);
  assert.equal(marketYesProb(market()), 0.49);
  assert.equal(brierScore(0.7, 'yes'), 0.09);
  assert.equal(brierScore(0.3, 'yes'), 0.49);
  assert.equal(brierScore(0.5, 'no'), 0.25);
});

test('a call is refused after the lock, on a stale quote, or twice', () => {
  const book = emptyTrainer();
  assert.equal(placeTrainerCall(book, market({ closeTime: '2026-11-18T12:00:00Z' }), 'yes', 60, now, ctx()).ok, false);
  assert.equal(placeTrainerCall(book, market(), 'yes', 60, now, ctx({ fetchedAt: new Date(now - 16 * 60 * 1000).toISOString() })).ok, false);
  assert.match(placeTrainerCall(book, market(), 'yes', 40, now, ctx()).reason, /51 to 99/);
  const ok = placeTrainerCall(book, market(), 'yes', 64, now, ctx());
  assert.equal(ok.ok, true);
  assert.equal(placeTrainerCall(book, market(), 'no', 64, now, ctx()).ok, false);
  assert.equal(book.open.length, 1);
  assert.equal(book.stakeUsd, 2);
});

test('settlement scores the taker fee, the Brier score, and does not raise size after a loss', () => {
  const book = emptyTrainer();
  book.stakeUsd = 50;
  const placed = placeTrainerCall(book, market(), 'no', 70, now, ctx());
  assert.equal(placed.ok, true);
  const edge = { closed: [{ pnl: 1 }], edgeBook: [] };
  const out = settleTrainer(book, { markets: [market({ result: 'yes' })] }, now + 60000, {});
  assert.equal(out.settled.length, 1);
  assert.equal(out.settled[0].won, false);
  assert.equal(out.settled[0].fees, placed.call.fee);
  const payout = 0;
  assert.ok(Math.abs(out.settled[0].pnl - (payout - placed.call.cost - placed.call.fee)) < 1e-9);
  assert.ok(out.settled[0].pnl < 0);
  assert.equal(out.settled[0].brier, brierScore(0.3, 'yes'));
  assert.equal(out.settled[0].marketBrier, brierScore(0.49, 'yes'));
  assert.equal(book.open.length, 0);
  assert.equal(book.stakeUsd, TRAINER_STAKE);
  assert.equal(edge.closed.length, 1);
  const again = settleTrainer(book, { markets: [market({ result: 'yes' })] }, now + 120000, {});
  assert.equal(again.settled.length, 0);
  assert.equal(book.closed.length, 1);
});

test('the lesson uses only the numbers it was given', () => {
  const row = {
    secondsLeft: 240,
    floorStrike: 100,
    spotPx: 99.5,
    spotSource: 'Coinbase estimate',
    settleSpotPx: 101.25,
    result: 'yes',
    side: 'yes',
    won: true,
    marketYes: 0.49,
    bots: [{ rule: 'mom', side: 'no', reason: 'momentum vs target, Coinbase estimate below strike' }],
    pnl: 1.38,
    fees: 0.06,
    contracts: 3,
    ask: 0.52,
  };
  const text = lessonText(row);
  assert.match(text, /4m 00s/);
  assert.match(text, /Coinbase estimate showed 99.5000, below the strike 100.00/);
  assert.match(text, /101.25 \(up from 99.5000\)/);
  assert.match(text, /crossed the strike/);
  assert.match(text, /momentum vs target/);
  assert.match(text, /Paper practice\. This is not advice/);
  assert.match(text, /next call is still \$2/);
  assert.doesNotMatch(text, /news|whale|liquidation|breaking|make it back/i);
  const blind = lessonText({ ...row, spotPx: null, settleSpotPx: null, bots: [] });
  assert.match(blind, /does not say where price was/);
  assert.match(blind, /none of the paper bot setups fired/);
  assert.doesNotMatch(blind, /Coinbase/);
});

test('a live call stores the bot setup from the same quote', () => {
  const book = emptyTrainer();
  const placed = placeTrainerCall(book, market({ yesAsk: 0.9, noAsk: 0.12, yesBid: 0.88, noBid: 0.1 }), 'yes', 80, now, ctx({
    spots: { BTC: { px: 101, source: 'Coinbase estimate' } },
  }));
  assert.equal(placed.ok, true);
  assert.ok(placed.call.bots.some((b) => b.rule === 'late' && b.side === 'yes'));
  assert.ok(placed.call.bots.some((b) => b.rule === 'mom' && b.side === 'yes'));
  const out = settleTrainer(book, { markets: [market({ yesAsk: 0.9, noAsk: 0.12, result: 'yes' })] }, now + 1000, {
    BTC: { px: 102, source: 'Coinbase estimate' },
  });
  assert.match(out.settled[0].lesson, /late leaned yes/);
  assert.match(out.settled[0].lesson, /102.00/);
});

test('the readiness bar matches the bot rule and does not loosen after a red day', () => {
  const day = (date, n, pnl) => Array.from({ length: n }, (_, i) => ({
    ticker: `${date}-${i}`,
    series: 'KXBTC15M',
    closeTime: `${date}T12:00:00Z`,
    pnl,
    won: pnl > 0,
    settledAt: Date.parse(`${date}T12:15:00Z`) + i,
  }));
  const short = trainerReady([...day('2026-11-18', 20, 0.2), ...day('2026-11-19', 19, 0.2)]);
  assert.equal(short.ready, false);
  assert.match(short.text, /Not there yet/);
  assert.match(short.text, /Paper practice\. Not advice/);
  const bad = trainerReady([...day('2026-11-18', 20, 0.2), ...day('2026-11-19', 20, 0.2), ...day('2026-11-20', 20, -0.4)]);
  assert.equal(bad.ready, false);
  assert.match(bad.text, /did not clear/);
  const good = trainerReady([...day('2026-11-18', 20, 0.2), ...day('2026-11-19', 20, 0.2), ...day('2026-11-20', 20, 0.2)]);
  assert.equal(good.ready, true);
  assert.match(good.text, /does not turn on a wallet/);
  assert.doesNotMatch(good.text, /real money now|increase size|make it back/i);
});

test('calibration, streak, and Brier wording stay humble under 20 settles', () => {
  const closed = [
    { confidence: 64, won: true, settledAt: 2, brier: 0.1, marketBrier: 0.2, pnl: 1, fees: 0.05 },
    { confidence: 80, won: false, settledAt: 3, brier: 0.6, marketBrier: 0.3, pnl: -2, fees: 0.05 },
    { confidence: 91, won: true, settledAt: 4, brier: 0.05, marketBrier: 0.1, pnl: 0.4, fees: 0.02 },
  ];
  assert.equal(hitStreak(closed), 1);
  const buckets = calibrationBuckets(closed);
  assert.equal(buckets.find((b) => b.lo === 60).n, 1);
  assert.equal(buckets.find((b) => b.lo === 80).hits, 0);
  assert.equal(buckets.find((b) => b.lo === 90).hits, 1);
  const stats = trainerStats({ open: [{}], closed, xp: 8 });
  assert.equal(stats.calls, 4);
  assert.equal(stats.settled, 3);
  assert.equal(stats.stakeUsd, 2);
  assert.match(brierVerdict(stats.brier, stats.marketBrier, stats.settled), /does not say you beat the crowd/);
  assert.match(brierVerdict(0.1, 0.2, 20), /closer than the quote/);
  assert.match(brierVerdict(0.4, 0.2, 20), /quote was closer/);
});

test('tips state the fee peak, late calls, and the fixed chip', () => {
  const tips = trainerTips();
  assert.equal(tips.length, 4);
  assert.match(tips[0].body, /0\.07 × contracts × price × \(1 − price\)/);
  assert.match(tips[1].body, /50¢/);
  assert.match(tips[2].body, /Size stays \$2/);
  assert.match(tips[3].body, /no make-it-back/i);
  const src = readFileSync(new URL('../engine/trainer.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /privateKey|signTransaction|placeOrder|edgeGate|updateSettings|allowExplore/);
  assert.doesNotMatch(src, /live_execution\s*[:=]/);
});
