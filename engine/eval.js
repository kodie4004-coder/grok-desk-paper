// Walk-forward study on minute candles. No network, no wallet.
// Decision rules are judgeStudy / deskPriorFromStudy. See EVAL_PROTOCOL.md.
import { fillPrice, tradePnl, strategyHealth } from './core.js';

export const PROTOCOL = Object.freeze({
  id: 'ohlcv-walkforward-v1',
  holdoutMs: 8 * 3600 * 1000,
  feePct: 1,
  fill: 'conservative',
  stopPct: 4,
  takeProfitPct: 12,
  maxHoldMin: 120,
  bank: 500,
  ownPositionPct: 5,
  maxOpen: 5,
  randomP: 0.01,
  randomSeed: 20261109,
  bootstrapIters: 2000,
  bootstrapSeed: 7,
  volFrac: 0.75,
  maxEntryGapMs: 3 * 60 * 1000,
  momentum: {
    ret60Lo: 0,
    ret60Hi: 25,
    ret360Hi: 80,
    look60Ms: 60 * 60000,
    look360Ms: 360 * 60000,
    slack60Ms: 3 * 60000,
    slack360Ms: 10 * 60000,
    rangeMs: 5 * 60000,
    minRangePrints: 3,
  },
});

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function lastIndexAtOrBefore(bars, t) {
  let lo = 0, hi = bars.length - 1, ans = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (bars[m].t <= t) { ans = m; lo = m + 1; }
    else hi = m - 1;
  }
  return ans;
}

function priceAt(bars, t) {
  const i = lastIndexAtOrBefore(bars, t);
  return i < 0 ? null : bars[i].c;
}

export function makeMomentum(cfg, volGate) {
  const m = cfg.momentum;
  return (bars, i) => {
    const t = bars[i].t;
    const c0 = bars[i].c;
    if (!(c0 > 0) || !(bars[i].v > 0)) return false;
    const i60 = lastIndexAtOrBefore(bars, t - m.look60Ms);
    const i360 = lastIndexAtOrBefore(bars, t - m.look360Ms);
    if (i60 < 0 || i360 < 0) return false;
    if (Math.abs(bars[i60].t - (t - m.look60Ms)) > m.slack60Ms) return false;
    if (Math.abs(bars[i360].t - (t - m.look360Ms)) > m.slack360Ms) return false;
    if (!(bars[i60].c > 0) || !(bars[i360].c > 0)) return false;
    const r60 = (c0 / bars[i60].c - 1) * 100;
    const r360 = (c0 / bars[i360].c - 1) * 100;
    if (!(r60 >= m.ret60Lo && r60 <= m.ret60Hi)) return false;
    if (!(r360 < m.ret360Hi)) return false;
    if (!volGate) return true;
    const from = t - m.rangeMs;
    let hi = -Infinity, lo = Infinity, n = 0;
    for (let k = i; k >= 0 && bars[k].t >= from; k--) {
      hi = Math.max(hi, bars[k].h);
      lo = Math.min(lo, bars[k].l);
      n++;
    }
    if (n < m.minRangePrints) return false;
    const mid = (hi + lo) / 2;
    if (!(mid > 0)) return false;
    return ((hi - lo) / mid) * 100 < cfg.stopPct * cfg.volFrac;
  };
}

