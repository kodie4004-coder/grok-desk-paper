import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CH_CHASE_CAP, CH_MIN_FORWARD, CH_WEIGHTS, CW_HORIZONS, forwardOnly, logChallenger, markPicks, pickRecord,
  promotionCheck, rankChallenger, rankWatch, scoreChallenger,
} from '../engine/coin-watch.js';
import { CH_SCORE_PARTS, challengerHtml, coinWatchHtml, pickSheetHtml } from '../engine/coin-watch-view.js';
import { updateCoinWatch } from '../runner/coin-watch.mjs';

const NOW = Date.parse('2026-11-26T12:00:00Z');
const H = 3600000;
const okReasons = () => [
  { name: 'liquidity', ok: true, detail: '$30,000' },
  { name: 'volume', ok: true, detail: '$90,000 / 24h' },
  { name: 'top 10 holders', ok: false, detail: 'lookup failed: HTTP 429' },
  { name: 'mint authority', ok: true, detail: 'no' },
  { name: 'freeze authority', ok: true, detail: 'no' },
];
const coin = (ca) => ({ ca, symbol: ca.toUpperCase(), name: ca, reasons: okReasons() });
const pair = (over = {}) => ({
  priceUsd: '0.001', pairCreatedAt: NOW - 6 * H, liquidity: { usd: 60000 }, volume: { h1: 120000, h24: 400000 },
  priceChange: { m5: 1, h1: 10, h6: 30, h24: 60 }, txns: { h1: { buys: 60, sells: 40 } }, url: 'https://dexscreener.com/solana/x', ...over,
});
const rug = (over = {}) => ({ mint: 'no', freeze: 'no', top10: 0.18, lpPct: 100, creatorShare: 0, insiders: 0, holders: 900, rugged: false, danger: [], warn: [], ...over });
const iso = (t) => new Date(t).toISOString();
const row = (ca, t, nets) => ({
  id: `${iso(t)}#${ca}`, ca, pickedAt: iso(t), price: 1, slip: 0.01, marks: Object.fromEntries(CW_HORIZONS.map((h, i) => [h.key, nets[i] == null ? undefined : { net: nets[i] }]).filter(([, v]) => v)),
});

test('challenger weights add to 100 and the view labels match them', () => {
  assert.equal(Object.values(CH_WEIGHTS).reduce((a, b) => a + b, 0), 100);
  assert.deepEqual(CH_SCORE_PARTS.map(([k, , max]) => [k, max]), Object.entries(CH_WEIGHTS));
});

test('challenger fades coins that already ran and never picks one up more than the cap', () => {
  const calm = scoreChallenger(pair({ priceChange: { h1: 10 } }), NOW);
  const warm = scoreChallenger(pair({ priceChange: { h1: 60 } }), NOW);
  const hot = scoreChallenger(pair({ priceChange: { h1: CH_CHASE_CAP + 50 } }), NOW);
  assert.ok(calm.score > warm.score && warm.score > hot.score);
  assert.equal(calm.parts.calm, CH_WEIGHTS.calm);
  assert.equal(hot.parts.calm, 0);
  assert.equal(hot.skip, true);
  assert.equal(calm.skip, false);
  for (const s of [calm, warm, hot, scoreChallenger({}, NOW)]) assert.ok(s.score >= 0 && s.score <= 100);
  assert.equal(scoreChallenger({}, NOW).score, 0);
});

