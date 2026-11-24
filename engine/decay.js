// Edge decay (recent form): does a bot's latest run of paper trades look like
// its earlier record? Paper only. Display and diagnostic only: nothing here
// moves a weight, a bench, a graduation, a repair gate, the edge gate, the
// holdout, the $2 size or live_execution. Every number comes from journal rows.
//
// Why: fair-spot-v2 made money after fees on its first 271 settled lines and
// then lost it on the next 114. The Model vs market card only shows the
// cumulative Brier and net, so the flip stayed hidden until the total turned
// negative. This check says so as soon as the recent run has enough trades.
// It does not say why; regime or bug is for a person to look at.
//
// Rules (fixed here, not fitted to any row, not tuned on the holdout):
// - Rows: settled paper rows with a finite after-fee pnl, per variant, from the
//   Kalshi journal and the meme journal. Skipped signals (counterfactuals that
//   were never taken) and paper:false rows are left out. Coin rows settled on a
//   bad quote (engine/quote-guard.js) are left out.
// - Order: by openedAt, then settledAt. The recent run is the last
//   DECAY_RECENT_N = 100 trades (all of them if there are fewer). It is marked
//   "small" under DECAY_SMALL_N = 40.
// - "Before" is every trade ahead of the recent run. All-time is every trade.
// - Flag "decaying" when the recent mean is below zero, the mean before it is
//   above zero, and both sides have at least DECAY_SMALL_N trades. "improving"
//   is the reverse. Otherwise no flag. Means are compared after rounding to the
//   cent, so a mean shown as $0.00 counts as flat and never flips a flag.
//   "Before" rather than all-time: all-time includes the recent run, so once a
//   bad run drags the total below zero an all-time check goes quiet exactly
//   when the flip matters (fair-spot-v2 on 2026-11-24).
// - Fair-family bots (family "fair") also get the recent Brier of pEst against
//   the ask they paid. Lower is better.
import { withoutQuoteErrors } from './quote-guard.js';

export const DECAY_RECENT_N = 100;
export const DECAY_SMALL_N = 40;
export const DECAY_SPARK_POINTS = 20;

const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const r2 = (n) => Math.round(n * 100) / 100;
const r3 = (n) => Math.round(n * 1000) / 1000;
const mean = (list) => (list.length ? list.reduce((s, row) => s + row.pnl, 0) / list.length : null);
const t = (v) => {
  const x = Date.parse(v || '');
  return Number.isFinite(x) ? x : Infinity;
};