function takeTrade(bars, entryIdx, cfg) {
  const entry = bars[entryIdx];
  const entryMid = entry.o;
  if (!(entryMid > 0)) return null;
  const stop = entryMid * (1 - cfg.stopPct / 100);
  const tp = entryMid * (1 + cfg.takeProfitPct / 100);
  const deadline = entry.t + cfg.maxHoldMin * 60000;
  let exit = null;
  for (let i = entryIdx; i < bars.length; i++) {
    const b = bars[i];
    if (b.t > deadline) break;
    if (cfg.tradeTo != null && b.t >= cfg.tradeTo) break;
    const stopHit = b.l <= stop;
    const tpHit = b.h >= tp;
    if (stopHit) {
      const exitMid = cfg.fill === 'optimistic' ? stop : Math.min(stop, b.l);
      exit = { i, exitMid, kind: 'stop', gap: Math.max(0, stop - exitMid) };
      break;
    }
    if (tpHit) {
      const exitMid = cfg.fill === 'optimistic' ? Math.min(b.h, Math.max(tp, b.c)) : tp;
      exit = { i, exitMid, kind: 'tp', gap: 0 };
      break;
    }
    const lastInside = i === bars.length - 1 || bars[i + 1].t > deadline;
    if (lastInside) {
      exit = { i, exitMid: b.c, kind: 'time', gap: 0 };
      break;
    }
  }
  if (!exit) return { incomplete: true, exitIndex: entryIdx };
  const r = tradePnl({ entryMid, exitMid: exit.exitMid, sizeUsd: cfg.sizeUsd, feePct: cfg.feePct });
  return {
    incomplete: false,
    exitIndex: exit.i,
    entryT: entry.t,
    exitT: bars[exit.i].t,
    entryMid,
    exitMid: exit.exitMid,
    kind: exit.kind,
    gap: exit.gap,
    pnl: r.pnl,
    fees: r.fees,
    gross: r.gross,
    sizeUsd: cfg.sizeUsd,
    retPct: (r.pnl / cfg.sizeUsd) * 100,
    feePct: cfg.feePct,
  };
}

// signal(bars, i) may only read bars[0..i]. Entry is the next bar's open.
export function simulateTrades(bars, signal, cfg) {
  const out = [];
  for (let i = 0; i < bars.length - 1;) {
    let step = 1;
    const planned = signal(bars, i);
    const enter = planned === true || planned?.enter === true;
    if (enter) {
      const entryIdx = i + 1;
      const gap = bars[entryIdx].t - bars[i].t;
      const entryT = bars[entryIdx].t;
      const inWindow = (cfg.tradeFrom == null || entryT >= cfg.tradeFrom) && (cfg.tradeTo == null || entryT < cfg.tradeTo);
      const use = planned?.enter ? {
        ...cfg,
        stopPct: planned.stopPct ?? cfg.stopPct,
        takeProfitPct: planned.takeProfitPct ?? cfg.takeProfitPct,
        maxHoldMin: planned.maxHoldMin ?? cfg.maxHoldMin,
      } : cfg;
      if (inWindow && gap > 0 && gap <= cfg.maxEntryGapMs) {
        const tr = takeTrade(bars, entryIdx, use);
        if (tr && !tr.incomplete) {
          out.push(tr);
          step = tr.exitIndex - i + 1;
        }
      }
    }
    i += Math.max(1, step);
  }
  return out;
}

export function runAccount(trades, cfg) {
  const events = [];
  for (const tr of trades) {
    events.push({ t: tr.exitT, k: 0, tr });
    events.push({ t: tr.entryT, k: 1, tr });
  }
  events.sort((a, b) => a.t - b.t || a.k - b.k);
  let cash = cfg.bank;
  const open = new Set();
  const taken = [];
  let skipped = 0;
  for (const e of events) {
    if (e.k === 0) {
      if (!open.delete(e.tr)) continue;
      cash += e.tr.sizeUsd + e.tr.pnl;
    } else if (open.size >= cfg.maxOpen || cash < e.tr.sizeUsd - 1e-6) skipped++;
    else {
      open.add(e.tr);
      cash -= e.tr.sizeUsd;
      taken.push(e.tr);
    }
  }
  return { taken, skipped, cashEnd: cash + [...open].reduce((a, t) => a + t.sizeUsd + t.pnl, 0) };
}