test('challenger rewards depth and age, and keeps every safety block', () => {
  const thin = scoreChallenger(pair({ liquidity: { usd: 21000 }, volume: { h1: 40000, h24: 90000 } }), NOW);
  const deep = scoreChallenger(pair({ liquidity: { usd: 300000 }, volume: { h1: 400000, h24: 900000 } }), NOW);
  assert.ok(deep.parts.depth > thin.parts.depth);
  const young = scoreChallenger(pair({ pairCreatedAt: NOW - 0.5 * H }), NOW);
  const old = scoreChallenger(pair({ pairCreatedAt: NOW - 30 * H }), NOW);
  assert.equal(young.parts.age, 0);
  assert.equal(old.parts.age, CH_WEIGHTS.age);
  const cands = [
    { coin: coin('safe'), pair: pair(), rug: rug() },
    { coin: coin('norug'), pair: pair(), rug: null },
    { coin: coin('whale'), pair: pair(), rug: rug({ top10: 0.55 }) },
    { coin: coin('unlocked'), pair: pair(), rug: rug({ lpPct: 0 }) },
    { coin: coin('mintable'), pair: pair(), rug: rug({ mint: 'yes' }) },
    { coin: coin('devbag'), pair: pair(), rug: rug({ creatorShare: 0.2 }) },
    { coin: coin('rugged'), pair: pair(), rug: rug({ rugged: true }) },
    { coin: coin('danger'), pair: pair(), rug: rug({ danger: ['x'] }) },
    { coin: coin('chaser'), pair: pair({ priceChange: { h1: 300 } }), rug: rug() },
  ];
  const ch = rankChallenger(cands, NOW);
  assert.deepEqual(ch.map((p) => p.ca), ['safe']);
  assert.equal(ch[0].model, 'challenger');
  const champ = rankWatch(cands, NOW);
  assert.deepEqual(champ.map((p) => p.ca).sort(), ['chaser', 'safe']);
  assert.equal(champ[0].model, undefined);
  assert.match(pickSheetHtml(ch[0], 1), /Calm 1h move/);
  assert.match(pickSheetHtml(champ[0], 1), /Volume surge/);
});

test('only picks at or after the start count, and the challenger log stores pick-time features', () => {
  const start = iso(NOW - 2 * H);
  const log = [row('old', NOW - 3 * H, [1, 1, 1]), row('new', NOW - 1 * H, [-0.1, null, null])];
  assert.deepEqual(forwardOnly(log, start).map((r) => r.ca), ['new']);
  assert.deepEqual(forwardOnly(log, 'not a date'), []);
  const top = rankChallenger([{ coin: coin('fresh'), pair: pair(), rug: rug() }], NOW);
  const out = logChallenger(log, top, NOW, start);
  assert.deepEqual(out.log.map((r) => r.ca), ['new', 'fresh']);
  assert.equal(out.added.length, 1);
  assert.equal(out.added[0].h1, 10);
  assert.equal(out.added[0].ageMin, 360);
  assert.equal(out.added[0].model, 'challenger');
  const again = logChallenger(out.log, top, NOW + 60000, start);
  assert.equal(again.added.length, 0, 'no repick inside a day');
  const marked = markPicks(out.log, { fresh: 0.002 }, NOW + 16 * 60000);
  assert.ok(marked.log.find((r) => r.ca === 'fresh').marks.m15.net > 0);
});

const many = (n, t0, net1, net4, tag) => Array.from({ length: n }, (_, i) => row(`${tag}${i}`, t0 + i * 60000, [0, net1, net4]));

test('promotion needs 30 forward picks, a higher 1h mean and a 4h mean not worse', () => {
  const t0 = NOW - 10 * H;
  const startedAt = iso(t0);
  const champ = many(30, t0, -0.1, -0.05, 'c');
  const short = promotionCheck({ championLog: champ, challengerLog: many(CH_MIN_FORWARD - 1, t0, 0.2, 0.2, 'x'), startedAt, now: NOW });
  assert.equal(short.status, 'tracking');
  assert.equal(short.n, CH_MIN_FORWARD - 1);
  const win = promotionCheck({ championLog: champ, challengerLog: many(30, t0, -0.05, -0.05, 'x'), startedAt, now: NOW });
  assert.equal(win.status, 'promoted');
  assert.ok(win.promotedAt && win.atPromotion);
  assert.equal(promotionCheck({ championLog: champ, challengerLog: many(30, t0, -0.1, 0.5, 'x'), startedAt, now: NOW }).status, 'tracking', '1h tie stays');
  assert.equal(promotionCheck({ championLog: champ, challengerLog: many(30, t0, 0.5, -0.06, 'x'), startedAt, now: NOW }).status, 'tracking', '4h worse stays');
  // Champion history from before the start is not the comparison.
  const oldChamp = many(30, t0 - 5 * H, 0.9, 0.9, 'o');
  assert.equal(promotionCheck({ championLog: [...oldChamp, ...champ], challengerLog: many(30, t0, -0.05, -0.05, 'x'), startedAt, now: NOW }).status, 'promoted');
  // Challenger rows before the start never count toward the 30.
  const pre = many(40, t0 - 5 * H, 0.5, 0.5, 'p');
  assert.equal(promotionCheck({ championLog: champ, challengerLog: pre, startedAt, now: NOW }).n, 0);
  assert.equal(promotionCheck({ championLog: [], challengerLog: many(30, t0, 0.5, 0.5, 'x'), startedAt, now: NOW }).status, 'tracking');
  // Promotion sticks and keeps live numbers.
  const kept = promotionCheck({ championLog: champ, challengerLog: many(30, t0, -0.5, -0.5, 'x'), startedAt, prev: win, now: NOW + H });
  assert.equal(kept.status, 'promoted');
  assert.equal(kept.promotedAt, win.promotedAt);
  assert.equal(kept.challenger.h1.avgNet, -0.5);
});

