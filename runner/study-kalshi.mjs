// One pass over the frozen K1 rule. No retune.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { favoriteSide, settlePnl, coinFlipSide } from '../engine/kalshi.js';
import { graduates } from '../engine/strategies.js';
import { clusterBootstrap } from '../engine/eval.js';

const file = process.argv[2] || 'runner/research/kalshi-15m.json.gz';
const data = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
const markets = data.markets || [];

function dayKey(t) {
  return new Date(t).toISOString().slice(0, 10);
}

function tradeOf(side, ask, won, market) {
  const deal = settlePnl(ask, won);
  if (!deal) return null;
  return { pool: market.series, ticker: market.ticker, day: dayKey(market.close), pnl: deal.pnl, ask, won, fee: deal.fee };
}

const k1 = [];
const alwaysUp = [];
const flip = [];
for (const m of markets) {
  if (!(m.yesAsk > 0) || !(m.noAsk > 0)) continue;
  const up = tradeOf('yes', m.yesAsk, m.result === 'yes', m);
  if (up) alwaysUp.push(up);
  const side = coinFlipSide(m.ticker);
  const flipAsk = side === 'yes' ? m.yesAsk : m.noAsk;
  const flipped = tradeOf(side, flipAsk, m.result === side, m);
  if (flipped) flip.push(flipped);
  const fav = favoriteSide(m.yesAsk, m.noAsk);
  if (!fav) continue;
  const row = tradeOf(fav.side, fav.ask, m.result === fav.side, m);
  if (row) k1.push(row);
}

function byDay(rows) {
  const map = new Map();
  for (const t of rows) {
    if (!map.has(t.day)) map.set(t.day, []);
    map.get(t.day).push(t);
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, list]) => {
    const boot = clusterBootstrap(list, { iters: 2000, seed: 7 });
    const mean = list.reduce((a, t) => a + t.pnl, 0) / list.length;
    return { day, seen: false, n: list.length, mean, lo: boot.lo, hi: boot.hi };
  });
}

function summary(rows) {
  const boot = clusterBootstrap(rows, { iters: 2000, seed: 7 });
  const wins = rows.filter((t) => t.won).length;
  const avgAsk = rows.length ? rows.reduce((a, t) => a + t.ask, 0) / rows.length : null;
  const mean = rows.length ? rows.reduce((a, t) => a + t.pnl, 0) / rows.length : null;
  return { n: rows.length, wins, winRate: rows.length ? wins / rows.length : null, avgAsk, mean, lo: boot.lo, hi: boot.hi };
}

const days = byDay(k1).map((d) => ({ ...d, week: d.day }));
const graduated = graduates(days.map((d) => ({ seen: false, n: d.n, mean: d.mean, lo: d.lo })));
const k1s = summary(k1);
const ups = summary(alwaysUp);
const flips = summary(flip);

const lines = [
  '# Kalshi 15-minute paper study',
  '',
  'K1 buys the side offered at 85 cents or more, about four minutes before the close, and holds to the Kalshi result. The fee is the published taker formula rounded up to the next cent. Controls use the same candle and are not K1.',
  '',
  `| Rule | Trades | Win rate | Average ask | Mean P&L | 90% low |`,
  `|---|---:|---:|---:|---:|---:|`,
  `| K1 late favorite | ${k1s.n} | ${k1s.winRate == null ? '—' : (k1s.winRate * 100).toFixed(1) + '%'} | ${k1s.avgAsk == null ? '—' : k1s.avgAsk.toFixed(3)} | ${k1s.mean == null ? '—' : '$' + k1s.mean.toFixed(2)} | ${k1s.lo == null ? '—' : '$' + k1s.lo.toFixed(2)} |`,
  `| Always Up | ${ups.n} | ${ups.winRate == null ? '—' : (ups.winRate * 100).toFixed(1) + '%'} | ${ups.avgAsk == null ? '—' : ups.avgAsk.toFixed(3)} | ${ups.mean == null ? '—' : '$' + ups.mean.toFixed(2)} | ${ups.lo == null ? '—' : '$' + ups.lo.toFixed(2)} |`,
  `| Coin-flip | ${flips.n} | ${flips.winRate == null ? '—' : (flips.winRate * 100).toFixed(1) + '%'} | ${flips.avgAsk == null ? '—' : flips.avgAsk.toFixed(3)} | ${flips.mean == null ? '—' : '$' + flips.mean.toFixed(2)} | ${flips.lo == null ? '—' : '$' + flips.lo.toFixed(2)} |`,
  '',
  '## K1 by UTC day',
  '',
  '| Day | Trades | Mean | 90% low | 90% high |',
  '|---|---:|---:|---:|---:|',
];
for (const d of days) lines.push(`| ${d.day} | ${d.n} | ${d.mean.toFixed(2)} | ${d.lo == null ? '—' : d.lo.toFixed(2)} | ${d.hi == null ? '—' : d.hi.toFixed(2)} |`);
if (!days.length) lines.push('| none | 0 | — | — | — |');
lines.push('');
lines.push(`Graduates: ${graduated ? 'yes' : 'no'}. A day counts only with 20 trades and a lower bound above zero, and three such days are required.`);
lines.push('');
lines.push('The implied chance is the ask. A win rate above that ask is not a profit until the fee is paid.');
fs.writeFileSync('KALSHI_REPORT.md', lines.join('\n'));

const prior = {
  id: 'kalshi-k1-v5',
  collectedAt: data.collectedAt || null,
  summary: graduated
    ? 'K1 was positive on every usable day. It can use the normal paper size. The controls are not a graduation.'
    : 'K1 did not clear three days of 20 trades with a lower bound above zero. It stays at a fixed $5. The always-Up and coin-flip controls are not a graduation.',
  edges: { k1: graduated },
  rows: [{ id: 'k1', label: 'Late favorite, 15 minutes', n: k1s.n, windows: days.length, usableWindows: days.filter((d) => d.n >= 20).length, mean: k1s.mean, lo: k1s.lo, hi: k1s.hi, winRate: k1s.winRate, avgAsk: k1s.avgAsk, graduated }],
  controls: { alwaysUp: ups, coinFlip: flips },
};
fs.writeFileSync('engine/kalshi-prior.js', `// Generated by runner/study-kalshi.mjs. Do not hand-edit the verdict.\nexport const KALSHI_PRIOR = ${JSON.stringify(prior, null, 2)};\n`);
console.log(JSON.stringify({ k1: k1s, alwaysUp: ups, coinFlip: flips, days, graduated }, null, 2));
