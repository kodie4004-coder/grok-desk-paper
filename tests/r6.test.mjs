// Round 6: live-ready (paper only), shared risk checks, fee-first ticket,
// P&L calendar, window replay and marks, user alerts, call-it streak.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { MODES, LIVE_ENABLED, tradingMode, resolveMode, assertPaper, liveReadiness, LIVE_PROOF } from '../engine/mode.js';
import { riskCheck, RISK_LIMITS, RECORDED_STAKE } from '../engine/risk.js';
import { preTradeCheck, preTradeCoin, ticketHtml } from '../engine/ticket.js';
import { simulate, guardNewOpens, normalizeBetSettings, settingsFileText } from '../engine/bets.js';
import { kalshiTakerFee } from '../engine/kalshi.js';
import { dayKey, dayTotals, monthGrid, monthSummary, calendarHtml, calendarShareModel, daySheetHtml } from '../engine/calendar.js';
import { windowOf, productFor, candlePoints, lineMarks, coinMarks, replayFrame, WINDOW_MS } from '../engine/replay.js';
import { chartSvg } from '../engine/chart.js';
import { cleanRule, cleanRules, evaluateAlerts, emptyMemory, addToInbox, unreadCount, ALERT_CAP_PER_HOUR, DEFAULT_RULES } from '../engine/user-alerts.js';
import { emptyTrainer, placeTrainerCall, settleTrainer, callStreak, TRAINER_STAKE, TRAINER_XP_HIT, TRAINER_XP_SETTLE, TRAINER_XP_CALL } from '../engine/trainer.js';
import { callItHtml, pickCallMarket } from '../engine/callit-view.js';
import { controlsSheetHtml } from '../engine/bets-view.js';

// ---- trading mode ----------------------------------------------------------
test('trading mode is always paper and live is refused', () => {
  assert.equal(LIVE_ENABLED, false);
  assert.equal(tradingMode(), MODES.PAPER);
  const r = resolveMode('live');
  assert.equal(r.mode, 'paper');
  assert.equal(r.live, false);
  assert.match(r.reason, /LIVE_READINESS/);
  assert.ok(Object.isFrozen(r));
  assert.equal(resolveMode('anything').mode, 'paper');
  assert.equal(assertPaper('test'), true);
});

test('live readiness never reports ready, even with perfect proof', () => {
  const r = liveReadiness({ forward: { n: 10000, days: 90, mean: 1, lo: 0.5, graduated: true } });
  assert.equal(r.ready, false);
  assert.equal(r.liveEnabled, false);
  for (const id of ['yes', 'keys', 'small', 'code']) assert.equal(r.items.find((i) => i.id === id).met, false, id);
  assert.equal(r.items.find((i) => i.id === 'sample').met, true);
  assert.equal(liveReadiness({ forward: { n: LIVE_PROOF.minLines - 1 } }).items.find((i) => i.id === 'sample').met, false);
});

test('no live order path exists in the app or engine', () => {
  const files = ['app.js', ...fs.readdirSync('engine').map((f) => 'engine/' + f)];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(src, /portfolio\/orders|createOrder|placeOrder|KALSHI-ACCESS-KEY|privateKey|api_key\s*[:=]/i, f);
  }
  assert.ok(fs.existsSync('docs/LIVE_READINESS.md'));
  const doc = fs.readFileSync('docs/LIVE_READINESS.md', 'utf8');
  for (const w of [/explicit yes/i, /server-side/i, /small/i, /after fees/i, /300/]) assert.match(doc, w);
});

// ---- shared risk module ------------------------------------------------------
test('riskCheck order: kill switch, pause, size, loss cap, max open', () => {
  const s = normalizeBetSettings({ killSwitch: true, paused: ['a'], dailyLossCap: 5, maxOpen: 1 });
  assert.equal(riskCheck({ settings: s, bot: 'a', stake: 999, dayPnl: -10, openCounted: 5 }).why, 'kill switch');
  const s2 = { ...s, killSwitch: false };
  assert.equal(riskCheck({ settings: s2, bot: 'a', stake: 999 }).why, 'paused');
  assert.equal(riskCheck({ settings: s2, bot: 'b', stake: 999 }).why, 'size');
  assert.equal(riskCheck({ settings: s2, bot: 'b', stake: 2, dayPnl: -5, openCounted: 5 }).why, 'daily loss cap');
  assert.equal(riskCheck({ settings: s2, bot: 'b', stake: 2, dayPnl: 0, openCounted: 1 }).why, 'max open');
  assert.equal(riskCheck({ settings: s2, bot: 'b', stake: 2, counted: false, dayPnl: -50, openCounted: 50 }).ok, true);
  assert.equal(RISK_LIMITS.runnerStake, RECORDED_STAKE);
});

