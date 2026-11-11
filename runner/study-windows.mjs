// Walk-forward across 8-hour blocks. Rules are frozen in EVAL_PROTOCOL.md section v3.
// The v2 holdout interval is seen and cannot graduate a slot.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { PROTOCOL, simulateTrades, clusterBootstrap } from '../engine/eval.js';
import { PLANNERS, momentumTightPlan, momentumTrailPlan, graduates } from '../engine/strategies.js';
import { roundTripImpactPct } from '../engine/core.js';

const file = process.argv[2] || 'runner/research/ohlcv-windows.json.gz';
const SEEN_START = Date.parse('2026-11-11T07:28:00.000Z');
const SEEN_END = Date.parse('2026-11-11T15:23:00.853Z');
const EIGHT = 8 * 3600 * 1000;
const raw = fs.readFileSync(file);
const data = JSON.parse((file.endsWith('.gz') ? zlib.gunzipSync(raw) : raw).toString('utf8'));
const pools = (data.pools || []).filter((p) => p.bars && p.bars.length > 120);
const tMax = Math.max(...pools.map((p) => p.bars.at(-1).t));
const tMin = Math.min(...pools.map((p) => p.bars[0].t));
const blocks = [];
for (let end = tMax; end - EIGHT >= tMin; end -= EIGHT) {
  const start = end - EIGHT;
  blocks.push({ start, end, seen: start < SEEN_END && end > SEEN_START });
}
blocks.reverse();

const candidates = [
  { id: 'v0-meanrev', slot: 'meanrev', plan: PLANNERS.meanrev },
  { id: 'v0-breakout', slot: 'breakout', plan: PLANNERS.breakout },
  { id: 'v0-momentum', slot: 'momentum', plan: PLANNERS.momentum },
  { id: 'v0-grid', slot: 'grid', plan: PLANNERS.grid },
  { id: 'v1-liq100', slot: 'momentum', plan: PLANNERS.momentum, poolOk: (p) => (p.liq || 0) >= 100000 },
  { id: 'v2-age6h', slot: 'momentum', plan: (bars, i, pool) => (!pool.createdAt || bars[i].t - pool.createdAt < 6 * 3600000 ? false : PLANNERS.momentum(bars, i)) },
  { id: 'v3-tight', slot: 'momentum', plan: momentumTightPlan },
  { id: 'v4-trail', slot: 'momentum', plan: momentumTrailPlan },
];

function tradesFor(candidate, start, end) {
  const all = [];
  for (const p of [...pools].sort((a, b) => String(a.pool).localeCompare(String(b.pool)))) {
    if (candidate.poolOk && !candidate.poolOk(p)) continue;
    const feePct = 1 + roundTripImpactPct(25, p.liq || 0);
    const cfg = { ...PROTOCOL, feePct, sizeUsd: 25, fill: 'conservative', tradeFrom: start, tradeTo: end };
    const signal = (bars, i) => candidate.plan(bars, i, p);
    for (const tr of simulateTrades(p.bars, signal, cfg)) {
      all.push({
        ...tr, pool: p.pool, chain: p.chain || '?', liq: p.liq || 0,
        ageH: p.createdAt ? (tr.entryT - p.createdAt) / 3600000 : null,
        hour: new Date(tr.entryT).getUTCHours(),
      });
    }
  }
  return all;
}

function summarize(trades) {
  const boot = clusterBootstrap(trades, { iters: 2000, seed: 7 });
  const net = trades.reduce((a, t) => a + t.pnl, 0);
  return {
    n: trades.length,
    nPools: new Set(trades.map((t) => t.pool)).size,
    mean: trades.length ? net / trades.length : 0,
    lo: boot.lo, hi: boot.hi, net,
  };
}

const results = {};
for (const c of candidates) {
  results[c.id] = blocks.map((b) => ({ ...b, ...summarize(tradesFor(c, b.start, b.end)) }));
}

function bucketMomentum(trades) {
  const put = (map, key, t) => { if (!map[key]) map[key] = []; map[key].push(t); };
  const chain = {}, liq = {}, age = {}, clock = {};
  for (const t of trades) {
    put(chain, t.chain, t);
    put(liq, t.liq >= 500000 ? '500k+' : t.liq >= 100000 ? '100-500k' : '<100k', t);
    put(age, t.ageH == null ? 'unknown' : t.ageH < 6 ? '<6h' : '>=6h', t);
    put(clock, t.hour >= 13 && t.hour < 21 ? '13-21 UTC' : 'other hours', t);
  }
  const brief = (map) => Object.entries(map).map(([k, rows]) => {
    const s = summarize(rows);
    return `${k}: n ${s.n} mean ${s.mean.toFixed(2)} lo ${s.lo == null ? '—' : s.lo.toFixed(2)}`;
  });
  return { chain: brief(chain), liq: brief(liq), age: brief(age), clock: brief(clock) };
}

