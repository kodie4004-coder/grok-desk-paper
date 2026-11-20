// Prints the repair diagnosis from the stored journals. Numbers come from the files.
import fs from 'node:fs';
import { diagnoseMeme, tradeWindow } from '../engine/repair.js';
import { memePnl } from '../engine/meme.js';

const read = (path) => fs.readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
const meme = read('data/meme-journal.jsonl');
const journal = read('data/journal.jsonl');
const report = diagnoseMeme(meme);
const flat = memePnl(1, 1);

const money = (n) => {
  if (n == null || !Number.isFinite(n)) return '—';
  const sign = n > 0 ? '+' : n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toFixed(2)}`;
};
const line = (label, row) => `| ${label} | ${row.n} | ${row.wins} | ${row.losses} | ${row.n ? Math.round(row.winRate * 100) + '%' : '—'} | ${money(row.pnl)} | ${money(row.fees)} | ${money(row.mean)} |`;

console.log('# Repair diagnosis');
console.log('');
console.log(report.note);
console.log(`A flat $2 meme round trip is ${money(flat.pnl)} before the price moves. That is the fee plus slippage.`);
console.log(`The incident window is the latest 34 settled meme trades with 7 wins. Exact match: ${report.exactIncident}.`);
console.log('');
console.log('## Meme trades');
console.log('');
console.log('| Slice | Trades | Wins | Losses | Win rate | Net after fees | Fees | Mean |');
console.log('|---|---:|---:|---:|---:|---:|---:|---:|');
console.log(line('Train, before the window', report.train));
console.log(line('Incident window', report.incident));
console.log(line('Later trades, not used to choose the rule', report.later));
console.log(line('Train after the 60-minute stop cooldown', report.after.train));
console.log(line('Incident window after that cooldown', report.after.holdout));
console.log(line('Later trades after that cooldown', report.after.later));
console.log('');
console.log('## Incident exits');
console.log('');
console.log('| Exit | Trades | Wins | Net after fees | Fees | Median hold (min) | Median move |');
console.log('|---|---:|---:|---:|---:|---:|---:|');
for (const [name, bucket] of Object.entries(report.incident.exits)) {
  const hold = bucket.medianHoldMin == null ? '—' : bucket.medianHoldMin.toFixed(1);
  const move = bucket.medianMovePct == null ? '—' : `${bucket.medianMovePct.toFixed(1)}%`;
  console.log(`| ${name} | ${bucket.n} | ${bucket.wins} | ${money(bucket.pnl)} | ${money(bucket.fees)} | ${hold} | ${move} |`);
}
console.log('');
console.log(`Stop fills: ${report.incident.stops.map((row) => `${row.symbol} ${row.movePct.toFixed(1)}% in ${row.holdMin.toFixed(0)}m (${money(row.pnl)})`).join('; ') || 'none'}.`);
console.log(`Re-entries within 60 minutes of a stop: ${report.incident.chase.n}, net ${money(report.incident.chase.pnl)}.`);
console.log(`Up before fees and down after: ${report.incident.feeKilled.n}, net ${money(report.incident.feeKilled.pnl)}.`);
console.log('');
console.log('## What changed, measured on the split');
console.log('');
console.log('The stop stays at -15% and the take-profit stays at +25%. A predeclared +9.2% target, twice the fee breakeven, made the train mean worse on a conservative replay, so it was not adopted. Skipping a re-entry inside an hour of a stop moved the train mean from the unfiltered train row to the cooldown row below, which is not an improvement, so that filter was not adopted. The sleeve is benched once 20 trades have a non-positive mean. New paper lines are shadow $2 until 20 of those average above zero.');
console.log('');
console.log(`Train bench fired: ${report.bench.benched}, n ${report.bench.n}, mean ${money(report.bench.mean)}.`);
console.log(`Shadow gate on rows already marked shadow: n ${report.repair.n}, pass ${report.repair.pass}, size $${report.repair.sizeUsd}.`);
console.log('');
console.log('## Findings');
console.log('');
for (const finding of report.findings) console.log(`- ${finding}`);
console.log('');
console.log('## Kalshi allocated sleeves');
console.log('');
const alloc = journal.filter((row) => row.allocated && row.pnl != null);
const by = new Map();
for (const row of alloc) {
  const key = row.variant || 'unknown';
  const cur = by.get(key) || [];
  cur.push(row);
  by.set(key, cur);
}
console.log('| Sleeve | Trades | Wins | Net after fees | Fees | Mean |');
console.log('|---|---:|---:|---:|---:|---:|');
for (const [name, rows] of [...by.entries()].sort((a, b) => a[1].reduce((s, r) => s + r.pnl, 0) - b[1].reduce((s, r) => s + r.pnl, 0))) {
  const stats = tradeWindow(rows);
  console.log(`| ${name} | ${stats.n} | ${stats.wins} | ${money(stats.pnl)} | ${money(stats.fees)} | ${money(stats.mean)} |`);
}
const all = tradeWindow(journal.filter((row) => row.pnl != null));
console.log('');
console.log(`All settled Kalshi lines: n ${all.n}, net ${money(all.pnl)} after fees. That running total is a different book from the meme window above.`);