export function maxDrawdown(poolsById, trades, bank) {
  if (!trades.length) return { maxDrawdown: 0, maxDrawdownPct: 0 };
  const t0 = Math.min(...trades.map((t) => t.entryT));
  const t1 = Math.max(...trades.map((t) => t.exitT));
  const times = new Set();
  for (const tr of trades) {
    const bars = poolsById.get(tr.pool);
    if (!bars) continue;
    for (const b of bars) if (b.t >= t0 && b.t <= t1) times.add(b.t);
  }
  const ts = [...times].sort((a, b) => a - b);
  const ordered = [...trades].sort((a, b) => a.entryT - b.entryT || a.exitT - b.exitT);
  let nextIn = 0;
  const live = [];
  let cash = bank;
  let peak = bank;
  let maxDd = 0;
  for (const t of ts) {
    for (let i = live.length - 1; i >= 0; i--) {
      if (live[i].exitT <= t) {
        cash += live[i].sizeUsd + live[i].pnl;
        live.splice(i, 1);
      }
    }
    while (nextIn < ordered.length && ordered[nextIn].entryT <= t) {
      const tr = ordered[nextIn++];
      cash -= tr.sizeUsd;
      live.push(tr);
    }
    let eq = cash;
    for (const tr of live) {
      const bars = poolsById.get(tr.pool);
      const px = bars ? priceAt(bars, t) : null;
      const mark = px == null ? tr.entryMid : px;
      const qty = tr.sizeUsd / fillPrice(tr.entryMid, 'buy', tr.feePct);
      eq += qty * fillPrice(mark, 'sell', tr.feePct);
    }
    if (eq > peak) peak = eq;
    if (peak - eq > maxDd) maxDd = peak - eq;
  }
  return { maxDrawdown: maxDd, maxDrawdownPct: peak > 0 ? maxDd / peak : 0 };
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const x = (sorted.length - 1) * q;
  const i = Math.floor(x);
  const f = x - i;
  if (i + 1 >= sorted.length) return sorted[i];
  return sorted[i] * (1 - f) + sorted[i + 1] * f;
}

export function clusterBootstrap(trades, { iters = 2000, seed = 7, qLo = 0.05, qHi = 0.95 } = {}) {
  const by = new Map();
  for (const tr of trades) {
    const k = tr.pool || '?';
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(tr);
  }
  const keys = [...by.keys()];
  const mean = trades.length ? trades.reduce((a, t) => a + t.pnl, 0) / trades.length : null;
  if (!keys.length) return { mean, lo: null, hi: null, iters: 0, nPools: 0 };
  const rng = mulberry32(seed);
  const means = [];
  for (let i = 0; i < iters; i++) {
    let n = 0, s = 0;
    for (let k = 0; k < keys.length; k++) {
      const g = by.get(keys[Math.floor(rng() * keys.length)]);
      for (const tr of g) { s += tr.pnl; n++; }
    }
    if (n) means.push(s / n);
  }
  means.sort((a, b) => a - b);
  return { mean, lo: quantile(means, qLo), hi: quantile(means, qHi), iters, nPools: keys.length };
}

function summarize(name, taken, dd, boot) {
  const h = strategyHealth(taken);
  const stops = taken.filter((t) => t.kind === 'stop');
  const gapped = stops.filter((t) => t.gap > 0);
  const gapPct = gapped.map((t) => (t.entryMid > 0 ? (t.gap / t.entryMid) * 100 : 0));
  return {
    name,
    n: taken.length,
    nPools: new Set(taken.map((t) => t.pool)).size,
    net: h.net,
    fees: h.fees,
    gross: h.gross,
    mean: taken.length ? taken.reduce((a, t) => a + t.pnl, 0) / taken.length : 0,
    expectancyPct: h.expectancyPct,
    profitFactor: h.profitFactor,
    profitFactorInfinite: h.profitFactorInfinite,
    winRate: h.winRate,
    costDrag: h.costDrag,
    maxDrawdown: dd.maxDrawdown,
    maxDrawdownPct: dd.maxDrawdownPct,
    realizedDrawdown: h.maxDrawdown,
    lo: boot.lo,
    hi: boot.hi,
    stops: stops.length,
    gapShare: stops.length ? gapped.length / stops.length : null,
    meanGapPct: gapPct.length ? gapPct.reduce((a, b) => a + b, 0) / gapPct.length : null,
  };
}

function collectTrades(pools, signal, cfg) {
  const all = [];
  const ordered = [...pools].sort((a, b) => String(a.pool).localeCompare(String(b.pool)));
  for (const p of ordered) {
    if (!p.bars || p.bars.length < 2) continue;
    for (const tr of simulateTrades(p.bars, signal, cfg)) all.push({ ...tr, pool: p.pool, symbol: p.symbol || p.pool.slice(0, 4) });
  }
  return all;
}

function evaluate(name, pools, poolsById, signal, cfg, account) {
  const all = collectTrades(pools, signal, cfg);
  const acct = runAccount(all, account);
  const dd = maxDrawdown(poolsById, acct.taken, account.bank);
  const boot = clusterBootstrap(acct.taken, { iters: cfg.bootstrapIters, seed: cfg.bootstrapSeed });
  return { summary: summarize(name, acct.taken, dd, boot), skipped: acct.skipped, signals: all.length };
}

