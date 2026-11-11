// Longer multi-chain minute history for the v3 walk-forward. Read-only.
// Writes runner/research/ohlcv-windows.json.gz and resumes if restarted.
import fs from 'node:fs';
import zlib from 'node:zlib';

const OUT = 'runner/research/ohlcv-windows.json.gz';
const NETWORKS = ['solana', 'base', 'eth', 'bsc', 'arbitrum'];
const PER_NET = 6;
const PAGES = 4;
const GAP_MS = 7000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let last = 0;
async function gt(url) {
  const wait = last + GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  last = Date.now();
  for (let i = 0; i < 4; i++) {
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
    if (res.status === 429) { await sleep(15000 * (i + 1)); last = Date.now(); continue; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
  throw new Error('rate limited');
}

function parsePool(row, network) {
  const a = row.attributes || {};
  const rel = row.relationships || {};
  return {
    pool: a.address,
    symbol: (a.name || '?').split(' / ')[0],
    liq: Number(a.reserve_in_usd) || 0,
    chain: rel.network?.data?.id || network,
    createdAt: a.pool_created_at ? Date.parse(a.pool_created_at) : null,
  };
}

async function ohlcv(network, pool, before) {
  const q = new URLSearchParams({ aggregate: '1', limit: '1000', currency: 'usd', token: 'base' });
  if (before) q.set('before_timestamp', String(before));
  const body = await gt(`https://api.geckoterminal.com/api/v2/networks/${network}/pools/${pool}/ohlcv/minute?${q}`);
  return (body?.data?.attributes?.ohlcv_list || [])
    .map(([t, o, h, l, c, v]) => ({ t: t * 1000, o: +o, h: +h, l: +l, c: +c, v: +v }))
    .filter((b) => b.t > 0 && b.o > 0 && b.c > 0 && b.h >= b.l);
}

const doc = fs.existsSync(OUT)
  ? JSON.parse(zlib.gunzipSync(fs.readFileSync(OUT)).toString('utf8'))
  : { id: 'ohlcv-walkforward-v3', collectedAt: new Date().toISOString(), pools: [] };
const have = new Set(doc.pools.map((p) => p.chain + ':' + p.pool));

for (const network of NETWORKS) {
  let listed = [];
  try {
    const body = await gt(`https://api.geckoterminal.com/api/v2/networks/${network}/trending_pools?page=1`);
    listed = (body.data || []).map((row) => parsePool(row, network)).filter((p) => p.pool && p.liq >= 40000).slice(0, PER_NET);
  } catch (e) { console.log('list', network, e.message); continue; }
  for (const p of listed) {
    const key = p.chain + ':' + p.pool;
    if (have.has(key)) { console.log('have', p.chain, p.symbol); continue; }
    try {
      let bars = [];
      let before = null;
      for (let page = 0; page < PAGES; page++) {
        const chunk = await ohlcv(p.chain, p.pool, before);
        if (!chunk.length) break;
        const seen = new Set(bars.map((b) => b.t));
        bars.push(...chunk.filter((b) => !seen.has(b.t)));
        const oldest = Math.min(...chunk.map((b) => b.t));
        before = Math.floor(oldest / 1000);
      }
      bars.sort((a, b) => a.t - b.t);
      doc.pools.push({ ...p, bars });
      have.add(key);
      const span = bars.length > 1 ? (bars.at(-1).t - bars[0].t) / 3600000 : 0;
      console.log(p.chain, p.symbol, 'bars', bars.length, 'span', span.toFixed(1) + 'h', 'liq', Math.round(p.liq));
      fs.writeFileSync(OUT, zlib.gzipSync(JSON.stringify(doc)));
    } catch (e) { console.log('skip', p.chain, p.symbol, e.message); }
  }
}
console.log('wrote', doc.pools.length, 'pools');
