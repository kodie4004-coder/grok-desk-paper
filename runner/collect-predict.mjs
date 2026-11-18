// Resolved Polymarket binaries and the last CLOB price in each pre-registered window.
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

async function lastInWindow(tokenId, start, end) {
  const url = `https://clob.polymarket.com/prices-history?market=${tokenId}&startTs=${Math.floor(start / 1000)}&endTs=${Math.floor(end / 1000)}&fidelity=60`;
  const body = await get(url);
  const rows = (body.history || []).filter((p) => p.t * 1000 >= start && p.t * 1000 <= end && p.p > 0 && p.p < 1);
  const last = rows.at(-1);
  return last ? { t: last.t * 1000, yes: Number(last.p) } : null;
}

const markets = [];
let offset = 0;
while (markets.length < 120 && offset < 800) {
  const url = `https://gamma-api.polymarket.com/markets?closed=true&umaResolutionStatus=resolved&limit=50&offset=${offset}&end_date_min=2026-01-01T00:00:00Z&order=volumeNum&ascending=false`;
  const page = await get(url);
  if (!Array.isArray(page) || !page.length) break;
  for (const m of page) {
    if (markets.some((x) => x.conditionId === m.conditionId)) continue;
    const outcomes = JSON.parse(m.outcomes || '[]');
    const prices = JSON.parse(m.outcomePrices || '[]');
    if (outcomes.length !== 2) continue;
    const yes = Number(prices[0]);
    if (yes !== 0 && yes !== 1) continue;
    const end = Date.parse(m.umaEndDate || m.closedTime || m.endDate);
    let token = null;
    try { token = JSON.parse(m.clobTokenIds || '[]')[0]; } catch { token = null; }
    if (!end || !token) continue;
    markets.push({
      id: m.id,
      conditionId: m.conditionId,
      token,
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
    m.week = await lastInWindow(m.token, weekLo, weekHi);
    await sleep(80);
    m.late = await lastInWindow(m.token, lateLo, lateHi);
  } catch (e) {
    m.error = e.message;
    console.log('skip', m.id, e.message);
  }
  console.log(m.question.slice(0, 48), 'week', m.week?.yes ?? '-', 'late', m.late?.yes ?? '-');
  fs.mkdirSync('runner/research', { recursive: true });
  fs.writeFileSync(OUT, zlib.gzipSync(JSON.stringify({ collectedAt: new Date().toISOString(), markets })));
}
console.log('wrote', markets.length);