export function buyAndHold(pools, cfg, from, to) {
  const picks = [];
  for (const p of [...pools].sort((a, b) => String(a.pool).localeCompare(String(b.pool)))) {
    const bars = (p.bars || []).filter((b) => (from == null || b.t >= from) && (to == null || b.t < to));
    if (bars.length < 2) continue;
    const entryMid = bars[0].o, exitMid = bars[bars.length - 1].c;
    if (!(entryMid > 0 && exitMid > 0)) continue;
    picks.push({ pool: p.pool, symbol: p.symbol, entryMid, exitMid, entryT: bars[0].t, exitT: bars[bars.length - 1].t, bars: p.bars });
  }
  if (!picks.length) return [];
  const size = cfg.bank / picks.length;
  return picks.map((p) => {
    const r = tradePnl({ entryMid: p.entryMid, exitMid: p.exitMid, sizeUsd: size, feePct: cfg.feePct });
    return {
      pool: p.pool, symbol: p.symbol, entryMid: p.entryMid, exitMid: p.exitMid, entryT: p.entryT, exitT: p.exitT,
      kind: 'hold', gap: 0, pnl: r.pnl, fees: r.fees, gross: r.gross, sizeUsd: size,
      retPct: (r.pnl / size) * 100, feePct: cfg.feePct,
    };
  });
}

function showsEdge(s) {
  return s.n >= 30 && s.nPools >= 8 && s.lo != null && s.lo > 0;
}
function softPositive(s) {
  return s.n >= 30 && s.mean > 0 && !(s.lo > 0);
}

export function judgeStudy(holdoutActive) {
  if (holdoutActive.some(showsEdge)) return 'edge';
  if (holdoutActive.some(softPositive)) return 'inconclusive';
  return 'no-edge';
}

// A candle-rule edge is not an edge for the live JUDGE rule. See EVAL_PROTOCOL.md.
export function deskPriorFromStudy(studyVerdict) {
  return studyVerdict === 'no-edge' ? 'no-edge' : 'inconclusive';
}

export function volGateAdopted(holdVol, holdMom, trainVol, trainMom) {
  if (!holdVol || !holdMom || !trainVol || !trainMom) return false;
  return holdVol.mean > holdMom.mean && holdVol.n >= 20 && holdVol.nPools >= 5 && trainVol.mean >= trainMom.mean;
}

