import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyWatch, MEME_RULES, MEME_SIZE, memePnl, stepMeme } from '../engine/meme.js';
import { sleeveBenched } from '../engine/repair.js';
import { challengerRows } from '../engine/upgrades.js';
import { mergeEarlyLog } from '../runner/merge-meme.mjs';
import {
  EARLY_RULES, EARLY_SOURCES, candidatesFromSources, decideCandidate, earlyClears, earlyShadow, earlySlip,
  fromGeckoPools, fromPump, launchMultiple, loadSources, needsChain, nextLog, openEarly, readLp, readRug,
} from '../engine/early.js';

const now = Date.parse('2026-11-20T18:00:00Z');

function young(over = {}) {
  return {
    ca: 'MINT',
    symbol: 'NEW',
    name: 'New Coin',
    priceUsd: 0.0001,
    liq: 8000,
    ageMin: 12,
    h1: 20,
    quote: 'SOL',
    dexUrl: 'https://dexscreener.com/solana/MINT',
    ...over,
  };
}

const safe = { mint: 'no', freeze: 'no', top10: 0.2 };
const locked = { known: true, locked: true, pct: 100 };
const full = { checkedSafety: true, safety: safe, checkedLp: true, lp: locked };

test('the meme safety bars stay put', () => {
  assert.equal(MEME_RULES.minAgeMin, 30);
  assert.equal(MEME_RULES.minLiq, 20000);
  assert.equal(MEME_RULES.maxTop10, 0.40);
  assert.equal(EARLY_RULES.maxTop10, MEME_RULES.maxTop10);
  assert.equal(MEME_SIZE, 2);
});

test('a flat early slip still loses the fee, and a thin pool does not clear the target', () => {
  const flat = memePnl(1, 1);
  const same = memePnl(1, 1, undefined);
  assert.equal(same.pnl, flat.pnl);
  assert.equal(earlyClears(8000), true);
  assert.equal(earlyClears(30), false);
  assert.ok(earlySlip(30) > earlySlip(8000));
});

test('mint authority still on is a kill', () => {
  const row = decideCandidate(young(), { ...full, safety: { ...safe, mint: 'yes' } });
  assert.equal(row.action, 'kill');
  assert.match(row.reason, /mint authority: not revoked/);
});

test('freeze authority still on is a kill', () => {
  const row = decideCandidate(young(), { ...full, safety: { ...safe, freeze: 'yes' } });
  assert.equal(row.action, 'kill');
  assert.match(row.reason, /freeze authority: not revoked/);
});

test('a missing mint lookup is a kill and an unknown LP is not', () => {
  const missed = decideCandidate(young(), { ...full, safety: { mint: null, freeze: 'no', top10: 0.1, mintDetail: 'lookup failed' } });
  assert.equal(missed.action, 'kill');
  assert.match(missed.reason, /mint authority: lookup failed/);
  const unknownLp = decideCandidate(young(), { ...full, lp: { known: false, locked: null, pct: null } });
  assert.equal(unknownLp.action, 'enter');
  assert.ok(unknownLp.checks.some((item) => item.name === 'lp' && item.action === 'unknown'));
});

test('RugCheck locked percent kills only when the pool is known to be unlocked', () => {
  assert.equal(readLp({ lpLockedPct: 100 }).locked, true);
  assert.equal(readLp({ lpLockedPct: 93.7 }).locked, true);
  assert.equal(readLp({ lpLockedPct: 10 }).locked, false);
  assert.equal(readLp({}).known, false);
  const unlocked = decideCandidate(young(), { ...full, lp: readLp({ lpLockedPct: 0 }) });
  assert.equal(unlocked.action, 'kill');
  assert.match(unlocked.reason, /lp:/);
  const partial = decideCandidate(young(), { ...full, lp: readLp({ lpLockedPct: 70 }) });
  assert.equal(partial.action, 'enter');
});

