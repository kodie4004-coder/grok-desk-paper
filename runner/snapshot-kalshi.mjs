// Public Kalshi read. No key. Browser pages are blocked, so this writes a same-origin file.
import fs from 'node:fs';
import { KALSHI_SERIES, tickersNeedingResult } from '../engine/kalshi.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const ROOT = 'https://api.elections.kalshi.com/trade-api/v2';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url) {
  const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function row(m) {
  return {
    ticker: m.ticker,
    series: String(m.ticker || '').split('-')[0],
    title: m.title || m.yes_sub_title || m.ticker,
    floorStrike: m.floor_strike ?? null,
    yesBid: Number(m.yes_bid_dollars),
    yesAsk: Number(m.yes_ask_dollars),
    noBid: Number(m.no_bid_dollars),
    noAsk: Number(m.no_ask_dollars),
    closeTime: m.close_time,
    volume: Number(m.volume_fp),
    result: m.result || '',
    status: m.status || '',
  };
}

const markets = [];
for (const series of KALSHI_SERIES) {
  for (const status of ['open', 'settled']) {
    try {
      const body = await get(`${ROOT}/markets?series_ticker=${series}&status=${status}&limit=${status === 'settled' ? 20 : 5}`);
      for (const m of body.markets || []) markets.push(row(m));
    } catch (e) {
      console.log('skip', series, status, e.message);
    }
    await sleep(80);
  }
}
const fetchedAt = new Date().toISOString();
let openEntries = [];
try { openEntries = JSON.parse(fs.readFileSync('data/journal-open.json', 'utf8')).entries || []; } catch { openEntries = []; }
const need = tickersNeedingResult(openEntries, markets, Date.parse(fetchedAt));
for (const ticker of need.slice(0, 80)) {
  try {
    const body = await get(`${ROOT}/markets/${encodeURIComponent(ticker)}`);
    const market = body.market || body;
    if (market?.ticker) markets.push(row(market));
  } catch (e) {
    console.log('skip ticker', ticker, e.message);
  }
  await sleep(40);
}
console.log('result backfill', Math.min(need.length, 80), 'of', need.length);
const doc = {
  fetchedAt,
  source: 'api.elections.kalshi.com',
  cors: 'A browser Origin is refused. This file is the same-origin fallback.',
  markets,
};
fs.mkdirSync('data', { recursive: true });
fs.writeFileSync('data/kalshi-15m.json', JSON.stringify(doc, null, 2));
console.log('wrote', markets.length);
