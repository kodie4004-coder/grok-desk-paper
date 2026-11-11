// Holdout for the four pre-declared slots. Does not retune thresholds.
// Protocol: EVAL_PROTOCOL.md "v2 slots" and engine/strategies.js.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { PROTOCOL, simulateTrades, runAccount, maxDrawdown, clusterBootstrap } from '../engine/eval.js';
import { PLANNERS, SLOT_IDS, SLOT_SPEC, slotEdge } from '../engine/strategies.js';
import { roundTripImpactPct } from '../engine/core.js';

const file = process.argv[2] || 'runner/research/ohlcv-v2.json.gz';
const raw = fs.readFileSync(file);
const data = JSON.parse((file.endsWith('.gz') ? zlib.gunzipSync(raw) : raw).toString('utf8'));
const pools = (data.pools || []).filter((p) => p.bars && p.bars.length >= 2);
const tMax = Math.max(...pools.map((p) => p.bars.at(-1).t));
const holdoutStart = tMax - PROTOCOL.holdoutMs;
const sizeUsd = 25;
const account = { bank: PROTOCOL.bank, maxOpen: PROTOCOL.maxOpen };
const poolsById = new Map(pools.map((p) => [p.pool, p.bars]));

function runOne(id, from, to) {
  const all = [];
  for (const p of [...pools].sort((a, b) => String(a.pool).localeCompare(String(b.pool)))) {
    const feePct = 1 + roundTripImpactPct(sizeUsd, p.liq || 0);
    const cfg = {
      ...PROTOCOL, feePct, sizeUsd, fill: 'conservative', tradeFrom: from, tradeTo: to,
      stopPct: SLOT_SPEC[id].stopPct, takeProfitPct: SLOT_SPEC[id].takeProfitPct, maxHoldMin: SLOT_SPEC[id].maxHoldMin,
    };
    for (const tr of simulateTrades(p.bars, PLANNERS[id], cfg)) all.push({ ...tr, pool: p.pool, symbol: p.symbol, chain: p.chain || 'solana', feePct });
  }
  const acct = runAccount(all, account);
  const dd = maxDrawdown(poolsById, acct.taken, account.bank);
  const boot = clusterBootstrap(acct.taken, { iters: 2000, seed: 7 });
  const wins = acct.taken.filter((t) => t.pnl > 0);
  const fees = acct.taken.reduce((a, t) => a + t.fees, 0);
  const net = acct.taken.reduce((a, t) => a + t.pnl, 0);
  return {
    n: acct.taken.length,
    nPools: new Set(acct.taken.map((t) => t.pool)).size,
    net: Math.round(net * 100) / 100,
    mean: acct.taken.length ? net / acct.taken.length : 0,
    lo: boot.lo, hi: boot.hi,
    winRate: acct.taken.length ? wins.length / acct.taken.length : 0,
    maxDrawdown: Math.round(dd.maxDrawdown * 100) / 100,
    fees: Math.round(fees * 100) / 100,
    costDrag: net + fees > 0 ? fees / (net + fees) : null,
  };
}

const splits = {};
for (const id of SLOT_IDS) {
  splits[id] = { train: runOne(id, null, holdoutStart), holdout: runOne(id, holdoutStart, null) };
}
const edges = {};
for (const id of SLOT_IDS) edges[id] = slotEdge(splits[id].holdout, splits[id].train);
const any = Object.values(edges).some(Boolean);
const prior = {
  id: 'ohlcv-walkforward-v2',
  collectedAt: data.collectedAt || null,
  summary: any
    ? 'A pre-declared slot cleared both the train and the holdout. That slot uses normal paper size. The others stay in exploration.'
    : 'No pre-declared slot cleared both windows after costs. Every slot stays in the exploration bucket at 1% of the bank until its own trades say otherwise.',
  edges,
  rows: SLOT_IDS.map((id) => ({ id, ...splits[id].holdout, trainMean: splits[id].train.mean, trainN: splits[id].train.n, edge: edges[id] })),
};
const lines = [];
lines.push('# Slot holdout');
lines.push('');
lines.push(`Collected ${prior.collectedAt || 'unknown'}. ${pools.length} pools, holdout starts ${new Date(holdoutStart).toISOString()}. Cost is 1% round trip plus the liquidity impact on a $25 paper trade. Stops fill at the bar low. Thresholds were not changed after this run.`);
lines.push('');
lines.push('| Slot | Holdout n | Pools | Net | Expectancy | 90% interval | Win rate | Drawdown | Train mean | Edge |');
lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---|');
for (const id of SLOT_IDS) {
  const h = splits[id].holdout;
  const money = (x) => x == null ? '—' : `${x < 0 ? '-' : ''}$${Math.abs(x).toFixed(2)}`;
  lines.push(`| ${id} | ${h.n} | ${h.nPools} | ${money(h.net)} | ${money(h.mean)} | ${money(h.lo)} .. ${money(h.hi)} | ${(h.winRate * 100).toFixed(1)}% | ${money(h.maxDrawdown)} | ${money(splits[id].train.mean)} | ${edges[id] ? 'yes' : 'no'} |`);
}
lines.push('');
lines.push(prior.summary);
lines.push('');
for (const id of SLOT_IDS) {
  const h = splits[id].holdout;
  if (!edges[id] && h.lo > 0) lines.push(`${id}: the holdout lower bound was above zero (${h.lo.toFixed(2)} per trade) and the train mean was ${splits[id].train.mean.toFixed(2)}. The rule needs both windows, so this slot stays at exploration size.`);
}
lines.push('');
lines.push('A slot is an edge only when the holdout has at least 30 trades, at least 8 pools, and a 90% lower bound above zero, and the train also has at least 20 trades, a positive mean, and a lower bound above zero. Otherwise it is exploration size.');
lines.push('');
fs.mkdirSync('runner/research', { recursive: true });
fs.writeFileSync('runner/research/slots-report.json', JSON.stringify({ prior, splits }, null, 2));
fs.writeFileSync('SLOTS_REPORT.md', lines.join('\n'));
const src = `// Generated by runner/study-slots.mjs. Do not hand-edit the verdict.\nexport const SLOT_PRIOR = ${JSON.stringify(prior, null, 2)};\n`;
fs.writeFileSync('engine/slot-prior.js', src);
console.log(JSON.stringify({ edges, rows: prior.rows }, null, 2));
