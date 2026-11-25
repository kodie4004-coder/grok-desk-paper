// Round 4: bets list, buy-in re-scale, what-if limits, runner guard.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBetSettings, clampBuyIn, buyInFor, kalshiBet, coinBet, rescale, simulate, guardNewOpens, betsDoc, settingsFileText, readSettingsText, settingsDiff, markOpen, filterBets, sortBets, pnlSeries, fromHist, histRow } from '../engine/bets.js';
import { kalshiTakerFee } from '../engine/kalshi.js';

const k = (o = {}) => ({ id: 'mom:T1', variant: 'mom', family: 'mom', role: 'champion', allocated: true, ticker: 'T1', series: 'KXBTC15M', title: 'BTC up?', side: 'yes', ask: 0.39, contracts: 5, sizeUsd: 2, fee: 0.09, openedAt: '2026-11-25T10:00:00Z', closeTime: '2026-11-25T10:15:00Z', result: 'yes', won: true, pnl: 2.96, fees: 0.09, settledAt: '2026-11-25T10:16:00Z', ...o });

test('settings default to $2, are clamped, and force paper with live execution off', () => {
  const d = normalizeBetSettings(null);
  assert.equal(d.defaultBuyIn, 2);
  assert.equal(d.paper, true);
  assert.equal(d.liveExecution, false);
  const s = normalizeBetSettings({ defaultBuyIn: 999, liveExecution: true, paper: false, buyIn: { mom: '0.01', 'bad key!': 5 }, paused: ['mom', 'mom', 7], dailyLossCap: -3, maxOpen: 2.7 });
  assert.equal(s.defaultBuyIn, 50);
  assert.equal(s.liveExecution, false);
  assert.equal(s.paper, true);
  assert.deepEqual(s.buyIn, { mom: 0.5 });
  assert.deepEqual(s.paused, ['mom']);
  assert.equal(s.dailyLossCap, null);
  assert.equal(s.maxOpen, 2);
  assert.equal(clampBuyIn('abc'), 2);
  assert.equal(buyInFor(s, 'mom'), 0.5);
  assert.equal(buyInFor(s, 'late'), 50);
  assert.equal(readSettingsText('{not json').defaultBuyIn, 2);
});

test('Kalshi re-scale at $2 reproduces the recorded line exactly', () => {
  const b = kalshiBet(k());
  const r = rescale(b, 2);
  assert.equal(r.contracts, 5);
  assert.ok(Math.abs(r.pnl - 2.96) < 1e-9);
  assert.equal(r.fees, 0.09);
});

test('Kalshi re-scale uses whole contracts and the rounded-up fee for the new size', () => {
  const b = kalshiBet(k());
  const r = rescale(b, 10); // floor(10 / 0.39) = 25 contracts
  assert.equal(r.contracts, 25);
  const fee = kalshiTakerFee(0.39, 25);
  assert.equal(r.fees, fee);
  assert.ok(Math.abs(r.pnl - (25 - 25 * 0.39 - fee)) < 1e-9);
  const lost = rescale(kalshiBet(k({ won: false, result: 'no', pnl: -2.04 })), 10);
  assert.ok(Math.abs(lost.pnl - (-25 * 0.39 - fee)) < 1e-9);
  assert.equal(rescale(kalshiBet(k({ ask: 0.9 })), 0.5).tooSmall, true);
});

test('scalp exits pay both taker legs at the new size', () => {
  const b = kalshiBet(k({ ask: 0.55, contracts: 3, exitPx: 0.25, won: false, result: 'exit', pnl: -1, fees: 0.1 }));
  assert.ok(Math.abs(rescale(b, 2).pnl - -1) < 1e-9);
  const r = rescale(b, 5.5); // 10 contracts
  assert.equal(r.contracts, 10);
  const fees = kalshiTakerFee(0.55, 10) + kalshiTakerFee(0.25, 10);
  assert.ok(Math.abs(r.pnl - (10 * 0.25 - 10 * 0.55 - fees)) < 1e-9);
});

