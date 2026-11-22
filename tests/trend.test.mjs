import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTrending, trendLeader, stepTrend, TREND_ID, TREND_MIN_VOL_H1, TREND_HOLD_MS, TREND_STOP, TREND_ADDED_AT, TREND_QUOTES } from '../engine/trend.js';
import { watchExit, MEME_SIZE } from '../engine/meme.js';
import { setRollingBench } from '../engine/focus-plan.js';

const fixture = {
  data: [
    {
      id: 'solana_pool1',
      attributes: {
        address: 'Pool1',
        name: 'PEPE / SOL',
        base_token_price_usd: '0.002',
        volume_usd: { h1: '1500000' },
      },
      relationships: {
        base_token: { data: { id: 'solana_MintPEPE', type: 'token' } },
        quote_token: { data: { id: 'solana_So11111111111111111111111111111111111111112', type: 'token' } },
      },
    },
    {
      id: 'solana_pool2',
      attributes: {
        address: 'Pool2',
        name: 'DOGE / SOL',
        base_token_price_usd: '0.01',
        volume_usd: { h1: '2000000' },
      },
      relationships: {
        base_token: { data: { id: 'solana_MintDOGE', type: 'token' } },
        quote_token: { data: { id: 'solana_So11111111111111111111111111111111111111112', type: 'token' } },
      },
    },
  ],
  included: [
    { id: 'solana_MintPEPE', type: 'token', attributes: { address: 'MintPEPE', name: 'Pepe', symbol: 'PEPE' } },
    { id: 'solana_MintDOGE', type: 'token', attributes: { address: 'MintDOGE', name: 'Doge', symbol: 'DOGE' } },
    { id: 'solana_So11111111111111111111111111111111111111112', type: 'token', attributes: { address: 'So11111111111111111111111111111111111111112', symbol: 'SOL' } },
  ],
};

test('trend-rotate is pre-registered: #1 only, $1M hour volume, 60-minute hold, 15% stop, $2', () => {
  assert.equal(TREND_ID, 'trend-rotate');
  assert.equal(TREND_MIN_VOL_H1, 1_000_000);
  assert.equal(TREND_HOLD_MS, 60 * 60 * 1000);
  assert.equal(TREND_STOP, 0.85);
  assert.equal(TREND_ADDED_AT, '2026-11-22T08:45:00.000Z');
  assert.deepEqual([...TREND_QUOTES], ['SOL', 'WSOL', 'USDC', 'USDT']);
  assert.equal(MEME_SIZE, 2);
});

test('the leader is the first trending pool, and a sub-$1M or exotic #1 is cash', () => {
  const rows = parseTrending(fixture);
  assert.equal(rows[0].ca, 'MintPEPE');
  assert.equal(rows[0].volH1, 1_500_000);
  assert.equal(trendLeader(rows).ca, 'MintPEPE');
  const thin = parseTrending({
    ...fixture,
    data: [{ ...fixture.data[0], attributes: { ...fixture.data[0].attributes, volume_usd: { h1: '999999' } } }],
  });
  assert.equal(trendLeader(thin), null);
});

test('stepTrend enters the leader as a $2 shadow, rotates after 60 minutes, and stops at 15%', () => {
  setRollingBench([]);
  const now = Date.parse('2026-11-23T12:00:00Z');
  const rows = parseTrending(fixture);
  const entered = stepTrend({ trending: rows, open: [], history: [], now });
  const pos = entered.open.find((p) => p.variant === TREND_ID);
  assert.ok(pos);
  assert.equal(pos.ca, 'MintPEPE');
  assert.equal(pos.sizeUsd, 2);
  assert.equal(pos.allocated, false);
  assert.equal(pos.entry, 0.002);
  const tooSoon = stepTrend({ trending: parseTrending({ ...fixture, data: [fixture.data[1], fixture.data[0]] }), open: [pos], history: [], now: now + 30 * 60_000, prices: { MintPEPE: 0.0021 } });
  assert.equal(tooSoon.settled.length, 0);
  assert.equal(tooSoon.open.find((p) => p.variant === TREND_ID).ca, 'MintPEPE');
  const rotated = stepTrend({
    trending: parseTrending({ ...fixture, data: [fixture.data[1], fixture.data[0]] }),
    open: [pos],
    history: [],
    now: now + 60 * 60_000,
    prices: { MintPEPE: 0.0021, MintDOGE: 0.01 },
  });
  assert.equal(rotated.settled.length, 1);
  assert.equal(rotated.settled[0].exit, 'rotate');
  assert.equal(rotated.settled[0].sizeUsd, 2);
  assert.equal(rotated.open.find((p) => p.variant === TREND_ID).ca, 'MintDOGE');
  const stopped = stepTrend({ trending: rows, open: [pos], history: [], now: now + 10_000, prices: { MintPEPE: 0.002 * 0.84 } });
  assert.equal(stopped.settled[0].exit, 'stop');
  assert.equal(stopped.open.some((p) => p.variant === TREND_ID), false);
});

test('the watcher enforces only the 15% trend stop, not the meme time-stop or take-profit', () => {
  const now = Date.parse('2026-11-23T12:00:00Z');
  const pos = { variant: TREND_ID, entry: 1, openedAt: new Date(now).toISOString(), sizeUsd: 2, ca: 'X', id: 'trend-rotate:X' };
  assert.equal(watchExit(pos, 1.30, now + 40 * 60_000), null);
  const hit = watchExit(pos, 0.84, now + 10_000);
  assert.equal(hit.exit, 'stop');
  assert.equal(hit.sizeUsd, 2);
});
