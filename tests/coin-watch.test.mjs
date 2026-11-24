import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CW_HORIZONS, CW_PUSH_MIN, CW_PUSH_PER_DAY, CW_REPICK_MS, formatWatchPush, logPicks, markPicks, pendingMints,
  pickRecord, planWatchPush, rankWatch, readRugReport, scoreWatch, sparkFromPair, watchSafety,
} from '../engine/coin-watch.js';
import { coinWatchHtml, recordHtml, priceSparkSvg } from '../engine/coin-watch-view.js';
import { boardReady } from '../runner/coin-watch.mjs';

const NOW = Date.parse('2026-11-24T18:00:00Z');
const okReasons = () => [
  { name: 'liquidity', ok: true, detail: '$30,000' },
  { name: 'volume', ok: true, detail: '$90,000 / 24h' },
  { name: 'age', ok: true, detail: '120 min' },
  { name: 'quote', ok: true, detail: 'SOL' },
  { name: 'fdv / liquidity', ok: true, detail: '4' },
  { name: '1h move', ok: true, detail: '20%' },
  { name: 'top 10 holders', ok: false, detail: 'lookup failed: HTTP 429' },
  { name: 'mint authority', ok: true, detail: 'no' },
  { name: 'freeze authority', ok: true, detail: 'no' },
  { name: 'dev wallet share', ok: null, detail: 'unknown, does not block' },
];
const coin = (ca, extra = {}) => ({ ca, symbol: ca.toUpperCase(), name: ca, reasons: okReasons(), ...extra });
const pair = (over = {}) => ({
  priceUsd: '0.001',
  pairCreatedAt: NOW - 48 * 3600000,
  liquidity: { usd: 50000 },
  volume: { h1: 40000, h24: 240000 },
  priceChange: { m5: 2, h1: 20, h6: 40, h24: 80 },
  txns: { h1: { buys: 70, sells: 30 } },
  url: 'https://dexscreener.com/solana/pool',
  ...over,
});
const rug = (over = {}) => ({ mint: 'no', freeze: 'no', top10: 0.18, lpPct: 100, creatorShare: 0, insiders: 0, holders: 900, rugged: false, danger: [], warn: [], ...over });

test('score stays inside 0-100 and rises with a volume surge', () => {
  const calm = scoreWatch(pair({ volume: { h1: 10000, h24: 240000 } }), NOW);
  const hot = scoreWatch(pair({ volume: { h1: 400000, h24: 600000 }, liquidity: { usd: 600000 } }), NOW);
  for (const s of [calm, hot, scoreWatch({}, NOW)]) assert.ok(s.score >= 0 && s.score <= 100);
  assert.ok(hot.score > calm.score);
  assert.equal(scoreWatch({}, NOW).score, 0);
});

test('a young pool spreads 24h volume over its real age', () => {
  const young = scoreWatch(pair({ pairCreatedAt: NOW - 3600000, volume: { h1: 100000, h24: 100000 } }), NOW);
  assert.ok(young.surge <= 1.0001);
});

test('ranking never shows a coin that fails safety', () => {
  const cands = [
    { coin: coin('safe'), pair: pair(), rug: rug() },
    { coin: coin('norug'), pair: pair({ volume: { h1: 900000, h24: 900000 } }), rug: null },
    { coin: coin('whale'), pair: pair(), rug: rug({ top10: 0.55 }) },
    { coin: coin('unlocked'), pair: pair(), rug: rug({ lpPct: 0 }) },
    { coin: coin('mintable'), pair: pair(), rug: rug({ mint: 'yes' }) },
    { coin: coin('danger'), pair: pair(), rug: rug({ danger: ['Large Amount of LP Unlocked'] }) },
    { coin: coin('devbag'), pair: pair(), rug: rug({ creatorShare: 0.2 }) },
    { coin: coin('rugged'), pair: pair(), rug: rug({ rugged: true }) },
    { coin: coin('flagged', { jev: { verdict: 'flag' } }), pair: pair(), rug: rug() },
    { coin: { ...coin('thin'), reasons: okReasons().map((r) => (r.name === 'liquidity' ? { ...r, ok: false } : r)) }, pair: pair(), rug: rug() },
  ];
  const top = rankWatch(cands, NOW);
  assert.deepEqual(top.map((p) => p.ca), ['safe']);
  assert.equal(watchSafety(coin('x'), null).ok, false);
});

