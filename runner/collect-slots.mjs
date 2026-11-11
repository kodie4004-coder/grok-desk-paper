// Fresh multi-chain minute bars for the v2 slot study. Read-only.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { createLiveSource } from '../engine/data.js';

const src = createLiveSource({ gtGapMs: 7000 });
const networks = ['solana', 'base', 'eth', 'bsc'];
fs.mkdirSync('runner/research', { recursive: true });
const doc = { id: 'ohlcv-walkforward-v2', collectedAt: new Date().toISOString(), pools: [] };

async function list(network) {
  const url = `https://api.geckoterminal.com/api/v2/networks/${network}/trending_pools?page=1`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${network}`);
  const body = await res.json();
  return (body.data || []).map((row) => {
    const a = row.attributes || {};
    const rel = row.relationships || {};
    return {
      pool: a.address,
      symbol: (a.name || '?').split(' / ')[0],
      liq: Number(a.reserve_in_usd) || 0,
      chain: rel.network?.data?.id || network,
    };
  }).filter((p) => p.pool && p.liq >= 40000);
}

for (const network of networks) {
  await new Promise((r) => setTimeout(r, 7000));
  let pools = [];
  try { pools = (await list(network)).slice(0, 4); }
  catch (e) { console.log('list', network, e.message); continue; }
  await new Promise((r) => setTimeout(r, 7000));
  for (const p of pools) {
    try {
      const first = await src.ohlcv(p.pool, { network, limit: 1000 });
      let bars = first;
      if (first.length) {
        const older = await src.ohlcv(p.pool, { network, limit: 1000, before: Math.floor(first[0].t / 1000) });
        const seen = new Set(first.map((b) => b.t));
        bars = [...older.filter((b) => !seen.has(b.t)), ...first].sort((a, b) => a.t - b.t);
      }
      doc.pools.push({ ...p, bars });
      const span = bars.length ? (bars.at(-1).t - bars[0].t) / 3600000 : 0;
      console.log(network, p.symbol, bars.length, span.toFixed(1) + 'h');
    } catch (e) { console.log('skip', network, p.symbol, e.message); }
    fs.writeFileSync('runner/research/ohlcv-v2.json.gz', zlib.gzipSync(JSON.stringify(doc)));
  }
}
console.log('wrote', doc.pools.length);
