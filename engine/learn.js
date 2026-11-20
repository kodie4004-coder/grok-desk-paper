// Paper learning loop. Variants below were written down before any journal
// settlement. A challenger may replace a champion only on a burned holdout.
// The v6 edge gate is not modified here. Size stays $2. Nothing here is real money.

import { kalshiTakerFee, coinFlipSide } from './kalshi.js';
import { reviewRoles, shouldExit, settleExit } from './roles.js';
import { clusterBootstrap } from './eval.js';
import { graduates } from './strategies.js';
import { repairGate, REPAIR_MIN_N } from './repair.js';

export const LEARN_SIZE = 2;
export const HOLD_MIN = 20;
export const BOT_DAY_LOSS = 6;
export const SNAPSHOT_ALLOC_CAP = 8;
export const SNAPSHOT_LINE_CAP = 16;

export const VARIANTS = [
  { id: 'late', family: 'late', label: 'Late favorite', role: 'champion', minAsk: 0.85, minLeft: 180, maxLeft: 300 },
  { id: 'late-loose', family: 'late', label: 'Late favorite, looser ask', role: 'challenger', minAsk: 0.80, minLeft: 180, maxLeft: 300 },
  { id: 'late-tight', family: 'late', label: 'Late favorite, tighter ask', role: 'challenger', minAsk: 0.90, minLeft: 180, maxLeft: 360 },
  { id: 'late-early', family: 'late', label: 'Late favorite, earlier', role: 'challenger', minAsk: 0.85, minLeft: 300, maxLeft: 480 },
  { id: 'mom', family: 'mom', label: 'Momentum vs target', role: 'champion', kind: 'mom', minLeft: 120, maxLeft: 600, minMove: 0 },
  { id: 'mom-strict', family: 'mom', label: 'Momentum, 0.05% past the strike', role: 'challenger', kind: 'mom', minLeft: 120, maxLeft: 600, minMove: 0.0005 },
  { id: 'revert', family: 'revert', label: 'Mean revert', role: 'champion', kind: 'revert', minLeft: 360, maxLeft: 720, cheap: [0.15, 0.40], rich: [0.60, 0.85] },
  { id: 'revert-wide', family: 'revert', label: 'Mean revert, wider band', role: 'challenger', kind: 'revert', minLeft: 360, maxLeft: 720, cheap: [0.10, 0.45], rich: [0.55, 0.90] },
  { id: 'revert-no-longshot', family: 'revert', label: 'Mean revert, skip asks under 0.40', role: 'challenger', kind: 'revert', minLeft: 360, maxLeft: 720, cheap: [0.15, 0.50], rich: [0.50, 0.85], minBuy: 0.40 },
  { id: 'scalp', family: 'scalp', label: 'Intra-window scalp', role: 'champion', kind: 'scalp', minJump: 0.04, maxSpread: 0.03, minLeft: 120 },
  { id: 'scalp-tight', family: 'scalp', label: 'Scalp, larger jump', role: 'challenger', kind: 'scalp', minJump: 0.06, maxSpread: 0.02, minLeft: 120 },
  { id: 'scalp-tp', family: 'scalp', label: 'Scalp, 3c take-profit', role: 'challenger', kind: 'scalp', minJump: 0.04, maxSpread: 0.03, minLeft: 120, exit: 'tp' },
  { id: 'scalp-stop', family: 'scalp', label: 'Scalp, 4c stop', role: 'challenger', kind: 'scalp', minJump: 0.04, maxSpread: 0.03, minLeft: 120, exit: 'stop' },
  { id: 'scalp-time', family: 'scalp', label: 'Scalp, 2-minute time-stop', role: 'challenger', kind: 'scalp', minJump: 0.04, maxSpread: 0.03, minLeft: 120, exit: 'time' },
  { id: 'flip', family: 'flip', label: 'Coin-flip control', role: 'control', kind: 'flip', minLeft: 600, maxLeft: 840 },
];

const FAMILY_LABEL = { late: 'Late favorite', mom: 'Momentum vs target', revert: 'Mean revert', scalp: 'Intra-window scalp', flip: 'Coin-flip control' };

export function defaultBrain() {
  return {
    schema: 1,
    paper: true,
    note: 'Paper only. The newest finished UTC day is the holdout and is judged once. The edge gate is not changed here. A loss does not raise size.',
    champions: { late: 'late', mom: 'mom', revert: 'revert', scalp: 'scalp', flip: 'flip' },
    benched: [],
    shadow: [],
    shadowSince: {},
    experimentSince: null,
    judged: [],
    weights: Object.fromEntries(VARIANTS.map((v) => [v.id, v.role === 'challenger' ? 1 : 2])),
    decisions: [],
  };
}

