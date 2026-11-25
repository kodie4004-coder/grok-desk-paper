// Round 5: the buy-in drives every money number (paper sim), not just rows.
// Regression for "I set the buy amount higher and it doesn't affect it".
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { betsDoc, kalshiBet, rescale, normalizeBetSettings, pnlSeries, lineStake } from '../engine/bets.js';
import { linesFile, decodeLines, simBook, simDoc, simDecay, simCurve, isSim, simLabel, simLine } from '../engine/sim.js';
import { viewRows, betsViewHtml } from '../engine/bets-view.js';
import { heroHtml } from '../engine/home-view.js';

const day = new Date(Date.UTC(2026, 10, 25, 18)).getTime();
const k = (i, o = {}) => ({ id: 'k' + i, variant: i % 2 ? 'mom' : 'late', family: 'mom', allocated: i % 3 === 0, ticker: 'T' + i, series: 'KXBTC15M', side: 'yes', ask: [0.39, 0.62, 0.91, 0.12][i % 4], contracts: Math.floor(2 / [0.39, 0.62, 0.91, 0.12][i % 4] + 1e-9), sizeUsd: 2, openedAt: new Date(day - (i + 1) * 3.1e6 - 600e3).toISOString(), settledAt: new Date(day - (i + 1) * 3.1e6).toISOString(), closeTime: new Date(day - (i + 1) * 3.1e6).toISOString(), won: i % 4 !== 1, ...o });
function settle(r) {
  const b = kalshiBet({ ...r, pnl: 0, settledAt: r.settledAt });
  const x = rescale({ ...b, pnl: 0 }, 2);
  return { ...r, pnl: x.pnl, fees: x.fees };
}
const kRows = Array.from({ length: 60 }, (_, i) => settle(k(i, i === 7 ? { exitPx: 0.55 } : i === 9 ? { maker: true } : {})));
const mRows = Array.from({ length: 12 }, (_, i) => ({ id: 'm' + i, variant: i % 2 ? 'meme-safety' : 'trend-rotate', ca: 'CA' + (i % 3), symbol: 'C' + (i % 3), entry: 0.001, exitPx: 0.0011 + i * 1e-5, sizeUsd: 2, pnl: (i % 3 - 1) * 0.3, fees: 0.05, allocated: i % 4 === 0, openedAt: new Date(day - i * 4e6 - 9e5).toISOString(), settledAt: new Date(day - i * 4e6).toISOString() }));
const doc = betsDoc({ kalshiRows: kRows, memeRows: mRows, kalshiOpen: [k(99, { pnl: undefined, settledAt: null, closeTime: new Date(day + 600e3).toISOString() })], now: day, histPerBot: 150 });
const file = JSON.parse(JSON.stringify(linesFile({ kalshiRows: kRows, memeRows: mRows, now: day })));
const lines = decodeLines(file);

test('lines.json round-trips: at $2 the sim equals the recorded totals, per bot and overall', () => {
  assert.equal(file.paper, true);
  assert.equal(file.liveExecution, false);
  assert.equal(lines.length, doc.totals.n);
  const b = simBook(lines, { defaultBuyIn: 2 }, { now: day });
  for (const key of ['n', 'net', 'todayNet', 'countedNet', 'countedN', 'todayN']) assert.ok(Math.abs(b.totals[key] - doc.totals[key]) < 0.011, key);
  for (const [id, bot] of Object.entries(doc.bots)) { assert.ok(Math.abs(b.bots[id].net - bot.net) < 0.011, id); assert.equal(b.bots[id].n, bot.n); }
  assert.equal(isSim({ defaultBuyIn: 2 }), false);
  assert.equal(simLabel({ defaultBuyIn: 2 }), null);
});

