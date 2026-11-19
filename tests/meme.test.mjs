import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreCoin, memePnl, stepMeme, MEME_SIZE, tokenMint, bestPair } from '../engine/meme.js';

const now = Date.parse('2026-11-19T18:00:00Z');

function pair(over = {}) {
  return {
    chainId: 'solana',
    baseToken: { address: 'CA', symbol: 'TEST', name: 'Test' },
    quoteToken: { symbol: 'SOL' },
    priceUsd: '1',
    liquidity: { usd: 50000 },
    volume: { h24: 20000 },
    priceChange: { h1: 10 },
    fdv: 100000,
    pairCreatedAt: now - 2 * 60 * 60 * 1000,
    ...over,
  };
}
const safe = { holders: { distribution_percentage: { top_10: '20' } }, mint_authority: 'no', freeze_authority: 'no' };

test('a flat meme round trip loses the fee and the slippage', () => {
  const deal = memePnl(1, 1);
  assert.ok(deal.pnl < 0);
  assert.equal(deal.sizeUsd, MEME_SIZE);
  assert.ok(deal.fees > 0);
});

test('missing mint authority fails the buy even when liquidity is deep', () => {
  const bad = scoreCoin(pair(), { ...safe, mint_authority: null }, now);
  assert.equal(bad.pass, false);
  assert.ok(bad.reasons.some((r) => r.name === 'mint authority' && r.ok !== true));
  const good = scoreCoin(pair(), safe, now);
  assert.equal(good.pass, true);
  const thin = scoreCoin(pair({ liquidity: { usd: 1000 } }), safe, now);
  assert.equal(thin.pass, false);
});

test('the contract address is the token mint, never the pair address', () => {
  const pair = { chainId: 'solana', pairAddress: 'PAIR111', baseToken: { address: 'MINT222', symbol: 'T', name: 'Token' }, liquidity: { usd: 1 } };
  assert.equal(tokenMint(pair), 'MINT222');
  assert.notEqual(tokenMint(pair), pair.pairAddress);
  assert.equal(tokenMint({ pairAddress: 'SAME', baseToken: { address: 'SAME' } }), null);
  assert.equal(bestPair([pair, { chainId: 'solana', pairAddress: 'OTHER', baseToken: { address: 'NOPE' }, liquidity: { usd: 99 } }], 'MINT222').pairAddress, 'PAIR111');
});

test('a 15% drop stops the paper meme trade at the same $2 size', () => {
  const open = [{ ca: 'CA', symbol: 'TEST', entry: 1, sizeUsd: 2, openedAt: new Date(now - 60000).toISOString(), variant: 'meme-safety', allocated: true }];
  const next = stepMeme({ coins: [{ ca: 'CA', priceUsd: 0.8, pass: true }], open, now });
  assert.equal(next.settled.length, 1);
  assert.equal(next.settled[0].exit, 'stop');
  assert.equal(next.settled[0].sizeUsd, 2);
  assert.ok(next.settled[0].pnl < 0);
});
