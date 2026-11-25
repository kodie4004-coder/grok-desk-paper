// Round-2 UI: bottom-sheet bodies and the pick record tiles. Display only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { botSheetHtml } from '../engine/home-view.js';
import { pickSheetHtml, pickHtml, recordHtml, SCORE_PARTS } from '../engine/coin-watch-view.js';

const bot = { id: 'mom-settle', book: 'kalshi', family: 'mom', n: 3407, net: 76.01, mean: 0.02, recentN: 100, recentNet: -14.56, recentMean: -0.15, recentWinRate: 0.69, beforeN: 3307, beforeMean: 0.03, spark: [1, 3, 2, 5, 4, 6], flag: 'decaying' };

test('bot sheet shows the real net, chart, last-100 vs before, and no live control', () => {
  const html = botSheetHtml(bot, { focus: { near: [{ id: 'mom-settle', gate: { need: 3, windows: 6, cleared: 1 } }] } });
  assert.match(html, /\+\$76\.01/);
  assert.match(html, /<svg class="spark/);
  assert.match(html, /Last 100[\s\S]*−\$0\.15/);
  assert.match(html, /Before[\s\S]*\+\$0\.03/);
  assert.match(html, /69%/);
  assert.match(html, /1 of 6 profitable/);
  assert.match(html, /fading/);
  assert.doesNotMatch(html, /execute|go live|buy now/i);
  assert.equal(botSheetHtml(null), '');
});

test('bot sheet skips the comparison when there is no before window', () => {
  const html = botSheetHtml({ ...bot, beforeN: 0, beforeMean: null });
  assert.doesNotMatch(html, /sh-form/);
});

const pick = { ca: 'MintAddr1111111111111111111pump', symbol: 'TEST', name: 'Test', score: 35, parts: { surge: 0, vol: 11.4, depth: 6, trend: 13.5, buys: 3.8 }, liq: 52495, volH1: 138538, h1: 26.98, ageMin: 1026, holders: 12720, flags: [{ label: 'LP 100% locked' }, { label: 'Top10 30%', warn: true }], reason: '$139k traded in 1h', spark: [{ m: -1440, p: 1 }, { m: 0, p: 2 }] };

test('pick sheet has the full mint, copy, three app links, score parts out of their weights', () => {
  const html = pickSheetHtml(pick, 1);
  assert.match(html, /MintAddr1111111111111111111pump<\/span>/);
  assert.match(html, /data-copy="MintAddr1111111111111111111pump"/);
  assert.match(html, /pump\.fun\/coin\/MintAddr/);
  assert.match(html, /fomo\.family\/tokens\/solana\/MintAddr/);
  assert.match(html, /dexscreener\.com/);
  assert.match(html, /14\/15/);
  assert.match(html, /\+27\.0%/);
  assert.match(html, /12,720/);
  assert.match(html, /not advice/);
  assert.equal(SCORE_PARTS.reduce((a, [, , max]) => a + max, 0), 100);
  assert.doesNotMatch(html, /\b(buy now|connect wallet)\b/i);
});

test('compact pick row opens the sheet and keeps copy one tap away', () => {
  const html = pickHtml(pick, 2);
  assert.match(html, /data-open-pick="MintAddr1111111111111111111pump"/);
  assert.match(html, /data-copy="MintAddr1111111111111111111pump"/);
  assert.match(html, /check flags/);
});

test('record tiles show hit counts and after-fee average per hold', () => {
  const html = recordHtml({ picks: 34, m15: { n: 34, hits: 12, avgNet: -0.1117 }, h1: { n: 0 }, h4: { n: 31, hits: 9, avgNet: 0.0307 } });
  assert.match(html, /12\/34 up/);
  assert.match(html, /−?-?11\.2%/);
  assert.match(html, /cw-tile is-up[^>]*--p:29%/);
  assert.match(html, /waiting/);
});
