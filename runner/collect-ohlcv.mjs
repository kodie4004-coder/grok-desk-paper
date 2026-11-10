// Pull public GeckoTerminal minute bars for the walk-forward study.
// Read-only. No wallet. Writes runner/research/ohlcv.json.gz
import fs from 'node:fs';
import zlib from 'node:zlib';
import { createLiveSource } from '../engine/data.js';

const src = createLiveSource({ gtGapMs: 2200 });
const outDir = 'runner/research';
fs.mkdirSync(outDir, { recursive: true });

const pools = new Map();
function add(list, origin) {
  for (const p of list || []) {
    if (!p.pool || !(p.liq >= 40000) || !(p.priceUsd > 0)) continue;
    const cur = pools.get(p.pool);
    if (!cur) pools.set(p.pool, { ...p, origin });
  }
}
add(await src.newPools(1), 'new');
add(await src.newPools(2), 'new');
add(await src.trendingPools(1, '1h'), 'trending');
add(await src.trendingPools(1, '5m'), 'trending');

const all = [...pools.values()];
const trending = all.filter((p) => p.origin === 'trending').sort((a, b) => b.liq - a.liq).slice(0, 22);
const fresh = all.filter((p) => p.origin === 'new' && !trending.some((t) => t.pool === p.pool))
  .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 14);
const chosen = [...trending, ...fresh];
console.log(`universe ${all.length} listed, collecting ${chosen.length}`);

async function loadBars(pool) {
  const first = await src.ohlcv(pool, { limit: 1000 });
  if (!first.length) return first;
  const before = Math.floor(first[0].t / 1000);
  const older = await src.ohlcv(pool, { limit: 1000, before });
  const seen = new Set(first.map((b) => b.t));
  return [...older.filter((b) => !seen.has(b.t)), ...first].sort((a, b) => a.t - b.t);
}

const doc = {
  id: 'ohlcv-walkforward-v1',
  collectedAt: new Date().toISOString(),
  note: 'Public GeckoTerminal minute bars. Pools that had already disappeared are not here. Liquidity is the snapshot at collection, not the bar.',
  pools: [],
};
for (const p of chosen) {
  try {
    const bars = await loadBars(p.pool);
    const spanH = bars.length ? (bars.at(-1).t - bars[0].t) / 3600000 : 0;
    doc.pools.push({
      pool: p.pool, token: p.token, symbol: p.symbol, origin: p.origin,
      liq: p.liq, priceUsd: p.priceUsd, createdAt: p.createdAt, bars,
    });
    console.log(`${p.symbol} ${p.origin} bars ${bars.length} span ${spanH.toFixed(1)}h liq ${Math.round(p.liq)}`);
  } catch (e) {
    console.log(`skip ${p.symbol}: ${e.message}`);
  }
  fs.writeFileSync(`${outDir}/ohlcv.json.gz`, zlib.gzipSync(JSON.stringify(doc)));
}
console.log(`wrote ${doc.pools.length} pools`);
