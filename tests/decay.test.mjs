import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { recentForm, decayFlag, decayLines, sparkPoints, recentFormChipHtml, freshDecay, settledTrades, DECAY_RECENT_N, DECAY_SMALL_N } from '../engine/decay.js';
import { lessonsDocument, lessonsMarkdown, morningReport, defaultBrain } from '../engine/learn.js';

const base = Date.parse('2026-11-20T00:00:00.000Z');
// i-th trade, 15 minutes apart. Kalshi-shaped row.
const krow = (i, pnl, over = {}) => ({
  variant: 'bot-a', family: 'revert', paper: true, skipped: false, ask: 0.4, won: pnl > 0, pnl,
  openedAt: new Date(base + i * 900000).toISOString(), settledAt: new Date(base + i * 900000 + 960000).toISOString(), ...over,
});
const series = (before, recent, over = {}) => [
  ...Array.from({ length: before.n }, (_, i) => krow(i, before.pnl, over)),
  ...Array.from({ length: recent.n }, (_, i) => krow(before.n + i, recent.pnl, over)),
];

test('the window is fixed at 100 trades and small is under 40', () => {
  assert.equal(DECAY_RECENT_N, 100);
  assert.equal(DECAY_SMALL_N, 40);
});

test('empty journals give an empty list and no lines', () => {
  assert.deepEqual(recentForm({}), []);
  assert.deepEqual(recentForm({ kalshiRows: [], memeRows: [] }), []);
  assert.deepEqual(decayLines(null), []);
  assert.equal(recentFormChipHtml(null), '');
  assert.deepEqual(sparkPoints([]), []);
});

test('fewer than 100 trades uses them all, marks small under 40, and never flags', () => {
  const [a] = recentForm({ kalshiRows: series({ n: 0 }, { n: 12, pnl: -1 }) });
  assert.equal(a.n, 12);
  assert.equal(a.recentN, 12);
  assert.equal(a.beforeN, 0);
  assert.equal(a.beforeMean, null);
  assert.equal(a.small, true);
  assert.equal(a.flag, null);
  assert.match(a.text, /^bot-a: all 12 trades -\$1\.00 a trade after fees, win rate 0%\. No earlier trades to compare yet\. Small sample\.$/);
  const [b] = recentForm({ kalshiRows: series({ n: 0 }, { n: 60, pnl: 1 }) });
  assert.equal(b.small, false);
  assert.equal(b.flag, null, 'no earlier trades, so nothing to diverge from');
});

test('decaying: recent run below zero after a positive record, with all the numbers from rows', () => {
  const rows = series({ n: 150, pnl: 0.5 }, { n: 100, pnl: -0.8 });
  const [a] = recentForm({ kalshiRows: rows });
  assert.equal(a.n, 250);
  assert.equal(a.recentN, 100);
  assert.equal(a.recentMean, -0.8);
  assert.equal(a.recentWinRate, 0);
  assert.equal(a.beforeN, 150);
  assert.equal(a.beforeMean, 0.5);
  assert.equal(a.mean, Math.round(((150 * 0.5 - 80) / 250) * 100) / 100);
  assert.equal(a.flag, 'decaying');
  assert.equal(a.text, 'bot-a: last 100 trades -$0.80 a trade after fees, win rate 0%, vs +$0.50 on the 150 trades before. All-time -$0.02 a trade on 250. Flagged as decaying.');
  assert.equal(a.spark.length, 20);
  assert.equal(a.spark[a.spark.length - 1], -80);
});

test('improving is the reverse, and order is by openedAt not file order', () => {
  const rows = series({ n: 120, pnl: -0.3 }, { n: 100, pnl: 0.2 }).reverse();
  const [a] = recentForm({ kalshiRows: rows });
  assert.equal(a.recentMean, 0.2);
  assert.equal(a.beforeMean, -0.3);
  assert.equal(a.flag, 'improving');
  assert.match(a.text, /Flagged as improving\.$/);
});