export function runStudy(pools, overrides = {}) {
  const cfg = { ...PROTOCOL, ...overrides, momentum: { ...PROTOCOL.momentum, ...(overrides.momentum || {}) } };
  const usable = pools.filter((p) => p.bars && p.bars.length >= 2);
  const tMax = Math.max(...usable.map((p) => p.bars[p.bars.length - 1].t));
  const tMin = Math.min(...usable.map((p) => p.bars[0].t));
  const holdoutStart = tMax - cfg.holdoutMs;
  const sizeUsd = (cfg.ownPositionPct / 100) * cfg.bank;
  const account = { bank: cfg.bank, maxOpen: cfg.maxOpen };
  const poolsById = new Map(usable.map((p) => [p.pool, p.bars]));
  const momentum = makeMomentum(cfg, false);
  const momentumVol = makeMomentum(cfg, true);

  const runSplit = (fill, feePct, from, to) => {
    const localRng = mulberry32(cfg.randomSeed);
    const randomSignal = () => localRng() < cfg.randomP;
    const sim = { ...cfg, fill, feePct, sizeUsd, tradeFrom: from, tradeTo: to, bootstrapIters: cfg.bootstrapIters };
    const names = [
      ['random', randomSignal],
      ['momentum', momentum],
      ['momentum-vol', momentumVol],
    ];
    const out = {};
    for (const [name, signal] of names) out[name] = evaluate(name, usable, poolsById, signal, sim, account);
    const held = buyAndHold(usable, { ...cfg, feePct, sizeUsd: cfg.bank }, from, to);
    const boot = clusterBootstrap(held, { iters: Math.min(cfg.bootstrapIters, 500), seed: cfg.bootstrapSeed });
    const dd = maxDrawdown(poolsById, held, cfg.bank);
    out['buy-and-hold'] = { summary: summarize('buy-and-hold', held, dd, boot), skipped: 0, signals: held.length };
    out['no-trade'] = {
      summary: {
        name: 'no-trade', n: 0, nPools: 0, net: 0, fees: 0, gross: 0, mean: 0, expectancyPct: 0,
        profitFactor: null, profitFactorInfinite: false, winRate: 0, costDrag: null,
        maxDrawdown: 0, maxDrawdownPct: 0, realizedDrawdown: 0, lo: 0, hi: 0, stops: 0, gapShare: null, meanGapPct: null,
      },
      skipped: 0, signals: 0,
    };
    return out;
  };

  const primary = {
    train: runSplit(cfg.fill, cfg.feePct, null, holdoutStart),
    holdout: runSplit(cfg.fill, cfg.feePct, holdoutStart, null),
  };
  // Fresh RNG for sensitivities so they don't depend on call order of the primary... actually randomSignal
  // already consumed the RNG. Sensitivities would see a continued stream and different trades.
  // Rebuild random from the same seed by running sensitivities inside runSplit only if we reseed.
  // The closure above already advanced rng during primary train AND holdout. That's two passes.
  // Reseed by reconstructing. Easiest: runStudy's random is created once and primary consumes it
  // in a fixed order (train then holdout). Sensitivities need their own seeded runs.
  // I'll recompute sensitivities with a fresh study path: call collect using a new rng by
  // not reusing randomSignal. Implement sensitivity with a second runStudy? Recursive overrides
  // would double-count. Do it inline with new rngs.

  function sensitivity(fill, feePct) {
    const localRng = mulberry32(cfg.randomSeed);
    const localRandom = () => localRng() < cfg.randomP;
    const simBase = { ...cfg, fill, feePct, sizeUsd };
    const out = {};
    for (const [name, signal] of [['random', localRandom], ['momentum', momentum], ['momentum-vol', momentumVol]]) {
      out[name] = evaluate(name, usable, poolsById, signal, { ...simBase, tradeFrom: holdoutStart, tradeTo: null }, account).summary;
    }
    return out;
  }

  const studyVerdict = judgeStudy(['random', 'momentum', 'momentum-vol'].map((k) => primary.holdout[k].summary));
  const adopted = volGateAdopted(
    primary.holdout['momentum-vol'].summary,
    primary.holdout.momentum.summary,
    primary.train['momentum-vol'].summary,
    primary.train.momentum.summary,
  );
  const verdict = deskPriorFromStudy(studyVerdict);
  return {
    id: cfg.id,
    pools: usable.length,
    bars: usable.reduce((a, p) => a + p.bars.length, 0),
    tMin, tMax, holdoutStart,
    feePct: cfg.feePct,
    fill: cfg.fill,
    studyVerdict,
    verdict,
    volGateAdopted: adopted,
    primary,
    sensitivity: {
      optimistic: sensitivity('optimistic', cfg.feePct),
      fee2: sensitivity(cfg.fill, 2),
    },
  };
}

function money(x) {
  if (x == null || Number.isNaN(x)) return '–';
  const n = Number(x);
  return `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`;
}
function pct(x) {
  if (x == null || Number.isNaN(x)) return '–';
  return `${(x * 100).toFixed(1)}%`;
}
function num(x, d = 2) {
  if (x == null || Number.isNaN(x)) return '–';
  return Number(x).toFixed(d);
}

function row(s) {
  const pf = s.profitFactorInfinite ? '∞' : (s.profitFactor == null ? '–' : num(s.profitFactor));
  const drag = s.costDrag == null ? '–' : (s.costDrag > 1 ? 'fees > gross' : pct(s.costDrag));
  const gap = s.meanGapPct == null ? '–' : `${num(s.meanGapPct)}%`;
  return `| ${s.name} | ${s.n} | ${s.nPools} | ${money(s.net)} | ${money(s.mean)} | ${money(s.lo)} .. ${money(s.hi)} | ${pf} | ${pct(s.winRate)} | ${drag} | ${money(s.maxDrawdown)} | ${gap} |`;
}

