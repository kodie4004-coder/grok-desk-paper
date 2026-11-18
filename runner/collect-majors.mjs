// Hourly bars for deep SOL, ETH, and BTC pools. Read-only.
// Canonical tokens, then the deepest GeckoTerminal pools. DexScreener search
// ranks many SOL pairs above real ETH and BTC books, so it is not the source.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { createLiveSource } from '../engine/data.js';

const src = createLiveSource({ gtGapMs: 7000 });
const OUT = 'runner/research/majors-hourly.json.gz';
const TOKENS = [
  ['solana', 'So11111111111111111111111111111111111111112', 'SOL'],
  ['eth', '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', 'WETH'],
  ['eth', '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', 'WBTC'],
  ['base', '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', 'CBBTC'],
];

const picks = [];
for (const [chain, token, symbol] of TOKENS) {
  const body = await (await fetch(`https://api.geckoterminal.com/api/v2/networks/${chain}/tokens/${token}/pools?page=1`, { headers: { accept: 'application/json' } })).json();
  const rows = (body.data || [])
    .map((row) => ({
      pool: row.attributes.address,
      symbol,
      chain,
      liq: Number(row.attributes.reserve_in_usd) || 0,
      dex: row.relationships?.dex?.data?.id || null,
      base: String(row.relationships?.base_token?.data?.id || '').toLowerCase(),
    }))
    .filter((p) => p.liq >= 2_000_000 && p.base.endsWith(token.toLowerCase()))
    .sort((a, b) => b.liq - a.liq)
    .slice(0, 2);
  picks.push(...rows);
  console.log(symbol, rows.map((p) => `${p.chain} ${Math.round(p.liq)}`).join(' | ') || 'none');
}

const doc = { collectedAt: new Date().toISOString(), pools: [] };
for (const p of picks) {
  try {
    let bars = await src.ohlcv(p.pool, { network: p.chain, timeframe: 'hour', limit: 1000 });
    if (bars.length) {
      const older = await src.ohlcv(p.pool, { network: p.chain, timeframe: 'hour', limit: 1000, before: Math.floor(bars[0].t / 1000) });
      const seen = new Set(bars.map((b) => b.t));
      bars = [...older.filter((b) => !seen.has(b.t)), ...bars].sort((a, b) => a.t - b.t);
    }
    doc.pools.push({ ...p, bars });
    const span = bars.length > 1 ? (bars.at(-1).t - bars[0].t) / 86400000 : 0;
    console.log(p.chain, p.symbol, bars.length, span.toFixed(1) + 'd');
    fs.mkdirSync('runner/research', { recursive: true });
    fs.writeFileSync(OUT, zlib.gzipSync(JSON.stringify(doc)));
  } catch (e) { console.log('skip', p.symbol, e.message); }
}
console.log('wrote', doc.pools.length);
