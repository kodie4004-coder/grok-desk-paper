// Round 3: away recap, Today strip, arena feed sheet, share-card models.
import test from 'node:test';
import assert from 'node:assert/strict';
import { seenSnapshot, awaySummary, awayHtml, todayStripHtml, clockText, AWAY_MIN_MS } from '../engine/away.js';
import { feedSheetHtml, shareModel } from '../engine/feed-view.js';

const T = Date.parse('2026-11-25T15:00:00Z');
const snap = (at, net, n, bots, picks) => ({ at, net, n, bots, picks });

test('snapshot needs a real curve and keeps bots and picks', () => {
  assert.equal(seenSnapshot({ curve: null }), null);
  const s = seenSnapshot({ curve: { net: -39.33, n: 376 }, today: { decay: [{ id: 'a', net: 2 }, { id: 'b' }] }, coinWatch: { picks: [{ ca: 'X' }, {}] }, now: T });
  assert.deepEqual(s, { at: T, net: -39.33, n: 376, bots: { a: 2 }, picks: ['X'] });
});

test('away summary is the real difference between two visits', () => {
  const prev = snap(T - 3 * 3600e3, -40, 370, { a: 10, b: 5 }, ['X']);
  const cur = snap(T, -38.5, 381, { a: 9, b: 8.25 }, ['X', 'Y', 'Z']);
  const s = awaySummary(prev, cur);
  assert.equal(s.away, '3 hr');
  assert.equal(s.pnl, 1.5);
  assert.equal(s.bets, 11);
  assert.deepEqual(s.mover, { id: 'b', delta: 3.25 });
  assert.equal(s.newPicks, 2);
  const html = awayHtml(s);
  assert.match(html, /While you were away/);
  assert.match(html, /\+\$1\.50/);
  assert.match(html, /b \+\$3\.25/);
});

test('no recap on a quick return, a first visit, or when nothing changed', () => {
  assert.equal(awaySummary(null, snap(T, 1, 1, {}, [])), null);
  assert.equal(awaySummary(snap(T - AWAY_MIN_MS + 1000, 1, 1, {}, []), snap(T, 2, 5, {}, [])), null);
  assert.equal(awaySummary(snap(T - 2 * AWAY_MIN_MS, 1, 1, { a: 1 }, ['X']), snap(T, 1, 1, { a: 1 }, ['X'])), null);
  assert.equal(awayHtml(null), '');
});

test('today strip shows the hot bot, coin picks and a live clock from real data', () => {
  const html = todayStripHtml({ today: { decay: [{ id: 'late', recentN: 100, recentNet: 7.35 }, { id: 'mom', recentN: 100, recentNet: -3 }] }, coinWatch: { picks: [{ ca: 'A', score: 35 }, { ca: 'B', score: 44 }] }, closeAt: new Date(T + 372e3).toISOString(), now: T });
  assert.match(html, /Hot bot/);
  assert.match(html, /\+\$7\.35/);
  assert.match(html, /late · last 100/);
  assert.match(html, /top score 44/);
  assert.match(html, /data-close="2026-11-25T15:06:12\.000Z">6:12</);
  assert.equal(todayStripHtml({}), '');
  assert.equal(clockText(T - 5, T), '0:00');
});

test('feed sheet splits the reason and shows a settle result', () => {
  const html = feedSheetHtml({ t: T, action: 'settle', rule: 'revert', title: 'EUR/USD up?', won: true, pnl: 0.88, fees: 0.12, reason: 'PAPER win · result yes · fee $0.12' });
  assert.match(html, /SETTLE · revert/);
  assert.match(html, /Mean revert/);
  assert.match(html, /\+\$0\.88/);
  assert.match(html, /<li>result yes<\/li>/);
  assert.match(html, /Paper only/);
  assert.equal(feedSheetHtml(null), '');
});

test('share models carry a paper label and only real numbers', () => {
  const b = shareModel('bot', { id: 'fair-spot-v2', family: 'fair', net: 55.29, n: 549, mean: 0.1, spark: [1, 2, null, 3] });
  assert.equal(b.big, '+$55.29');
  assert.match(b.badge, /PAPER TRADING · NOT REAL MONEY/);
  assert.deepEqual(b.spark, [1, 2, 3]);
  assert.match(b.lines[0], /549 paper bets/);
  assert.equal(shareModel('bot', { id: 'x' }), null);
  const p = shareModel('pick', { ca: 'M', name: 'Test', symbol: 'T', score: 35, reason: 'r', flags: [{ label: 'LP 100% locked' }], spark: [{ p: 1 }, { p: 0 }, { p: 2 }] });
  assert.match(p.badge, /NOT ADVICE/);
  assert.deepEqual(p.spark, [1, 2]);
  assert.equal(shareModel('pick', { ca: 'M' }), null);
  for (const m of [b, p]) assert.doesNotMatch(JSON.stringify(m), /guaranteed|profit guaranteed|get rich/i);
});