const diagTrades = [];
for (const b of blocks) diagTrades.push(...tradesFor(candidates[2], b.start, b.end));
const diag = bucketMomentum(diagTrades);

const order = ['v1-liq100', 'v2-age6h', 'v3-tight', 'v4-trail'];
let graduated = null;
for (const id of order) if (graduates(results[id])) { graduated = id; break; }
const edges = { meanrev: false, breakout: false, momentum: false, grid: false };
if (graduates(results['v0-meanrev'])) edges.meanrev = true;
if (graduates(results['v0-breakout'])) edges.breakout = true;
if (graduates(results['v0-grid'])) edges.grid = true;
if (graduated || graduates(results['v0-momentum'])) edges.momentum = true;
const graduatedCode = { 'v1-liq100': 'liq100', 'v2-age6h': 'age6h', 'v3-tight': 'tight', 'v4-trail': 'trail' }[graduated] || null;

const money = (x) => (x == null || Number.isNaN(x) ? '—' : `${x < 0 ? '-' : ''}$${Math.abs(Number(x)).toFixed(2)}`);
const lines = [];
lines.push('# Walk-forward windows');
lines.push('');
lines.push(`Pools ${pools.length}. Bars from ${new Date(tMin).toISOString()} to ${new Date(tMax).toISOString()}. Seen interval ${new Date(SEEN_START).toISOString()} to ${new Date(SEEN_END).toISOString()} cannot graduate anyone.`);
lines.push('');
lines.push(`Graduated: **${graduated || 'none'}**. Live momentum filter: **${graduatedCode || 'unchanged'}**.`);
lines.push('');
for (const c of candidates) {
  lines.push(`## ${c.id}`);
  lines.push('');
  lines.push('| Window | Seen | Trades | Pools | Mean | 90% low | 90% high |');
  lines.push('|---|---|---:|---:|---:|---:|---:|');
  results[c.id].forEach((w, i) => {
    lines.push(`| ${i} ${new Date(w.start).toISOString().slice(0, 13)} | ${w.seen ? 'seen' : 'unseen'} | ${w.n} | ${w.nPools} | ${money(w.mean)} | ${money(w.lo)} | ${money(w.hi)} |`);
  });
  lines.push('');
  lines.push(`Graduates: ${graduates(results[c.id]) ? 'yes' : 'no'}.`);
  lines.push('');
}
lines.push('## Momentum diagnostics (not used to pick a filter)');
lines.push('');
for (const [name, rows] of Object.entries(diag)) lines.push(`- ${name}: ${rows.join('; ')}`);
lines.push('');
fs.writeFileSync('WINDOWS_REPORT.md', lines.join('\n'));
const prior = {
  id: 'ohlcv-walkforward-v3',
  collectedAt: data.collectedAt || null,
  summary: graduated
    ? `${graduated} was positive with the lower bound above zero on every unseen window that had 20 trades. That filter uses normal paper size. The other slots stay at exploration size.`
    : 'No pre-registered candidate was positive on three or more unseen windows. Every slot stays at exploration size. The earlier single holdout where momentum looked good is treated as seen, not as proof.',
  edges,
  graduated: graduatedCode,
  rows: candidates.filter((c) => c.id.startsWith('v0-')).map((c) => {
    const unseen = results[c.id].filter((w) => !w.seen && w.n >= 20);
    const last = unseen.at(-1) || results[c.id].at(-1) || { n: 0, mean: 0, lo: null, hi: null };
    return { id: c.slot, n: last.n, mean: last.mean, lo: last.lo, hi: last.hi, edge: edges[c.slot] === true };
  }),
};
fs.writeFileSync('engine/slot-prior.js', `// Generated by runner/study-windows.mjs. Do not hand-edit the verdict.\nexport const SLOT_PRIOR = ${JSON.stringify(prior, null, 2)};\n`);
fs.writeFileSync('runner/research/windows-report.json', JSON.stringify({ blocks: blocks.length, graduated, edges, results }, null, 2));
console.log(JSON.stringify({ pools: pools.length, blocks: blocks.length, unseen: blocks.filter((b) => !b.seen).length, graduated, edges }, null, 2));