test('top 10 over 40 percent is a kill and a missing share is a kill', () => {
  const heavy = decideCandidate(young(), { ...full, safety: { ...safe, top10: 0.55 } });
  assert.equal(heavy.action, 'kill');
  assert.match(heavy.reason, /top 10 holders: 55\.0%/);
  const missing = decideCandidate(young(), { ...full, safety: { ...safe, top10: null, top10Detail: 'no holder accounts' } });
  assert.equal(missing.action, 'kill');
  assert.match(missing.reason, /top 10 holders: no holder accounts/);
});

test('liquidity under the floor is a kill', () => {
  const thin = decideCandidate(young({ liq: 400 }), full);
  assert.equal(thin.action, 'kill');
  assert.match(thin.reason, /liquidity: \$400/);
  assert.equal(needsChain(young({ liq: 400 })), false);
});

test('a $2 take-profit that does not clear modeled slippage is a kill', () => {
  const row = decideCandidate(young({ liq: 30 }), full);
  assert.equal(row.action, 'kill');
  assert.match(row.reason, /expectancy:/);
  assert.match(row.reason, /liquidity:/);
});

test('already up 3x is a pass, and a hard kill still wins', () => {
  assert.equal(launchMultiple(young({ h1: 250, ageMin: 8 })) >= 3, true);
  const chase = decideCandidate(young({ h1: 250, ageMin: 8 }), full);
  assert.equal(chase.action, 'pass');
  assert.match(chase.reason, /chase not entry/);
  const rugged = decideCandidate(young({ h1: 250, ageMin: 8 }), { ...full, safety: { ...safe, mint: 'yes' } });
  assert.equal(rugged.action, 'kill');
  assert.match(rugged.reason, /mint authority/);
  const old = decideCandidate(young({ ageMin: 45 }), full);
  assert.equal(old.action, 'pass');
  assert.match(old.reason, /not early/);
  assert.equal(needsChain(young({ ageMin: 45 })), false);
});

test('a fresh coin that clears the hard checks opens one $2 shadow', () => {
  const row = decideCandidate(young(), full);
  assert.equal(row.action, 'enter');
  assert.equal(row.slip, earlySlip(8000));
  const added = openEarly({ decisions: [row], open: [], now });
  assert.equal(added.length, 1);
  assert.equal(added[0].sizeUsd, 2);
  assert.equal(added[0].allocated, false);
  assert.equal(added[0].shadow, true);
  assert.equal(added[0].variant, 'early-entry');
  assert.equal(added[0].paper, true);
  const again = openEarly({ decisions: [row, row], open: added, now });
  assert.equal(again.length, 0);
  const fullBook = openEarly({
    decisions: Array.from({ length: 6 }, (_, i) => ({ ...row, ca: 'C' + i })),
    open: [],
    now,
  });
  assert.equal(fullBook.length, EARLY_RULES.maxOpen);
  assert.ok(fullBook.every((pos) => pos.allocated === false && pos.sizeUsd === 2));
});

test('early shadows do not take the baseline slots or clear a benched sleeve', () => {
  const early = Array.from({ length: 4 }, (_, i) => ({
    ca: 'E' + i, entry: 1, sizeUsd: 2, openedAt: new Date(now).toISOString(), variant: 'early-entry', allocated: false, shadow: true, pnl: null,
  }));
  const coins = Array.from({ length: 10 }, (_, i) => ({ ca: 'B' + i, symbol: 'B', name: 'B', priceUsd: 1, pass: true }));
  const next = stepMeme({ coins, open: early, history: [], now });
  assert.equal(next.open.filter((pos) => pos.variant !== 'early-entry').length, 8);
  const losses = Array.from({ length: 20 }, (_, i) => ({ ca: 'OLD' + i, pnl: -0.2, allocated: true, variant: 'meme-safety' }));
  const wins = Array.from({ length: 10 }, (_, i) => ({ ca: 'EARLY' + i, pnl: 0.4, allocated: false, variant: 'early-entry' }));
  assert.equal(sleeveBenched([...losses, ...wins]).benched, true);
  assert.equal(sleeveBenched([{ pnl: -0.2, allocated: false, variant: 'meme-safety' }]).benched, true);
  assert.equal(sleeveBenched([{ pnl: 0.4, allocated: false, variant: 'early-entry' }]).benched, false);
});