test('flags need 40 trades on each side and a cent-sized sign change', () => {
  assert.equal(decayFlag({ recentN: 39, recentMean: -1, beforeN: 300, beforeMean: 1 }), null);
  assert.equal(decayFlag({ recentN: 100, recentMean: -1, beforeN: 39, beforeMean: 1 }), null);
  assert.equal(decayFlag({ recentN: 40, recentMean: -0.01, beforeN: 40, beforeMean: 0.01 }), 'decaying');
  assert.equal(decayFlag({ recentN: 100, recentMean: -0.5, beforeN: 100, beforeMean: -0.1 }), null);
  assert.equal(decayFlag({ recentN: 100, recentMean: 0, beforeN: 100, beforeMean: 0.3 }), null);
  // Means under half a cent round to $0.00 and do not flip a flag.
  const [a] = recentForm({ kalshiRows: series({ n: 200, pnl: 0.004 }, { n: 100, pnl: -0.004 }) });
  assert.equal(a.flag, null);
});

test('skipped signals, paper:false rows, open rows and bad-quote coin rows are left out', () => {
  const k = [
    krow(1, 1),
    krow(2, 1, { skipped: true }),
    krow(3, 1, { paper: false }),
    krow(4, null, { won: null }),
    krow(5, NaN),
  ];
  const m = [
    { variant: 'coin-a', family: 'meme', entry: 0.001, exitPx: 0.0012, pnl: 0.3, won: true, openedAt: '2026-11-23T01:00:00.000Z', settledAt: '2026-11-23T01:10:00.000Z' },
    // 4,400x tick: a quote-guard feed error, set aside everywhere.
    { variant: 'coin-a', family: 'meme', entry: 0.0027, exitPx: 11.9, pnl: 8400, won: true, openedAt: '2026-11-23T02:00:00.000Z', settledAt: '2026-11-23T02:05:00.000Z' },
    { variant: 'coin-a', family: 'meme', entry: 0.001, exitPx: null, pnl: null, open: true, openedAt: '2026-11-23T03:00:00.000Z' },
  ];
  assert.equal(settledTrades(k).length, 1);
  const out = recentForm({ kalshiRows: k, memeRows: m });
  const a = out.find((s) => s.id === 'bot-a');
  const c = out.find((s) => s.id === 'coin-a');
  assert.equal(a.n, 1);
  assert.equal(c.book, 'meme');
  assert.equal(c.n, 1);
  assert.equal(c.net, 0.3);
});

