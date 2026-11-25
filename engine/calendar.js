// After-fee P&L calendar. A month of paper days from data/lines.json: one
// block per day with the after-fee net and the line count. Recorded $2 lines
// by default; with a Sim buy-in set, the same lines re-scaled (labeled).
// Share images always use the recorded $2 book.
import { simLine } from './sim.js';
import { lineStake, normalizeBetSettings } from './bets.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const r2 = (x) => Math.round(x * 100) / 100;

// Local day key for a timestamp. offsetMin is minutes east of UTC (ET = -300).
export function dayKey(ms, offsetMin = 0) {
  return new Date(ms + offsetMin * 60e3).toISOString().slice(0, 10);
}
export function localOffset(ms = Date.now()) {
  return -new Date(ms).getTimezoneOffset();
}

// Per-day totals. settings null (or all $2) gives the recorded book.
export function dayTotals(lines, { settings = null, offsetMin = 0, recorded = false } = {}) {
  const s = settings ? normalizeBetSettings(settings) : null;
  const out = new Map();
  for (const l of lines || []) {
    const k = dayKey(l.t, offsetMin);
    const d = out.get(k) || { day: k, net: 0, fees: 0, n: 0, wins: 0, counted: 0, bots: {} };
    const sc = recorded || !s ? { pnl: l.pnl, fees: l.fees } : simLine(l, lineStake(s, l.bot, l.ca));
    d.net += sc.pnl; d.fees += sc.fees; d.n += 1; d.wins += sc.pnl > 0 ? 1 : 0; d.counted += l.counted ? 1 : 0;
    const b = d.bots[l.bot] || (d.bots[l.bot] = { id: l.bot, book: l.book, net: 0, n: 0 });
    b.net += sc.pnl; b.n += 1;
    out.set(k, d);
  }
  for (const d of out.values()) { d.net = r2(d.net); d.fees = r2(d.fees); for (const b of Object.values(d.bots)) b.net = r2(b.net); }
  return out;
}

