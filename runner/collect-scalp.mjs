// One-minute Coinbase candles for the frozen S1 and S2 sample. Read-only.
import fs from 'node:fs';
import zlib from 'node:zlib';

const PRODUCTS = ['BTC-USD', 'ETH-USD', 'SOL-USD'];
const START = Date.parse('2026-11-17T00:00:00Z');
const OUT = 'runner/research/scalp-bars.json.gz';

async function candles(product, start, end) {
  const url = `https://api.exchange.coinbase.com/products/${product}/candles?granularity=60&start=${encodeURIComponent(new Date(start).toISOString())}&end=${encodeURIComponent(new Date(end).toISOString())}`;
  const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const rows = await res.json();
  return rows.map(([t, low, high, open, close, volume]) => ({ t: t * 1000, o: +open, h: +high, l: +low, c: +close, v: +volume }))
    .filter((b) => b.t >= start && b.c > 0 && b.h >= b.l);
}

const doc = { collectedAt: new Date().toISOString(), products: [] };
const end = Date.now();
for (const product of PRODUCTS) {
  let bars = [];
  for (let t = START; t < end; t += 300 * 60 * 1000) {
    const chunk = await candles(product, t, Math.min(end, t + 300 * 60 * 1000));
    bars.push(...chunk);
    await new Promise((r) => setTimeout(r, 200));
  }
  const seen = new Set();
  bars = bars.filter((b) => (seen.has(b.t) ? false : seen.add(b.t))).sort((a, b) => a.t - b.t);
  doc.products.push({ product, bars });
  console.log(product, bars.length);
}
fs.mkdirSync('runner/research', { recursive: true });
fs.writeFileSync(OUT, zlib.gzipSync(JSON.stringify(doc)));
console.log('wrote', OUT);
