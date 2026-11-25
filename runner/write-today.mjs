// Rewrite data/today.json from the settled journals and feed timestamps.
// Derived file only. Does not change strategy, weights, fees, or live_execution.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { todayDoc } from '../engine/today.js';
import { modelCalibration } from '../engine/calibration.js';
import { variantAddedAt } from '../engine/learn.js';
import { recentForm } from '../engine/decay.js';
import { betsDoc } from '../engine/bets.js';

function readJson(path) {
  try { return JSON.parse(fs.readFileSync(path, 'utf8')); } catch { return null; }
}

function readJsonl(path) {
  if (!fs.existsSync(path)) return [];
  return fs.readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

export function writeTodayFile({ now, kalshiFetchedAt, memeFetchedAt, kalshiRows, memeRows } = {}) {
  const t = Number.isFinite(now) ? now : Date.now();
  const board = readJson('data/kalshi-15m.json');
  const beat = readJson('data/heartbeat.json');
  const memeBoard = readJson('data/meme-board.json');
  const memeOpen = readJson('data/meme-open.json');
  const kRows = kalshiRows || readJsonl('data/journal.jsonl');
  const mRows = memeRows || readJsonl('data/meme-journal.jsonl');
  const doc = todayDoc({
    kalshiRows: kRows,
    memeRows: mRows,
    kalshiFetchedAt: kalshiFetchedAt || board?.fetchedAt || beat?.fetchedAt || beat?.at || null,
    memeFetchedAt: memeFetchedAt || memeBoard?.fetchedAt || memeOpen?.updatedAt || null,
    now: t,
  });
  const out = {
    paper: true,
    liveExecution: false,
    day: doc.day,
    generatedAt: doc.generatedAt,
    kalshiFetchedAt: doc.kalshiFetchedAt,
    memeFetchedAt: doc.memeFetchedAt,
    allocated: doc.allocated,
    shadow: doc.shadow,
    repair: doc.repair,
  };
  // Model vs market on every snapshot, so the card is not a day old.
  try {
    out.calibration = modelCalibration(kRows, variantAddedAt());
    out.calibrationAt = doc.generatedAt;
  } catch (err) {
    console.log('calibration skipped', err.message);
  }
  // Recent form (edge decay) on every snapshot. Diagnostic only.
  try {
    out.decay = recentForm({ kalshiRows: kRows, memeRows: mRows });
    out.decayAt = doc.generatedAt;
  } catch (err) {
    console.log('recent form skipped', err.message);
  }
  fs.mkdirSync('data', { recursive: true });
  // Bets list for the app: open lines, newest settled lines, per-bot totals.
  // Derived only, after fees, bad coin quotes set aside.
  try {
    const kOpen = readJson('data/journal-open.json')?.entries || [];
    fs.writeFileSync('data/bets.json', JSON.stringify(betsDoc({ kalshiRows: kRows, kalshiOpen: kOpen, memeRows: mRows, memeOpen: memeOpen?.entries || [], now: t, recentPerBot: 10, histPerBot: 150 })) + '\n');
  } catch (err) {
    console.log('bets list skipped', err.message);
  }
  fs.writeFileSync('data/today.json', JSON.stringify(out, null, 2) + '\n');
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const doc = writeTodayFile();
  console.log('today', doc.day, 'allocated', doc.allocated.n, doc.allocated.pnl, 'shadow', doc.shadow.n, doc.shadow.pnl, 'repair', doc.repair.n, doc.repair.mean);
}