test('kill switch: only true turns it on, it survives the settings file, and it stops the sim', () => {
  assert.equal(normalizeBetSettings({ killSwitch: 'yes' }).killSwitch, false);
  assert.equal(normalizeBetSettings({ killSwitch: true }).killSwitch, true);
  assert.equal(JSON.parse(settingsFileText({ killSwitch: true })).killSwitch, true);
  const bets = [1, 2, 3].map((i) => ({ id: 'x' + i, bot: 'mom', book: 'kalshi', side: 'yes', entry: 0.5, contracts: 4, stake: 2, fees: 0.04, pnl: 1, openedAt: `2026-11-20T0${i}:00:00Z`, settledAt: `2026-11-20T0${i}:10:00Z` }));
  const off = simulate(bets, {});
  const on = simulate(bets, { killSwitch: true });
  assert.equal(off.n, 3);
  assert.equal(on.n, 0);
  assert.equal(on.skipped.kill, 3);
});

test('runner guard drops every new line under the kill switch and keeps old ones', () => {
  const prev = [{ id: 'old', allocated: true, variant: 'a' }];
  const next = [{ id: 'old', allocated: true, variant: 'a' }, { id: 'n1', allocated: true, variant: 'a' }, { id: 'n2', allocated: false, variant: 'b' }];
  const g = guardNewOpens({ prevOpen: prev, nextOpen: next, settings: { killSwitch: true } });
  assert.deepEqual(g.open.map((r) => r.id), ['old']);
  assert.deepEqual(g.dropped.map((d) => d.why), ['kill switch', 'kill switch']);
  assert.equal(guardNewOpens({ prevOpen: prev, nextOpen: next, settings: {} }).open.length, 3);
});

// ---- fee-first ticket ----------------------------------------------------------
test('preTradeCheck: contracts, round-up fee, break-even, max win/loss, EV', () => {
  const t = preTradeCheck({ ask: 0.26, bid: 0.25, side: 'yes', stake: 2, pWin: 0.75 });
  assert.equal(t.contracts, 7);
  assert.equal(t.fee, kalshiTakerFee(0.26, 7));
  assert.equal(t.fee, 0.1);
  assert.ok(Math.abs(t.breakEven - (0.26 + 0.1 / 7)) < 1e-9);
  assert.ok(Math.abs(t.maxWin - (7 - 1.82 - 0.1)) < 1e-9);
  assert.ok(Math.abs(t.maxLoss + 1.92) < 1e-9);
  assert.ok(Math.abs(t.evYou - (0.75 * 7 - 1.82 - 0.1)) < 1e-9);
  assert.ok(Math.abs(t.pMarket - 0.255) < 1e-9);
  assert.ok(t.evMarket < 0, 'at the market price a taker loses the spread and fee');
  assert.ok(Math.abs(t.exitNow - (7 * 0.25 - 1.82 - 0.1 - kalshiTakerFee(0.25, 7))) < 1e-9);
  assert.equal(t.mode, 'paper');
  assert.equal(t.paper, true);
});

test('preTradeCheck: too small, no ask, maker fee and kill switch', () => {
  assert.equal(preTradeCheck({ ask: 0.9, stake: 0.5 }).why, 'too small');
  assert.equal(preTradeCheck({ ask: 1.2 }).why, 'no ask');
  assert.equal(preTradeCheck({ ask: 0.5, maker: true }).fee, 0);
  const k = preTradeCheck({ ask: 0.5, settings: normalizeBetSettings({ killSwitch: true }) });
  assert.equal(k.ok, false);
  assert.match(ticketHtml(k), /Kill switch is on/);
  const html = ticketHtml(preTradeCheck({ ask: 0.4 }), { title: 'T', simLabel: 'Sim @ $5' });
  for (const w of ['Contracts', 'Taker fee', 'Break-even', 'Max win', 'Max loss', 'EV after fees', 'PAPER · LIVE OFF', 'Sim @ $5']) assert.ok(html.includes(w), w);
});