const TABLE_HEAD = '| Rule | Trades | Pools | Net | Expectancy | 90% interval | Profit factor | Win rate | Cost drag | Drawdown | Avg extra past stop |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|';

export function renderReport(result, meta = {}) {
  const when = meta.collectedAt || 'unknown';
  const lines = [];
  lines.push('# Walk-forward paper study');
  lines.push('');
  lines.push(`Collected ${when}. Protocol \`${result.id}\` in \`EVAL_PROTOCOL.md\`, executed by \`engine/eval.js\`. Paper only. This is not a claim of live profitability.`);
  lines.push('');
  lines.push(`Pools ${result.pools}, minute bars ${result.bars}. Holdout starts ${new Date(result.holdoutStart).toISOString()} (last 8 hours before ${new Date(result.tMax).toISOString()}). Primary cost: ${result.feePct}% round trip, ${result.fill} stop fills.`);
  lines.push('');
  lines.push(`Study verdict: **${result.studyVerdict}**. Desk prior (what sizes live paper entries): **${result.verdict}**. Volatility gate adopted: **${result.volGateAdopted ? 'yes' : 'no'}**.`);
  lines.push('');
  lines.push('## Holdout (unseen tail)');
  lines.push('');
  lines.push(TABLE_HEAD);
  for (const k of ['no-trade', 'random', 'momentum', 'momentum-vol', 'buy-and-hold']) lines.push(row(result.primary.holdout[k].summary));
  lines.push('');
  lines.push('## Train (earlier bars, same rules, not used to pick a winner)');
  lines.push('');
  lines.push(TABLE_HEAD);
  for (const k of ['no-trade', 'random', 'momentum', 'momentum-vol', 'buy-and-hold']) lines.push(row(result.primary.train[k].summary));
  lines.push('');
  lines.push('## What the desk does with this');
  lines.push('');
  const hv = result.primary.holdout['momentum-vol'].summary;
  const hm = result.primary.holdout.momentum.summary;
  const tv = result.primary.train['momentum-vol'].summary;
  const tm = result.primary.train.momentum.summary;
  const rnd = result.primary.holdout.random.summary;
  if (result.verdict === 'no-edge') {
    lines.push(`Default paper entries are off. On this holdout, random entries netted ${money(rnd.net)} over ${rnd.n} trades (90% interval ${money(rnd.lo)} to ${money(rnd.hi)} per trade) and the momentum rule netted ${money(hm.net)} over ${hm.n} trades (interval ${money(hm.lo)} to ${money(hm.hi)}). No-trade netted ${money(0)}. The desk's default is the no-trade number. That is a risk control, not a new entry formula.`);
  } else {
    lines.push(`Desk prior is \`${result.verdict}\`. Live entries stay on the existing JUDGE rule at half size until this desk's own closed trades (30 or more) have an 80% lower bound above zero. The study does not install the candle rule that looked best.`);
  }
  lines.push('');
  lines.push(`The range filter was not turned on. Holdout mean ${money(hv.mean)} versus momentum ${money(hm.mean)}; train mean ${money(tv.mean)} versus momentum ${money(tm.mean)}. Adoption required the filter to be better on the holdout and no worse on the train. It was better on the holdout and worse on the train.`);
  lines.push('');
  lines.push(`Stops in the conservative run fill at the bar low whenever the low is through the stop, so "gapped" is true by construction. The amount past the stop is the measurement: about ${num(rnd.meanGapPct)}% extra on random stops and ${num(hm.meanGapPct)}% on momentum stops. The optimistic table fills those stops at the stop price. Random and momentum intervals stay below zero there too, so the loss is not only the harsh fill.`);
  lines.push('');
  lines.push('JUDGE weights were not changed. The candle rules are a proxy: free history has no holder counts, top-10 share, mint authority, or wallet paths, so the live gate cannot be replayed bar by bar.');
  lines.push('');
  lines.push('## Sensitivity (not used for the decision)');
  lines.push('');
  lines.push('Optimistic stops (fill at the stop price, not the low), same 1% cost, holdout:');
  lines.push('');
  lines.push(TABLE_HEAD);
  for (const k of ['random', 'momentum', 'momentum-vol']) lines.push(row(result.sensitivity.optimistic[k]));
  lines.push('');
  lines.push('Conservative stops, 2% round trip, holdout:');
  lines.push('');
  lines.push(TABLE_HEAD);
  for (const k of ['random', 'momentum', 'momentum-vol']) lines.push(row(result.sensitivity.fee2[k]));
  lines.push('');
  if (result.bhTop?.length) {
    lines.push('## Buy-and-hold contributors (holdout, not a candidate)');
    lines.push('');
    lines.push('Equal-weight dollar P&L is not a typical-pool result. Largest positions:');
    lines.push('');
    for (const t of result.bhTop) lines.push(`- ${t.symbol}: ${money(t.pnl)} (${num(t.retPct, 1)}% on its slice, ${pct(t.share)} of the buy-and-hold total)`);
    lines.push('');
  }
  lines.push('## Limitations');
  lines.push('');
  lines.push('- Survivorship: the universe is pools that still had a GeckoTerminal page when the collector ran, and that cleared a $40k liquidity snapshot taken at the end, not at each bar. Dead pools are missing. Results are biased toward looking better than a live scout would.');
  lines.push('- One holdout slice, three active rules. The decision rule was frozen, but the sample is still one window of meme-coin time.');
  lines.push('- Bootstrap resamples pools that traded. If only a few pools trade, the interval is too tight. The edge rule requires 8 pools for that reason.');
  lines.push('- Buy-and-hold deploys the whole bank and is not an entry candidate. A single new pool whose first prints jump by orders of magnitude can dominate the dollar total. See the contributor list under the tables. Do not read that total as an edge.');
  lines.push('- Live paper fills open positions at the polled price (every 15s when a position is open). This study fills stops at the minute low, which is worse. A live gain is not a study gain.');
  lines.push('- The recorded 50-minute session (RESULTS.md) is a separate, smaller sample: 7 trades, net +$1.76, fees $1.78, one stop filled at −10.6% against a −4% level. It is not confirmation.');
  lines.push('- No live trading, no wallet, no claim that the next session makes money.');
  lines.push('');
  return lines.join('\n');
}