test('coin re-scale is linear in stake, fees included', () => {
  const b = coinBet({ id: 'meme:x', ca: 'x', symbol: 'X', entry: 1, sizeUsd: 2, variant: 'meme-safety', allocated: true, pnl: -0.4, fees: 0.05, settledAt: '2026-11-25T10:00:00Z', openedAt: '2026-11-25T09:30:00Z', exitPx: 0.8 });
  const r = rescale(b, 5);
  assert.ok(Math.abs(r.pnl - -1) < 1e-9);
  assert.ok(Math.abs(r.fees - 0.13) < 0.006);
});

test('skipped rows never become bets', () => {
  assert.equal(kalshiBet(k({ skipped: true })), null);
});

test('what-if: a loss never raises the next stake, and limits only skip lines', () => {
  const rows = [];
  for (let i = 0; i < 6; i++) rows.push(kalshiBet(k({ id: `mom:T${i}`, won: false, result: 'no', pnl: -2.04, openedAt: `2026-11-25T1${i}:00:00Z`, settledAt: `2026-11-25T1${i}:16:00Z` })));
  const base = simulate(rows, { defaultBuyIn: 4 });
  const stakes = base.rows.map((r) => r.sim.stake);
  assert.ok(stakes.every((s) => s === 4));
  assert.equal(base.n, 6);
  const capped = simulate(rows, { defaultBuyIn: 4, dailyLossCap: 8 });
  assert.ok(capped.n < base.n);
  assert.ok(capped.skipped.cap > 0);
  assert.ok(capped.net >= base.net); // a cap can only remove losing lines here
  const paused = simulate(rows, { paused: ['mom'] });
  assert.equal(paused.n, 0);
  assert.equal(paused.skipped.paused, 6);
});

test('what-if: max open skips overlapping lines', () => {
  const a = kalshiBet(k({ id: 'a', openedAt: '2026-11-25T10:00:00Z', settledAt: '2026-11-25T10:16:00Z' }));
  const b = kalshiBet(k({ id: 'b', openedAt: '2026-11-25T10:05:00Z', settledAt: '2026-11-25T10:16:00Z' }));
  const c = kalshiBet(k({ id: 'c', openedAt: '2026-11-25T10:20:00Z', settledAt: '2026-11-25T10:31:00Z' }));
  const r = simulate([a, b, c], { maxOpen: 1 });
  assert.equal(r.n, 2);
  assert.equal(r.skipped.maxOpen, 1);
});

test('runner guard only drops new lines and never touches open ones or sizes', () => {
  const old = { id: 'mom:A', variant: 'mom', allocated: true, sizeUsd: 2 };
  const fresh = { id: 'mom:B', variant: 'mom', allocated: true, sizeUsd: 2 };
  const late = { id: 'late:C', variant: 'late', allocated: false, sizeUsd: 2 };
  const none = guardNewOpens({ prevOpen: [old], nextOpen: [old, fresh, late], settings: null });
  assert.equal(none.open.length, 3);
  const paused = guardNewOpens({ prevOpen: [old], nextOpen: [old, fresh, late], settings: { paused: ['mom'] } });
  assert.deepEqual(paused.open.map((r) => r.id), ['mom:A', 'late:C']);
  const max = guardNewOpens({ prevOpen: [old], nextOpen: [old, fresh, late], settings: { maxOpen: 1 } });
  assert.deepEqual(max.open.map((r) => r.id), ['mom:A', 'late:C']);
  const cap = guardNewOpens({ prevOpen: [], nextOpen: [fresh, late], settledToday: [{ allocated: true, pnl: -6 }], settings: { dailyLossCap: 5 } });
  assert.deepEqual(cap.open.map((r) => r.id), ['late:C']);
  assert.ok(paused.open.every((r) => r.sizeUsd === 2));
});