test('fair-family bots get a recent Brier of pEst against the ask; others do not', () => {
  const rows = [
    krow(1, 2.9, { variant: 'fair-x', family: 'fair', ask: 0.4, pEst: 0.5, won: true }),
    krow(2, -2.1, { variant: 'fair-x', family: 'fair', ask: 0.2, pEst: 0.3, won: false }),
    krow(3, 1, { variant: 'pairs-x', family: 'pairs', pEst: 0.6 }),
  ];
  const out = recentForm({ kalshiRows: rows });
  const f = out.find((s) => s.id === 'fair-x');
  assert.deepEqual(f.brier, { n: 2, model: Math.round(((0.5 ** 2 + 0.3 ** 2) / 2) * 1000) / 1000, market: Math.round(((0.6 ** 2 + 0.2 ** 2) / 2) * 1000) / 1000 });
  assert.match(f.text, /Recent Brier 0\.170 vs Kalshi's ask 0\.200, lower is better\./);
  assert.equal(out.find((s) => s.id === 'pairs-x').brier, null);
});

test('flagged bots come first; flaggedOnly lines keep just those', () => {
  const rows = [
    ...series({ n: 10, pnl: 1 }, { n: 0 }, { variant: 'quiet' }),
    ...series({ n: 50, pnl: 1 }, { n: 100, pnl: -1 }, { variant: 'falling' }),
  ];
  const out = recentForm({ kalshiRows: rows });
  assert.equal(out[0].id, 'falling');
  assert.deepEqual(decayLines(out, { flaggedOnly: true }), [out[0].text]);
  assert.equal(decayLines(out).length, 2);
});

test('the chip shows the computed mean and a sparkline, with an accessible label', () => {
  const [a] = recentForm({ kalshiRows: series({ n: 150, pnl: 0.5 }, { n: 100, pnl: -0.8 }) });
  const html = recentFormChipHtml(a);
  assert.match(html, /class="rf-chip is-dn"/);
  assert.match(html, /Decaying/);
  assert.match(html, /-\$0\.80/);
  assert.match(html, /<svg class="rf-spark"[^>]*aria-hidden="true"/);
  assert.match(html, /aria-label="Recent form for bot-a: bot-a: last 100 trades/);
});

test('freshDecay picks the newer of today.json and lessons.json', () => {
  const lessons = { generatedAt: '2026-11-24T06:00:00.000Z', decay: [{ id: 'old' }] };
  const today = { decayAt: '2026-11-24T09:00:00.000Z', decay: [{ id: 'new' }] };
  assert.equal(freshDecay(lessons, today)[0].id, 'new');
  assert.equal(freshDecay(lessons, { decayAt: '2026-11-24T01:00:00.000Z', decay: [{ id: 'new' }] })[0].id, 'old');
  assert.deepEqual(freshDecay(null, null), []);
});

test('lessons and the morning report carry the plain recent-form lines', () => {
  const rows = series({ n: 50, pnl: 1 }, { n: 100, pnl: -1 }, { variant: 'falling', window: '2026-11-21' });
  const now = Date.parse('2026-11-24T06:00:00.000Z');
  const doc = lessonsDocument(rows, null, defaultBrain(), now, []);
  assert.equal(doc.decay[0].id, 'falling');
  assert.equal(doc.decay[0].flag, 'decaying');
  const md = lessonsMarkdown(doc);
  assert.match(md, /## Recent form/);
  assert.ok(md.includes(`- ${doc.decay[0].text}`));
  const morning = morningReport(rows, defaultBrain(), doc.summary, now, doc.decay);
  assert.deepEqual(morning.recentForm, [doc.decay[0].text]);
  assert.equal(morning.lessons[0], doc.decay[0].text);
  const plain = morningReport(rows, defaultBrain(), doc.summary, now);
  assert.deepEqual(plain.recentForm, []);
});

test('recent form is read-only: no gate, weight or live code imports it', () => {
  for (const file of ['engine/strategies.js', 'engine/repair.js', 'engine/focus-plan.js', 'engine/kalshi.js', 'engine/fair.js', 'engine/roles.js']) {
    assert.doesNotMatch(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), /decay\.js/, file);
  }
  const src = readFileSync(new URL('../engine/decay.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /weight\s*=|live_execution\s*[:=]\s*true|placeOrder|privateKey/);
  const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  assert.match(app, /recentFormChipHtml/);
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  assert.match(css, /prefers-reduced-motion:reduce\)\{\s*\.rf-spark path\{animation:none/);
  const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
  assert.match(sw, /'engine\/decay\.js'/);
});

test('writeTodayFile writes recent form on every snapshot', async () => {
  const { writeTodayFile } = await import('../runner/write-today.mjs');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decay-'));
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    const out = writeTodayFile({ now: Date.parse('2026-11-24T09:00:00.000Z'), kalshiRows: series({ n: 50, pnl: 1 }, { n: 100, pnl: -1 }), memeRows: [] });
    assert.equal(out.decay[0].flag, 'decaying');
    assert.equal(out.decayAt, out.generatedAt);
    assert.equal(out.liveExecution, false);
    const disk = JSON.parse(fs.readFileSync('data/today.json', 'utf8'));
    assert.equal(disk.decay.length, out.decay.length);
  } finally {
    process.chdir(cwd);
  }
});
