// Kalshi 1-minute candles for the frozen S4 and S5 sample. Read-only.
import fs from 'node:fs';
import zlib from 'node:zlib';

const SERIES = ['KXBTC15M', 'KXETH15M', 'KXSOL15M'];
const CUTOFF = Date.parse('2026-11-17T00:00:00Z');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const ROOT = 'https://api.elections.kalshi.com/trade-api/v2';
const OUT = 'runner/research/kalshi-scalp.json.gz';

async function get(url) {
  for (let i = 0; i < 5; i++) {
    const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': UA } });
    if (res.status === 429) { await new Promise((r) => setTimeout(r, 1500 * (i + 1))); continue; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
  throw new Error('rate limited');
}

const doc = { collectedAt: new Date().toISOString(), markets: [] };
for (const series of SERIES) {
  const body = await get(`${ROOT}/markets?series_ticker=${series}&status=settled&limit=100`);
  let n = 0;
  for (const m of body.markets || []) {
    const close = Date.parse(m.close_time || '');
    if (!close || close < CUTOFF || n >= 40) continue;
    const candles = await get(`${ROOT}/series/${series}/markets/${m.ticker}/candlesticks?start_ts=${Math.floor(close / 1000) - 15 * 60}&end_ts=${Math.floor(close / 1000)}&period_interval=1`);
    doc.markets.push({ ticker: m.ticker, series, close, candles: candles.candlesticks || [] });
    n += 1;
    await new Promise((r) => setTimeout(r, 250));
  }
  console.log(series, n);
}
fs.mkdirSync('runner/research', { recursive: true });
fs.writeFileSync(OUT, zlib.gzipSync(JSON.stringify(doc)));
console.log('wrote', doc.markets.length);
