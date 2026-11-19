import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreCoin, memePnl, stepMeme, MEME_SIZE, tokenMint, bestPair, parseMintAccount, topHolderShare, candidateMints, lookupMints } from '../engine/meme.js';

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

function mintAccount({ mintAuthority, freezeAuthority, supply = '1000000', decimals = 6 }) {
  return {
    data: {
      parsed: {
        type: 'mint',
        info: { mintAuthority, freezeAuthority, supply, decimals, isInitialized: true },
      },
    },
  };
}

test('a revoked mint authority is off and a live pubkey is on', () => {
  const off = parseMintAccount(mintAccount({ mintAuthority: null, freezeAuthority: null }));
  assert.equal(off.mint, 'no');
  assert.equal(off.freeze, 'no');
  assert.equal(off.supply, '1000000');
  assert.equal(off.decimals, 6);
  const live = parseMintAccount(mintAccount({ mintAuthority: 'Auth111', freezeAuthority: 'Freeze111' }));
  assert.equal(live.mint, 'yes');
  assert.equal(live.freeze, 'yes');
  const missing = parseMintAccount(null);
  assert.equal(missing.mint, null);
  assert.equal(missing.freeze, null);
  assert.match(missing.detail, /account missing/);
  const raw = parseMintAccount({ data: ['base64', 'base64'] });
  assert.equal(raw.mint, null);
  assert.match(raw.detail, /not a mint/);
});

test('top 10 share drops the pool vault when it is the only account on the pair reserve', () => {
  const accounts = [
    { address: 'POOL', amount: '5000000' },
    { address: 'A', amount: '1000000' },
    { address: 'B', amount: '500000' },
  ];
  const held = topHolderShare(accounts, '10000000', { baseUi: 5, decimals: 6, pairAddress: 'PAIR' });
  assert.equal(held.excluded, 'POOL');
  assert.equal(held.share, 0.15);
  const byOwner = topHolderShare([
    { address: 'VAULT', amount: '9000000' },
    { address: 'A', amount: '1000000' },
  ], '10000000', { pairAddress: 'PAIR', owners: new Map([['VAULT', 'PAIR']]) });
  assert.equal(byOwner.excluded, 'VAULT');
  assert.equal(byOwner.share, 0.1);
  const ambiguous = topHolderShare([
    { address: 'A', amount: '5000000' },
    { address: 'B', amount: '5000000' },
  ], '10000000', { baseUi: 5, decimals: 6 });
  assert.equal(ambiguous.excluded, null);
  assert.equal(ambiguous.share, 1);
  const empty = topHolderShare([], '10000000', {});
  assert.equal(empty.share, null);
  assert.match(empty.detail, /no holder accounts/);
  const nosup = topHolderShare(accounts, '0', {});
  assert.equal(nosup.share, null);
  assert.match(nosup.detail, /supply missing/);
});

test('chain safety uses the same bars and an unknown dev share does not block', () => {
  const chain = { mint: 'no', freeze: 'no', top10: 0.4 };
  const good = scoreCoin(pair(), chain, now);
  assert.equal(good.pass, true);
  assert.equal(good.reasons.find((r) => r.name === 'dev wallet share').ok, null);
  assert.match(good.reasons.find((r) => r.name === 'dev wallet share').detail, /unknown/);
  assert.match(good.reasons.find((r) => r.name === 'dev wallet share').detail, /does not block/);
  const hot = scoreCoin(pair(), { ...chain, top10: 0.41 }, now);
  assert.equal(hot.pass, false);
  assert.equal(hot.reasons.find((r) => r.name === 'top 10 holders').ok, false);
  const minted = scoreCoin(pair({ liquidity: { usd: 80000 } }), { ...chain, mint: 'yes' }, now);
  assert.equal(minted.pass, false);
  assert.equal(minted.reasons.find((r) => r.name === 'mint authority').detail, 'yes');
  const frozen = scoreCoin(pair(), { ...chain, freeze: 'yes' }, now);
  assert.equal(frozen.pass, false);
  const missed = scoreCoin(pair(), { mint: null, freeze: null, top10: null, mintDetail: 'lookup failed: timed out', freezeDetail: 'lookup failed: timed out', top10Detail: 'lookup failed: HTTP 429' }, now);
  assert.equal(missed.pass, false);
  assert.match(missed.reasons.find((r) => r.name === 'mint authority').detail, /timed out/);
  assert.match(missed.reasons.find((r) => r.name === 'top 10 holders').detail, /HTTP 429/);
});

