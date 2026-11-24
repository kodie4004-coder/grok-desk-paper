import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { usd, sparkSvg, deskStatus, gateSummary, gateProgressOf, botChipsHtml, heroHtml, agentGridHtml, gateMeterHtml, logEvents, liveLogHtml, deskHomeHtml, familyOf } from '../engine/home-view.js';

const now = Date.parse('2026-11-24T17:00:00Z');
const stat = (over) => ({ id: 'mom-settle', book: 'kalshi', family: 'mom', n: 100, net: 5, mean: 0.05, recentN: 100, recentNet: 2, recentMean: 0.02, spark: [0.1, 0.4, 0.2, 0.9], small: false, flag: null, ...over });
const focus = {
  near: [
    { id: 'mom-strict', mean: 0.01, gate: { windows: 6, cleared: 3, need: 3, graduated: false } },
    { id: 'mom-settle', mean: 0.05, gate: { windows: 5, cleared: 2, need: 3, graduated: false } },
  ],
  research: [{ id: 'pairs-lag', mean: 0.03, gate: { windows: 2, cleared: 1, need: 3, graduated: false } }],
};

test('money has a real minus sign and a plus on gains', () => {
  assert.equal(usd(-39.33), '−$39.33');
  assert.equal(usd(1234.5), '+$1,234.50');
  assert.equal(usd(0), '$0.00');
  assert.equal(usd(null), '—');
});

test('sparkline starts at break-even and colors by the last point', () => {
  assert.equal(sparkSvg([1]), '');
  assert.match(sparkSvg([1, 2, -3]), /is-dn/);
  assert.match(sparkSvg([1, 2, 3]), /is-up/);
  assert.match(sparkSvg([1, 2, 3], { label: 'curve' }), /role="img" aria-label="curve"/);
});

test('desk status light follows feed age: green fresh, amber at 20 min, red at 60 min or missing', () => {
  const at = (min) => new Date(now - min * 60000).toISOString();
  assert.equal(deskStatus({ kalshiFetchedAt: at(3), memeFetchedAt: at(4) }, now).tone, 'g');
  assert.equal(deskStatus({ kalshiFetchedAt: at(25), memeFetchedAt: at(4) }, now).tone, 'y');
  assert.equal(deskStatus({ kalshiFetchedAt: at(3), memeFetchedAt: at(90) }, now).tone, 'r');
  assert.equal(deskStatus(null, now).tone, 'r');
});

test('gate progress needs every window positive, so a bot with 3 of 6 good windows is not done', () => {
  assert.deepEqual(gateProgressOf(focus.near[0]), { good: 3, total: 6, ratio: 0.5, graduated: false });
  assert.equal(gateProgressOf(focus.research[0]).total, 3);
  const g = gateSummary(focus);
  assert.equal(g.total, 3);
  assert.equal(g.passed, 0);
  assert.equal(g.closest.id, 'mom-strict');
  const html = gateMeterHtml(focus);
  assert.match(html, /Not yet/);
  assert.match(html, /3 of 6 test windows profitable/);
  assert.equal((html.match(/<i class="on">/g) || []).length, 3);
  assert.equal(gateMeterHtml({}), '');
});

test('hero shows the allocated after-fee number, bet count, open lines and practice today', () => {
  const html = heroHtml({ curve: { net: -39.33, n: 376, points: [1, -2, -39.33] }, today: { allocated: { n: 0 }, shadow: { n: 4139, pnl: -129.6 } }, brain: { experimentSince: '2026-11-19T04:20:29.490Z' }, openN: 29, now });
  assert.match(html, /−\$39\.33/);
  assert.match(html, /376 bets · 5 days · 29 open · practice mode/);
  assert.match(html, /Practice today/);
  assert.match(html, /−\$129\.60/);
  assert.match(html, /hero2 is-dn/);
});

test('bot chips sort by last-100 net and keep each bot', () => {
  const html = botChipsHtml([stat({ id: 'a', recentNet: -1 }), stat({ id: 'b', recentNet: 3 })]);
  assert.ok(html.indexOf('>b<') < html.indexOf('>a<'));
  assert.match(html, /is-dn/);
  assert.equal(botChipsHtml([]), '');
});

test('agent grid ranks by all-time net, keeps small samples last, and folds the rest', () => {
  const list = [stat({ id: 'tiny', net: 9, small: true }), stat({ id: 'best', net: 7 }), stat({ id: 'worst', net: -5, flag: 'decaying' }), stat({ id: 'rise', net: 1, flag: 'improving' })];
  const html = agentGridHtml(list, { benched: ['worst'], champions: { mom: 'best' } }, { top: 2 });
  assert.ok(html.indexOf('best') < html.indexOf('rise'));
  assert.ok(html.indexOf('worst') < html.indexOf('tiny'));
  assert.match(html, /All 4 bots/);
  assert.match(html, /champ/);
  assert.match(html, /benched/);
  assert.match(html, /fading/);
  assert.match(html, /rising/);
});

test('families map to fixed accents; coins use the meme accent', () => {
  assert.equal(familyOf({ id: 'fair-spot-v2', family: 'fair' }), 'fair');
  assert.equal(familyOf({ id: 'early-entry', book: 'meme' }), 'meme');
  assert.equal(familyOf({ id: 'rest-maker' }), 'rest');
});

test('live log merges open paper bets and coin alerts, newest first', () => {
  const openDoc = { entries: [
    { variant: 'flip', family: 'flip', side: 'no', title: 'BTC price up in next 15 mins?', ask: 0.46, openedAt: '2026-11-24T16:50:00Z' },
    { variant: 'mom-settle', family: 'mom', side: 'yes', title: 'ETH price up in next 15 mins?', ask: 0.9, openedAt: '2026-11-24T16:40:00Z' },
  ] };
  const alerts = { sent: [{ symbol: 'PUMP', at: '2026-11-24T16:45:00Z', ca: 'x' }] };
  const ev = logEvents({ openDoc, alerts });
  assert.deepEqual(ev.map((e) => e.who), ['flip', 'coin alert', 'mom-settle']);
  assert.equal(ev[0].text, 'NO BTC 46¢');
  const html = liveLogHtml({ openDoc, alerts, now });
  assert.match(html, /10m/);
  assert.doesNotMatch(html, /\bx\b<\/span>/);
});

test('desk home has no execute or live-trading control and says paper only', () => {
  const html = deskHomeHtml({ today: { decay: [stat()], allocated: { n: 0 }, shadow: { n: 1, pnl: 0 } }, curve: { net: 1, n: 2, points: [0.5, 1] }, focus, now });
  assert.match(html, /Paper only/);
  assert.doesNotMatch(html, /execute|go live|live trading|wallet connect/i);
  assert.doesNotMatch(html, /<input/);
});

test('service worker caches the home view module', () => {
  const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
  assert.match(sw, /'engine\/home-view\.js'/);
});

test('gate list ranks by good-window share and skips bots with no trades', async () => {
  const { gateListHtml } = await import('../engine/home-view.js');
  const html = gateListHtml({ near: [...focus.near.map((r) => ({ ...r, n: 10 })), { id: 'empty', n: 0, gate: { windows: 0, cleared: 0, need: 3 } }] });
  assert.ok(html.indexOf('mom-strict') < html.indexOf('mom-settle'));
  assert.doesNotMatch(html, /empty/);
});
