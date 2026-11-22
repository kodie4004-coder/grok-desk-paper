// Download 1-minute BTC/ETH/SOL closes for the fair-value backtest. Public
// market data only. Never looks at a wallet or a key.
import fs from 'node:fs';

const START = Date.parse('2026-11-18T03:00:00.000Z');
const END = Date.now();
const BASES = ['BTC', 'ETH', 'SOL'];
const CHUNK = 4 * 60 * 60 * 1000; // 4 hours, 240 candles, under the 300 cap

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, tries = 6) {
  let last = null;
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'grok-desk-paper/1.0' }, signal: AbortSignal.timeout(20000) });
      if (res.status === 429 || res.status >= 500) {
        last = new Error(`HTTP ${res.status} ${url}`);
        await sleep(1500 * (i + 1));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      return res.json();
    } catch (err) {
      last = err;
      if (String(err.message || err).startsWith('HTTP 4') && !String(err.message).includes('429')) throw err;
      await sleep(1500 * (i + 1));
    }
  }
  throw last || new Error(url);
}

function dedupe(rows) {
  const out = [];
  const seen = new Set();
  for (const row of [...rows].sort((a, b) => a.t - b.t)) {
    if (!row.px || !Number.isFinite(row.t) || seen.has(row.t)) continue;
    seen.add(row.t);
    out.push(row);
  }
  return out;
}

async function coinbase(base) {
  const out = [];
  for (let t = START; t < END; t += CHUNK) {
    const start = new Date(t).toISOString();
    const end = new Date(Math.min(t + CHUNK, END)).toISOString();
    const url = `https://api.exchange.coinbase.com/products/${base}-USD/candles?granularity=60&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;
    const body = await get(url);
    for (const row of body || []) {
      const ts = Number(row[0]) * 1000;
      const px = Number(row[4]);
      if (px > 0 && Number.isFinite(ts)) out.push({ t: ts, px });
    }
    await sleep(250);
  }
  return dedupe(out);
}

async function okx(base) {
  const inst = `${base}-USDT`;
  const out = [];
  let after = END;
  for (let i = 0; i < 80 && after > START; i += 1) {
    const url = `https://www.okx.com/api/v5/market/history-candles?instId=${inst}&bar=1m&limit=300&after=${after}`;
    const body = await get(url);
    const rows = body?.data || [];
    if (!rows.length) break;
    for (const row of rows) {
      const ts = Number(row[0]);
      const px = Number(row[4]);
      if (px > 0 && Number.isFinite(ts) && ts >= START && ts <= END) out.push({ t: ts, px });
    }
    const oldest = Math.min(...rows.map((row) => Number(row[0])));
    if (!Number.isFinite(oldest) || oldest >= after) break;
    after = oldest;
    await sleep(200);
  }
  return dedupe(out);
}

const closes = {};
const sources = {};
for (const base of BASES) {
  try {
    closes[base] = await coinbase(base);
    sources[base] = 'Coinbase 1m';
  } catch (err) {
    console.log(base, 'coinbase failed', err.message);
    closes[base] = await okx(base);
    sources[base] = 'OKX 1m';
  }
  const rows = closes[base] || [];
  console.log(base, sources[base], rows.length, rows[0] && new Date(rows[0].t).toISOString(), rows.at(-1) && new Date(rows.at(-1).t).toISOString());
  if (rows.length < 1000) throw new Error(`${base} candle series too short`);
}

const doc = { builtAt: new Date().toISOString(), paper: true, source: sources, closes };
fs.mkdirSync('data', { recursive: true });
fs.writeFileSync('data/spot-candles.json', JSON.stringify(doc));
console.log('wrote data/spot-candles.json');