test('preTradeCoin: break-even move covers both fees and both slips', () => {
  const t = preTradeCoin({ entry: 0.001, stake: 4, slip: 0.01 });
  const want = (1.0125 / 0.9875) * (1.01 / 0.99) - 1;
  assert.ok(Math.abs(t.breakEvenMove - want) < 1e-12);
  assert.ok(Math.abs(t.feeIn - 0.05) < 1e-12);
  assert.ok(t.breakEvenMove > 0.045 && t.breakEvenMove < 0.047);
  assert.match(ticketHtml(t), /Break-even move/);
});

// ---- calendar --------------------------------------------------------------------
const L = (t, pnl, extra = {}) => ({ t: Date.parse(t), pnl, fees: 0.05, bot: 'mom', book: 'kalshi', side: 'yes', entry: 0.5, payout: pnl > 0 ? 1 : 0, maker: false, contracts: 4, stake: 2, counted: false, ...extra });

test('calendar day keys follow the local offset', () => {
  const t = Date.parse('2026-11-25T03:30:00Z');
  assert.equal(dayKey(t, 0), '2026-11-25');
  assert.equal(dayKey(t, -300), '2026-11-24');
});

test('monthGrid starts on Sunday and covers the month', () => {
  const w = monthGrid(2026, 10); // November 2026 starts on a Sunday
  assert.equal(w[0][0], '2026-11-01');
  assert.equal(w.flat().filter(Boolean).length, 30);
  assert.ok(w.every((r) => r.length === 7));
  const f = monthGrid(2026, 1); // Feb 2026 starts on a Sunday too
  assert.equal(f.flat().filter(Boolean).length, 28);
});

test('day totals: recorded by default, re-scaled with a Sim buy-in, share stays recorded', () => {
  const lines = [L('2026-11-20T12:00:00Z', 1.9), L('2026-11-20T13:00:00Z', -2.05), L('2026-11-21T12:00:00Z', -2.05)];
  const rec = dayTotals(lines, { offsetMin: 0 });
  assert.equal(rec.get('2026-11-20').net, -0.15);
  assert.equal(rec.get('2026-11-20').n, 2);
  assert.equal(rec.get('2026-11-21').net, -2.05);
  const sim = dayTotals(lines, { settings: { defaultBuyIn: 10 }, offsetMin: 0 });
  assert.notEqual(sim.get('2026-11-21').net, rec.get('2026-11-21').net);
  assert.ok(sim.get('2026-11-21').net < -9);
  assert.equal(dayTotals(lines, { settings: { defaultBuyIn: 10 }, offsetMin: 0, recorded: true }).get('2026-11-21').net, -2.05);
  const sum = monthSummary(rec, 2026, 10);
  assert.equal(sum.red, 2);
  assert.equal(sum.green, 0);
  const share = calendarShareModel(rec, 2026, 10);
  assert.match(share.badge, /PAPER/);
  assert.match(share.note, /\$2/);
  assert.equal(share.net, -2.2);
});