test('the fast watcher prices an early shadow with its stored slip', () => {
  const pos = { ca: 'CA', symbol: 'T', entry: 1, sizeUsd: 2, openedAt: new Date(now - 60000).toISOString(), variant: 'early-entry', allocated: false, shadow: true, slip: 0.2 };
  const hit = applyWatch({ open: [pos], prices: { CA: 0.8 }, now, history: [] });
  assert.equal(hit.settled.length, 1);
  assert.equal(hit.settled[0].exit, 'stop');
  assert.equal(hit.settled[0].sizeUsd, 2);
  assert.ok(hit.settled[0].pnl < memePnl(1, 0.8).pnl);
});

test('weight stays 0 until graduates() and a pass does not allocate', () => {
  const quiet = earlyShadow([{ variant: 'early-entry', pnl: 0.2, settledAt: '2026-11-20T01:00:00Z', ca: 'A', ageMin: 8 }]);
  assert.equal(quiet.weight, 0);
  assert.equal(quiet.status, 'shadow');
  assert.equal(quiet.liveExecution, false);
  assert.equal(quiet.n, 1);
  assert.equal(quiet.medianAgeMin, 8);
  const days = ['2026-11-01', '2026-11-02', '2026-11-03'];
  const cleared = days.flatMap((day, d) => Array.from({ length: 20 }, (_, i) => ({
    variant: 'early-entry', pnl: 0.1, settledAt: `${day}T00:00:00Z`, ca: `D${d}-${i}`, ageMin: 6 + i,
  })));
  const won = earlyShadow(cleared);
  assert.equal(won.weight, 1);
  assert.equal(won.status, 'shadow');
  assert.equal(won.allocated, false);
  const base = earlyShadow([
    { variant: 'meme-safety', pnl: -0.4, settledAt: '2026-11-20T01:00:00Z', ca: 'B' },
    { variant: 'early-entry', pnl: 0.2, settledAt: '2026-11-20T02:00:00Z', ca: 'A', ageMin: 9 },
  ]);
  assert.ok(Math.abs(base.baselineMean + 0.4) < 1e-12);
  assert.ok(Math.abs(base.mean - 0.2) < 1e-12);
});

test('each source degrades and a blocked pump response adds no mints', async () => {
  const gecko = {
    data: [{
      relationships: { base_token: { data: { id: 'solana_MINTGECKO' } } },
      attributes: {
        name: 'NEW / SOL',
        pool_created_at: new Date(now - 8 * 60000).toISOString(),
        base_token_price_usd: '0.00002',
        reserve_in_usd: '5000',
        price_change_percentage: { h1: '10' },
      },
    }],
  };
  const loaded = await loadSources(async (url) => {
    if (url.includes('geckoterminal')) return { ok: true, status: 200, text: async () => JSON.stringify(gecko) };
    if (url.includes('pump.fun')) return { ok: false, status: 403, text: async () => '<html>Just a moment' };
    if (url.includes('/pairs/solana')) return { ok: false, status: 404, text: async () => 'Cannot GET' };
    return { ok: true, status: 200, text: async () => JSON.stringify([{ chainId: 'solana', tokenAddress: 'MINTDEX' }]) };
  });
  assert.equal(loaded.find((row) => row.id === 'pump-latest').ok, false);
  assert.equal(loaded.find((row) => row.id === 'dex-pairs').ok, false);
  assert.equal(loaded.find((row) => row.id === 'gecko-new').ok, true);
  const rows = candidatesFromSources(loaded, now);
  assert.ok(rows.some((row) => row.ca === 'MINTGECKO'));
  assert.ok(rows.some((row) => row.ca === 'MINTDEX'));
  assert.equal(fromPump('<html>', now).length, 0);
  const pump = fromPump([{ mint: 'MINTPUMP', symbol: 'P', name: 'Pump', created_timestamp: Math.floor((now - 5 * 60000) / 1000) }], now);
  assert.equal(pump[0].ca, 'MINTPUMP');
  assert.ok(pump[0].ageMin > 4 && pump[0].ageMin < 6);
  assert.equal(fromGeckoPools(gecko, now)[0].quote, 'SOL');
  assert.ok(EARLY_SOURCES.some((source) => source.id === 'pump-latest'));
});