test('ranking sorts by score, caps the list, and carries card fields', () => {
  const cands = Array.from({ length: 8 }, (_, i) => ({ coin: coin(`c${i}`), pair: pair({ volume: { h1: 5000 * (i + 1), h24: 240000 } }), rug: rug() }));
  const top = rankWatch(cands, NOW);
  assert.equal(top.length, 5);
  for (let i = 1; i < top.length; i++) assert.ok(top[i - 1].score >= top[i].score);
  const p = top[0];
  assert.equal(p.ca, 'c7');
  assert.ok(p.reason.length > 0);
  assert.equal(p.spark.length, 5);
  assert.equal(p.ageMin, 48 * 60);
  assert.ok(p.flags.some((f) => f.label.startsWith('LP 100%')));
});

test('rug report leaves pool vaults out of the top 10 share', () => {
  const r = readRugReport({
    mint: 'M', mintAuthority: null, freezeAuthority: null, totalHolders: 50, creatorBalance: 0, token: { supply: 1000 },
    knownAccounts: { POOL: { type: 'AMM' } },
    markets: [{ pubkey: 'MKT', liquidityAAccount: { owner: 'MKT' }, lp: { lpLockedPct: 100, baseUSD: 10, quoteUSD: 10 } }, { pubkey: 'M2', lp: { lpLockedPct: 0, baseUSD: 1, quoteUSD: 1 } }],
    topHolders: [{ owner: 'POOL', address: 'a', pct: 30 }, { owner: 'MKT', address: 'b', pct: 20 }, { owner: 'w1', address: 'c', pct: 10, insider: true }, { owner: 'w2', address: 'd', pct: 5 }],
    risks: [{ name: 'Low holders', level: 'warn' }],
  });
  assert.equal(r.top10, 0.15);
  assert.equal(r.lpPct, 100);
  assert.equal(r.insiders, 1);
  assert.deepEqual(r.warn, ['Low holders']);
  assert.equal(readRugReport({}), null);
});

test('spark points come from real % changes', () => {
  const pts = sparkFromPair(pair({ priceUsd: '2', priceChange: { h24: 100, h1: 0 } }));
  assert.deepEqual(pts.map((p) => p.m), [-1440, -60, 0]);
  assert.equal(pts[0].p, 1);
  assert.match(priceSparkSvg(pts), /<svg/);
});

test('picks are logged once a day with the price when picked', () => {
  const top = [{ ca: 'A', symbol: 'A', priceUsd: 0.01, score: 70, liq: 40000 }];
  const first = logPicks([], top, NOW);
  assert.equal(first.added.length, 1);
  assert.equal(first.log[0].price, 0.01);
  assert.equal(first.log[0].pickedAt, new Date(NOW).toISOString());
  const again = logPicks(first.log, top, NOW + 3600000);
  assert.equal(again.added.length, 0);
  const later = logPicks(first.log, top, NOW + CW_REPICK_MS + 1);
  assert.equal(later.added.length, 1);
  assert.equal(later.log.length, 2);
});

test('marks land at 15m, 1h and 4h, after fees, and skip bad prints', () => {
  const { log } = logPicks([], [{ ca: 'A', symbol: 'A', priceUsd: 1, score: 60, liq: 1e6 }], NOW);
  assert.deepEqual(pendingMints(log, NOW + 60000), []);
  let step = markPicks(log, { A: 1.2 }, NOW + 15 * 60000);
  assert.equal(step.marked, 1);
  const m = step.log[0].marks.m15;
  assert.equal(m.ret, 0.2);
  assert.ok(m.net < 0.2 && m.net > 0.1, 'net is after fee and slip');
  // flat price is a loss after fees
  step = markPicks(step.log, { A: 1 }, NOW + 61 * 60000);
  assert.ok(step.log[0].marks.h1.net < 0);
  // a 100x+ print is a bad feed, not a result
  const bad = markPicks(step.log, { A: 500 }, NOW + 4 * 3600000);
  assert.equal(bad.log[0].marks.h4, undefined);
  // no good price inside 30 minutes is recorded as missed
  const missed = markPicks(bad.log, {}, NOW + 4 * 3600000 + 31 * 60000);
  assert.equal(missed.log[0].marks.h4.missed, true);
  const rec = pickRecord(missed.log);
  assert.equal(rec.m15.n, 1); assert.equal(rec.m15.hits, 1);
  assert.equal(rec.h1.n, 1); assert.equal(rec.h1.hits, 0);
  assert.equal(rec.h4.n, 0); assert.equal(rec.h4.missed, 1);
  assert.equal(CW_HORIZONS.length, 3);
});

