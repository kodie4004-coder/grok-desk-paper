// Paper learning loop. Variants below were written down before any journal
// settlement. A challenger may replace a champion only on a burned holdout.
// The v6 edge gate is not modified here. Size stays $2. Nothing here is real money.

import { kalshiTakerFee, coinFlipSide } from './kalshi.js';
import { clusterBootstrap } from './eval.js';
import { graduates } from './strategies.js';

export const LEARN_SIZE = 2;
export const HOLD_MIN = 20;
export const LEARN_DAY_LOSS = 20;

export const VARIANTS = [
  { id: 'late', family: 'late', label: 'Late favorite', role: 'champion', minAsk: 0.85, minLeft: 180, maxLeft: 300 },
  { id: 'late-loose', family: 'late', label: 'Late favorite, looser ask', role: 'challenger', minAsk: 0.80, minLeft: 180, maxLeft: 300 },
  { id: 'late-tight', family: 'late', label: 'Late favorite, tighter ask', role: 'challenger', minAsk: 0.90, minLeft: 180, maxLeft: 360 },
  { id: 'late-early', family: 'late', label: 'Late favorite, earlier', role: 'challenger', minAsk: 0.85, minLeft: 300, maxLeft: 480 },
  { id: 'mom', family: 'mom', label: 'Momentum vs target', role: 'champion', kind: 'mom', minLeft: 120, maxLeft: 600, minMove: 0 },
  { id: 'mom-strict', family: 'mom', label: 'Momentum, 0.05% past the strike', role: 'challenger', kind: 'mom', minLeft: 120, maxLeft: 600, minMove: 0.0005 },
  { id: 'revert', family: 'revert', label: 'Mean revert', role: 'champion', kind: 'revert', minLeft: 360, maxLeft: 720, cheap: [0.15, 0.40], rich: [0.60, 0.85] },
  { id: 'revert-wide', family: 'revert', label: 'Mean revert, wider band', role: 'challenger', kind: 'revert', minLeft: 360, maxLeft: 720, cheap: [0.10, 0.45], rich: [0.55, 0.90] },
  { id: 'scalp', family: 'scalp', label: 'Intra-window scalp', role: 'champion', kind: 'scalp', minJump: 0.04, maxSpread: 0.03, minLeft: 120 },
  { id: 'scalp-tight', family: 'scalp', label: 'Scalp, larger jump', role: 'challenger', kind: 'scalp', minJump: 0.06, maxSpread: 0.02, minLeft: 120 },
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
  if (!picked) return null;
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
  const benched = new Set(state.benched || []);
  const weights = { ...defaultBrain().weights, ...(state.weights || {}) };
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
  const today = dayKey(now);
  const booked = [...(settledRows || []), ...settled].filter((row) => row.allocated && dayKey(row.settledAt || row.window) === today).reduce((sum, row) => sum + (row.pnl || 0), 0);
  const paused = booked <= -LEARN_DAY_LOSS;
  const nextQuotes = {};
  for (const market of markets || []) {
    const prev = quotes[market.ticker] || null;
    const yes = Number(market.yesAsk);
    if (Number.isFinite(yes)) {
      nextQuotes[market.ticker] = { yesAsk: yes, yesBid: Number(market.yesBid), samples: [...(prev?.samples || []), yes].slice(-5) };
    }
    if (paused || market.result === 'yes' || market.result === 'no') continue;
    const firing = [];
    for (const variant of VARIANTS) {
      if (benched.has(variant.id)) continue;
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
      for (const row of rows) {
        const id = `${row.variant.id}:${market.ticker}`;
        if (known.has(id) || still.some((e) => e.id === id)) continue;
        const opened = openRow(row.variant, market, row.sig, now, chosen === row.variant.id);
        if (!opened) continue;
        still.push(opened);
      }
    }
  }
  return { settled, open: still, quotes: nextQuotes };
}

function windowStats(rows, iters = 300) {
  if (!rows.length) return { n: 0, mean: null, lo: null };
  const boot = clusterBootstrap(rows.map((r) => ({ pnl: r.pnl, pool: r.series || r.ticker })), { iters, seed: 7, qLo: 0.05, qHi: 0.95 });
  return { n: rows.length, mean: boot.mean, lo: boot.lo };
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
    const mean = list.reduce((a, r) => a + r.pnl, 0) / list.length;
    if (!(mean > 0) && !(mean < 0)) continue;
    const verb = mean < 0 ? 'loses' : 'makes money';
    lessons.push({
      family,
      n: list.length,
      mean,
      text: `${FAMILY_LABEL[family] || family} ${verb} when ${price} and ${time}. n ${list.length}, mean ${usd(mean)} after fees. This describes paper trades. It does not change the rule.`,
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
    return {
      id: variant.id,
      family: variant.family,
      label: variant.label,
      role: variant.role === 'control' ? 'control' : state.champions?.[variant.family] === variant.id ? 'champion' : variant.role,
      n: mine.length,
      mean: stats.mean,
      lo: stats.lo,
      benched: benched.has(variant.id),
      weight: state.weights?.[variant.id] ?? 1,
      level: 1 + Math.floor(mine.length / 10),
      gateWindows: usable,
      graduated: gate.graduated,
    };
  });
}

export function lessonsDocument(rows, prior, brain, now) {
  const lessons = featureLessons(rows);
  const frozen = frozenLessons(prior);
  const bots = botCards(rows, brain);
  return {
    generatedAt: new Date(now).toISOString(),
    paper: true,
    note: 'Paper only, after fees. Lessons do not move the edge gate, raise size, or turn on live execution.',
    lessons,
    frozen,
    bots,
    decisions: brain?.decisions || [],
    holdout: brain?.holdout || null,
  };
}

export function lessonsMarkdown(doc) {
  const lines = ['# Paper lessons', '', doc.note, ''];
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