export function dayKey(value) {
  const t = typeof value === 'number' ? value : Date.parse(value || '');
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

function hash01(text) {
  let h = 2166136261;
  for (const ch of String(text)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return ((h >>> 0) % 10000) / 10000;
}

function stdev(values) {
  if (!values || values.length < 3) return null;
  const m = values.reduce((a, b) => a + b, 0) / values.length;
  const v = values.reduce((a, b) => a + (b - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(v);
}

function favorite(market, minAsk) {
  const yes = Number(market.yesAsk);
  const no = Number(market.noAsk);
  const yesOk = yes >= minAsk && yes < 1;
  const noOk = no >= minAsk && no < 1;
  if (yesOk && (!noOk || yes >= no)) return { side: 'yes', ask: yes };
  if (noOk) return { side: 'no', ask: no };
  return null;
}

export function signal(variant, market, now, ctx = {}) {
  const left = (Date.parse(market.closeTime) - now) / 1000;
  if (!Number.isFinite(left) || left < variant.minLeft || left > variant.maxLeft) return null;
  const yes = Number(market.yesAsk);
  const no = Number(market.noAsk);
  const bid = Number(market.yesBid);
  let picked = null;
  if (!variant.kind) picked = favorite(market, variant.minAsk);
  else if (variant.kind === 'mom') {
    const base = { KXBTC15M: 'BTC', KXETH15M: 'ETH', KXSOL15M: 'SOL', KXXRP15M: 'XRP', KXDOGE15M: 'DOGE', KXBNB15M: 'BNB', KXHYPE15M: 'HYPE', KXZEC15M: 'ZEC', KXNEAR15M: 'NEAR' }[market.series];
    const px = ctx.spots?.[base]?.px;
    const strike = Number(market.floorStrike);
    if (!(px > 0) || !(strike > 0) || !(yes > 0 && yes < 1) || !(no > 0 && no < 1)) return null;
    const gap = Math.abs(px - strike) / strike;
    if (gap < variant.minMove) return null;
    if (px > strike) picked = { side: 'yes', ask: yes };
    else if (px < strike) picked = { side: 'no', ask: no };
  } else if (variant.kind === 'revert') {
    const [c0, c1] = variant.cheap;
    const [r0, r1] = variant.rich;
    if (yes > c0 && yes < c1 && yes > 0 && yes < 1) picked = { side: 'yes', ask: yes };
    else if (yes > r0 && yes < r1 && no > 0 && no < 1) picked = { side: 'no', ask: no };
  } else if (variant.kind === 'scalp') {
    const prev = ctx.prev?.yesAsk;
    const spread = Number.isFinite(yes) && Number.isFinite(bid) ? yes - bid : null;
    if (prev == null || !(yes - prev >= variant.minJump) || !(spread != null && spread <= variant.maxSpread && spread >= 0) || !(yes > 0 && yes < 1)) return null;
    picked = { side: 'yes', ask: yes };
  } else if (variant.kind === 'flip') {
    if (!(yes > 0 && yes < 1) || !(no > 0 && no < 1)) return null;
    const side = coinFlipSide(market.ticker + market.closeTime);
    picked = { side, ask: side === 'yes' ? yes : no };
  }
  if (!picked || (variant.minBuy && picked.ask < variant.minBuy)) return null;
  const samples = [...(ctx.prev?.samples || []), yes].filter((n) => Number.isFinite(n));
  const spread = Number.isFinite(yes) && Number.isFinite(bid) && yes >= bid ? +(yes - bid).toFixed(4) : null;
  return {
    ...picked,
    features: {
      price: +picked.ask.toFixed(4),
      secondsLeft: Math.round(left),
      spread,
      momentum: ctx.prev && Number.isFinite(ctx.prev.yesAsk) && Number.isFinite(yes) ? +(yes - ctx.prev.yesAsk).toFixed(4) : null,
      volatility: stdev(samples.slice(-5)),
      strategy: variant.id,
      market: market.series || '',
    },
  };
}

export function settleRow(entry, result, now) {
  const won = result === entry.side;
  const contracts = entry.contracts;
  const fee = kalshiTakerFee(entry.ask, contracts);
  const pnl = (won ? contracts : 0) - contracts * entry.ask - fee;
  if (entry.sizeUsd !== LEARN_SIZE) throw new Error('paper size is fixed at $2');
  return {
    ...entry,
    result,
    won,
    pnl,
    fees: fee,
    settledAt: new Date(now).toISOString(),
    window: dayKey(entry.closeTime) || dayKey(now),
    paper: true,
  };
}

function openRow(variant, market, sig, now, allocated) {
  const contracts = Math.floor(LEARN_SIZE / sig.ask);
  if (contracts < 1) return null;
  return {
    id: `${variant.id}:${market.ticker}`,
    family: variant.family,
    variant: variant.id,
    role: variant.role,
    allocated,
    ticker: market.ticker,
    series: market.series || '',
    title: market.title || market.ticker,
    side: sig.side,
    ask: sig.ask,
    contracts,
    sizeUsd: LEARN_SIZE,
    fee: kalshiTakerFee(sig.ask, contracts),
    openedAt: new Date(now).toISOString(),
    closeTime: market.closeTime,
    exit: variant.exit || null,
    ...sig.features,
    paper: true,
  };
}

export function pickAllocated(variants, weights, seed) {
  const live = variants.filter((v) => (weights[v.id] ?? 1) > 0);
  if (!live.length) return null;
  const total = live.reduce((sum, v) => sum + (weights[v.id] ?? 1), 0);
  let cursor = hash01(seed) * total;
  for (const variant of live) {
    cursor -= weights[variant.id] ?? 1;
    if (cursor <= 0) return variant.id;
  }
  return live[live.length - 1].id;
}

export function stepJournal({ markets, open = [], quotes = {}, brain, existingIds = [], settledRows = [], spots = {}, now }) {
  const state = brain || defaultBrain();
  const known = new Set(existingIds);
  const settled = [];
  const still = [];
  const byTicker = new Map((markets || []).map((m) => [m.ticker, m]));
  for (const entry of open) {
    const market = byTicker.get(entry.ticker);
    const resolved = market && (market.result === 'yes' || market.result === 'no');
    if (resolved) {
      if (!known.has(entry.id)) {
        settled.push(settleRow(entry, market.result, now));
        known.add(entry.id);
      }
      continue;
    }
    const close = Date.parse(entry.closeTime);
    if (Number.isFinite(close) && now - close > 6 * 3600000 && !market) continue;
    still.push(entry);
  }
  for (let i = still.length - 1; i >= 0; i -= 1) {
    const entry = still[i];
    const market = byTicker.get(entry.ticker);
    if (!market || entry.skipped) continue;
    const hit = shouldExit(entry, market, now);
    if (!hit || known.has(entry.id)) continue;
    settled.push(settleExit(entry, hit.bid, hit.why, now));
    known.add(entry.id);
    still.splice(i, 1);
  }
  const history = [...(settledRows || []), ...settled];
  const risk = riskShadow(state, history, now);
  const demoted = rollingDemote(history, 40);
  const quiet = new Set([...(state.benched || []), ...risk.shadow, ...demoted.map((d) => d.id), ...controls()]);
  const weights = evidenceWeights(history, state, now, 40);
  for (const id of quiet) weights[id] = 0;
  const nextQuotes = {};
  let allocLeft = SNAPSHOT_ALLOC_CAP;
  let lineLeft = SNAPSHOT_LINE_CAP;
  const ordered = [...(markets || [])].sort((a, b) => String(a.ticker).localeCompare(String(b.ticker)));
  for (const market of ordered) {
    const prev = quotes[market.ticker] || null;
    const yes = Number(market.yesAsk);
    if (Number.isFinite(yes)) {
      nextQuotes[market.ticker] = { yesAsk: yes, yesBid: Number(market.yesBid), samples: [...(prev?.samples || []), yes].slice(-5) };
    }
    if (market.result === 'yes' || market.result === 'no') continue;
    const firing = [];
    for (const variant of VARIANTS) {
      const sig = signal(variant, market, now, { spots, prev });
      if (sig) firing.push({ variant, sig });
    }
    const byFamily = new Map();
    for (const row of firing) {
      if (!byFamily.has(row.variant.family)) byFamily.set(row.variant.family, []);
      byFamily.get(row.variant.family).push(row);
    }
    for (const [family, rows] of byFamily) {
      const chosen = pickAllocated(rows.map((r) => r.variant), weights, `${market.ticker}:${market.closeTime}:${family}`);
      const orderedRows = [...rows].sort((a, b) => Number(b.variant.id === chosen) - Number(a.variant.id === chosen));
      for (const row of orderedRows) {
        const id = `${row.variant.id}:${market.ticker}`;
        if (known.has(id) || still.some((e) => e.id === id)) continue;
        const quietBot = quiet.has(row.variant.id) || row.variant.role === 'control';
        // Control and shadow logs do not spend the cap that gates allocated bets.
        if (!quietBot && lineLeft <= 0) continue;
        const chosenOne = !quietBot && chosen === row.variant.id;
        const fee = quietBot ? null : feeVeto(row.variant.id, row.sig, history);
        const capped = chosenOne && allocLeft <= 0;
        const decision = reviewRoles({
          variant: row.variant,
          market,
          sig: row.sig,
          quiet: quietBot || (!chosenOne && !fee),
          settledRows: history,
          room: !capped,
          feeVeto: fee,
        });
        if (!decision.take && !decision.skipped) continue;
        const opened = openRow(row.variant, market, row.sig, now, !!(decision.allocated && !capped && chosenOne));
        if (!opened) continue;
        opened.role = liveRole(row.variant, state, quietBot);
        opened.roles = decision.logs;
        opened.skipped = decision.skipped;
        opened.skipReason = decision.skipReason || null;
        if (opened.allocated) allocLeft -= 1;
        if (!quietBot) lineLeft -= 1;
        still.push(opened);
        known.add(id);
      }
    }
  }
  return {
    settled,
    open: still,
    quotes: nextQuotes,
    brain: {
      ...state,
      shadow: [...quiet].filter((id) => !controls().has(id)),
      shadowSince: { ...risk.shadowSince, ...Object.fromEntries(demoted.map((d) => [d.id, risk.shadowSince[d.id] || dayKey(now)])) },
      shadowReturned: risk.shadowReturned || {},
      weights,
      lessons: demoted.map((d) => `benched ${d.id}: ${usd(d.mean)}/trade over 30`),
    },
  };
}

function dayPnlOf(rows, variantId, day) {
  return (rows || []).filter((row) => row.allocated && row.variant === variantId && dayKey(row.settledAt || row.window) === day).reduce((sum, row) => sum + (row.pnl || 0), 0);
}

function liveRole(variant, state, quietBot) {
  if (variant.role === 'control') return 'control';
  if (quietBot) return 'shadow';
  if (state?.champions?.[variant.family] === variant.id) return 'champion';
  return variant.role;
}

// Settled $0 practice. Vetoed skips are not practice and do not move the repair bar.
export function shadowPractice(rows, variantId, start) {
  return (rows || []).filter((row) => {
    if (!row || row.variant !== variantId || row.allocated !== false || row.skipped === true || row.pnl == null) return false;
    if (start && !(String(row.openedAt || row.settledAt || '') > start)) return false;
    return true;
  });
}

export function repairPracticeGate(rows, variantId, since = null) {
  const gate = repairGate(shadowPractice(rows, variantId, since));
  return { ...gate, need: REPAIR_MIN_N };
}

function practiceCleared(rows, variantId, start) {
  const last = shadowPractice(rows, variantId, start).slice(-30);
  if (last.length < 30) return false;
  return last.reduce((sum, row) => sum + row.pnl, 0) / last.length > 0;
}

export function riskShadow(brain, rows, now) {
  const today = dayKey(now);
  const finished = [...new Set((rows || []).map((row) => dayKey(row.settledAt || row.window)).filter((day) => day && today && day < today))].sort();
  const lastDay = finished.length ? finished[finished.length - 1] : null;
  const since = { ...(brain?.shadowSince || {}) };
  const returned = { ...(brain?.shadowReturned || {}) };
  const shadow = new Set(brain?.shadow || []);
  for (const variant of VARIANTS) {
    if (variant.role === 'control') continue;
    const todayPnl = dayPnlOf(rows, variant.id, today);
    const priorPnl = lastDay ? dayPnlOf(rows, variant.id, lastDay) : 0;
    const priorStillOpen = priorPnl <= -BOT_DAY_LOSS && returned[variant.id] !== lastDay;
    const mark = todayPnl <= -BOT_DAY_LOSS ? today : lastDay;
    const start = since[variant.id] || mark;
    const alreadyCleared = priorStillOpen && !(todayPnl <= -BOT_DAY_LOSS) && practiceCleared(rows, variant.id, start);
    if (alreadyCleared) {
      shadow.delete(variant.id);
      delete since[variant.id];
      if (lastDay) returned[variant.id] = lastDay;
    } else if (todayPnl <= -BOT_DAY_LOSS || priorStillOpen) {
      shadow.add(variant.id);
      if (!since[variant.id]) since[variant.id] = mark;
    }
  }
  for (const id of [...shadow]) {
    const start = since[id];
    if (!start) continue;
    if (!practiceCleared(rows, id, start)) continue;
    shadow.delete(id);
    delete since[id];
    if (lastDay) returned[id] = lastDay;
  }
  return { shadow: [...shadow], shadowSince: since, shadowReturned: returned };
}

function controls() {
  return new Set(VARIANTS.filter((v) => v.role === 'control').map((v) => v.id));
}

export function rollingDemote(rows, iters = 80) {
  const by = new Map();
  for (const row of rows || []) {
    if (!row.allocated || row.pnl == null || !row.variant || controls().has(row.variant)) continue;
    if (!by.has(row.variant)) by.set(row.variant, []);
    by.get(row.variant).push(row);
  }
  const out = [];
  for (const [id, list] of by) {
    const last = list.slice(-30);
    if (last.length < 30) continue;
    const stats = windowStats(last, iters);
    if (stats.mean < 0 && stats.hi != null && stats.hi < 0) out.push({ id, mean: stats.mean, n: last.length });
  }
  return out;
}

export function feeVeto(variantId, sig, rows) {
  const shadows = (rows || []).filter((row) => row.variant === variantId && row.pnl != null && !row.allocated).slice(-30);
  if (shadows.length < 8 || !(sig?.ask > 0)) return null;
  const mean = shadows.reduce((sum, row) => sum + row.pnl, 0) / shadows.length;
  const contracts = Math.max(1, Math.floor(LEARN_SIZE / sig.ask));
  const fee = kalshiTakerFee(sig.ask, contracts);
  const half = Math.max(0, Number(sig.features?.spread) || 0) / 2 * contracts;
  if (mean > fee + half) return null;
  return `risk: shadow mean ${mean.toFixed(2)} does not clear fee ${fee.toFixed(2)} plus half-spread ${half.toFixed(2)}`;
}

export function evidenceWeights(rows, brain, now, iters = 40) {
  const weights = {};
  const today = dayKey(now);
  for (const variant of VARIANTS) {
    if (variant.role === 'control') { weights[variant.id] = 0; continue; }
    const mine = (rows || []).filter((row) => row.allocated && row.variant === variant.id && row.pnl != null).slice(-30);
    let weight = 0.25;
    if (mine.length >= 8) {
      const stats = windowStats(mine, iters);
      weight = stats.lo > 0 ? Math.min(1, stats.lo / 0.5) : 0;
    }
    const dayPnl = (rows || []).filter((row) => row.allocated && row.variant === variant.id && dayKey(row.settledAt || row.window) === today).reduce((sum, row) => sum + (row.pnl || 0), 0);
    const prev = brain?.weights?.[variant.id];
    if (dayPnl < 0 && prev != null) weight = Math.min(weight, prev);
    weights[variant.id] = weight;
  }
  return weights;
}

export function allocCurve(rows, today = new Date().toISOString().slice(0, 10)) {
  const settled = [...(rows || [])].filter((row) => row.allocated && row.pnl != null).sort((a, b) => String(a.settledAt || '').localeCompare(String(b.settledAt || '')));
  let net = 0;
  let fees = 0;
  let day = 0;
  const raw = [0];
  for (const row of settled) {
    net += row.pnl;
    fees += row.fees || row.fee || 0;
    if (String(row.settledAt || row.window || '').slice(0, 10) === today) day += row.pnl;
    raw.push(Math.round(net * 100) / 100);
  }
  const points = raw.length <= 80 ? raw : raw.filter((_, i) => i === raw.length - 1 || i % Math.ceil(raw.length / 80) === 0);
  return {
    today,
    n: settled.length,
    net: Math.round(net * 100) / 100,
    fees: Math.round(fees * 100) / 100,
    day: Math.round(day * 100) / 100,
    points,
  };
}

export function replayAllocated(rows) {
  const sorted = [...(rows || [])].filter((row) => row.pnl != null).sort((a, b) => String(a.openedAt || '').localeCompare(String(b.openedAt || '')));
  let before = 0;
  let after = 0;
  let nBefore = 0;
  let nAfter = 0;
  const kept = [];
  for (const row of sorted) {
    if (row.allocated) { before += row.pnl; nBefore += 1; }
    const quiet = new Set([...controls(), ...(riskShadow({ shadow: [], shadowSince: {} }, kept, Date.parse(row.openedAt) || 0).shadow), ...rollingDemote(kept, 20).map((d) => d.id)]);
    if (row.allocated && !quiet.has(row.variant)) { after += row.pnl; nAfter += 1; kept.push(row); }
  }
  return { before, after, nBefore, nAfter, inSample: true };
}

function windowStats(rows, iters = 300) {
  if (!rows.length) return { n: 0, mean: null, lo: null, hi: null, wins: 0 };
  const boot = clusterBootstrap(rows.map((r) => ({ pnl: r.pnl, pool: r.series || r.ticker || '?' })), { iters, seed: 7, qLo: 0.05, qHi: 0.95 });
  return { n: rows.length, mean: boot.mean, lo: boot.lo, hi: boot.hi, wins: rows.filter((r) => r.won || r.pnl > 0).length };
}

export function sampleLabel(n, lo, hi) {
  if (n < 20) return 'noise';
  if (lo == null || hi == null || (lo <= 0 && hi >= 0)) return 'uncertain';
  if (n < 40) return 'thin';
  return 'clear';
}

export function splitWindows(rows, now) {
  const today = dayKey(now);
  const groups = new Map();
  for (const row of rows) {
    const key = row.window || dayKey(row.closeTime);
    if (!key || key >= today) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const finished = [...groups.keys()].sort();
  const holdout = finished.length ? finished[finished.length - 1] : null;
  const trainKeys = finished.filter((key) => key !== holdout);
  return { holdout, trainKeys, groups };
}

export function reviewBrain(brain, rows, now, opts = {}) {
  const base = { ...defaultBrain(), ...brain, champions: { ...defaultBrain().champions, ...(brain?.champions || {}) }, judged: [...(brain?.judged || [])] };
  const { holdout, trainKeys, groups } = splitWindows(rows, now);
  const train = trainKeys.flatMap((key) => groups.get(key) || []);
  const holdRows = holdout ? groups.get(holdout) || [] : [];
  const weights = {};
  const benched = new Set((base.benched || []).filter((id) => VARIANTS.some((v) => v.id === id && v.role !== 'control')));
  const decisions = [];
  for (const variant of VARIANTS) {
    if (variant.role === 'control') {
      weights[variant.id] = 1;
      continue;
    }
    const mine = train.filter((r) => r.variant === variant.id);
    const stats = windowStats(mine, opts.iters || 200);
    const losing = stats.n >= HOLD_MIN && !(stats.mean > 0) && !(stats.lo > 0);
    if (losing) benched.add(variant.id);
    const mean = stats.mean == null ? 0 : Math.max(-0.1, Math.min(0.1, stats.mean));
    weights[variant.id] = benched.has(variant.id) ? 0 : Math.exp(mean / 0.02);
  }
  const champions = { ...base.champions };
  const already = !!(holdout && base.judged.includes(holdout));
  if (already) {
    decisions.push(`Holdout ${holdout} was already judged. It was not used to retune.`);
  } else {
    for (const family of Object.keys(FAMILY_LABEL)) {
      if (family === 'flip') continue;
      const champId = champions[family];
      const champHold = windowStats(holdRows.filter((r) => r.variant === champId), opts.iters || 200);
      let best = null;
      for (const variant of VARIANTS.filter((v) => v.family === family && v.id !== champId && v.role !== 'control')) {
        const stats = windowStats(holdRows.filter((r) => r.variant === variant.id), opts.iters || 200);
        const beats = holdout && stats.n >= HOLD_MIN && champHold.n >= HOLD_MIN && stats.mean > champHold.mean && stats.mean > 0;
        if (beats && (!best || stats.mean > best.stats.mean)) best = { variant, stats };
      }
      if (best) {
        champions[family] = best.variant.id;
        decisions.push(`${best.variant.label} replaces ${champId} on the ${holdout} holdout. n ${best.stats.n}, mean ${usd(best.stats.mean)} after fees, against the champion's ${usd(champHold.mean)}.`);
      } else if (holdout) {
        decisions.push(`${FAMILY_LABEL[family]} keeps ${champId}. The ${holdout} holdout did not clear n ${HOLD_MIN} for both bots with a higher after-fee mean.`);
      } else {
        decisions.push(`${FAMILY_LABEL[family]} keeps ${champId}. No finished holdout day yet.`);
      }
    }
    if (holdout) base.judged.push(holdout);
  }
  return {
    ...base,
    paper: true,
    champions,
    benched: [...benched],
    judged: base.judged,
    weights,
    holdout,
    decisions,
    reviewedAt: new Date(now).toISOString(),
  };
}

export function gateProgress(rows, iters = 200) {
  const groups = new Map();
  for (const row of rows) {
    const key = row.window || dayKey(row.closeTime);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const windows = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, list]) => {
    const stats = windowStats(list, iters);
    return { key, seen: false, ...stats };
  });
  return { windows, graduated: graduates(windows) };
}

function usd(x) {
  if (x == null || !Number.isFinite(x)) return '—';
  const sign = x > 0 ? '+' : x < 0 ? '−' : '';
  return `${sign}$${Math.abs(x).toFixed(2)}`;
}

function priceWords(price) {
  if (price >= 0.95) return 'the ask is above 0.95';
  if (price >= 0.85) return 'the ask is from 0.85 to 0.95';
  if (price >= 0.6) return 'the ask is from 0.60 to 0.85';
  return 'the ask is below 0.60';
}

function timeWords(seconds) {
  if (seconds < 120) return 'under 2 minutes are left';
  if (seconds <= 300) return '2 to 5 minutes are left';
  if (seconds <= 600) return '5 to 10 minutes are left';
  return 'more than 10 minutes are left';
}

export function featureLessons(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (row.pnl == null || row.price == null || row.secondsLeft == null) continue;
    const key = `${row.family}|${priceWords(row.price)}|${timeWords(row.secondsLeft)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const lessons = [];
  for (const [key, list] of groups) {
    if (list.length < 8) continue;
    const [family, price, time] = key.split('|');
    const stats = windowStats(list, 120);
    if (!(stats.mean > 0) && !(stats.mean < 0)) continue;
    const verb = stats.mean < 0 ? 'loses' : 'makes money';
    const label = sampleLabel(stats.n, stats.lo, stats.hi);
    const wr = stats.n ? Math.round((100 * stats.wins) / stats.n) : 0;
    lessons.push({
      family,
      n: stats.n,
      mean: stats.mean,
      lo: stats.lo,
      hi: stats.hi,
      winRate: wr / 100,
      sample: label,
      text: `${FAMILY_LABEL[family] || family} ${verb} when ${price} and ${time}. n ${stats.n}, win rate ${wr}%, mean ${usd(stats.mean)} after fees, 90% interval ${usd(stats.lo)} to ${usd(stats.hi)}. Sample: ${label}. This describes paper trades. It does not change the rule.`,
    });
  }
  return lessons.sort((a, b) => a.mean - b.mean);
}

export function frozenLessons(prior) {
  return (prior?.rules || []).map((rule) => ({
    source: prior.id || 'frozen-study',
    text: `${rule.label} on the frozen study: n ${rule.n ?? 0}, mean ${usd(rule.mean)} after costs, 90% low ${usd(rule.lo)}. ${rule.graduated ? 'It cleared the gate.' : 'Not ready for real money.'}${rule.note ? ' ' + rule.note : ''}`,
  }));
}

export function botCards(rows, brain) {
  const state = brain || defaultBrain();
  const benched = new Set(state.benched || []);
  return VARIANTS.map((variant) => {
    const mine = rows.filter((r) => r.variant === variant.id && r.pnl != null);
    const stats = windowStats(mine, 80);
    const gate = gateProgress(mine, 80);
    const usable = gate.windows.filter((w) => w.n >= 20).length;
    const shadow = (state.shadow || []).includes(variant.id) || benched.has(variant.id);
    const repair = shadow ? repairPracticeGate(rows, variant.id, state.shadowSince?.[variant.id] || null) : null;
    return {
      id: variant.id,
      family: variant.family,
      label: variant.label,
      role: liveRole(variant, state, shadow),
      n: mine.length,
      wins: stats.wins,
      mean: stats.mean,
      lo: stats.lo,
      hi: stats.hi,
      sample: sampleLabel(mine.length, stats.lo, stats.hi),
      benched: benched.has(variant.id),
      shadow,
      status: shadow ? 'benched-shadow' : 'active',
      weight: shadow ? 0 : (state.weights?.[variant.id] ?? 1),
      level: 1 + Math.floor(mine.length / 10),
      gateWindows: usable,
      graduated: gate.graduated,
      repairN: repair ? repair.n : 0,
      repairNeed: repair ? repair.need : 0,
      repairMean: repair ? repair.mean : null,
      repairPass: repair ? repair.pass : false,
    };
  });
}

export function journalSummary(rows) {
  const stats = windowStats(rows, 160);
  const net = rows.reduce((sum, row) => sum + (row.pnl || 0), 0);
  const alloc = rows.filter((row) => row.allocated);
  const allocNet = alloc.reduce((sum, row) => sum + (row.pnl || 0), 0);
  const allocStats = windowStats(alloc, 160);
  const lines = [];
  if (!rows.length) return ['No settled journal trades yet.'];
  lines.push(`All settled lines: n ${stats.n}, win rate ${Math.round((100 * stats.wins) / stats.n)}%, net ${usd(net)} after fees, mean ${usd(stats.mean)}, 90% interval ${usd(stats.lo)} to ${usd(stats.hi)}.`);
  lines.push(`Allocated $2 picks: n ${alloc.length}, net ${usd(allocNet)}, mean ${usd(allocStats.mean)}, 90% interval ${usd(allocStats.lo)} to ${usd(allocStats.hi)}. ${sampleLabel(alloc.length, allocStats.lo, allocStats.hi)}. Shadows are logged and are not a second bet.`);
  for (const family of ['revert', 'late', 'mom', 'scalp', 'flip']) {
    const mine = rows.filter((row) => row.family === family);
    const s = windowStats(mine, 120);
    if (!s.n) continue;
    lines.push(`${FAMILY_LABEL[family]}: n ${s.n}, win rate ${Math.round((100 * s.wins) / s.n)}%, mean ${usd(s.mean)}, 90% interval ${usd(s.lo)} to ${usd(s.hi)}. ${sampleLabel(s.n, s.lo, s.hi)}.`);
  }
  const mom = windowStats(rows.filter((row) => row.family === 'mom'), 120);
  const momWords = mom.lo > 0 ? 'Momentum’s interval is above zero.' : 'Momentum’s point estimate is positive, and its 90% interval still includes zero, so that gain is not clear.';
  lines.push(`The clear loss is mean revert buying an ask under 0.60 with 5 to 10 minutes left. That is the whole revert book on this day: win rate about 22%. A new challenger skips asks under 0.40. It was added after seeing 2026-11-19, so that day cannot promote it. ${momWords} Late favorites in the 2 to 5 minute window are a small gain; the 5 to 10 minute bucket lost and the sample is thinner. Buckets under 20 trades are noise.`);
  lines.push('No champion was replaced. The only day so far is still unfinished as a holdout. The edge gate was not touched. Live execution stays off.');
  return lines;
}

export function filterLessons(rows) {
  const skipped = (rows || []).filter((row) => row.skipped && row.pnl != null);
  if (skipped.length < 8) return [];
  const stats = windowStats(skipped, 80);
  const net = skipped.reduce((sum, row) => sum + row.pnl, 0);
  const label = sampleLabel(stats.n, stats.lo, stats.hi);
  return [{
    n: skipped.length,
    mean: stats.mean,
    saved: net < 0,
    text: `Skipped signals: n ${skipped.length}, mean ${usd(stats.mean)} after fees, 90% interval ${usd(stats.lo)} to ${usd(stats.hi)}. Taking them would have ${net < 0 ? 'lost' : 'made'} ${usd(Math.abs(net))}, so the filters ${net < 0 ? 'saved' : 'cost'} that amount. Sample: ${label}.`,
  }];
}

export function morningReport(rows, brain, summary, now) {
  const day = [...new Set((rows || []).map((row) => row.window).filter(Boolean))].sort().pop() || dayKey(now);
  const dayRows = (rows || []).filter((row) => row.window === day && row.pnl != null);
  const net = dayRows.reduce((sum, row) => sum + row.pnl, 0);
  const by = new Map();
  for (const row of dayRows) {
    const cur = by.get(row.variant) || { n: 0, pnl: 0 };
    cur.n += 1;
    cur.pnl += row.pnl;
    by.set(row.variant, cur);
  }
  const ranked = [...by.entries()].map(([id, v]) => ({ id, ...v, mean: v.n ? v.pnl / v.n : 0 })).sort((a, b) => b.mean - a.mean);
  return {
    paper: true,
    day,
    generatedAt: new Date(now).toISOString(),
    trades: dayRows.length,
    net,
    best: ranked[0] || null,
    worst: ranked.length ? ranked[ranked.length - 1] : null,
    lessons: (summary || []).slice(0, 3),
    changed: (brain?.decisions || []).slice(0, 6),
    shadow: brain?.shadow || [],
  };
}

export function lessonsDocument(rows, prior, brain, now) {
  const lessons = featureLessons(rows);
  const filters = filterLessons(rows);
  const frozen = frozenLessons(prior);
  const bots = botCards(rows, brain);
  return {
    generatedAt: new Date(now).toISOString(),
    paper: true,
    note: 'Paper only, after fees. Lessons do not move the edge gate, raise size, or turn on live execution.',
    summary: journalSummary(rows),
    lessons,
    filters,
    frozen,
    bots,
    decisions: brain?.decisions || [],
    holdout: brain?.holdout || null,
    experimentSince: brain?.experimentSince || null,
  };
}

export function lessonsMarkdown(doc) {
  const lines = ['# Paper lessons', '', doc.note, ''];
  lines.push('## Plain English', '');
  for (const line of doc.summary || []) lines.push(line, '');
  lines.push('## Filters', '');
  if (!(doc.filters || []).length) lines.push('No skipped-signal bucket has 8 settled counterfactuals yet.', '');
  for (const lesson of doc.filters || []) lines.push(`- ${lesson.text}`, '');
  lines.push('## This week from the journal', '');
  if (!doc.lessons.length) lines.push('No feature bucket has 8 settled paper trades yet. Nothing was retuned.', '');
  for (const lesson of doc.lessons) lines.push(`- ${lesson.text}`, '');
  lines.push('## Frozen studies', '');
  for (const lesson of doc.frozen) lines.push(`- ${lesson.text}`, '');
  lines.push('## Champion check', '');
  for (const line of doc.decisions) lines.push(`- ${line}`, '');
  lines.push('Live execution stays off.');
  return lines.join('\n');
}
