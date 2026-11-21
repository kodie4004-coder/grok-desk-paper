// Focus board data. Paper only. Node-side (journal step and backtest runner).
// It reads the journal and writes numbers; it never changes a weight, the edge
// gate, graduates(), the $2 size or live_execution.

import { VARIANTS, eligibleRows, gateProgress } from './learn.js';
import { summarize } from './backtest.js';
import { NEAR_WINNERS, FOCUS_BENCHED, FOCUS_BENCHED_IDS, BENCH_RULE, meetsBench, FOCUS_REGISTERED_AT, rollBench, rollingBench, setRollingBench } from './focus-plan.js';

const settled = (rows) => (rows || []).filter((row) => row && Number.isFinite(row.pnl) && row.skipped !== true);
const memeCluster = (row) => row.ca || row.symbol || '?';

// Applies the bench rule to every book with forward rows. Controls are listed but
// never benched.
export function benchScan(rows, memeRows = []) {
  const out = [];
  const kalshi = new Map();
  for (const row of settled(rows)) {
    if (!kalshi.has(row.variant)) kalshi.set(row.variant, []);
    kalshi.get(row.variant).push(row);
  }
  for (const [id, list] of kalshi) {
    const variant = VARIANTS.find((v) => v.id === id);
    const stats = summarize(list);
    const control = variant?.role === 'control';
    out.push({ id, book: 'kalshi', label: variant?.label || id, control, n: stats.n, mean: stats.mean, lo: stats.lo, hi: stats.hi, meets: !control && meetsBench(stats) });
  }
  const meme = new Map();
  for (const row of settled(memeRows)) {
    if (!meme.has(row.variant)) meme.set(row.variant, []);
    meme.get(row.variant).push(row);
  }
  for (const [id, list] of meme) {
    const stats = summarize(list, { cluster: memeCluster });
    out.push({ id, book: 'meme', label: id, control: false, n: stats.n, mean: stats.mean, lo: stats.lo, hi: stats.hi, meets: meetsBench(stats) });
  }
  return out.sort((a, b) => (a.mean ?? 0) - (b.mean ?? 0));
}

const MEME_LABELS = { 'early-entry': 'Early entry', 'meme-safety': 'Meme safety sleeve', 'early-track': 'Early track' };
const earlyBook = (id) => id === 'early-entry' || id === 'early-track' || String(id).startsWith('early-exit');
const controlIds = () => new Set(VARIANTS.filter((v) => v.role === 'control').map((v) => v.id));

// Same numbers as benchScan (same summarize(), same seed, same clusters), but
// only forward rows: a Kalshi book counts rows after its added day
// (eligibleRows), and only books the desk still runs are scanned.
export function rollingScan(rows, memeRows = []) {
  const out = [];
  for (const variant of VARIANTS) {
    const list = settled(eligibleRows(variant, rows));
    if (!list.length) continue;
    const stats = summarize(list);
    out.push({ id: variant.id, book: 'kalshi', label: variant.label || variant.id, control: variant.role === 'control', n: stats.n, mean: stats.mean, lo: stats.lo, hi: stats.hi });
  }
  const meme = new Map();
  for (const row of settled(memeRows)) {
    if (!row.variant) continue;
    if (!meme.has(row.variant)) meme.set(row.variant, []);
    meme.get(row.variant).push(row);
  }
  for (const [id, list] of meme) {
    const stats = summarize(list, { cluster: memeCluster });
    out.push({ id, book: earlyBook(id) ? 'early' : 'meme', label: MEME_LABELS[id] || id, control: false, n: stats.n, mean: stats.mean, lo: stats.lo, hi: stats.hi });
  }
  return out;
}

// Loads a saved list into isFocusBenched(). A control in the file is dropped:
// controls are never benched.
export function applyRollingBench(books) {
  const controls = controlIds();
  return setRollingBench((books || []).filter((row) => row && !controls.has(row.id)));
}

// Re-applies the frozen rule. prev is the saved list; nothing in it is removed.
export function rollingBenchDoc({ rows = [], memeRows = [], prev = [], now = Date.now() } = {}) {
  const controls = controlIds();
  const scan = rollingScan(rows, memeRows).filter((row) => !FOCUS_BENCHED_IDS.has(row.id));
  const keep = (prev || []).filter((row) => row && !controls.has(row.id));
  const { books, added } = rollBench(scan, keep, now);
  return {
    updatedAt: new Date(now).toISOString(),
    paper: true,
    liveExecution: false,
    rule: BENCH_RULE,
    note: 'Rolling bench. The frozen focus rule (40+ settled forward paper rows, 90% cluster-bootstrap high of the after-fee mean below zero) re-applied each snapshot. Controls are never benched. Nothing is taken off. Benched books open no new paper lines; history stays.',
    books,
    added: added.map((row) => row.id),
  };
}

function gateLine(variant, rows) {
  const forward = settled(variant ? eligibleRows(variant, rows) : []);
  const gate = gateProgress(forward, 200);
  const cleared = gate.windows.filter((w) => w.n >= 20 && w.mean > 0 && w.lo != null && w.lo > 0).length;
  return { forwardN: forward.length, windows: gate.windows.length, cleared, need: 3, graduated: gate.graduated };
}

export function focusDoc({ rows = [], memeRows = [], backtest = null, brain = null, rolled = null, now = Date.now() } = {}) {
  const bt = new Map((backtest?.reports || []).map((r) => [r.id, r]));
  const near = NEAR_WINNERS.map((id) => {
    const variant = VARIANTS.find((v) => v.id === id);
    const mine = settled(rows).filter((row) => row.variant === id);
    const stats = summarize(mine);
    const report = bt.get(id);
    const pick = (s) => (s && !s.hidden ? { n: s.n, mean: s.mean, lo: s.lo, hi: s.hi, winRate: s.winRate, breakEven: s.breakEven } : null);
    return {
      id,
      label: variant?.label || id,
      addedAt: variant?.addedAt || null,
      weight: Number.isFinite(brain?.weights?.[id]) ? brain.weights[id] : null,
      n: stats.n,
      mean: stats.mean,
      lo: stats.lo,
      hi: stats.hi,
      winRate: stats.winRate,
      gate: gateLine(variant, rows),
      backtest: report ? { mode: report.mode, cut: report.cut, inSample: pick(report.inSample), outSample: pick(report.outSample) } : null,
    };
  });
  const scan = new Map(benchScan(rows, memeRows).map((row) => [row.id, row]));
  const benched = FOCUS_BENCHED.map((row) => {
    const now2 = scan.get(row.id);
    return { ...row, nowN: now2?.n ?? null, nowMean: now2?.mean ?? null, nowHi: now2?.hi ?? null };
  });
  const rolledList = (Array.isArray(rolled) ? rolled : rollingBench()).filter((row) => row && !FOCUS_BENCHED_IDS.has(row.id)).map((row) => {
    const now2 = scan.get(row.id);
    return { ...row, nowN: now2?.n ?? null, nowMean: now2?.mean ?? null, nowHi: now2?.hi ?? null };
  });
  return {
    generatedAt: new Date(now).toISOString(),
    registeredAt: FOCUS_REGISTERED_AT,
    paper: true,
    liveExecution: false,
    sizeUsd: 2,
    rule: BENCH_RULE,
    backtestAt: backtest?.generatedAt || null,
    near,
    benched,
    rolled: rolledList,
    note: 'Paper only, after fees. Weight moves only when graduates() clears on forward paper rows. A backtest never graduates a strategy.',
  };
}
