// Focus plan, written down 2026-11-21. Paper only. No imports, so the journal
// step, the early book and the page can all read it without a cycle.
// Nothing here moves the edge gate, graduates(), the $2 size or live_execution.

export const FOCUS_REGISTERED_AT = '2026-11-21T07:15:00.000Z';
export const RESEARCH_REGISTERED_AT = '2026-11-22T08:45:00.000Z';

// Near-winners stay on paper and on the Focus card. scalp-95 is new and pinned at
// weight 0. The others keep their existing rules and weights. mom-strict and
// revert are listed because they are the only books whose forward 90% low is
// above zero (runner/backtest.mjs --bench); listing them changes no weight.
export const NEAR_WINNERS = ['scalp-95', 'late-loose', 'mom-settle', 'late-fee', 'scalp-fee', 'mom-strict', 'revert'];

// Bench rule: at least 40 settled forward paper rows and a 90% cluster-bootstrap
// upper bound of the after-fee mean below zero (clusters are Kalshi series, or
// the coin for meme rows). Controls are not benched; the coin-flip control is
// the yardstick.
export const BENCH_RULE = Object.freeze({ minN: 40, hiBelow: 0 });

export function meetsBench(stats) {
  return !!stats && stats.n >= BENCH_RULE.minN && stats.hi != null && stats.hi < BENCH_RULE.hiBelow;
}

// Derived from data/journal.jsonl and data/meme-journal.jsonl as of
// 2026-11-21T07:01Z with the rule above (runner/backtest.mjs --bench). Values are
// the evidence at registration. Benched books open no new paper lines. History
// is kept, and their old rows still show on the page.
export const FOCUS_BENCHED = Object.freeze([
  { id: 'scalp', book: 'kalshi', label: 'Intra-window scalp', n: 204, mean: -0.185, hi: -0.057 },
  { id: 'scalp-tight', book: 'kalshi', label: 'Scalp, larger jump', n: 129, mean: -0.181, hi: -0.033 },
  { id: 'scalp-tp', book: 'kalshi', label: 'Scalp, 3c take-profit', n: 179, mean: -0.196, hi: -0.075 },
  { id: 'scalp-stop', book: 'kalshi', label: 'Scalp, 4c stop', n: 252, mean: -0.212, hi: -0.095 },
  { id: 'scalp-time', book: 'kalshi', label: 'Scalp, 2-minute time-stop', n: 172, mean: -0.166, hi: -0.068 },
  { id: 'late-tight', book: 'kalshi', label: 'Late favorite, tighter ask', n: 179, mean: -0.045, hi: -0.004 },
  { id: 'late-early', book: 'kalshi', label: 'Late favorite, earlier', n: 342, mean: -0.062, hi: -0.022 },
  { id: 'rest-maker', book: 'kalshi', label: 'Resting maker', n: 171, mean: -0.938, hi: -0.735 },
  { id: 'early-exit-fast', book: 'early', label: 'Early exit · 10 min', n: 92, mean: -0.298, hi: -0.197 },
  { id: 'early-exit-half', book: 'early', label: 'Early exit · half then trail', n: 91, mean: -0.307, hi: -0.206 },
  { id: 'early-exit-trail', book: 'early', label: 'Early exit · peak trail', n: 91, mean: -0.314, hi: -0.189 },
]);

export const FOCUS_BENCHED_IDS = new Set(FOCUS_BENCHED.map((row) => row.id));

// Rolling bench. The frozen rule above is applied again on every snapshot to
// each non-control book that is not already benched, on settled forward paper
// rows only (engine/focus.js rollingBenchDoc). A book that meets it is added to
// data/rolling-bench.json with the time and the evidence. Nothing is ever taken
// off. The rule itself does not change.
let rolling = [];
let rollingIds = new Set();

// Node runners load data/rolling-bench.json and pass its books here before they
// step a journal. Static entries are ignored so a book is listed once.
export function setRollingBench(books) {
  rolling = (Array.isArray(books) ? books : []).filter((row) => row && typeof row.id === 'string' && !FOCUS_BENCHED_IDS.has(row.id));
  rollingIds = new Set(rolling.map((row) => row.id));
  return rolling.slice();
}

export function rollingBench() {
  return rolling.slice();
}

export function isFocusBenched(id) {
  return FOCUS_BENCHED_IDS.has(id) || rollingIds.has(id);
}

// Pure step. scan rows are { id, book, label, control, n, mean, lo, hi }.
// Keeps every earlier entry (no auto-unbench), never adds a control or a book
// on the static list, and adds a book only when meetsBench() holds.
export function rollBench(scan, prev = [], now = Date.now()) {
  const books = (Array.isArray(prev) ? prev : []).filter((row) => row && typeof row.id === 'string' && !FOCUS_BENCHED_IDS.has(row.id));
  const have = new Set(books.map((row) => row.id));
  const added = [];
  for (const row of scan || []) {
    if (!row || row.control || FOCUS_BENCHED_IDS.has(row.id) || have.has(row.id) || !meetsBench(row)) continue;
    const entry = { id: row.id, book: row.book, label: row.label || row.id, benchedAt: new Date(now).toISOString(), n: row.n, mean: row.mean, lo: row.lo ?? null, hi: row.hi };
    books.push(entry);
    added.push(entry);
    have.add(row.id);
  }
  return { books, added };
}

// New research shadows, written down 2026-11-22 before their first replay.
// They stay at weight 0 until graduates() clears on forward paper rows.
export const RESEARCH_SHADOWS = Object.freeze([
  { id: 'fair-spot', book: 'kalshi', label: 'Spot-implied fair value' },
  { id: 'pairs-lag', book: 'kalshi', label: 'BTC/ETH/SOL quote lag' },
  { id: 'lonely-entry', book: 'meme', label: 'Lonely entry' },
  { id: 'trend-rotate', book: 'meme', label: 'Hourly trending leader' },
]);
