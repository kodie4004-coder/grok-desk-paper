// Recheck OPEN meme paper positions on DexScreener. No wallet, no key, no order.
// One batched call per pass. Default gap is 4 seconds, inside the 2–5 second ask,
// about 15 calls a minute against a 300/minute limit.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { applyWatch, pricesFromDex, stopSlippage, watchIntervalMs, watchStamp } from '../engine/meme.js';
import { advanceEarlyExits, mergeOpenEntry } from '../engine/early.js';
import { withShadowScores } from '../engine/upgrades.js';

const interval = watchIntervalMs(Number(process.env.MEME_WATCH_MS || 4000));
const duration = Number(process.env.MEME_WATCH_FOR || 240000);

function readJson(path, fallback) {
  try { return JSON.parse(fs.readFileSync(path, 'utf8')); } catch { return fallback; }
}

function readJournal() {
  if (!fs.existsSync('data/meme-journal.jsonl')) return [];
  return fs.readFileSync('data/meme-journal.jsonl', 'utf8').trim().split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

async function dexPrices(mints) {
  const url = 'https://api.dexscreener.com/latest/dex/tokens/' + mints.join(',');
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return pricesFromDex(await res.json(), mints);
}

function refreshOpen(localOpen, settledIds) {
  try {
    execFileSync('git', ['fetch', '--depth=20', 'origin', 'main'], { stdio: 'ignore' });
    const text = execFileSync('git', ['show', 'origin/main:data/meme-open.json'], { encoding: 'utf8' });
    const remote = JSON.parse(text).entries || [];
    const map = new Map();
    for (const row of remote) {
      if (!row?.id || settledIds.has(row.id)) continue;
      map.set(row.id, row);
    }
    for (const row of localOpen) {
      if (!row?.id || settledIds.has(row.id)) continue;
      const prev = map.get(row.id);
      map.set(row.id, prev ? mergeOpenEntry(row, prev) : row);
    }
    return [...map.values()];
  } catch (e) {
    console.log('refresh', e.message);
    return localOpen.filter((row) => !settledIds.has(row.id));
  }
}

let open = [];
let calls = 0;
try {
  const history = readJournal();
  const settledIds = new Set(history.map((row) => row.id));
  open = refreshOpen(readJson('data/meme-open.json', { entries: [] }).entries || [], settledIds);
  const until = Date.now() + Math.max(0, duration);
  let nextFetch = Date.now() + 30000;
  while (open.length && Date.now() < until) {
    if (Date.now() >= nextFetch) {
      open = refreshOpen(open, settledIds);
      nextFetch = Date.now() + 30000;
    }
    if (!open.length) break;
    let prices = {};
    try {
      prices = await dexPrices([...new Set(open.map((row) => row.ca).filter(Boolean))]);
      calls += 1;
    } catch (e) {
      console.log('dex', e.message);
    }
    const now = Date.now();
    const next = applyWatch({ open, prices, now, history, track: advanceEarlyExits });
    open = next.open.filter((row) => !settledIds.has(row.id));
    const journalRows = [...next.settled, ...(next.shadows || [])];
    if (journalRows.length) {
      fs.mkdirSync('data', { recursive: true });
      fs.appendFileSync('data/meme-journal.jsonl', journalRows.map((row) => JSON.stringify(row)).join('\n') + '\n');
      history.push(...journalRows);
      for (const row of next.settled) settledIds.add(row.id);
      for (const row of next.shadows || []) settledIds.add(row.id);
      fs.writeFileSync('data/meme-open.json', JSON.stringify({ updatedAt: new Date(now).toISOString(), entries: open }, null, 2) + '\n');
      fs.writeFileSync('data/meme-stops.json', JSON.stringify({ ...stopSlippage(history), updatedAt: new Date(now).toISOString(), calls }, null, 2) + '\n');
      const path = 'data/research-upgrades.json';
      let doc = { paper: true, liveExecution: false };
      try { doc = { ...doc, ...JSON.parse(fs.readFileSync(path, 'utf8')) }; } catch { /* keep the paper report */ }
      fs.writeFileSync(path, JSON.stringify(withShadowScores(doc, history), null, 2) + '\n');
      console.log('exited', journalRows.map((row) => `${row.symbol || row.ca} ${row.exit}`).join(', '));
    }
    const left = until - Date.now();
    if (left <= 0 || !open.length) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(interval, left)));
  }
  const disk = readJson('data/meme-open.json', { entries: [] }).entries || [];
  if (JSON.stringify(disk) !== JSON.stringify(open)) {
    fs.mkdirSync('data', { recursive: true });
    fs.writeFileSync('data/meme-open.json', JSON.stringify({ updatedAt: new Date().toISOString(), entries: open }, null, 2) + '\n');
  }
  console.log('calls', calls, 'open', open.length, 'intervalMs', interval);
  console.log(open.length ? 'chain=yes' : 'chain=no');
} finally {
  const doc = watchStamp({ open: open.length, calls, at: Date.now() });
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync('data/meme-watch.json', JSON.stringify(doc, null, 2) + '\n');
  console.log('watchedAt', doc.watchedAt || 'missing');
}
