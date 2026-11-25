// Which pick-time features split coin-watch hits from misses. Read-only study:
// the champion log in data/coin-watch.json stores only price, score and
// liquidity, so the features are rebuilt from the `picks` array of each
// committed coin-watch.json (git history), joined on `${updatedAt}#${ca}`.
// Prints splits at fixed cut points with n, hits, after-cost mean and median.
// Usage: node runner/study-coin-watch.mjs [--before ISO]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const before = arg('--before');
const git = (...a) => execFileSync('git', a, { maxBuffer: 1 << 28 }).toString();
const feat = {};
for (const h of git('log', '--format=%h', '--', 'data/coin-watch.json').trim().split('\n').filter(Boolean)) {
  let d; try { d = JSON.parse(git('show', `${h}:data/coin-watch.json`)); } catch { continue; }
  (d.picks || []).forEach((p, i) => { const id = `${d.updatedAt}#${p.ca}`; if (!feat[id]) feat[id] = { ...p, rank: i + 1 }; });
}
const doc = JSON.parse(fs.readFileSync('data/coin-watch.json', 'utf8'));
const rows = (doc.log || []).filter((r) => feat[r.id] && (!before || r.pickedAt < before)).map((r) => ({ ...r, f: feat[r.id] }));
const turn = (f) => (f.volH1 > 0 && f.liq > 0 ? f.volH1 / f.liq : null);
const SPLITS = [
  ['1h move <= +30%', (f) => f.h1 != null && f.h1 <= 30], ['1h move > +30%', (f) => f.h1 != null && f.h1 > 30],
  ['1h move > +100%', (f) => f.h1 != null && f.h1 > 100],
  ['liquidity >= $29k', (f) => f.liq >= 29000], ['liquidity < $29k', (f) => f.liq != null && f.liq < 29000],
  ['age > 111m', (f) => f.ageMin > 111], ['age <= 111m', (f) => f.ageMin != null && f.ageMin <= 111],
  ['turnover <= 5.6x', (f) => turn(f) != null && turn(f) <= 5.6], ['turnover > 5.6x', (f) => turn(f) > 5.6],
  ['champion score <= 34', (f) => f.score <= 34], ['champion score > 34', (f) => f.score > 34],
];
const stat = (sel, h) => {
  const v = rows.filter((r) => sel(r.f)).map((r) => r.marks?.[h]?.net).filter((x) => typeof x === 'number').sort((a, b) => a - b);
  if (!v.length) return { n: 0 };
  const mean = v.reduce((s, x) => s + x, 0) / v.length;
  return { n: v.length, hits: v.filter((x) => x > 0).length, mean: Math.round(mean * 1000) / 1000, median: Math.round(v[Math.floor(v.length / 2)] * 1000) / 1000 };
};
const out = { picks: rows.length, joined: rows.length, of: (doc.log || []).length, splits: SPLITS.map(([name, sel]) => ({ name, m15: stat(sel, 'm15'), h1: stat(sel, 'h1'), h4: stat(sel, 'h4') })) };
console.log(JSON.stringify(out, null, 1));