test('calendar html: green/red cells, tap targets, sim badge, paper label', () => {
  const rec = dayTotals([L('2026-11-20T12:00:00Z', 1.9), L('2026-11-21T12:00:00Z', -2.05)], {});
  const h = calendarHtml({ totals: rec, year: 2026, month: 10, today: '2026-11-21' });
  assert.match(h, /data-cal-day="2026-11-20"[^>]*aria-label="2026-11-20: \+\$1\.90/);
  assert.match(h, /cal-cell is-up/);
  assert.match(h, /cal-cell is-dn is-today/);
  assert.match(h, /PAPER \$/);
  assert.match(h, /recorded \$2 lines/);
  assert.match(calendarHtml({ totals: rec, year: 2026, month: 10, simLabel: 'Sim @ $25' }), /simb">Sim @ \$25/);
  assert.match(daySheetHtml(rec.get('2026-11-21')), /data-cal-bot="mom"/);
});

// ---- replay and marks ---------------------------------------------------------------
test('window of a Kalshi line is the 15 minutes before close, with a Coinbase product', () => {
  const w = windowOf({ ticker: 'KXBTC15M-26NOV251645-45', closeAt: '2026-11-25T21:45:00Z', floorStrike: 60289.58 });
  assert.equal(w.end - w.start, WINDOW_MS);
  assert.equal(w.product, 'BTC-USD');
  assert.equal(w.strike, 60289.58);
  assert.equal(productFor({ ticker: 'KXBNB15M-X' }), null);
  assert.equal(windowOf({}), null);
});

test('replay frames reveal the path minute by minute and only passed marks', () => {
  const start = Date.parse('2026-11-25T21:30:00Z');
  const rows = Array.from({ length: 16 }, (_, i) => [(start + i * 60e3) / 1000, 99, 101, 100 + i, 100 + i + 0.5, 1]).reverse();
  const pts = candlePoints(rows);
  assert.equal(pts.length, 16);
  assert.ok(pts[0].t < pts[1].t);
  const win = { start, end: start + WINDOW_MS, strike: 105 };
  const bet = { side: 'yes', entry: 0.4, openedAt: new Date(start + 5 * 60e3).toISOString(), closeAt: new Date(start + WINDOW_MS).toISOString(), pnl: 1.1 };
  const marks = lineMarks(bet, pts);
  assert.deepEqual(marks.map((m) => m.kind), ['entry', 'exit']);
  assert.equal(marks[1].tone, 'up');
  const early = replayFrame({ points: pts, win, marks, frame: 2 / 15 });
  assert.equal(early.marks.length, 0);
  assert.equal(early.leaning, 'down');
  const mid = replayFrame({ points: pts, win, marks, frame: 0.5 });
  assert.equal(mid.marks.length, 1);
  const end = replayFrame({ points: pts, win, marks, frame: 1 });
  assert.equal(end.marks.length, 2);
  assert.equal(end.leaning, 'up');
  assert.equal(end.secondsLeft, 0);
});

test('coin marks use entry and exit prices for that coin only', () => {
  const m = coinMarks([
    { ca: 'A', bot: 'meme', entry: 1, exitPx: 1.2, pnl: 0.3, openedAt: '2026-11-25T10:00:00Z', settledAt: '2026-11-25T11:00:00Z' },
    { ca: 'B', bot: 'meme', entry: 5, openedAt: '2026-11-25T10:00:00Z' },
  ], 'A');
  assert.deepEqual(m.map((x) => [x.kind, x.v]), [['entry', 1], ['exit', 1.2]]);
});

test('chartSvg draws marks and the strike line', () => {
  const svg = chartSvg({ points: [{ t: 0, v: 1 }, { t: 60e3, v: 2 }], kind: 'price', marks: [{ t: 30e3, kind: 'entry', label: 'YES <b>' }, { t: 9e9, kind: 'exit' }], hline: { v: 1.5, label: 'start' }, domain: [0, 120e3] });
  assert.equal((svg.match(/dc-mark is-entry/g) || []).length, 1);
  assert.doesNotMatch(svg, /dc-mark is-exit/);
  assert.match(svg, /dc-hline/);
  assert.match(svg, /YES &lt;b&gt;/);
});

// ---- alerts -------------------------------------------------------------------------
test('alert rules are validated; bad ones drop', () => {
  assert.equal(cleanRule({ type: 'price', target: 'BTC', level: -1 }), null);
  assert.equal(cleanRule({ type: 'price', target: 'javascript:x', level: 5 }), null);
  assert.equal(cleanRule({ type: 'nope' }), null);
  assert.equal(cleanRule({ type: 'closing', secs: 5 }).secs, 30);
  assert.equal(cleanRules(DEFAULT_RULES).every((r) => r.on === false), true);
});

test('price alert fires on a crossing, not on first sight or every check', () => {
  const rules = [{ id: 'p', type: 'price', target: 'BTC', op: 'above', level: 100, on: true }];
  let r = evaluateAlerts(rules, { prices: { BTC: 120 } }, emptyMemory(), 1);
  assert.equal(r.events.length, 0, 'first sighting above does not fire');
  r = evaluateAlerts(rules, { prices: { BTC: 90 } }, r.memory, 2);
  assert.equal(r.events.length, 0);
  r = evaluateAlerts(rules, { prices: { BTC: 101 } }, r.memory, 3);
  assert.equal(r.events.length, 1);
  r = evaluateAlerts(rules, { prices: { BTC: 105 } }, r.memory, 4);
  assert.equal(r.events.length, 0);
});

test('closing alert fires once per window', () => {
  const now = Date.parse('2026-11-25T21:41:00Z');
  const markets = [{ ticker: 'KXBTC15M-A', series: 'KXBTC15M', closeTime: '2026-11-25T21:45:00Z', title: 'BTC price up in next 15 mins?' }];
  const rules = [{ id: 'c', type: 'closing', series: 'KXBTC15M', secs: 300, on: true }];
  let r = evaluateAlerts(rules, { markets }, emptyMemory(), now);
  assert.equal(r.events.length, 1);
  assert.match(r.events[0].body, /mins\? Call it/);
  r = evaluateAlerts(rules, { markets }, r.memory, now + 30e3);
  assert.equal(r.events.length, 0);
});

test('bot flip, new pick and daily recap alerts', () => {
  const flip = [{ id: 'f', type: 'botflip', bot: 'any', on: true }];
  let r = evaluateAlerts(flip, { decay: [{ id: 'mom', flag: 'flat' }] }, emptyMemory(), 1);
  r = evaluateAlerts(flip, { decay: [{ id: 'mom', flag: 'fading' }] }, r.memory, 2);
  assert.equal(r.events.length, 1);
  const pick = [{ id: 'k', type: 'pick', minScore: 60, on: true }];
  let q = evaluateAlerts(pick, { picks: [{ ca: 'A', score: 80 }] }, emptyMemory(), 1);
  assert.equal(q.events.length, 0, 'the first list is the baseline');
  q = evaluateAlerts(pick, { picks: [{ ca: 'A', score: 80 }, { ca: 'B', score: 40 }, { ca: 'C', score: 70, symbol: 'C' }] }, q.memory, 2);
  assert.deepEqual(q.events.map((e) => e.title), ['New coin pick: $C']);
  const recap = [{ id: 'r', type: 'recap', hour: 21, on: true }];
  let d = evaluateAlerts(recap, { recap: { net: -3.5, n: 10 }, localDay: '2026-11-25', localHour: 20 }, emptyMemory(), 1);
  assert.equal(d.events.length, 0);
  d = evaluateAlerts(recap, { recap: { net: -3.5, n: 10 }, localDay: '2026-11-25', localHour: 21 }, d.memory, 2);
  assert.match(d.events[0].title, /−\$3\.50 after fees/);
  d = evaluateAlerts(recap, { recap: { net: -3.5, n: 10 }, localDay: '2026-11-25', localHour: 22 }, d.memory, 3);
  assert.equal(d.events.length, 0);
});

test('alerts are rate limited and the inbox dedupes and caps', () => {
  const rules = Array.from({ length: 30 }, (_, i) => ({ id: 'p' + i, type: 'price', target: 'BTC', op: 'above', level: 100 + i, on: true }));
  let r = evaluateAlerts(rules, { prices: { BTC: 50 } }, emptyMemory(), 1000);
  r = evaluateAlerts(rules, { prices: { BTC: 500 } }, r.memory, 2000);
  assert.equal(r.events.length, ALERT_CAP_PER_HOUR);
  assert.equal(r.dropped, 30 - ALERT_CAP_PER_HOUR);
  const box = addToInbox(addToInbox([], r.events), r.events);
  assert.equal(box.length, ALERT_CAP_PER_HOUR);
  assert.equal(unreadCount(box), ALERT_CAP_PER_HOUR);
});

// ---- call-it streak --------------------------------------------------------------------
const mkt = (close, extra = {}) => ({ ticker: 'KXBTC15M-' + close, series: 'KXBTC15M', title: 'BTC price up in next 15 mins?', yesAsk: 0.52, yesBid: 0.5, noAsk: 0.5, noBid: 0.48, floorStrike: 60000, closeTime: new Date(close).toISOString(), result: '', ...extra });

test('call-it: correct calls earn XP, the stake never changes, streaks count days and hits', () => {
  const book = emptyTrainer();
  const day0 = Date.parse('2026-11-23T15:00:00Z');
  let hitsXp = 0;
  for (let d = 0; d < 3; d++) {
    const at = day0 + d * 86400e3;
    const m = mkt(at + 10 * 60e3);
    const res = placeTrainerCall(book, m, 'yes', 70, at, { fetchedAt: new Date(at).toISOString() });
    assert.ok(res.ok, res.reason);
    assert.equal(res.call.stake ?? TRAINER_STAKE, TRAINER_STAKE);
    const xp0 = book.xp;
    settleTrainer(book, { markets: [{ ...m, result: 'yes' }] }, at + 11 * 60e3, {});
    hitsXp = book.xp - xp0;
  }
  assert.equal(hitsXp, TRAINER_XP_SETTLE + TRAINER_XP_HIT);
  const s = callStreak(book, day0 + 2 * 86400e3 + 3600e3, 0);
  assert.equal(s.days, 3);
  assert.equal(s.hits, 3);
  assert.equal(s.bestHits, 3);
  assert.ok(s.badges.includes('hit3') && s.badges.includes('day3'));
  assert.equal(book.stakeUsd, TRAINER_STAKE);
  for (const c of book.closed) assert.ok(c.cost + c.fee <= TRAINER_STAKE + 0.2, 'every call is sized at $2');
  // A miss resets the hit run but not the day streak; no size change.
  const at = day0 + 3 * 86400e3;
  const m = mkt(at + 10 * 60e3);
  placeTrainerCall(book, m, 'yes', 90, at, { fetchedAt: new Date(at).toISOString() });
  const before = book.xp;
  settleTrainer(book, { markets: [{ ...m, result: 'no' }] }, at + 11 * 60e3, {});
  assert.equal(book.xp - before, TRAINER_XP_SETTLE);
  const s2 = callStreak(book, at + 3600e3, 0);
  assert.equal(s2.hits, 0);
  assert.equal(s2.bestHits, 3);
  assert.equal(s2.days, 4);
  assert.equal(book.closed.at(-1).contracts, book.closed[0].contracts, 'same $2 size after a streak and after a miss');
  assert.ok(TRAINER_XP_CALL > 0);
});

test('call-it: a day without a call breaks the day streak (yesterday still counts)', () => {
  const book = emptyTrainer();
  const t = Date.parse('2026-11-20T15:00:00Z');
  placeTrainerCall(book, mkt(t + 600e3), 'no', 60, t, { fetchedAt: new Date(t).toISOString() });
  assert.equal(callStreak(book, t + 86400e3, 0).days, 1, 'yesterday keeps it alive');
  assert.equal(callStreak(book, t + 2 * 86400e3, 0).days, 0);
});

test('call-it card: picks the soonest BTC window, shows the fee ticket, honest when stale', () => {
  const now = Date.parse('2026-11-25T21:35:00Z');
  const ms = [mkt(now + 20 * 60e3), mkt(now + 8 * 60e3), { ...mkt(now + 5 * 60e3), series: 'KXETH15M', ticker: 'KXETH15M-x' }];
  const m = pickCallMarket(ms, now);
  assert.equal(m.closeTime, new Date(now + 8 * 60e3).toISOString());
  const h = callItHtml({ market: m, book: emptyTrainer(), side: 'yes', conf: 75, now });
  assert.match(h, /data-ci-side="yes"/);
  assert.match(h, /break-even/);
  assert.match(h, /paper \$2/);
  assert.doesNotMatch(h, /data-ci-go="[^"]+" disabled/);
  assert.match(callItHtml({ market: m, book: emptyTrainer(), now }), /data-ci-go="[^"]+" disabled/);
  assert.match(callItHtml({ market: m, stale: true, now }), /older than 15 minutes/);
});

test('controls sheet shows the kill switch', () => {
  const h = controlsSheetHtml({ settings: normalizeBetSettings({ killSwitch: true }), doc: { bots: {} } });
  assert.match(h, /id="ctlKill" checked/);
  assert.match(h, /ctl-kill is-on/);
  assert.match(h, /<section class="ctl-sec"><h3>Default buy-in<\/h3>/, 'app.js relies on this marker');
});
