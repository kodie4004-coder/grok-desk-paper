// Rewrite data/today.json from the settled journals and feed timestamps.
// Derived file only. Does not change strategy, weights, fees, or live_execution.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { todayDoc } from '../engine/today.js';
import { modelCalibration } from '../engine/calibration.js';
import { variantAddedAt } from '../engine/learn.js';

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
  const doc = todayDoc({
    kalshiRows: kRows,
    memeRows: memeRows || readJsonl('data/meme-journal.jsonl'),
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
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync('data/today.json', JSON.stringify(out, null, 2) + '\n');
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const doc = writeTodayFile();
  console.log('today', doc.day, 'allocated', doc.allocated.n, doc.allocated.pnl, 'shadow', doc.shadow.n, doc.shadow.pnl, 'repair', doc.repair.n, doc.repair.mean);
}
