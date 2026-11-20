import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { applyWatch, openMemeCount, stopSlippage, watchBudget, watchHealth, watchHealthLine, watchIntervalMs, watchStamp, WATCH_STALE_MS, MEME_RULES, MEME_SIZE } from '../engine/meme.js';
import { quoteCrossed, replayResting, restingExpectancy, settlementProb, upgradeLines } from '../engine/upgrades.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeMemeJournal, mergeMemeOpen } from '../runner/merge-meme.mjs';
import { watchKickDecision } from '../runner/kick-watch.mjs';
import { stepJournal, signal, reviewBrain, defaultBrain, VARIANTS, LEARN_SIZE } from '../engine/learn.js';

const now = Date.parse('2026-11-20T12:00:00Z');
const root = new URL('..', import.meta.url);

function market(over) {
  return {
    ticker: 'KXBTC15M-T', series: 'KXBTC15M', title: 'BTC',
    yesAsk: 0.55, noAsk: 0.48, yesBid: 0.5, noBid: 0.45,
    closeTime: '2026-11-20T12:05:00Z', floorStrike: 100, result: '', ...over,
  };
}

test('a fast check sells at the stop or the target and does not open a new coin', () => {
  const open = [{ id: 'meme:CA', ca: 'CA', symbol: 'T', entry: 1, sizeUsd: 2, openedAt: new Date(now - 60000).toISOString(), variant: 'meme-safety', allocated: true }];
  const held = applyWatch({ open, prices: { CA: 0.9 }, now, history: [] });
  assert.equal(held.settled.length, 0);
  assert.equal(held.open.length, 1);
  const stopped = applyWatch({ open, prices: { CA: 0.8 }, now, history: [] });
  assert.equal(stopped.settled.length, 1);
  assert.equal(stopped.settled[0].exit, 'stop');
  assert.equal(stopped.settled[0].watch, true);
  assert.equal(stopped.settled[0].sizeUsd, MEME_SIZE);
  assert.equal(stopped.settled[0].exitPx, 0.8);
  assert.ok(Math.abs(stopped.settled[0].gap - (0.8 - MEME_RULES.stop)) < 1e-12);
  const target = applyWatch({ open, prices: { CA: 1.3 }, now, history: [] });
  assert.equal(target.settled[0].exit, 'take-profit');
  const again = applyWatch({ open, prices: { CA: 0.5 }, now, history: stopped.settled });
  assert.equal(again.settled.length, 0);
  assert.equal(again.open.length, 0);
});