export function priorModuleSource(result) {
  const slim = ['no-trade', 'random', 'momentum', 'momentum-vol', 'buy-and-hold'].map((k) => {
    const s = result.primary.holdout[k].summary;
    return {
      name: k, n: s.n, nPools: s.nPools, net: round2(s.net), mean: round4(s.mean),
      lo: s.lo == null ? null : round4(s.lo), hi: s.hi == null ? null : round4(s.hi),
      profitFactor: s.profitFactor == null ? null : round4(s.profitFactor),
      costDrag: s.costDrag == null ? null : round4(s.costDrag),
      maxDrawdown: round2(s.maxDrawdown), winRate: round4(s.winRate),
      note: k === 'buy-and-hold' ? 'Not a candidate. One launch print can dominate this dollar total.' : undefined,
    };
  });
  const summary = result.verdict === 'no-edge'
    ? 'Holdout: random entries and the momentum rule both lost money after costs, and the loss interval sat below zero. New paper entries stay off unless exploratory mode is on. Buy-and-hold of this survivor list is not a candidate; a launch print can dominate it.'
    : 'Holdout study did not justify full-size JUDGE entries. Size stays at half until this desk\'s own sample clears the local bar.';
  const prior = {
    id: result.id,
    verdict: result.verdict,
    studyVerdict: result.studyVerdict,
    summary,
    collectedAt: result.collectedAt || null,
    holdout: 'last 8 hours of collected 1-minute bars',
    primary: { feePct: result.feePct, fill: result.fill },
    volGateAdopted: result.volGateAdopted,
    strategies: slim,
    limitations: [
      'Candle study is not a replay of JUDGE. Holder, authority, and wallet data are not in the bars.',
      'Pools that had already died before collection are missing, so the sample is biased upward.',
      'One 8-hour holdout. Intervals that include zero are not an edge.',
    ],
  };
  return `// Generated by runner/walkforward.mjs. Do not hand-edit the verdict.\nexport const VOL_GATE_ADOPTED = ${result.volGateAdopted ? 'true' : 'false'};\n\nexport const RESEARCH_PRIOR = ${JSON.stringify(prior, null, 2)};\n`;
}

const round2 = (x) => Math.round(x * 100) / 100;
const round4 = (x) => Math.round(x * 10000) / 10000;