// Weeks (Sunday first) for one month. Each cell is a day key or null.
export function monthGrid(year, month) {
  const first = new Date(Date.UTC(year, month, 1));
  const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const cells = Array(first.getUTCDay()).fill(null);
  for (let d = 1; d <= days; d++) cells.push(`${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  while (cells.length % 7) cells.push(null);
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

export function monthSummary(totals, year, month) {
  const prefix = `${year}-${String(month + 1).padStart(2, '0')}`;
  const days = [...totals.values()].filter((d) => d.day.startsWith(prefix));
  const net = r2(days.reduce((a, d) => a + d.net, 0));
  const green = days.filter((d) => d.net > 0.004).length;
  const red = days.filter((d) => d.net < -0.004).length;
  const best = days.slice().sort((a, b) => b.net - a.net)[0] || null;
  const worst = days.slice().sort((a, b) => a.net - b.net)[0] || null;
  return { month: prefix, net, n: days.reduce((a, d) => a + d.n, 0), fees: r2(days.reduce((a, d) => a + d.fees, 0)), days: days.length, green, red, best, worst };
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const monthName = (y, m) => `${MONTHS[m]} ${y}`;
const short = (x) => {
  if (!Number.isFinite(x)) return '';
  const a = Math.abs(x);
  const v = a >= 1000 ? (a / 1000).toFixed(a >= 10000 ? 0 : 1) + 'k' : a >= 100 ? Math.round(a) : a.toFixed(2);
  return (x > 0.004 ? '+' : x < -0.004 ? '−' : '') + '$' + v;
};
const money = (x) => (x > 0.004 ? '+' : x < -0.004 ? '−' : '') + '$' + Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Color strength by size against the month's biggest day.
export function heat(net, maxAbs) {
  if (!Number.isFinite(net) || !maxAbs) return 0;
  return Math.max(0.18, Math.min(1, Math.abs(net) / maxAbs));
}

export function calendarHtml({ totals, year, month, today = null, simLabel = null, pending = false } = {}) {
  const weeks = monthGrid(year, month);
  const sum = monthSummary(totals || new Map(), year, month);
  const inMonth = weeks.flat().filter(Boolean).map((k) => totals?.get(k)).filter(Boolean);
  const maxAbs = Math.max(0, ...inMonth.map((d) => Math.abs(d.net)));
  const head = ['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => `<span class="cal-dow" aria-hidden="true">${d}<i class="sr">${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][i]}</i></span>`).join('');
  const cells = weeks.flat().map((k) => {
    if (!k) return '<span class="cal-cell is-blank" aria-hidden="true"></span>';
    const d = totals?.get(k);
    const dn = Number(k.slice(8));
    const isToday = k === today;
    if (!d) return `<span class="cal-cell is-empty${isToday ? ' is-today' : ''}" aria-label="${k}: no paper lines"><b class="cal-d">${dn}</b></span>`;
    const t = d.net > 0.004 ? 'up' : d.net < -0.004 ? 'dn' : 'flat';
    return `<button type="button" class="cal-cell is-${t}${isToday ? ' is-today' : ''}" style="--heat:${heat(d.net, maxAbs).toFixed(2)}" data-cal-day="${k}" aria-label="${k}: ${money(d.net)} after fees on ${d.n} lines"><b class="cal-d">${dn}</b><span class="cal-net">${short(d.net)}</span><small class="cal-n">${d.n}</small></button>`;
  }).join('');
  const tone = sum.net > 0.004 ? 'up' : sum.net < -0.004 ? 'dn' : 'flat';
  return `<section class="pcal" aria-label="After-fee P&amp;L calendar">
    <div class="cal-top"><button type="button" class="cal-nav" data-cal-step="-1" aria-label="Previous month">‹</button><div class="cal-title"><b>${monthName(year, month)}</b><small>after fees · ${simLabel ? `<i class="simb">${esc(simLabel)}</i>` : 'recorded $2 lines'} · <i class="pm">PAPER $</i></small></div><button type="button" class="cal-nav" data-cal-step="1" aria-label="Next month">›</button></div>
    <div class="cal-sum"><b class="is-${tone}">${pending ? '…' : money(sum.net)}</b><span>${sum.green} green · ${sum.red} red · ${sum.n.toLocaleString('en-US')} lines · fees ${money(sum.fees).replace('+', '')}</span></div>
    <div class="cal-grid" role="grid">${head}${cells}</div>
    <div class="cal-act"><button type="button" class="btn" data-cal-share>Share month image</button><span class="note">The image always shows the recorded $2 book.</span></div>
  </section>`;
}

export function daySheetHtml(d, { simLabel = null, rows = '' } = {}) {
  if (!d) return '';
  const bots = Object.values(d.bots).sort((a, b) => b.net - a.net);
  const t = d.net > 0.004 ? 'up' : d.net < -0.004 ? 'dn' : 'flat';
  return `<div class="cal-sheet"><h2 id="sheetTitle">${esc(new Date(d.day + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }))}</h2>
  <div class="bsh-big is-${t}"><small>After fees${simLabel ? ` · <i class="simb">${esc(simLabel)}</i>` : ' · recorded $2'}</small><b>${money(d.net)}</b><i class="pm">PAPER $</i></div>
  <div class="sh-stats"><div class="sh-stat"><small>Lines</small><b>${d.n.toLocaleString('en-US')}</b></div><div class="sh-stat"><small>Won</small><b>${d.n ? Math.round((100 * d.wins) / d.n) : 0}%</b></div><div class="sh-stat"><small>Fees</small><b>${money(d.fees).replace('+', '')}</b></div><div class="sh-stat"><small>Counted</small><b>${d.counted}</b></div></div>
  <h3 class="sh-sec">By bot</h3><ul class="cal-bots">${bots.map((b) => `<li><button type="button" class="cal-bot" data-cal-bot="${esc(b.id)}" data-cal-bot-day="${esc(d.day)}"><span>${esc(b.id)}</span><small>${b.n} lines</small><b class="is-${b.net > 0.004 ? 'up' : b.net < -0.004 ? 'dn' : 'flat'}">${money(b.net)}</b></button></li>`).join('')}</ul>
  ${rows ? `<h3 class="sh-sec">Bets kept in the list</h3>${rows}` : ''}
  <p class="sh-note">Every settled paper line that day, after fees. Paper only.</p></div>`;
}

// What the share image shows: the recorded $2 book, labeled paper.
export function calendarShareModel(recordedTotals, year, month) {
  const sum = monthSummary(recordedTotals, year, month);
  const weeks = monthGrid(year, month);
  const cells = weeks.flat().map((k) => (k ? { day: k, d: Number(k.slice(8)), net: recordedTotals.get(k)?.net ?? null, n: recordedTotals.get(k)?.n ?? 0 } : null));
  return { title: monthName(year, month), net: sum.net, green: sum.green, red: sum.red, n: sum.n, fees: sum.fees, weeks: weeks.length, cells, badge: 'PAPER TRADING · NOT REAL MONEY', note: 'After fees · recorded $2 lines' };
}
