import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { rugTop10Strict, withRugTop10, wantsRugTop10, fetchRugTop10, RUG_FALLBACK_CAP } from '../engine/holder-fallback.js';
import { scoreCoin, stepMeme, MEME_RULES, MEME_SIZE } from '../engine/meme.js';
import { setRollingBench } from '../engine/focus-plan.js';
import { repairGate } from '../engine/repair.js';

const report = {
  mint: 'M',
  knownAccounts: { POOL: { type: 'AMM' }, LOCK: { type: 'LOCKER' }, DEV: { type: 'CREATOR' } },
  markets: [{ pubkey: 'MKT', liquidityAAccount: { owner: 'VAULT' } }],
  topHolders: [
    { owner: 'POOL', address: 'a', pct: 40 },
    { owner: 'MKT', address: 'b', pct: 10 },
    { owner: 'VAULT', address: 'v', pct: 5 },
    { owner: 'LOCK', address: 'c', pct: 12 },
    { owner: 'DEV', address: 'd', pct: 3 },
    { owner: 'w1', address: 'e', pct: 4.5 },
  ],
};

test('RugCheck top 10 leaves out only the pool and counts lockers and the creator', () => {
  assert.equal(rugTop10Strict(report).toFixed(3), '0.195');
  assert.equal(rugTop10Strict({ mint: 'M' }), null);
  assert.equal(rugTop10Strict({ topHolders: [{ owner: 'POOL', pct: 90 }], knownAccounts: { POOL: { type: 'AMM' } } }), null);
  assert.equal(rugTop10Strict({ topHolders: [{ owner: 'x', pct: 'bad' }] }), null);
});

test('the fallback fills only a missing RPC number and keeps the 40% limit', () => {
  assert.equal(MEME_RULES.maxTop10, 0.40);
  const rpc = { mint: 'no', freeze: 'no', top10: 0.5 };
  assert.equal(withRugTop10(rpc, 0.1), rpc);
  const failed = { mint: 'no', freeze: 'no', top10: null, top10Detail: 'lookup failed: HTTP 429' };
  assert.equal(withRugTop10(failed, null), failed);
  const filled = withRugTop10(failed, 0.2);
  assert.equal(filled.top10, 0.2);
  assert.equal(filled.top10Source, 'rugcheck');
  const now = Date.parse('2026-11-25T14:00:00Z');
  const pair = { liquidity: { usd: 100000 }, volume: { h24: 500000 }, priceChange: { h1: 5 }, pairCreatedAt: now - 5 * 3600e3, quoteToken: { symbol: 'SOL' }, fdv: 500000 };
  const before = scoreCoin(pair, failed, now);
  assert.equal(before.pass, false);
  assert.equal(wantsRugTop10(before), true);
  const after = scoreCoin(pair, filled, now);
  assert.equal(after.pass, true);
  assert.match(after.reasons.find((r) => r.name === 'top 10 holders').detail, /20\.0% \(RugCheck\)/);
  assert.equal(scoreCoin(pair, withRugTop10(failed, 0.41), now).pass, false);
  assert.equal(wantsRugTop10(after), false);
  assert.equal(wantsRugTop10(scoreCoin({ ...pair, liquidity: { usd: 10 } }, failed, now)), false);
});

test('a failed RugCheck request is a failed check, not a number', async () => {
  assert.equal(await fetchRugTop10('M', async () => ({ ok: false, status: 429 })), null);
  assert.equal(await fetchRugTop10('M', async () => { throw new Error('down'); }), null);
  assert.equal((await fetchRugTop10('M', async () => ({ ok: true, json: async () => report }))).toFixed(3), '0.195');
  assert.ok(RUG_FALLBACK_CAP <= 10);
});

test('a focus-benched safety sleeve logs $0 shadow lines only, at $2 paper size', () => {
  const now = Date.parse('2026-11-25T14:00:00Z');
  const coins = [{ ca: 'C1', symbol: 'C', name: 'Coin', pass: true, priceUsd: 1 }];
  setRollingBench([{ id: 'meme-safety' }]);
  try {
    const out = stepMeme({ coins, open: [], history: [], now });
    const row = out.open.find((p) => p.variant === 'meme-safety');
    assert.ok(row);
    assert.equal(row.allocated, false);
    assert.equal(row.shadow, true);
    assert.equal(row.benchShadow, true);
    assert.equal(row.sizeUsd, MEME_SIZE);
    assert.equal(row.paper, true);
  } finally { setRollingBench([]); }
  const free = stepMeme({ coins, open: [], history: [], now }).open.find((p) => p.variant === 'meme-safety');
  assert.equal(free.allocated, true);
  assert.equal(free.benchShadow, undefined);
  assert.equal(repairGate(Array.from({ length: 19 }, () => ({ pnl: 0.5, allocated: false }))).pass, false);
});

test('the snapshot asks RugCheck at most the cap and never touches a wallet', () => {
  const src = fs.readFileSync('runner/snapshot-meme.mjs', 'utf8');
  assert.match(src, /RUG_FALLBACK_CAP/);
  const mod = fs.readFileSync('engine/holder-fallback.js', 'utf8');
  assert.doesNotMatch(mod, /privateKey|secretKey|sendTransaction|signTransaction/);
});
