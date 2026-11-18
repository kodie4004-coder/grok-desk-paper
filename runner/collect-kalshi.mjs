// Settled 15-minute markets and the candle nearest four minutes before the close.
// Read-only. The sample is frozen in EVAL_PROTOCOL.md.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { KALSHI_SERIES, candleInWindow, asksFromCandle } from '../engine/kalshi.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const ROOT = 'https://api.elections.kalshi.com/trade-api/v2';
const CUTOFF = Date.parse('2026-11-15T00:00:00Z');
const OUT = 'runner/research/kalshi-15m.json.gz';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url) {
  for (let i = 0; i < 4; i++) {
    const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': UA }, signal: AbortSignal.timeout(20000) });
    if (res.status === 429) { await sleep(1500 * (i + 1)); continue; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
  throw new Error('rate limited');
}

const doc = { collectedAt: new Date().toISOString(), markets: [] };
for (const series of KALSHI_SERIES) {
  let cursor = '';
  let kept = 0;
  while (kept < 200) {
    const url = `${ROOT}/markets?series_ticker=${series}&status=settled&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const body = await get(url);
    const rows = body.markets || [];
    if (!rows.length) break;
    let older = false;
    for (const m of rows) {
      const close = Date.parse(m.close_time || '');
      if (!close || close < CUTOFF) { older = true; continue; }
      if (m.result !== 'yes' && m.result !== 'no') continue;
      if (kept >= 200) break;
      const start = Math.floor(close / 1000) - 15 * 60;
      const end = Math.floor(close / 1000);
      let candle = null;
      try {
        const candles = await get(`${ROOT}/series/${series}/markets/${m.ticker}/candlesticks?start_ts=${start}&end_ts=${end}&period_interval=1`);
        candle = candleInWindow(candles.candlesticks || [], close);
        await sleep(60);
      } catch (e) {
        console.log('candle', m.ticker, e.message);
      }
      const asks = asksFromCandle(candle);
      doc.markets.push({
        ticker: m.ticker,
        series,
        close,
        result: m.result,
        yesAsk: asks?.yesAsk ?? null,
        noAsk: asks?.noAsk ?? null,
      });
      kept++;
    }
    fs.mkdirSync('runner/research', { recursive: true });
    fs.writeFileSync(OUT, zlib.gzipSync(JSON.stringify(doc)));
    console.log(series, kept);
    if (older || !body.cursor) break;
    cursor = body.cursor;
    await sleep(80);
  }
}
console.log('wrote', doc.markets.length);
