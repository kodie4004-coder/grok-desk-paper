// Offline replay of the desk's own recorded Kalshi quotes. Paper only.
// A backtest never graduates a strategy and never changes a weight. Only forward
// paper rows that pass graduates() can do that (EVAL_PROTOCOL.md v13).
// Fills match the journal: buy at the recorded ask, floor($2 / ask) contracts,
// taker fee round up(0.07 × C × P × (1 − P)), maker fee 0, hold to the settled
// result unless the variant has a scalp exit, which sells at the recorded bid
// through roles.shouldExit / roles.settleExit.

import { kalshiTakerFee } from './kalshi.js';
import { signal, LEARN_SIZE } from './learn.js';
import { shouldExit, settleExit, RISK_MAX_SPREAD } from './roles.js';
import { clusterBootstrap } from './eval.js';

// Most recent 30% of the tape's time span is out-of-sample. It is never used to
// choose parameters. Fixed before any challenger was registered.
export const OOS_FRACTION = 0.3;
export const BOOT_ITERS = 2000;
export const BOOT_SEED = 7;

// Rules that read only the quote board can be replayed. Momentum and the
// 60-second settlement bot need spot prints the board does not hold, and the
// resting maker needs trade prints. Those are reported from recorded forward rows.
export function replayable(variant) {
  return !variant.kind || ['revert', 'scalp', 'flip', 'pocket'].includes(variant.kind);
}

const COLS = ['ticker', 'series', 'closeTime', 'yesBid', 'yesAsk', 'noBid', 'noAsk', 'floorStrike'];

// One recorded board → compact rows. Only open markets are kept as quotes.
export function compactSnapshot(doc) {
  const t = doc?.fetchedAt;
  if (!t) return null;
  const now = Date.parse(t);
  const m = [];
  for (const row of doc.markets || []) {
    if (!row?.ticker || row.result === 'yes' || row.result === 'no') continue;
    const close = Date.parse(row.closeTime || '');
    if (!Number.isFinite(close) || close <= now) continue;
    m.push(COLS.map((k) => (row[k] === undefined ? null : row[k])));
  }
  return { t, m };
}

export function resultsFrom(doc, into = {}) {
  for (const row of doc?.markets || []) {
    if (row?.ticker && (row.result === 'yes' || row.result === 'no')) into[row.ticker] = row.result;
  }
  return into;
}

export function expandMarket(arr) {
  const out = {};
  COLS.forEach((k, i) => { out[k] = arr[i]; });
  return out;
}

// Sorted, de-duplicated snapshots.
export function normalizeTape(tape) {
  const seen = new Set();
  const snaps = [];
  for (const s of tape?.snapshots || []) {
    if (!s?.t || seen.has(s.t)) continue;
    seen.add(s.t);
    snaps.push(s);
  }
  snaps.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  return { ...tape, snapshots: snaps, results: tape?.results || {} };
}

export function splitTime(tape, fraction = OOS_FRACTION) {
  const snaps = tape.snapshots || [];
  if (!snaps.length) return null;
  const t0 = Date.parse(snaps[0].t);
  const t1 = Date.parse(snaps[snaps.length - 1].t);
  return new Date(Math.round(t0 + (1 - fraction) * (t1 - t0))).toISOString();
}

function entryFor(variant, market, sig, now) {
  const contracts = Math.floor(LEARN_SIZE / sig.ask);
  if (contracts < 1) return null;
  return {
    id: `${variant.id}:${market.ticker}`,
    variant: variant.id,
    family: variant.family,
    ticker: market.ticker,
    series: market.series || '',
    side: sig.side,
    ask: sig.ask,
    contracts,
    sizeUsd: LEARN_SIZE,
    fee: kalshiTakerFee(sig.ask, contracts),
    openedAt: new Date(now).toISOString(),
    closeTime: market.closeTime,
    secondsLeft: sig.features.secondsLeft,
    exit: variant.exit || null,
    paper: true,
    backtest: true,
  };
}

function settleHeld(entry, result) {
  const won = result === entry.side;
  const fee = kalshiTakerFee(entry.ask, entry.contracts);
  const pnl = (won ? entry.contracts : 0) - entry.contracts * entry.ask - fee;
  return { ...entry, result, won, pnl, fees: fee, settledAt: entry.closeTime };
}