test('stop slippage is measured from fills, and a missing fast sample is not a number', () => {
  const rows = [
    { exit: 'stop', entry: 1, exitPx: 0.8 },
    { exit: 'stop', entry: 1, exitPx: 0.7 },
    { exit: 'time-stop', entry: 1, exitPx: 0.5 },
  ];
  const report = stopSlippage(rows);
  assert.equal(report.rule, MEME_RULES.stop - 1);
  assert.equal(report.before.n, 2);
  assert.ok(Math.abs(report.before.meanRealized - (-0.25)) < 1e-12);
  assert.equal(report.before.medianRealized, -0.25);
  assert.ok(Math.abs(report.before.meanGap - (-0.10)) < 1e-12);
  assert.equal(report.after.n, 0);
  assert.equal(report.after.meanRealized, null);
  const watched = stopSlippage([...rows, { exit: 'stop', entry: 1, exitPx: 0.85, watch: true }]);
  assert.equal(watched.after.n, 1);
  assert.ok(Math.abs(watched.after.meanGap) < 1e-12);
  const stored = fs.readFileSync('data/meme-journal.jsonl', 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const live = stopSlippage(stored);
  const stops = stored.filter((row) => row.exit === 'stop' && !row.watch && row.entry > 0 && row.exitPx > 0);
  assert.equal(live.before.n, stops.length);
  const mean = stops.reduce((sum, row) => sum + (row.exitPx / row.entry - 1), 0) / stops.length;
  assert.ok(Math.abs(live.before.meanRealized - mean) < 1e-9);
  assert.equal(live.after.n, stored.filter((row) => row.exit === 'stop' && row.watch).length);
  // The snapshot job keeps appending stops, and CI merges that newer journal.
  // The saved report is a point in time, so it is not required to match the file.
  const saved = JSON.parse(fs.readFileSync('data/meme-stops.json', 'utf8'));
  assert.equal(typeof saved.before.n, 'number');
  assert.equal(typeof saved.after.n, 'number');
  const shadow = JSON.parse(fs.readFileSync('data/research-upgrades.json', 'utf8'));
  assert.equal(shadow.maker.queue, 'last');
  assert.equal(shadow.maker.measured, true);
  assert.equal(shadow.maker.attempts, shadow.maker.filled + shadow.maker.unfilled);
  assert.equal(shadow.liveExecution, false);
  assert.equal(shadow.settlement.n, 0);
});

test('the watcher stays inside 2 to 5 seconds and well under 300 DexScreener calls a minute', () => {
  assert.equal(watchIntervalMs(1000), 2000);
  assert.equal(watchIntervalMs(9000), 5000);
  assert.equal(watchIntervalMs(4000), 4000);
  assert.ok(watchBudget(8, 4000) < 30);
  assert.ok(watchBudget(8, 4000) < 300);
  assert.equal(watchBudget(0, 4000), 0);
});

test('a resting order fills only after a later quote crosses, and an unfilled order is not a trade', () => {
  const when = Date.parse('2026-11-20T12:02:00Z');
  const brain = defaultBrain();
  const first = stepJournal({ markets: [market()], open: [], quotes: {}, brain, existingIds: [], now: when });
  const rest = first.open.find((row) => row.variant === 'rest-maker');
  assert.ok(rest);
  assert.equal(rest.resting, true);
  assert.equal(rest.fee, 0);
  assert.equal(rest.sizeUsd, LEARN_SIZE);
  assert.equal(rest.role, 'challenger');
  const quiet = stepJournal({ markets: [market({ yesAsk: 0.54, yesBid: 0.49 })], open: first.open, quotes: {}, brain, existingIds: [], now: when + 1000 });
  assert.equal(quiet.settled.some((row) => row.variant === 'rest-maker'), false);
  assert.ok(quiet.open.some((row) => row.variant === 'rest-maker' && row.resting));
  const crossed = stepJournal({ markets: [market({ yesAsk: 0.49, yesBid: 0.47, result: 'yes' })], open: quiet.open, quotes: {}, brain, existingIds: [], now: when + 2000 });
  const fill = crossed.settled.find((row) => row.variant === 'rest-maker');
  assert.ok(fill);
  assert.equal(fill.fees, 0);
  assert.equal(fill.ask, rest.limit);
  assert.equal(fill.sizeUsd, 2);
  assert.ok(fill.pnl > 0);
  const missed = stepJournal({ markets: [market({ yesAsk: 0.7, yesBid: 0.6, result: 'no' })], open: first.open, quotes: {}, brain, existingIds: [], now: when + 3000 });
  assert.equal(missed.settled.some((row) => row.variant === 'rest-maker'), false);
  assert.equal(missed.open.some((row) => row.variant === 'rest-maker'), false);
  assert.equal(quoteCrossed(0.5, { yesAsk: 0.49 }), true);
  assert.equal(quoteCrossed(0.5, { yesAsk: 0.5 }), false);
  assert.equal(quoteCrossed(0.5, { lastTrade: 0.5, yesAsk: 0.55 }), false);
  assert.equal(quoteCrossed(0.5, { lastTrade: 0.49, yesAsk: 0.55 }), true);
  assert.equal(quoteCrossed(0.5, { yesAsk: 0.55, yesBid: 0.4 }), false);
});

test('maker expectancy counts a fill and skips an order the next trade never reached', () => {
  const close = Date.parse('2026-11-20T12:15:00Z');
  const candle = (sec, bid, ask, low) => ({
    end_period_ts: (close - sec * 1000) / 1000,
    yes_bid: { close_dollars: bid.toFixed(2) },
    yes_ask: { close_dollars: ask.toFixed(2), low_dollars: ask.toFixed(2) },
    price: { low_dollars: low.toFixed(2) },
  });
  const filled = replayResting({
    ticker: 'KXBTC15M-A', series: 'KXBTC15M', close, result: 'yes',
    candles: [candle(300, 0.4, 0.45, 0.4), candle(180, 0.35, 0.39, 0.36)],
  });
  assert.equal(filled.filled, true);
  assert.equal(filled.maker.fees, 0);
  assert.ok(filled.taker.fees > 0);
  const missed = replayResting({
    ticker: 'KXBTC15M-B', series: 'KXBTC15M', close, result: 'yes',
    candles: [candle(300, 0.4, 0.45, 0.4), candle(180, 0.44, 0.48, 0.42)],
  });
  assert.equal(missed.filled, false);
  const touched = replayResting({
    ticker: 'KXBTC15M-C', series: 'KXBTC15M', close, result: 'no',
    candles: [candle(300, 0.4, 0.45, 0.4), candle(180, 0.4, 0.4, 0.4)],
  });
  assert.equal(touched.filled, false);
  assert.equal(touched.queue, 'last');
  assert.equal(touched.maker, null);
  assert.equal(missed.maker, null);
  const stats = restingExpectancy([filled, missed]);
  assert.equal(stats.attempts, 2);
  assert.equal(stats.filled, 1);
  assert.equal(stats.unfilled, 1);
  assert.equal(stats.makerMean, filled.maker.pnl);
  assert.ok(stats.takerMean != null);
  const takerOnly = (filled.taker.pnl + missed.taker.pnl) / 2;
  assert.ok(Math.abs(stats.takerMean - takerOnly) < 1e-9);
});

test('settlement probability uses the minute average, and one tick on the other side does not flip it', () => {
  const below = settlementProb({ strike: 100, avg60: 99.9, secondsLeft: 180 });
  const above = settlementProb({ strike: 100, avg60: 100.2, secondsLeft: 180 });
  assert.ok(below < 0.5);
  assert.ok(above > 0.5);
  assert.equal(settlementProb({ strike: 100, avg60: null, secondsLeft: 180 }), null);
  const variant = VARIANTS.find((row) => row.id === 'mom-settle');
  assert.equal(variant.role, 'challenger');
  assert.equal(variant.family, 'mom');
  const when = Date.parse('2026-11-20T12:02:00Z');
  const down = signal(variant, market({ yesAsk: 0.4, noAsk: 0.62 }), when, { spots: { BTC: { px: 101, avg60: 99.9 } } });
  assert.equal(down.side, 'no');
  const up = signal(variant, market({ yesAsk: 0.4, noAsk: 0.62 }), when, { spots: { BTC: { px: 99, avg60: 100.2 } } });
  assert.equal(up.side, 'yes');
  assert.equal(signal(variant, market(), when, { spots: { BTC: { px: 101 } } }), null);
});

test('the new variants stay challengers and a short sample does not replace the champion', () => {
  assert.equal(VARIANTS.find((row) => row.id === 'rest-maker').role, 'challenger');
  const rows = Array.from({ length: 3 }, (_, i) => ({
    variant: 'mom-settle', family: 'mom', window: '2026-11-18', pnl: 0.2, series: 'KXBTC15M', ticker: 'm' + i, sizeUsd: 2, closeTime: '2026-11-18T12:00:00Z',
  }));
  const brain = reviewBrain(defaultBrain(), rows, now, { iters: 20 });
  assert.equal(brain.champions.mom, 'mom');
  assert.equal(brain.decisions.some((line) => /mom-settle replaces/.test(line)), false);
  const fresh = stepJournal({ markets: [market()], open: [], quotes: {}, brain: defaultBrain(), existingIds: [], now: Date.parse('2026-11-20T12:02:00Z') });
  assert.equal(fresh.brain.weights['rest-maker'], 0.25);
  assert.equal(fresh.brain.weights['mom-settle'], 0.25);
  const lines = upgradeLines({
    meme: stopSlippage([{ exit: 'stop', entry: 1, exitPx: 0.8 }]),
    maker: { measured: false },
    settlement: { n: 0 },
  });
  const text = lines.join(' ');
  assert.match(text, /New research upgrades/);
  assert.match(text, /20\.0%/);
  assert.match(text, /no fast fill/i);
  assert.match(text, /challenger/i);
  assert.match(text, /live execution stays off/i);
  const src = readFileSync(fileURLToPath(new URL('app.js', root)), 'utf8');
  assert.match(src, /live_execution[\s\S]*disabled/);
  assert.doesNotMatch(readFileSync(fileURLToPath(new URL('engine/upgrades.js', root)), 'utf8'), /privateKey|secretKey/);
});

test('a meme push keeps both journals and drops a coin that either side already sold', () => {
  const earlier = JSON.stringify({ id: 'meme:A', exit: 'stop', entry: 1, exitPx: 0.7, settledAt: '2026-11-20T01:00:00Z' });
  const later = JSON.stringify({ id: 'meme:A', exit: 'stop', entry: 1, exitPx: 0.8, settledAt: '2026-11-20T01:02:00Z', watch: true });
  const extra = JSON.stringify({ id: 'meme:B', exit: 'take-profit', entry: 1, exitPx: 1.3, settledAt: '2026-11-20T01:03:00Z' });
  const journal = mergeMemeJournal(`${earlier}\n`, `${later}\n${extra}\n`);
  const ids = journal.trim().split('\n').map((line) => JSON.parse(line).id);
  assert.deepEqual(ids.sort(), ['meme:A', 'meme:B']);
  assert.equal(JSON.parse(journal.trim().split('\n').find((line) => line.includes('meme:A'))).exitPx, 0.7);
  const open = mergeMemeOpen(
    { entries: [{ id: 'meme:A' }, { id: 'meme:C' }] },
    { entries: [{ id: 'meme:B' }, { id: 'meme:D' }] },
    journal,
  );
  assert.deepEqual(open.entries.map((row) => row.id).sort(), ['meme:C', 'meme:D']);
});

test('the free watcher chains itself and pushes with the rebase retry', () => {
  const yml = readFileSync(fileURLToPath(new URL('.github/workflows/meme-watch.yml', root)), 'utf8');
  const kick = readFileSync(fileURLToPath(new URL('.github/workflows/meme-watch-kick.yml', root)), 'utf8');
  const push = readFileSync(fileURLToPath(new URL('runner/push-snapshot.sh', root)), 'utf8');
  assert.match(yml, /group: meme-stop-watch/);
  assert.match(yml, /cancel-in-progress: false/);
  assert.match(yml, /push-snapshot\.sh/);
  assert.match(yml, /queue-watch\.sh/);
  assert.match(kick, /cron:/);
  assert.match(push, /git rebase origin\/main/);
  assert.match(push, /merge-meme\.mjs/);
  assert.match(push, /meme-watch\.json/);
});

test('a watch pass is stale only when a paper coin is open and the last pass is more than 10 minutes old', () => {
  const t0 = Date.parse('2026-11-20T17:00:00Z');
  const open = [{ id: 'meme:A', open: true, paper: true }];
  assert.equal(WATCH_STALE_MS, 10 * 60 * 1000);
  assert.equal(watchHealth({ open, watchedAt: new Date(t0 - WATCH_STALE_MS).toISOString(), now: t0 }).stale, false);
  const justOver = watchHealth({ open, watchedAt: new Date(t0 - WATCH_STALE_MS - 1).toISOString(), now: t0 });
  assert.equal(justOver.stale, true);
  assert.match(watchHealthLine(justOver), /more than 10 minutes ago/);
  const missing = watchHealth({ open, watchedAt: null, now: t0 });
  assert.equal(missing.stale, true);
  assert.match(watchHealthLine(missing), /1 paper coin is open/);
  assert.match(watchHealthLine(missing), /no watch pass yet/);
  assert.equal(watchHealth({ open: [], watchedAt: null, now: t0 }).stale, false);
  assert.equal(watchHealthLine(watchHealth({ open: [], watchedAt: null, now: t0 })), '');
  const fresh = watchHealth({ open, watchedAt: new Date(t0 - 4 * 60 * 1000).toISOString(), now: t0 });
  assert.equal(fresh.stale, false);
  assert.equal(watchHealthLine(fresh), '');
  const old = watchHealth({
    open: [open[0], { id: 'meme:B', shadow: true }],
    watchedAt: new Date(t0 - 74 * 60 * 1000).toISOString(),
    now: t0,
  });
  assert.equal(old.stale, true);
  assert.equal(old.open, 2);
  assert.match(watchHealthLine(old), /2 paper coins are open/);
  assert.match(watchHealthLine(old), /74 minutes ago/);
  const sold = watchHealth({ open: [{ id: 'meme:C', exit: 'stop', pnl: -1 }], watchedAt: null, now: t0 });
  assert.equal(sold.stale, false);
  const stamp = watchStamp({ open: 2, calls: 4, at: t0 });
  assert.equal(stamp.paper, true);
  assert.equal(stamp.watchedAt, new Date(t0).toISOString());
  assert.equal(stamp.open, 2);
  assert.equal(stamp.calls, 4);
});

test('the kalshi chain and the meme snapshot dispatch a watch pass without workflow_run', () => {
  const kalshi = readFileSync(fileURLToPath(new URL('.github/workflows/kalshi-15m.yml', root)), 'utf8');
  const watch = readFileSync(fileURLToPath(new URL('.github/workflows/meme-watch.yml', root)), 'utf8');
  const kick = readFileSync(fileURLToPath(new URL('.github/workflows/meme-watch-kick.yml', root)), 'utf8');
  const snap = readFileSync(fileURLToPath(new URL('runner/snapshot-meme.mjs', root)), 'utf8');
  const kickSh = readFileSync(fileURLToPath(new URL('runner/kick-watch.sh', root)), 'utf8');
  const queue = readFileSync(fileURLToPath(new URL('runner/queue-watch.sh', root)), 'utf8');
  const watcher = readFileSync(fileURLToPath(new URL('runner/watch-meme.mjs', root)), 'utf8');
  const app = readFileSync(fileURLToPath(new URL('app.js', root)), 'utf8');
  const triggers = (yml) => (yml.split(/^on:\n/m)[1] || '').split(/^permissions:/m)[0];
  assert.match(kalshi, /actions: write/);
  assert.match(kalshi, /GH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  assert.match(kalshi, /Dispatch a meme stop pass when a paper coin is open[\s\S]*if: always\(\)[\s\S]*bash runner\/kick-watch\.sh/);
  assert.doesNotMatch(triggers(kalshi), /workflow_run:/);
  assert.doesNotMatch(triggers(watch), /workflow_run:/);
  assert.doesNotMatch(triggers(kick), /workflow_run:/);
  assert.match(watch, /group: meme-stop-watch/);
  assert.match(watch, /cancel-in-progress: false/);
  assert.match(kick, /cron: '\*\/5 \* \* \* \*'/);
  assert.match(snap, /runner\/kick-watch\.sh/);
  assert.match(kickSh, /queue-watch\.sh/);
  assert.match(kickSh, /actions: write/);
  assert.match(queue, /gh workflow run meme-watch\.yml/);
  assert.match(watcher, /data\/meme-watch\.json/);
  assert.match(app, /Strategy health[\s\S]{0,200}watchStatus\(\)/);
  assert.match(app, /Morning report[\s\S]{0,250}watchStatus\(\)/);
  assert.match(app, /Paper meme book[\s\S]{0,600}watchStatus\(\)/);
  assert.match(app, /data\/meme-watch\.json/);
  assert.equal(MEME_SIZE, 2);
  assert.equal(watchKickDecision(0), 'skip');
  assert.equal(watchKickDecision(2), 'dispatch');
  assert.equal(openMemeCount({ entries: [] }), 0);
  assert.equal(openMemeCount({ entries: [{ id: 'sold', pnl: -1, exit: 'stop' }] }), 0);
  assert.equal(openMemeCount({ entries: [{ id: 'shadow', shadow: true, paper: true }] }), 1);
  const dir = mkdtempSync(join(tmpdir(), 'kick-watch-'));
  try {
    const empty = join(dir, 'empty.json');
    const held = join(dir, 'held.json');
    fs.writeFileSync(empty, JSON.stringify({ entries: [] }));
    fs.writeFileSync(held, JSON.stringify({ entries: [{ id: 'meme:A', paper: true }, { id: 'meme:B', exit: 'stop', pnl: -1 }] }));
    const cwd = fileURLToPath(root);
    assert.equal(execFileSync('node', ['runner/kick-watch.mjs', empty], { cwd, encoding: 'utf8' }).trim(), 'skip');
    assert.equal(execFileSync('node', ['runner/kick-watch.mjs', held], { cwd, encoding: 'utf8' }).trim(), 'dispatch');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