test('the scan keeps boosted mints and still adds newer solana mints', () => {
  const boosts = Array.from({ length: 20 }, (_, i) => ({ chainId: 'solana', tokenAddress: `B${i}` }));
  boosts.push({ chainId: 'ethereum', tokenAddress: 'ETH' });
  const mints = candidateMints({
    boosts,
    profiles: [{ chainId: 'solana', tokenAddress: 'P1' }, { chainId: 'solana', tokenAddress: 'B0' }],
    pools: [
      { relationships: { base_token: { data: { id: 'solana_NEWMINT' } } } },
      { relationships: { base_token: { data: { id: 'eth_NOPE' } } } },
    ],
  }, 24);
  assert.equal(mints.length, 22);
  assert.equal(mints.filter((m) => m.startsWith('B')).length, 20);
  assert.ok(mints.includes('P1'));
  assert.ok(mints.includes('NEWMINT'));
  assert.equal(mints.includes('ETH'), false);
  assert.equal(mints.includes('NOPE'), false);
  assert.equal(new Set(mints).size, mints.length);
});

test('an RPC failure is a failed check and a later endpoint can still supply the mint', async () => {
  const mint = 'Mint111';
  const account = mintAccount({ mintAuthority: null, freezeAuthority: 'FreezeLive' });
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    if (String(url).includes('down.example')) {
      return { ok: false, status: 429, json: async () => ({}) };
    }
    if (body.method === 'getMultipleAccounts') {
      return { ok: true, status: 200, json: async () => ({ result: { value: [account] } }) };
    }
    if (body.method === 'getTokenLargestAccounts') {
      return { ok: true, status: 200, json: async () => ({ error: { code: 429, message: 'Too many requests for a specific RPC call' } }) };
    }
    throw new Error('unexpected ' + body.method);
  };
  const safety = await lookupMints([mint], new Map([[mint, { baseUi: 1, pairAddress: 'PAIR', decimals: 6 }]]), {
    fetchImpl,
    rpcUrls: ['https://down.example/rpc', 'https://ok.example/rpc'],
    budgetMs: 5000,
    gapMs: 0,
    retryWaitMs: 0,
    ownerReserveMs: 0,
  });
  const row = safety.get(mint);
  assert.equal(row.mint, 'no');
  assert.equal(row.freeze, 'yes');
  assert.equal(row.top10, null);
  assert.match(row.top10Detail, /Too many requests/);
  const dead = await lookupMints([mint], new Map(), {
    fetchImpl: async () => { const e = new Error('The operation was aborted'); e.name = 'TimeoutError'; throw e; },
    rpcUrls: ['https://slow.example/rpc'],
    budgetMs: 5000,
    gapMs: 0,
    retryWaitMs: 0,
    ownerReserveMs: 0,
  });
  assert.match(dead.get(mint).mintDetail, /timed out/);
  assert.equal(dead.get(mint).mint, null);
  const scored = scoreCoin(pair(), dead.get(mint), now);
  assert.equal(scored.pass, false);
});

test('a 15% drop stops the paper meme trade at the same $2 size', () => {
  const open = [{ ca: 'CA', symbol: 'TEST', entry: 1, sizeUsd: 2, openedAt: new Date(now - 60000).toISOString(), variant: 'meme-safety', allocated: true }];
  const next = stepMeme({ coins: [{ ca: 'CA', priceUsd: 0.8, pass: true }], open, now });
  assert.equal(next.settled.length, 1);
  assert.equal(next.settled[0].exit, 'stop');
  assert.equal(next.settled[0].sizeUsd, 2);
  assert.ok(next.settled[0].pnl < 0);
});

test('a coin that passes the bars opens one $2 paper position', () => {
  const next = stepMeme({ coins: [{ ca: 'CA', symbol: 'TEST', name: 'Test', priceUsd: 1, pass: true }], open: [], now });
  assert.equal(next.open.length, 1);
  assert.equal(next.open[0].sizeUsd, 2);
  assert.equal(next.open[0].paper, true);
  assert.equal(next.open[0].ca, 'CA');
  const blocked = stepMeme({ coins: [{ ca: 'CA', symbol: 'TEST', priceUsd: 1, pass: false }], open: [], now });
  assert.equal(blocked.open.length, 0);
});