test('a RugCheck summary is read from the public summary URL', async () => {
  let called = '';
  const lp = await readRug('MINT', async (url) => {
    called = url;
    return { ok: true, status: 200, json: async () => ({ lpLockedPct: 0, score: 900 }) };
  });
  assert.match(called, /api\.rugcheck\.xyz\/v1\/tokens\/MINT\/report\/summary/);
  assert.equal(lp.locked, false);
  const down = await readRug('MINT', async () => ({ ok: false, status: 429, json: async () => ({}) }));
  assert.equal(down.known, false);
  assert.match(down.error, /HTTP 429/);
});

test('a repeated candidate is logged once until the reason changes', () => {
  const first = nextLog([], [{ ca: 'A', symbol: 'A', action: 'kill', reason: 'liquidity: $10', ageMin: 4, liq: 10 }], '2026-11-20T18:00:00Z');
  assert.equal(first.length, 1);
  const again = nextLog(first, [{ ca: 'A', symbol: 'A', action: 'kill', reason: 'liquidity: $10', ageMin: 8, liq: 10 }], '2026-11-20T18:04:00Z');
  assert.equal(again.length, 0);
  const changed = nextLog(first, [{ ca: 'A', symbol: 'A', action: 'enter', reason: 'early shadow $2', ageMin: 9, liq: 8000 }], '2026-11-20T18:08:00Z');
  assert.equal(changed.length, 1);
  assert.equal(changed[0].action, 'enter');
  const merged = mergeEarlyLog(JSON.stringify(first[0]) + '\n', JSON.stringify(changed[0]) + '\n' + JSON.stringify(first[0]) + '\n');
  assert.equal(merged.trim().split('\n').length, 2);
});

test('the scoreboard card is shadow and the safety module is not retuned', () => {
  const rows = challengerRows({ early: earlyShadow([]), jev: { n: 0, weight: 0 } });
  const card = rows.find((row) => row.id === 'early-entry');
  assert.equal(card.name, 'Early entry');
  assert.equal(card.status, 'shadow');
  assert.equal(card.weight, 0);
  assert.equal(card.n, 0);
  const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const snap = readFileSync(new URL('../runner/snapshot-meme.mjs', import.meta.url), 'utf8');
  assert.match(app, /Early entry/);
  assert.match(app, /pump\.fun\/coin/);
  assert.match(app, /fomo\.family/);
  assert.match(app, /data-copy/);
  assert.match(snap, /JEV_CALL_CAP - reviewed\.asked/);
  assert.doesNotMatch(readFileSync(new URL('../engine/early.js', import.meta.url), 'utf8'), /privateKey|secretKey|signTransaction/);
  const saved = JSON.parse(readFileSync(new URL('../data/research-upgrades.json', import.meta.url), 'utf8'));
  const journal = readFileSync(new URL('../data/meme-journal.jsonl', import.meta.url), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(saved.liveExecution, false);
  assert.equal(JSON.stringify(saved.early), JSON.stringify(earlyShadow(journal)));
  assert.equal(JSON.parse(readFileSync(new URL('../data/early-audit.json', import.meta.url), 'utf8')).firstSight.median, 15.7);
  assert.equal(JSON.parse(readFileSync(new URL('../data/early-audit.json', import.meta.url), 'utf8')).entryAgeMin.under30, 0);
});