test('a higher default buy-in moves today, all-time, per-bot, counted and hourly numbers', () => {
  const s = normalizeBetSettings({ defaultBuyIn: 25 });
  const b = simBook(lines, s, { now: day });
  const sum = (f) => lines.filter(f).reduce((a, l) => a + simLine(l, lineStake(s, l.bot, l.ca)).pnl, 0);
  assert.ok(Math.abs(b.totals.net - sum(() => true)) < 0.011);
  assert.ok(Math.abs(b.totals.net - doc.totals.net) > 1, 'all-time must change');
  assert.ok(Math.abs(b.totals.todayNet - doc.totals.todayNet) > 0.5, 'today must change');
  assert.ok(Math.abs(b.totals.rec.net - doc.totals.net) < 0.011, 'recorded $2 kept alongside');
  const v = simDoc(doc, b);
  assert.equal(v.sim.label, 'Sim @ $25');
  assert.notEqual(v.bots.mom.net, doc.bots.mom.net);
  const s2 = pnlSeries(v, { range: 'all', now: day });
  assert.ok(Math.abs(s2.total - b.totals.net) < 0.011, 'chart ends at the sim all-time');
  assert.ok(Math.abs(s2.points[s2.points.length - 1].v - b.totals.net) < 0.011);
});

test('Kalshi sim is exact per line (whole contracts, round-up fee each taker leg); coins scale with stake', () => {
  const kl = lines.find((l) => l.book === 'kalshi' && !l.maker && l.payout > 0 && l.payout < 1);
  const r = simLine(kl, 10);
  const c = Math.floor(10 / kl.entry + 1e-9);
  assert.equal(r.contracts, c);
  const fee = Math.ceil((0.07 * c * kl.entry * (1 - kl.entry) - 1e-9) * 100) / 100 + Math.ceil((0.07 * c * kl.payout * (1 - kl.payout) - 1e-9) * 100) / 100;
  assert.ok(Math.abs(r.fees - fee) < 1e-9);
  assert.ok(Math.abs(r.pnl - (c * kl.payout - c * kl.entry - fee)) < 1e-9);
  const cl = lines.find((l) => l.book === 'coin');
  assert.ok(Math.abs(simLine(cl, 20).pnl - cl.pnl * 10) < 1e-9);
  const tiny = simLine(lines.find((l) => l.book === 'kalshi' && l.entry > 0.5), 0.5);
  assert.equal(tiny.tooSmall, true);
});

test('a per-bot buy-in applies to that bot\'s coin lines; a coin practice buy-in wins over it', () => {
  const s = normalizeBetSettings({ defaultBuyIn: 2, buyIn: { 'meme-safety': 10 }, coinBuyIn: { CA1: 4 } });
  assert.equal(lineStake(s, 'meme-safety', 'CA0'), 10);
  assert.equal(lineStake(s, 'meme-safety', 'CA1'), 4);
  assert.equal(lineStake(s, 'trend-rotate', 'CA0'), 2);
  assert.equal(lineStake(s, 'mom', null), 2);
  const rows = viewRows({ ...doc, recent: doc.recent }, s, {}, day);
  const ms = rows.find((r) => r.bot === 'meme-safety' && r.ca === 'CA0');
  assert.equal(ms.view.stake, 10, 'coin rows used to ignore the per-bot buy-in');
  assert.equal(simLabel(s), 'Sim @ $2 + per-bot');
});

test('Bets view: the hero, tiles and board follow the sim with a Sim badge, the recorded $2 and a one-tap reset', () => {
  const s = normalizeBetSettings({ defaultBuyIn: 25 });
  const v = simDoc(doc, simBook(lines, s, { now: day }));
  const html = betsViewHtml({ doc: v, rawDoc: doc, settings: s, now: day });
  assert.match(html, /class="simb"[^>]*>Sim @ \$25</);
  assert.match(html, /Recorded at \$2: today/);
  assert.match(html, /data-sim-reset/);
  assert.match(html, new RegExp(`data-count-key="bets-all" data-big="1" data-sign="1"`));
  assert.ok(html.includes(`data-count="${v.totals.net}" data-count-key="bets-all"`));
  assert.match(html, /Sim @ \$25 · all lines re-scaled/);
  const plain = betsViewHtml({ doc, rawDoc: doc, settings: normalizeBetSettings(null), now: day });
  assert.doesNotMatch(plain, /class="simb"/);
  assert.doesNotMatch(plain, /data-sim-reset/);
  assert.match(plain, /recorded \$2 lines/);
  const pending = betsViewHtml({ doc: { ...doc, simPending: 'Sim @ $25' }, rawDoc: doc, settings: s, now: day });
  assert.match(pending, /Re-scaling every recorded line/);
});

