// Append paper journal rows from the Kalshi snapshot. Never rewrites old lines.
import fs from 'node:fs';
import { stepJournal, defaultBrain, allocCurve } from '../engine/learn.js';
import { loadSpots, loadSpotWindow } from '../engine/arena.js';
import { focusDoc } from '../engine/focus.js';

const board = JSON.parse(fs.readFileSync('data/kalshi-15m.json', 'utf8'));
const openDoc = fs.existsSync('data/journal-open.json') ? JSON.parse(fs.readFileSync('data/journal-open.json', 'utf8')) : { entries: [] };
const quoteDoc = fs.existsSync('data/journal-quotes.json') ? JSON.parse(fs.readFileSync('data/journal-quotes.json', 'utf8')) : {};
const brain = fs.existsSync('data/brain.json') ? JSON.parse(fs.readFileSync('data/brain.json', 'utf8')) : defaultBrain();
const prior = fs.existsSync('data/journal.jsonl') ? fs.readFileSync('data/journal.jsonl', 'utf8').trim().split('\n').filter(Boolean) : [];
const settledRows = prior.map((line) => JSON.parse(line));
const existingIds = settledRows.map((row) => row.id);
let spots = {};
try { spots = await loadSpots(); } catch { spots = {}; }
try {
  const windowed = await loadSpotWindow();
  for (const [key, value] of Object.entries(windowed)) {
    spots[key] = { ...(spots[key] || {}), ...value, px: spots[key]?.px || value.prints?.[0]?.px };
  }
} catch { /* settlement challenger skips when the minute average is missing */ }
const now = Date.parse(board.fetchedAt || '') || Date.now();
const next = stepJournal({ markets: board.markets || [], open: openDoc.entries || [], quotes: quoteDoc, brain, existingIds, settledRows, spots, now });
fs.mkdirSync('data', { recursive: true });
if (next.settled.length) {
  fs.appendFileSync('data/journal.jsonl', next.settled.map((row) => JSON.stringify(row)).join('\n') + '\n');
} else if (!fs.existsSync('data/journal.jsonl')) {
  fs.writeFileSync('data/journal.jsonl', '');
}
fs.writeFileSync('data/journal-open.json', JSON.stringify({ updatedAt: board.fetchedAt, entries: next.open }, null, 2));
fs.writeFileSync('data/journal-quotes.json', JSON.stringify(next.quotes));
if (next.brain) fs.writeFileSync('data/brain.json', JSON.stringify({ ...brain, ...next.brain, experimentSince: brain.experimentSince || null }, null, 2));
const allSettled = settledRows.concat(next.settled);
fs.writeFileSync('data/alloc-curve.json', JSON.stringify(allocCurve(allSettled, new Date(now).toISOString().slice(0, 10))));
// Focus board: near-winners and the bench, after fees. Reads rows only.
try {
  const memeRows = fs.existsSync('data/meme-journal.jsonl') ? fs.readFileSync('data/meme-journal.jsonl', 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
  const backtest = fs.existsSync('data/backtest.json') ? JSON.parse(fs.readFileSync('data/backtest.json', 'utf8')) : null;
  fs.writeFileSync('data/focus.json', JSON.stringify(focusDoc({ rows: allSettled, memeRows, backtest, brain: { ...brain, ...(next.brain || {}) }, now }), null, 2));
} catch (err) { console.log('focus board skipped', err.message); }
fs.writeFileSync('data/heartbeat.json', JSON.stringify({
  paper: true,
  at: new Date(now).toISOString(),
  fetchedAt: board.fetchedAt || null,
  open: next.open.length,
  settled: settledRows.length + next.settled.length,
}));
console.log('journal settled', next.settled.length, 'open', next.open.length);
