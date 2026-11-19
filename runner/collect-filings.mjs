// Berkshire 13F holdings and Yahoo closes. Entry is the filing date. Read-only.
import fs from 'node:fs';
import { matchTicker, normName } from '../engine/filings.js';

const UA = 'grok-desk-paper research kodie4004@gmail.com';
const FILINGS = [
  { filing: '2026-02-17', report: '2025-12-31', acc: '0001193125-26-054580' },
  { filing: '2026-05-15', report: '2026-03-31', acc: '0001193125-26-226661' },
  { filing: '2026-08-14', report: '2026-06-30', acc: '0001193125-26-352200' },
  { filing: '2026-11-16', report: '2026-09-30', acc: '0001193125-26-463399' },
];

async function get(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json,text/html,application/xml,*/*' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}

function tickersFrom(json) {
  return Object.values(json).map((row) => ({ ticker: row.ticker, title: row.title }));
}

async function infoTable(acc) {
  const path = acc.replace(/-/g, '');
  const index = await get(`https://www.sec.gov/Archives/edgar/data/1067983/${path}/${acc}-index.html`);
  const hrefs = [...index.matchAll(/href="([^"]+\.xml)"/g)].map((m) => m[1]);
  const href = hrefs.find((h) => !h.includes('primary_doc') && !h.includes('xslForm'));
  if (!href) throw new Error('no info table ' + acc);
  const xml = await get(href.startsWith('http') ? href : 'https://www.sec.gov' + href);
  const rows = [];
  for (const block of xml.split('<infoTable').slice(1)) {
    const name = block.match(/<nameOfIssuer>([^<]+)/)?.[1];
    const klass = block.match(/<titleOfClass>([^<]+)/)?.[1] || '';
    const value = Number(block.match(/<value>([^<]+)/)?.[1] || 0);
    if (!/COM/.test(klass)) continue;
    rows.push({ name, value });
  }
  const by = new Map();
  for (const row of rows) by.set(row.name, (by.get(row.name) || 0) + row.value);
  return [...by.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
}

async function closes(symbol) {
  const p1 = Math.floor(Date.parse('2026-02-01') / 1000);
  const p2 = Math.floor(Date.now() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${p1}&period2=${p2}&interval=1d`;
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0', accept: 'application/json' } });
  if (!res.ok) return [];
  const body = await res.json();
  const result = body.chart?.result?.[0];
  const ts = result?.timestamp || [];
  const px = result?.indicators?.quote?.[0]?.close || [];
  return ts.map((t, i) => ({ t: t * 1000, c: px[i] })).filter((b) => b.c > 0);
}

function onOrAfter(series, day) {
  const target = Date.parse(day + 'T00:00:00Z');
  return series.find((b) => b.t >= target) || null;
}

const tickerJson = JSON.parse(await get('https://www.sec.gov/files/company_tickers.json'));
const tickers = tickersFrom(tickerJson);
const bench = {};
for (const symbol of ['SPY', 'QQQ']) {
  bench[symbol] = await closes(symbol);
  await new Promise((r) => setTimeout(r, 200));
}
const doc = { collectedAt: new Date().toISOString(), filings: [], unreachable: [
  'House periodic transaction reports: the 2025 zip returned HTTP 404, and the annual disclosure XML has no trades.',
  'Senate eFD is an HTML search, not a trade file.',
] };
for (const filing of FILINGS) {
  const table = await infoTable(filing.acc);
  const names = [];
  for (const row of table) {
    if (names.length >= 25) break;
    const ticker = matchTicker(row.name, tickers);
    if (!ticker || names.some((n) => n.ticker === ticker)) continue;
    names.push({ ticker, name: row.name, value: row.value });
  }
  doc.filings.push({ ...filing, names });
  console.log(filing.filing, 'matched', names.length, 'of', table.length);
  await new Promise((r) => setTimeout(r, 150));
}
const need = [...new Set(doc.filings.flatMap((f) => f.names.map((n) => n.ticker)))];
const prices = {};
for (const ticker of need) {
  prices[ticker] = await closes(ticker);
  await new Promise((r) => setTimeout(r, 120));
}
for (let i = 0; i < doc.filings.length; i++) {
  const filing = doc.filings[i];
  const exitDay = doc.filings[i + 1]?.filing || new Date().toISOString().slice(0, 10);
  filing.exitDay = exitDay;
  for (const name of filing.names) {
    const entry = onOrAfter(prices[name.ticker] || [], filing.filing);
    const exit = onOrAfter(prices[name.ticker] || [], exitDay);
    name.entry = entry?.c ?? null;
    name.exit = exit?.c ?? null;
    name.entryDay = entry ? new Date(entry.t).toISOString().slice(0, 10) : null;
  }
  for (const symbol of ['SPY', 'QQQ']) {
    const entry = onOrAfter(bench[symbol], filing.filing);
    const exit = onOrAfter(bench[symbol], exitDay);
    filing[symbol] = { entry: entry?.c ?? null, exit: exit?.c ?? null };
  }
}
fs.mkdirSync('data', { recursive: true });
fs.mkdirSync('runner/research', { recursive: true });
fs.writeFileSync('runner/research/filings.json', JSON.stringify(doc));
fs.writeFileSync('data/filings.json', JSON.stringify({
  collectedAt: doc.collectedAt,
  unreachable: doc.unreachable,
  filings: doc.filings.map((f) => ({ filing: f.filing, report: f.report, exitDay: f.exitDay, names: f.names.map((n) => n.ticker) })),
}, null, 2));
console.log('wrote filings', doc.filings.map((f) => f.names.filter((n) => n.entry && n.exit).length).join(','));