test('bets doc: totals after fees, bad coin quotes set aside, hourly sums match totals', () => {
  const kalshiRows = [k(), k({ id: 'late:T2', variant: 'late', family: 'late', allocated: false, won: false, result: 'no', pnl: -2.04, settledAt: '2026-11-25T11:16:00Z' }), k({ id: 'x', skipped: true })];
  const memeRows = [{ id: 'meme:q', ca: 'q', entry: 0.001, exitPx: 12, sizeUsd: 2, variant: 'trend-rotate', pnl: 8400, fees: 1, settledAt: '2026-11-25T10:00:00Z', openedAt: '2026-11-25T09:59:00Z' }];
  const d = betsDoc({ kalshiRows, memeRows, kalshiOpen: [k({ id: 'mom:O', pnl: undefined, settledAt: undefined, result: undefined, won: undefined })], now: Date.parse('2026-11-25T12:00:00Z') });
  assert.equal(d.paper, true);
  assert.equal(d.liveExecution, false);
  assert.equal(d.quoteErrorsSetAside, 1);
  assert.equal(d.totals.n, 2);
  assert.equal(d.totals.net, 0.92);
  assert.equal(d.totals.open, 1);
  const hourSum = d.hourly._all.reduce((a, h) => a + h[1], 0);
  assert.ok(Math.abs(hourSum - d.totals.net) < 1e-6);
  assert.equal(d.bots.mom.countedNet, 2.96);
  // hist rows round-trip to the same P&L
  const back = fromHist('kalshi', 'mom', d.hist.mom.rows[0]);
  assert.ok(Math.abs(back.pnl - 2.96) < 1e-9);
  assert.deepEqual(histRow(kalshiBet(k())).length, 8);
});

test('P&L series ends exactly on the recorded all-time net', () => {
  const rows = [k(), k({ id: 'mom:T2', pnl: -2.04, won: false, settledAt: '2026-11-25T11:16:00Z' })];
  const now = Date.parse('2026-11-25T12:00:00Z');
  const d = betsDoc({ kalshiRows: rows, now });
  for (const range of ['1h', '1d', '1w', 'all']) {
    const s = pnlSeries(d, { bot: 'mom', range, now });
    assert.equal(s.points[s.points.length - 1].v, d.bots.mom.net, range);
  }
  assert.equal(pnlSeries(d, { bot: 'mom', range: '1d', now }).resolution, 'line');
});

test('open Kalshi mark sells at the bid with both fees; filters and sort work', () => {
  const open = kalshiBet(k({ pnl: undefined, settledAt: undefined }));
  const m = markOpen(open, { board: { markets: [{ ticker: 'T1', yesBid: 0.5, noBid: 0.49 }] } }, 2);
  const fees = kalshiTakerFee(0.39, 5) + kalshiTakerFee(0.5, 5);
  assert.ok(Math.abs(m.pnl - (5 * 0.5 - 5 * 0.39 - fees)) < 1e-9);
  const rows = [kalshiBet(k()), kalshiBet(k({ id: 'late:T9', variant: 'late', pnl: -1, won: false })), open];
  assert.equal(filterBets(rows, { bot: 'late' }).length, 1);
  assert.equal(filterBets(rows, { status: 'open' }).length, 1);
  assert.equal(filterBets(rows, { q: 'btc' }).length, 3);
  assert.equal(sortBets(rows.slice(0, 2), 'pnl', 'asc')[0].pnl, -1);
});

test('settings file is paper-stamped and diffable', () => {
  const t = JSON.parse(settingsFileText({ defaultBuyIn: 5, paused: ['b', 'a'] }, '2026-11-25T00:00:00Z'));
  assert.equal(t.paper, true);
  assert.equal(t.liveExecution, false);
  assert.deepEqual(t.paused, ['a', 'b']);
  assert.deepEqual(settingsDiff(t, null), ['defaultBuyIn', 'paused']);
  assert.doesNotMatch(JSON.stringify(t), /TYPESAFE|NTFY|key/i);
});