test('empty record says tracking starts now', () => {
  assert.match(recordHtml(pickRecord([])), /Tracking starts now/);
  const html = coinWatchHtml({ updatedAt: new Date(NOW).toISOString(), picks: [], record: pickRecord([]), scanned: 6, blocked: 6 }, NOW);
  assert.match(html, /Nothing safe right now/);
  assert.match(html, /not advice/);
  assert.match(html, /losing after fees/);
});

test('card shows score, links, and a copyable mint, and no buy button', () => {
  const top = rankWatch([{ coin: coin('MintAddr1111111111111111111pump'), pair: pair(), rug: rug() }], NOW);
  const html = coinWatchHtml({ updatedAt: new Date(NOW).toISOString(), picks: top, record: pickRecord([]) }, NOW);
  assert.match(html, /data-copy="MintAddr1111111111111111111pump"/);
  assert.match(html, /pump\.fun\/coin\/MintAddr/);
  assert.match(html, /fomo\.family\/tokens\/solana\/MintAddr/);
  assert.match(html, /dexscreener\.com/);
  assert.doesNotMatch(html, /\b(buy now|connect wallet|sign)\b/i);
});

test('push only for a fresh high score, capped per day', () => {
  const picks = [{ ca: 'A', score: CW_PUSH_MIN + 2 }, { ca: 'B', score: CW_PUSH_MIN - 1 }, { ca: 'C', score: 99 }];
  const added = [{ ca: 'A' }, { ca: 'B' }];
  assert.deepEqual(planWatchPush(picks, added, { sent: [] }, NOW).map((p) => p.ca), ['A']);
  const full = { sent: Array.from({ length: CW_PUSH_PER_DAY }, (_, i) => ({ ca: `x${i}`, at: new Date(NOW - 1000).toISOString() })) };
  assert.equal(planWatchPush(picks, added, full, NOW).length, 0);
  const msg = formatWatchPush({ ca: 'A', symbol: 'AAA', score: 90, reason: 'r' }, 'https://desk');
  assert.match(msg.body, /not advice/);
});

test('board coins need every check except the ones RugCheck replaces', () => {
  assert.equal(boardReady(coin('a')), true);
  assert.equal(boardReady({ ca: 'b', reasons: okReasons().map((r) => (r.name === 'age' ? { ...r, ok: false } : r)) }), false);
  assert.equal(boardReady({ ca: 'c', reasons: [] }), false);
});

test('coin watch is wired read-only and keeps the topic secret', () => {
  const mod = readFileSync(new URL('../engine/coin-watch.js', import.meta.url), 'utf8');
  const run = readFileSync(new URL('../runner/coin-watch.mjs', import.meta.url), 'utf8');
  const snap = readFileSync(new URL('../runner/snapshot-meme.mjs', import.meta.url), 'utf8');
  const push = readFileSync(new URL('../runner/push-snapshot.sh', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  for (const text of [mod, run]) {
    assert.doesNotMatch(text, /privateKey|secretKey|signTransaction|sendTransaction|Keypair/);
    assert.doesNotMatch(text, /console\.log\([^)]*(topic|NTFY_TOPIC)/);
  }
  assert.match(snap, /updateCoinWatch\(/);
  assert.match(snap, /delete env\.NTFY_TOPIC/);
  assert.match(push, /data\/coin-watch\.json/);
  assert.doesNotMatch(app, /NTFY_TOPIC/);
  assert.match(app, /coinWatchHtml\(/);
});