export function usd(n) {
  if (!finite(n)) return '—';
  const sign = n > 0 ? '+' : n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

export function settledTrades(rows) {
  return withoutQuoteErrors(rows).filter((row) => row && row.variant && row.paper !== false && row.skipped !== true && finite(row.pnl));
}

function sortTrades(list) {
  return list
    .map((row, i) => ({ row, i }))
    .sort((a, b) => (t(a.row.openedAt) - t(b.row.openedAt)) || (t(a.row.settledAt) - t(b.row.settledAt)) || (a.i - b.i))
    .map((x) => x.row);
}

// Cumulative after-fee net across the recent run, cut down to at most
// DECAY_SPARK_POINTS points (the last point is always the full run).
export function sparkPoints(list, points = DECAY_SPARK_POINTS) {
  if (!list.length) return [];
  const cum = [];
  let s = 0;
  for (const row of list) { s += row.pnl; cum.push(s); }
  const k = Math.min(points, cum.length);
  const out = [];
  for (let j = 1; j <= k; j += 1) out.push(r2(cum[Math.ceil((j * cum.length) / k) - 1]));
  return out;
}

function recentBrier(list) {
  const priced = list.filter((row) => finite(row.pEst) && row.pEst >= 0 && row.pEst <= 1 && finite(row.ask) && row.ask > 0 && row.ask < 1 && typeof row.won === 'boolean');
  if (!priced.length) return null;
  const won = (row) => (row.won ? 1 : 0);
  const model = priced.reduce((s, row) => s + (row.pEst - won(row)) ** 2, 0) / priced.length;
  const market = priced.reduce((s, row) => s + (row.ask - won(row)) ** 2, 0) / priced.length;
  return { n: priced.length, model: r3(model), market: r3(market) };
}

export function decayFlag(stat) {
  if (!stat || stat.recentN < DECAY_SMALL_N || stat.beforeN < DECAY_SMALL_N) return null;
  if (stat.recentMean < 0 && stat.beforeMean > 0) return 'decaying';
  if (stat.recentMean > 0 && stat.beforeMean < 0) return 'improving';
  return null;
}

export function decayLine(stat) {
  const word = stat.recentN === 1 ? 'trade' : 'trades';
  const head = stat.recentN < stat.n ? `last ${stat.recentN} ${word}` : `all ${stat.recentN} ${word}`;
  let text = `${stat.id}: ${head} ${usd(stat.recentMean)} a trade after fees, win rate ${Math.round(100 * stat.recentWinRate)}%`;
  if (stat.beforeN) text += `, vs ${usd(stat.beforeMean)} on the ${stat.beforeN} ${stat.beforeN === 1 ? 'trade' : 'trades'} before. All-time ${usd(stat.mean)} a trade on ${stat.n}.`;
  else text += '. No earlier trades to compare yet.';
  if (stat.brier) text += ` Recent Brier ${stat.brier.model.toFixed(3)} vs Kalshi's ask ${stat.brier.market.toFixed(3)}, lower is better.`;
  if (stat.small) text += ' Small sample.';
  if (stat.flag === 'decaying') text += ' Flagged as decaying.';
  if (stat.flag === 'improving') text += ' Flagged as improving.';
  return text;
}

function formFor(id, book, list, recentN) {
  const sorted = sortTrades(list);
  const recent = sorted.slice(-recentN);
  const before = sorted.slice(0, sorted.length - recent.length);
  const family = sorted[sorted.length - 1].family || null;
  const stat = {
    id,
    book,
    family,
    n: sorted.length,
    net: r2(sorted.reduce((s, row) => s + row.pnl, 0)),
    mean: r2(mean(sorted)),
    recentN: recent.length,
    recentNet: r2(recent.reduce((s, row) => s + row.pnl, 0)),
    recentMean: r2(mean(recent)),
    recentWinRate: r3(recent.filter((row) => row.won === true || (row.won == null && row.pnl > 0)).length / recent.length),
    recentFrom: recent[0].openedAt || null,
    beforeN: before.length,
    beforeMean: before.length ? r2(mean(before)) : null,
    small: recent.length < DECAY_SMALL_N,
    brier: family === 'fair' ? recentBrier(recent) : null,
    spark: sparkPoints(recent),
  };
  // Flags read the cent-rounded means, so a mean shown as $0.00 is flat.
  stat.flag = decayFlag(stat);
  stat.text = decayLine(stat);
  return stat;
}

// Recent form for every variant in both journals. Flagged bots first, then by
// all-time trade count. Pure: same rows in, same list out.
export function recentForm({ kalshiRows = [], memeRows = [], recentN = DECAY_RECENT_N } = {}) {
  const out = [];
  for (const [book, rows] of [['kalshi', kalshiRows], ['meme', memeRows]]) {
    const by = new Map();
    for (const row of settledTrades(rows)) {
      if (!by.has(row.variant)) by.set(row.variant, []);
      by.get(row.variant).push(row);
    }
    for (const [id, list] of by) out.push(formFor(id, book, list, recentN));
  }
  const rank = (s) => (s.flag === 'decaying' ? 0 : s.flag === 'improving' ? 1 : 2);
  return out.sort((a, b) => rank(a) - rank(b) || b.n - a.n || a.id.localeCompare(b.id));
}

export function decayLines(list, { flaggedOnly = false } = {}) {
  return (list || []).filter((s) => !flaggedOnly || s.flag).map((s) => s.text);
}

// Small chip with a sparkline of the recent run's cumulative net. Plain markup
// for the app and for tests. Colors come from the theme variables.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function sparkPath(points, w = 64, h = 18) {
  const ys = [0, ...(points || [])];
  if (ys.length < 2) return '';
  const min = Math.min(...ys);
  const max = Math.max(...ys);
  const span = max - min || 1;
  return ys.map((y, i) => `${i ? 'L' : 'M'}${r2(1 + (i / (ys.length - 1)) * (w - 2))} ${r2(h - 1 - ((y - min) / span) * (h - 2))}`).join(' ');
}

export function recentFormChipHtml(stat) {
  if (!stat || !stat.recentN) return '';
  const tone = stat.flag === 'decaying' ? 'dn' : stat.flag === 'improving' ? 'up' : stat.recentMean < 0 ? 'soft-dn' : 'soft-up';
  const word = stat.flag === 'decaying' ? 'Decaying' : stat.flag === 'improving' ? 'Improving' : 'Recent form';
  const d = sparkPath(stat.spark);
  const label = `Recent form for ${stat.id}: ${stat.text}`;
  return `<span class="rf-chip is-${tone}" role="img" aria-label="${esc(label)}" title="${esc(stat.text)}">
    <span class="rf-word">${word}</span>
    ${d ? `<svg class="rf-spark" viewBox="0 0 64 18" width="64" height="18" aria-hidden="true" focusable="false"><path d="${d}" pathLength="1"/></svg>` : ''}
    <span class="rf-num">${esc(usd(stat.recentMean))}<small>/trade · last ${stat.recentN}${stat.small ? ' · small' : ''}</small></span>
  </span>`;
}

// Pick the fresher recent-form list (today.json every snapshot, lessons.json
// nightly). Read-only.
export function freshDecay(lessons, today) {
  const nightly = Array.isArray(lessons?.decay) ? lessons.decay : null;
  const live = Array.isArray(today?.decay) ? today.decay : null;
  const nightlyAt = Date.parse(lessons?.generatedAt || '');
  const liveAt = Date.parse(today?.decayAt || '');
  if (live && (!nightly || !Number.isFinite(nightlyAt) || (Number.isFinite(liveAt) && liveAt >= nightlyAt))) return live;
  return nightly || [];
}
