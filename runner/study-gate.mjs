// One pass over the frozen v6 rules. No retune.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { runMicro, runVwap, runKalshiScalp, runMaker, blockOf } from '../engine/scalp.js';
import { stockPnl } from '../engine/filings.js';
import { graduates } from '../engine/strategies.js';
import { clusterBootstrap } from '../engine/eval.js';

function windowsOf(trades, keyFn) {
  const map = new Map();
  for (const t of trades) {
    const key = keyFn(t);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(t);
  }
  return [...map.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]))).map(([key, rows]) => {
    const boot = clusterBootstrap(rows, { iters: 1500, seed: 7 });
    const mean = rows.reduce((a, t) => a + t.pnl, 0) / rows.length;
    return { key, seen: false, n: rows.length, mean, lo: boot.lo, hi: boot.hi };
  });
}

function pack(id, label, venue, windowLabel, trades, keyFn) {
  const windows = windowsOf(trades, keyFn);
  const pass = graduates(windows);
  const boot = clusterBootstrap(trades, { iters: 1500, seed: 7 });
  const mean = trades.length ? trades.reduce((a, t) => a + t.pnl, 0) / trades.length : null;
  return {
    id, label, venue, windowLabel, n: trades.length,
    windows: windows.length,
    usableWindows: windows.filter((w) => w.n >= 20).length,
    mean, lo: boot.lo, hi: boot.hi, graduated: pass,
    days: windows,
  };
}

const rules = [];
const lines = ['# v6 gate study', '', 'Costs were frozen in EVAL_PROTOCOL.md before this run. A rule that does not clear three windows stays off the real-money list. Live execution is still disabled.', ''];

const scalp = JSON.parse(zlib.gunzipSync(fs.readFileSync('runner/research/scalp-bars.json.gz')));
for (const spec of [
  ['s1', 'Crypto micro-momentum', runMicro],
  ['s2', 'Crypto VWAP revert', runVwap],
]) {
  const trades = [];
  for (const product of scalp.products || []) {
    for (const tr of spec[2](product.bars, 2)) trades.push({ ...tr, pool: product.product });
  }
  rules.push(pack(spec[0], spec[1], 'Coinbase spot', '12-hour block', trades, (t) => blockOf(t.t, 12)));
}

const kalshi = JSON.parse(zlib.gunzipSync(fs.readFileSync('runner/research/kalshi-scalp.json.gz')));
const s4 = [], s5 = [];
for (const market of kalshi.markets || []) {
  for (const tr of runKalshiScalp(market.candles, market.close, 2)) s4.push({ ...tr, pool: market.series });
  for (const tr of runMaker(market.candles, market.close, 2)) s5.push({ ...tr, pool: market.series });
}
rules.push(pack('s4', 'Kalshi intra-window scalp', 'Kalshi', 'UTC day', s4, (t) => new Date(t.t).toISOString().slice(0, 10)));
rules.push(pack('s5', 'Maker quote', 'Kalshi', 'UTC day', s5, (t) => new Date(t.t).toISOString().slice(0, 10)));
rules.push({ id: 's3', label: 'Book imbalance', venue: 'Coinbase L2', windowLabel: 'none', n: 0, windows: 0, usableWindows: 0, mean: null, lo: null, hi: null, graduated: false, note: 'No historical book, so this rule cannot graduate.' });

const filings = JSON.parse(fs.readFileSync('runner/research/filings.json', 'utf8'));
const fTrades = [];
const benches = { SPY: [], QQQ: [] };
for (const filing of filings.filings || []) {
  for (const name of filing.names || []) {
    const deal = stockPnl(name.entry, name.exit, 100);
    if (!deal) continue;
    fTrades.push({ t: Date.parse(filing.filing), pnl: deal.pnl, fees: deal.fees, pool: name.ticker, filing: filing.filing });
  }
  for (const symbol of ['SPY', 'QQQ']) {
    const deal = stockPnl(filing[symbol]?.entry, filing[symbol]?.exit, 100);
    if (deal) benches[symbol].push({ filing: filing.filing, pnl: deal.pnl });
  }
}
const fWindows = [];
for (const filing of [...new Set(fTrades.map((t) => t.filing))]) {
  const rows = fTrades.filter((t) => t.filing === filing);
  const boot = clusterBootstrap(rows, { iters: 1500, seed: 7 });
  const mean = rows.reduce((a, t) => a + t.pnl, 0) / rows.length;
  fWindows.push({ seen: false, n: rows.length, mean, lo: boot.lo, hi: boot.hi, key: filing });
}
const fPass = graduates(fWindows);
const fBoot = clusterBootstrap(fTrades, { iters: 1500, seed: 7 });
rules.push({
  id: 'f1', label: 'Berkshire 13F copy', venue: 'EDGAR + Yahoo daily', windowLabel: 'one filing, not a day',
  n: fTrades.length, windows: fWindows.length, usableWindows: fWindows.filter((w) => w.n >= 20).length,
  mean: fTrades.length ? fTrades.reduce((a, t) => a + t.pnl, 0) / fTrades.length : null,
  lo: fBoot.lo, hi: fBoot.hi, graduated: fPass, days: fWindows,
  benchmark: benches,
});
rules.push({ id: 'f2', label: 'Congressional filings', venue: 'House / Senate', windowLabel: 'not tested', n: 0, windows: 0, usableWindows: 0, mean: null, lo: null, hi: null, graduated: false, note: (filings.unreachable || []).join(' ') });

lines.push('| Rule | Trades | Windows with 20+ | Mean after costs | 90% low | Gate |');
lines.push('|---|---:|---:|---:|---:|---|');
for (const r of rules) {
  lines.push(`| ${r.label} | ${r.n} | ${r.usableWindows} | ${r.mean == null ? '—' : '$' + r.mean.toFixed(2)} | ${r.lo == null ? '—' : '$' + r.lo.toFixed(2)} | ${r.graduated ? 'passed' : 'not ready'} |`);
}
lines.push('');
lines.push('F1 is compared with SPY and QQQ bought on the same filing dates. F2 was not tested. S3 has no historical book.');
lines.push('');
for (const symbol of ['SPY', 'QQQ']) {
  const rows = benches[symbol];
  const mean = rows.length ? rows.reduce((a, t) => a + t.pnl, 0) / rows.length : null;
  lines.push(`${symbol} buy-and-hold over the same filing dates, $100 paper: n ${rows.length}, mean ${mean == null ? '—' : '$' + mean.toFixed(2)}.`);
}
fs.writeFileSync('GATE_REPORT.md', lines.join('\n'));
const prior = {
  id: 'gate-v6',
  collectedAt: new Date().toISOString(),
  summary: rules.some((r) => r.graduated)
    ? 'At least one v6 rule cleared its windows. Live execution still stays off.'
    : 'No v6 rule cleared three windows after costs. None are ready for real money. Live execution stays off.',
  rules,
};
fs.writeFileSync('engine/gate-prior.js', `// Generated by runner/study-gate.mjs. Do not hand-edit the verdict.\nexport const GATE_PRIOR = ${JSON.stringify(prior, null, 2)};\n`);
console.log(JSON.stringify(rules.map((r) => ({ id: r.id, n: r.n, mean: r.mean, lo: r.lo, graduated: r.graduated })), null, 2));
