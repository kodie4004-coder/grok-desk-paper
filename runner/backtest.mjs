// Offline backtest over the desk's recorded Kalshi boards. Paper only.
//   node runner/backtest.mjs --build-tape        rebuild data/backtest-tape.json from git history
//   node runner/backtest.mjs [--ids a,b] [--oos] [--json out.json]
//   node runner/backtest.mjs --bench             apply the focus bench rule to forward rows
//   node runner/backtest.mjs --focus             write data/focus.json
// Out-of-sample numbers print only with --oos. A backtest never graduates a
// strategy; only forward paper rows through graduates() can.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { VARIANTS } from '../engine/learn.js';
import { compactSnapshot, resultsFrom, normalizeTape, backtestVariant, OOS_FRACTION } from '../engine/backtest.js';
import { benchScan, focusDoc } from '../engine/focus.js';
import { BENCH_RULE } from '../engine/focus-plan.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const TAPE = opt('--tape') || 'data/backtest-tape.json';

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function buildTape() {
  const shas = execFileSync('git', ['log', '--format=%H', '--', 'data/kalshi-15m.json'], { encoding: 'utf8', maxBuffer: 1 << 26 }).trim().split('\n').filter(Boolean);
  const snapshots = [];
  const results = {};
  for (const sha of shas) {
    let doc;
    try { doc = JSON.parse(execFileSync('git', ['show', `${sha}:data/kalshi-15m.json`], { encoding: 'utf8', maxBuffer: 1 << 26 })); } catch { continue; }
    const snap = compactSnapshot(doc);
    if (snap) snapshots.push(snap);
    resultsFrom(doc, results);
  }
  for (const row of readJsonl('data/journal.jsonl')) {
    if (row.ticker && (row.result === 'yes' || row.result === 'no') && !results[row.ticker]) results[row.ticker] = row.result;
  }
  const tape = normalizeTape({ source: 'git history of data/kalshi-15m.json', commits: shas.length, snapshots, results });
  tape.builtAt = new Date().toISOString();
  tape.paper = true;
  fs.writeFileSync(TAPE, JSON.stringify(tape));
  console.log(`tape: ${tape.snapshots.length} boards from ${shas.length} commits, ${Object.keys(results).length} results, ${tape.snapshots[0]?.t} to ${tape.snapshots.at(-1)?.t}`);
}

if (flag('--build-tape')) {
  buildTape();
  process.exit(0);
}

const recorded = readJsonl('data/journal.jsonl');
const memeRows = readJsonl('data/meme-journal.jsonl');
const usd3 = (x) => (x == null ? '—' : `${x < 0 ? '−' : x > 0 ? '+' : ''}$${Math.abs(x).toFixed(3)}`);

if (flag('--bench')) {
  console.log(`Bench rule: n ≥ ${BENCH_RULE.minN} and the 90% cluster-bootstrap high of the after-fee mean < 0. Forward paper rows only.`);
  for (const row of benchScan(recorded, memeRows)) {
    console.log(`${row.meets ? 'BENCH' : row.control ? 'ctrl ' : 'keep '} ${row.book.padEnd(6)} ${row.id.padEnd(20)} n ${String(row.n).padStart(4)} mean ${usd3(row.mean)} 90% ${usd3(row.lo)} to ${usd3(row.hi)}`);
  }
  process.exit(0);
}

if (flag('--focus')) {
  const backtest = fs.existsSync('data/backtest.json') ? JSON.parse(fs.readFileSync('data/backtest.json', 'utf8')) : null;
  const brain = fs.existsSync('data/brain.json') ? JSON.parse(fs.readFileSync('data/brain.json', 'utf8')) : null;
  fs.writeFileSync('data/focus.json', JSON.stringify(focusDoc({ rows: recorded, memeRows, backtest, brain, now: Date.now() }), null, 2));
  console.log('focus written');
  process.exit(0);
}

const tape = JSON.parse(fs.readFileSync(TAPE, 'utf8'));
const ids = opt('--ids') ? opt('--ids').split(',') : VARIANTS.map((v) => v.id);
const showOos = flag('--oos');
const reports = ids.map((id) => VARIANTS.find((v) => v.id === id)).filter(Boolean).map((v) => backtestVariant(v, tape, { showOos, recorded }));

const usd = (x) => (x == null ? '—' : `${x < 0 ? '−' : x > 0 ? '+' : ''}$${Math.abs(x).toFixed(3)}`);
const pct = (x) => (x == null ? '—' : `${(100 * x).toFixed(1)}%`);
const cell = (s) => (s.hidden ? `hidden (n ${s.n})` : `n ${s.n} · mean ${usd(s.mean)} · win ${pct(s.winRate)} vs BE ${pct(s.breakEven)} · 90% lo ${usd(s.lo)} hi ${usd(s.hi)}`);
console.log(`Backtest (paper, after fees). ${tape.snapshots.length} boards, ${tape.snapshots[0]?.t} to ${tape.snapshots.at(-1)?.t}. Out-of-sample = last ${OOS_FRACTION * 100}% of time, from ${reports[0]?.cut}.`);
for (const r of reports) {
  console.log(`${r.id} [${r.mode}]`);
  console.log(`  IS : ${cell(r.inSample)}`);
  console.log(`  OOS: ${cell(r.outSample)}`);
}
console.log('Backtests never graduate a strategy. Live execution stays off.');
if (opt('--json')) fs.writeFileSync(opt('--json'), JSON.stringify({ generatedAt: new Date().toISOString(), paper: true, oosShown: showOos, reports }, null, 2));