test('the pill and compare only show numbers the runner wrote', () => {
  assert.equal(challengerHtml({ picks: [] }), '');
  const startedAt = iso(NOW - 10 * H);
  const champion = pickRecord(many(4, NOW - 9 * H, -0.2, -0.1, 'c'));
  const challenger = pickRecord(many(3, NOW - 9 * H, 0.1, 0.1, 'x'));
  const doc = { challenger: { startedAt }, promotion: { status: 'tracking', need: 30, n: 3, startedAt, champion, challenger } };
  const html = challengerHtml(doc);
  assert.match(html, /Challenger · 3\/30/);
  assert.match(html, /data-fold="cw-challenger"/);
  assert.match(html, /<th scope="row">Champion<\/th><td>4<\/td><td>0% <small>0\/4<\/small><\/td><td class="is-dn">-20\.0%<\/td>/);
  assert.match(html, /<th scope="row">Challenger<\/th><td>3<\/td><td>100% <small>3\/3<\/small><\/td><td class="is-up">\+10\.0%<\/td>/);
  assert.match(coinWatchHtml({ ...doc, updatedAt: iso(NOW), picks: [] }, NOW), /cw-ch-pill/);
  assert.match(challengerHtml({ ...doc, promotion: { ...doc.promotion, status: 'promoted', promotedAt: iso(NOW) } }), /Challenger · promoted/);
});

test('runner keeps the champion log and record untouched and writes the challenger apart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cw-'));
  const path = join(dir, 'coin-watch.json');
  const champLog = [row('hist', NOW - 30 * H, [0.1, -0.2, -0.3])];
  const cas = ['calm', 'chase'];
  const rugCache = Object.fromEntries(cas.map((ca) => [ca, { at: iso(NOW - 60000), rug: rug() }]));
  writeFileSync(path, JSON.stringify({ log: champLog, rugCache }));
  const pairs = { calm: pair(), chase: pair({ priceChange: { h1: 250 }, volume: { h1: 900000, h24: 1000000 }, liquidity: { usd: 90000 } }) };
  const meta = new Map(cas.map((ca) => [ca, { pair: pairs[ca] }]));
  const coins = cas.map(coin);
  const fetchImpl = async () => ({ ok: true, json: async () => ({ pairs: [] }) });
  const doc = await updateCoinWatch({ coins, meta, now: NOW, fetchImpl, path });
  assert.equal(doc.liveExecution, false);
  assert.equal(doc.active, 'champion');
  assert.deepEqual(doc.log[0], champLog[0], 'past champion rows are not rewritten');
  assert.ok(doc.log.every((r) => r.model === undefined));
  assert.ok(doc.log.some((r) => r.ca === 'chase'), 'champion still picks what it picked');
  assert.deepEqual(doc.record, pickRecord(doc.log));
  assert.equal(doc.challenger.startedAt, iso(NOW));
  assert.deepEqual(doc.challenger.log.map((r) => r.ca), ['calm']);
  assert.ok(doc.challenger.log.every((r) => r.model === 'challenger'));
  assert.deepEqual(doc.picks.map((p) => p.ca), doc.log.filter((r) => r.pickedAt === iso(NOW)).map((r) => r.ca));
  assert.equal(doc.promotion.status, 'tracking');
  // Next scan keeps the same start and does not mix logs.
  const later = await updateCoinWatch({ coins, meta, now: NOW + 20 * 60000, fetchImpl, path });
  assert.equal(later.challenger.startedAt, iso(NOW));
  assert.ok(later.challenger.log[0].marks.m15, 'challenger picks are marked at 15m');
  assert.equal(later.log.length, doc.log.length);
  assert.equal(later.challenger.record.picks, 1);
  const disk = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(disk.challenger.version, 'calm-depth-v1');
});
