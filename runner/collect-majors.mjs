// Hourly bars for deep SOL, ETH, and BTC pools. Read-only.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { createLiveSource } from '../engine/data.js';
import { MAJOR_SYMBOLS, MAJOR_MIN_LIQ } from '../engine/majors.js';

const src = createLiveSource({ gtGapMs: 7000 });
const OUT = 'runner/research/majors-hourly.json.gz';
const queries = ['SOL', 'WETH', 'WBTC', 'cbBTC'];
const found = new Map();

for (const q of queries) {
  const pairs = await (await fetch(`https://api.dexscreener.com/latest/dex/search?q=${q}`)).json();
  for (const p of pairs.pairs || []) {
    const sym = String(p.baseToken?.symbol || '').toUpperCase();
    const liq = p.liquidity?.usd || 0;
    if (!MAJOR_SYMBOLS.includes(sym) || liq < MAJOR_MIN_LIQ) continue;
    const chain = p.chainId === 'ethereum' ? 'eth' : p.chainId;
    if (!['solana', 'eth', 'base', 'bsc', 'arbitrum'].includes(chain)) continue;
    const key = chain + ':' + p.pairAddress;
    if (!found.has(key) || liq > found.get(key).liq) {
      found.set(key, { pool: p.pairAddress, symbol: sym, chain, liq, dex: p.dexId });
    }
  }
}
const picks = [...found.values()].sort((a, b) => b.liq - a.liq).slice(0, 12);
console.log('picks', picks.map((p) => `${p.chain} ${p.symbol} ${Math.round(p.liq)}`).join(' | '));

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