test('bot cards and the home hero follow the sim; at $2 they are unchanged', () => {
  const decay = [{ id: 'mom', n: doc.bots.mom.n, net: doc.bots.mom.net, mean: 0, recentN: 5, recentNet: 1, recentFrom: new Date(lines.filter((l) => l.bot === 'mom').slice(-5)[0].open).toISOString(), beforeN: doc.bots.mom.n - 5, spark: [0.1, 0.2, 0.3, 0.4, 1] }];
  const same = simDecay(decay, lines, { defaultBuyIn: 2 });
  assert.ok(Math.abs(same[0].net - decay[0].net) < 0.011);
  assert.ok(Math.abs(same[0].recentNet - decay[0].recentNet) < 0.011);
  const big = simDecay(decay, lines, { defaultBuyIn: 25 });
  assert.notEqual(big[0].net, decay[0].net);
  assert.equal(big[0].sim, true);
  assert.equal(big[0].rec.net, decay[0].net);
  const c2 = simCurve(lines, { defaultBuyIn: 2 }, { now: day });
  assert.ok(Math.abs(c2.net - doc.totals.countedNet) < 0.011);
  const c25 = simCurve(lines, { defaultBuyIn: 25 }, { now: day });
  assert.notEqual(c25.net, c2.net);
  const hero = heroHtml({ curve: { ...c25, label: 'Sim @ $25' }, today: null, brain: null, now: day });
  assert.match(hero, /Sim @ \$25/);
  assert.match(hero, /Recorded at \$2/);
});

test('the app saves buy-ins as you type, re-renders every money tab, and offers an update reload', () => {
  const app = fs.readFileSync('app.js', 'utf8');
  assert.match(app, /el\.oninput = \(\) => \{ clearTimeout\(ui\.ctlTyping\)/);
  assert.match(app, /\['bets', 'home', 'brain'\]\.includes\(ui\.tab\)\) render\(\)/);
  assert.match(app, /controllerchange/);
  assert.match(app, /New version ready/);
  assert.match(app, /data\/lines\.json/);
  assert.match(app, /sheetDecayRaw\(\)\.find/, 'share cards keep the recorded $2 result');
  const sw = fs.readFileSync('sw.js', 'utf8');
  assert.match(sw, /'engine\/sim\.js'/);
});

test('the runner writes lines.json and pushes it; it still records $2 lines only', () => {
  const wt = fs.readFileSync('runner/write-today.mjs', 'utf8');
  assert.match(wt, /data\/lines\.json/);
  const sh = fs.readFileSync('runner/push-snapshot.sh', 'utf8');
  assert.equal((sh.match(/data\/lines\.json/g) || []).length >= 2, true);
  const sim = fs.readFileSync('engine/sim.js', 'utf8');
  assert.doesNotMatch(sim, /settleRow|sizeUsd\s*=|writeFileSync/);
});

test('real journal: lines.json at $2 reproduces data/bets.json totals', { skip: !fs.existsSync('data/lines.json') || !fs.existsSync('data/bets.json') }, () => {
  const f = JSON.parse(fs.readFileSync('data/lines.json', 'utf8'));
  const d = JSON.parse(fs.readFileSync('data/bets.json', 'utf8'));
  if (f.generatedAt !== d.generatedAt) return; // written in the same step; skip a mismatched pair
  const b = simBook(decodeLines(f), { defaultBuyIn: 2 }, { now: Date.parse(d.generatedAt) });
  assert.equal(b.totals.n, d.totals.n);
  assert.ok(Math.abs(b.totals.net - d.totals.net) < 0.05);
});
