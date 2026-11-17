// Resolved Polymarket binaries and the last trade in each pre-registered window.
// Read-only. No orders.
import fs from 'node:fs';
import zlib from 'node:zlib';

const OUT = 'runner/research/predict-markets.json.gz';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url) {
  for (let i = 0; i < 4; i++) {
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
    if (res.status === 429) { await sleep(4000 * (i + 1)); continue; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
  throw new Error('rate limited');
}

function yesPriceOf(trade) {
  const p = Number(trade.price);
  if (!(p > 0 && p < 1)) return null;
  const outcome = String(trade.outcome || '').toLowerCase();
  if (outcome === 'no') return 1 - p;
  return p;
}

async function lastInWindow(conditionId, start, end) {
  let cursor = '';
  for (let page = 0; page < 15; page++) {
    const url = `https://data-api.polymarket.com/v2/trades?condition=${conditionId}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const body = await get(url);
    const rows = body.data || [];
    for (const row of rows) {
      const t = row.timestamp * 1000;
      if (t > end) continue;
      if (t < start) return null;
      const yes = yesPriceOf(row);
      if (yes == null) continue;
      return { t, yes };
    }
    if (!body.pagination?.has_more || !body.pagination?.next_cursor) return null;
    cursor = body.pagination.next_cursor;
    await sleep(80);
  }
  return null;
}

const markets = [];
let offset = 0;
while (markets.length < 120 && offset < 800) {
  const url = `https://gamma-api.polymarket.com/markets?closed=true&umaResolutionStatus=resolved&limit=50&offset=${offset}&end_date_min=2026-01-01T00:00:00Z&order=volumeNum&ascending=false`;
  const page = await get(url);
  if (!Array.isArray(page) || !page.length) break;
  for (const m of page) {
    if (markets.length >= 120) break;
    const outcomes = JSON.parse(m.outcomes || '[]');
    const prices = JSON.parse(m.outcomePrices || '[]');
    if (outcomes.length !== 2) continue;
    const yes = Number(prices[0]);
    if (yes !== 0 && yes !== 1) continue;
    const end = Date.parse(m.umaEndDate || m.endDate);
    if (!end) continue;
    markets.push({
      id: m.id,
      conditionId: m.conditionId,
      question: m.question,
      end,
      yesWon: yes === 1,
      feesEnabled: m.feesEnabled === true,
      feeSchedule: m.feeSchedule || null,
    });
  }
  offset += page.length;
  await sleep(120);
  console.log('listed', markets.length);
}

for (const m of markets) {
  const weekLo = m.end - 8 * 86400000;
  const weekHi = m.end - 6 * 86400000;
  const lateLo = m.end - 36 * 3600000;
  const lateHi = m.end - 12 * 3600000;
  try {
    m.week = await lastInWindow(m.conditionId, weekLo, weekHi);
    m.late = await lastInWindow(m.conditionId, lateLo, lateHi);
  } catch (e) {
    m.error = e.message;
    console.log('skip', m.id, e.message);
  }
  console.log(m.question.slice(0, 48), 'week', m.week?.yes ?? '-', 'late', m.late?.yes ?? '-');
  fs.mkdirSync('runner/research', { recursive: true });
  fs.writeFileSync(OUT, zlib.gzipSync(JSON.stringify({ collectedAt: new Date().toISOString(), markets })));
}
console.log('wrote', markets.length);