// One line per variant per ticker, the first snapshot the live signal fires,
// as in stepJournal. The live risk spread veto applies. Cooldown applies only to
// allocated losses, so it does not apply to a $0 replay line.
export function replayVariant(variant, tapeIn) {
  const tape = normalizeTape(tapeIn);
  const prev = new Map();
  const open = new Map();
  const trades = [];
  let vetoed = 0;
  for (const snap of tape.snapshots) {
    const now = Date.parse(snap.t);
    for (const arr of snap.m || []) {
      const market = expandMarket(arr);
      const entry = open.get(market.ticker);
      if (entry && !entry.done && entry.exit) {
        const hit = shouldExit(entry, market, now);
        if (hit) {
          trades.push({ ...settleExit(entry, hit.bid, hit.why, now), backtest: true });
          entry.done = true;
        }
      }
      if (!open.has(market.ticker)) {
        const sig = signal(variant, market, now, { prev: prev.get(market.ticker) || null });
        if (sig) {
          if (sig.features.spread != null && sig.features.spread > RISK_MAX_SPREAD) {
            vetoed += 1;
            open.set(market.ticker, { done: true, vetoed: true });
          } else {
            const e = entryFor(variant, market, sig, now);
            if (e) open.set(market.ticker, e);
          }
        }
      }
      const yes = Number(market.yesAsk);
      if (Number.isFinite(yes)) {
        const p = prev.get(market.ticker);
        prev.set(market.ticker, { yesAsk: yes, yesBid: Number(market.yesBid), samples: [...(p?.samples || []), yes].slice(-5) });
      }
    }
  }
  let unresolved = 0;
  for (const entry of open.values()) {
    if (entry.done) continue;
    const result = tape.results[entry.ticker];
    if (result !== 'yes' && result !== 'no') { unresolved += 1; continue; }
    trades.push(settleHeld(entry, result));
  }
  trades.sort((a, b) => a.openedAt.localeCompare(b.openedAt));
  return { trades, vetoed, unresolved };
}

// Break-even win rate of a held line: ask plus fee per contract.
export function breakEven(trade) {
  if (!(trade.ask > 0 && trade.contracts >= 1)) return null;
  return trade.ask + kalshiTakerFee(trade.ask, trade.contracts) / trade.contracts;
}

export function summarize(trades, { iters = BOOT_ITERS, seed = BOOT_SEED, cluster = (t) => t.series || t.ticker || '?' } = {}) {
  const list = (trades || []).filter((t) => t && Number.isFinite(t.pnl));
  if (!list.length) return { n: 0, mean: null, winRate: null, breakEven: null, lo: null, hi: null, net: 0 };
  const boot = clusterBootstrap(list.map((t) => ({ pnl: t.pnl, pool: cluster(t) })), { iters, seed, qLo: 0.05, qHi: 0.95 });
  const wins = list.filter((t) => t.pnl > 0).length;
  const held = list.filter((t) => t.result === 'yes' || t.result === 'no');
  const bes = held.map(breakEven).filter((x) => x != null);
  return {
    n: list.length,
    mean: boot.mean,
    net: list.reduce((s, t) => s + t.pnl, 0),
    winRate: wins / list.length,
    breakEven: bes.length ? bes.reduce((a, b) => a + b, 0) / bes.length : null,
    lo: boot.lo,
    hi: boot.hi,
    clusters: boot.nPools,
  };
}

export function splitTrades(trades, cut, key = (t) => t.openedAt) {
  const inSample = [];
  const outSample = [];
  for (const t of trades || []) (String(key(t)) < cut ? inSample : outSample).push(t);
  return { inSample, outSample };
}

// Full report for one variant. showOos false hides out-of-sample numbers so a
// rule can be checked in-sample before it is frozen.
export function backtestVariant(variant, tape, { showOos = false, recorded = [], iters = BOOT_ITERS } = {}) {
  const norm = normalizeTape(tape);
  const cut = splitTime(norm);
  let mode;
  let trades;
  let extra = {};
  if (replayable(variant)) {
    mode = 'replay';
    const r = replayVariant(variant, norm);
    trades = r.trades;
    extra = { vetoed: r.vetoed, unresolved: r.unresolved };
  } else {
    mode = 'recorded';
    trades = (recorded || []).filter((row) => row.variant === variant.id && Number.isFinite(row.pnl) && row.skipped !== true);
  }
  const { inSample, outSample } = splitTrades(trades, cut);
  return {
    id: variant.id,
    label: variant.label,
    mode,
    cut,
    ...extra,
    inSample: summarize(inSample, { iters }),
    outSample: showOos ? summarize(outSample, { iters }) : { hidden: true, n: outSample.length },
    note: 'Backtests never graduate a strategy. Only forward paper rows through graduates() can.',
  };
}
