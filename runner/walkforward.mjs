// Run the frozen walk-forward study and write EVAL_REPORT.md plus engine/prior.js.
// Does not retune thresholds. See EVAL_PROTOCOL.md.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { PROTOCOL, buyAndHold, runStudy, renderReport, priorModuleSource } from '../engine/eval.js';

const file = process.argv[2] || 'runner/research/ohlcv.json.gz';
const raw = fs.readFileSync(file);
const data = JSON.parse((file.endsWith('.gz') ? zlib.gunzipSync(raw) : raw).toString('utf8'));
const result = runStudy(data.pools);
result.collectedAt = data.collectedAt || null;
const held = buyAndHold(data.pools, PROTOCOL, result.holdoutStart, null).sort((a, b) => b.pnl - a.pnl);
const bhNet = held.reduce((a, t) => a + t.pnl, 0);
result.bhTop = held.slice(0, 5).map((t) => ({
  symbol: t.symbol, pnl: Math.round(t.pnl * 100) / 100,
  retPct: Math.round(t.retPct * 10) / 10, share: bhNet ? t.pnl / bhNet : 0,
}));
fs.mkdirSync('runner/research', { recursive: true });
fs.writeFileSync('runner/research/eval-report.json', JSON.stringify(result));
fs.writeFileSync('EVAL_REPORT.md', renderReport(result, data));
fs.writeFileSync('engine/prior.js', priorModuleSource(result));
const h = result.primary.holdout;
console.log(JSON.stringify({
  studyVerdict: result.studyVerdict,
  verdict: result.verdict,
  volGateAdopted: result.volGateAdopted,
  pools: result.pools,
  holdout: Object.fromEntries(Object.entries(h).map(([k, v]) => [k, { n: v.summary.n, net: Math.round(v.summary.net * 100) / 100, mean: v.summary.mean, lo: v.summary.lo, hi: v.summary.hi }])),
}, null, 2));
