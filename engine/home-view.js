// Visual-first Home ("Desk") markup. Loads in the browser and in tests.
// PAPER ONLY. Display only: nothing here moves a weight, a bench, a gate, the
// holdout, the $2 size or live_execution. Every number comes from the data
// files the runner already writes (today.json, alloc-curve.json, brain.json,
// focus.json, journal-open.json, phone-alerts.json). There is no execute or
// live-trading control on this screen, on purpose.
import { feedAge } from './today.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const r1 = (n) => Math.round(n * 10) / 10;

export function usd(x, { cents = true } = {}) {
  if (!finite(x)) return '—';
  const sign = x > 0 ? '+' : x < 0 ? '−' : '';
  const abs = Math.abs(x);
  const body = cents ? abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : Math.round(abs).toLocaleString('en-US');
  return `${sign}$${body}`;
}
export const tone = (x) => (finite(x) && x > 0 ? 'up' : finite(x) && x < 0 ? 'dn' : 'flat');

// Neon accent per strategy family. Fixed list; unknown families get grey.
export const FAMILY = {
  mom: { color: '#3dff9a', icon: '↗', name: 'Momentum' },
  late: { color: '#38e1ff', icon: '◷', name: 'Late favorite' },
  fair: { color: '#b98cff', icon: '◈', name: 'Fair value' },
  pairs: { color: '#ffc94d', icon: '⇄', name: 'Pairs' },
  revert: { color: '#ff6bd5', icon: '↺', name: 'Mean revert' },
  flip: { color: '#7aa8ff', icon: '◐', name: 'Coin flip' },
  scalp: { color: '#ff9a4d', icon: '⚡', name: 'Scalp' },
  rest: { color: '#ff6b7d', icon: '▤', name: 'Maker' },
  meme: { color: '#ffe066', icon: '◎', name: 'Coins' },
};
export function familyOf(stat) {
  const id = String(stat?.id || stat?.variant || '');
  if (stat?.book === 'meme') return 'meme';
  const fam = stat?.family || id.split('-')[0];
  return FAMILY[fam] ? fam : id.startsWith('rest') ? 'rest' : fam;
}
const accent = (fam) => FAMILY[fam] || { color: '#8b97a6', icon: '•', name: fam || 'Bot' };

// Area sparkline. Points are a cumulative after-fee series; a 0 start is added
// so the line begins at break-even.
export function sparkSvg(points, { w = 120, h = 40, cls = '', label = '' } = {}) {
  const ys = [0, ...(points || []).filter(finite)];
  if (ys.length < 3) return '';
  const min = Math.min(...ys), max = Math.max(...ys);
  const span = max - min || 1;
  const x = (i) => r1(1 + (i / (ys.length - 1)) * (w - 2));
  const y = (v) => r1(h - 2 - ((v - min) / span) * (h - 4));
  const line = ys.map((v, i) => `${i ? 'L' : 'M'}${x(i)} ${y(v)}`).join(' ');
  const area = `${line} L${x(ys.length - 1)} ${h} L${x(0)} ${h} Z`;
  const zero = y(0);
  const t = tone(ys[ys.length - 1]);
  const role = label ? `role="img" aria-label="${esc(label)}"` : 'aria-hidden="true"';
  return `<svg class="spark is-${t} ${cls}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" ${role} focusable="false"><line class="spark-zero" x1="0" x2="${w}" y1="${zero}" y2="${zero}"/><path class="spark-area" d="${area}"/><path class="spark-line" d="${line}" vector-effect="non-scaling-stroke"/><circle class="spark-dot" cx="${x(ys.length - 1)}" cy="${y(ys[ys.length - 1])}" r="2.4"/></svg>`;
}

// Traffic light: is the paper desk running on fresh data?
export function deskStatus(today, now = Date.now()) {
  if (!today) return { tone: 'r', word: 'No data', detail: 'Numbers did not load' };
  const k = feedAge(today.kalshiFetchedAt, now);
  const m = feedAge(today.memeFetchedAt, now);
  const worst = [k, m].some((a) => a.tone === 'old') ? 'old' : [k, m].some((a) => a.tone === 'stale') ? 'stale' : 'fresh';
  const short = (a) => a.label.replace('updated ', '').replace(' min ago', 'm ago').replace(' hr ago', 'h ago');
  if (worst === 'fresh') return { tone: 'g', word: 'Running', detail: short(k) };
  if (worst === 'stale') return { tone: 'y', word: 'Slow', detail: short(k.tone !== 'fresh' ? k : m) };
  return { tone: 'r', word: 'Stalled', detail: short(k.tone === 'old' ? k : m) };
}

// Real-money readiness, straight from focus.json gate rows. graduates() needs
// at least 3 forward test windows and every one of them positive with a lower
// bound above zero, so progress is "good windows / windows so far" (at least
// 3). Never computed or loosened here.
export function gateProgressOf(row) {
  const g = row?.gate || {};
  const total = Math.max(g.need || 3, g.windows || 0);
  const good = Math.min(total, g.cleared || 0);
  return { good, total, ratio: total ? good / total : 0, graduated: !!g.graduated };
}
export function gateSummary(focus) {
  const rows = [...(focus?.near || []), ...(focus?.research || [])].filter((r) => r && r.gate);
  const passed = rows.filter((r) => r.gate.graduated).length;
  const closest = rows.slice().sort((a, b) => gateProgressOf(b).ratio - gateProgressOf(a).ratio || (b.mean ?? -9) - (a.mean ?? -9))[0] || null;
  return { total: rows.length, passed, closest };
}

export function botChipsHtml(decay) {
  const list = (decay || []).filter((s) => s && s.recentN).slice().sort((a, b) => (b.recentNet ?? 0) - (a.recentNet ?? 0));
  if (!list.length) return '';
  const chips = list.map((s) => {
    const fam = familyOf(s);
    return `<li class="bchip is-${tone(s.recentNet)}" style="--ac:${accent(fam).color}"><i aria-hidden="true"></i><span>${esc(s.id)}</span><b>${usd(s.recentNet)}</b></li>`;
  }).join('');
  return `<section class="bchips" aria-label="Each bot, last 100 paper trades after fees"><ul>${chips}</ul></section>`;
}

export function heroHtml({ curve, today, brain, openN, now = Date.now() } = {}) {
  const net = finite(curve?.net) ? curve.net : null;
  const n = curve?.n ?? 0;
  const since = Date.parse(brain?.experimentSince || '');
  const days = Number.isFinite(since) ? Math.max(1, Math.floor((now - since) / 86400000)) : null;
  const allocToday = today?.allocated?.n || 0;
  const action = allocToday ? `${allocToday} bets today` : 'practice mode';
  const bits = [`${n.toLocaleString('en-US')} bets`, days ? `${days} days` : null, finite(openN) ? `${openN} open` : null, action].filter(Boolean);
  const shadow = today?.shadow;
  const spark = sparkSvg(curve?.points || [], { w: 132, h: 52, cls: 'hero-spark', label: `Paper P and L curve, now ${usd(net)}` });
  return `<section class="hero2 is-${tone(net)}" aria-label="Paper profit after fees">
    <p class="hero2-k">Paper P&amp;L <span>after fees</span></p>
    <div class="hero2-row"><b class="hero2-num"${net == null ? '' : ` data-count="${net}" data-count-key="hero-net" data-count-from="0" data-sign="1"`}>${net == null ? '—' : usd(net)}</b>${spark}</div>
    <p class="hero2-sub">${esc(bits.join(' · '))}</p>
    ${shadow ? `<p class="hero2-practice">Practice today <b class="is-${tone(shadow.pnl)}">${usd(shadow.pnl)}</b> <span>on ${Number(shadow.n || 0).toLocaleString('en-US')}</span></p>` : ''}
  </section>`;
}

export function statusRowHtml({ today, focus, now = Date.now() } = {}) {
  const st = deskStatus(today, now);
  const g = gateSummary(focus);
  return `<section class="pills" aria-label="Desk status">
    <span class="pill light-${st.tone}"><i aria-hidden="true"></i>${esc(st.word)}<small>${esc(st.detail)}</small></span>
    <span class="pill paper"><i aria-hidden="true"></i>Paper only<small>no wallet</small></span>
    <button type="button" class="pill gatep" data-tabjump="score"><i aria-hidden="true"></i>Real money<small>${g.passed}/${g.total} ready</small></button>
  </section>`;
}

// Card status from real gate and bench lists in focus.json — not the sticky
// brain.benched flag, which can keep a later-profitable bot marked "benched".
// Display only. Loss benches are focus.benched and focus.rolled.
export const PRACTICE_HINT = 'Practice bots trade with $0 until they win every test window.';

export function gateRowOf(focus, id) {
  return [...(focus?.near || []), ...(focus?.research || [])].find((r) => r && r.id === id) || null;
}
export function isLossBenched(id, focus) {
  const hit = (list) => (list || []).some((r) => (typeof r === 'string' ? r : r?.id) === id);
  return hit(focus?.benched) || hit(focus?.rolled);
}
export function botStatus(stat, { focus } = {}) {
  const id = stat?.id;
  if (isLossBenched(id, focus)) return { label: 'Benched · losing', kind: 'benched', hint: PRACTICE_HINT };
  const row = gateRowOf(focus, id);
  const p = row?.gate ? gateProgressOf(row) : null;
  const windowsDone = row?.gate?.windows || 0;
  const isNew = !!stat?.small || (windowsDone === 0 && (stat?.n || 0) < 40);
  if (p?.graduated) return { label: 'Ready', kind: 'ready', hint: PRACTICE_HINT };
  if (isNew) return { label: 'Practice · new', kind: 'practice', hint: PRACTICE_HINT };
  if (p) return { label: `Practice · ${p.good}/${p.total} windows`, kind: 'practice', hint: PRACTICE_HINT };
  return { label: 'Practice', kind: 'practice', hint: PRACTICE_HINT };
}

function agentCard(s, { focus } = {}) {
  const fam = familyOf(s);
  const a = accent(fam);
  const st = botStatus(s, { focus });
  const flag = s.flag === 'decaying' ? '<span class="flag dn" title="Last 100 bets worse than before">▼ fading</span>' : s.flag === 'improving' ? '<span class="flag up" title="Last 100 bets better than before">▲ rising</span>' : '';
  return `<li class="agent${st.kind === 'benched' ? ' is-benched' : ''}" style="--ac:${a.color}" data-bot="${esc(s.id)}" role="button" tabindex="0" aria-label="${esc(s.id)} details">
    <div class="agent-top"><span class="agent-ic" aria-hidden="true">${a.icon}</span>${flag}<span class="agent-role is-${st.kind}" title="${esc(st.hint)}">${esc(st.label)}</span></div>
    <b class="agent-name">${esc(s.id)}</b>
    <span class="agent-num is-${tone(s.net)}">${usd(s.net)}</span>
    <span class="agent-meta">${usd(s.mean)}/bet · ${Number(s.n || 0).toLocaleString('en-US')}</span>
    ${sparkSvg(s.spark, { w: 120, h: 28, cls: 'agent-spark' })}
  </li>`;
}

// Bot detail for the bottom sheet. Same decay row the card uses: all-time
// after-fee net, the cumulative spark, and last-100 vs before. Display only.
export function botSheetHtml(s, { focus } = {}) {
  if (!s) return '';
  const fam = familyOf(s);
  const a = accent(fam);
  const st = botStatus(s, { focus });
  const n = Number(s.n || 0);
  const stat = (k, v) => `<div class="sh-stat"><small>${k}</small><b>${v}</b></div>`;
  const win = finite(s.recentWinRate) ? `${Math.round(s.recentWinRate * 100)}%` : '—';
  const chart = sparkSvg(s.spark, { w: 320, h: 120, cls: 'sh-spark', label: `${s.id}, running after-fee total over the last ${s.recentN || 'few'} bets` });
  let form = '';
  if (s.recentN && finite(s.recentMean) && finite(s.beforeMean) && s.beforeN) {
    const max = Math.max(Math.abs(s.recentMean), Math.abs(s.beforeMean), 0.01);
    const bar = (label, v, cnt) => `<li class="is-${tone(v)}"><span>${label}<small>${Number(cnt).toLocaleString('en-US')} bets</small></span><i style="--w:${Math.round((Math.abs(v) / max) * 100)}%" aria-hidden="true"></i><b>${usd(v)}</b></li>`;
    form = `<h3 class="sh-sec">Per bet, after fees</h3><ul class="sh-form">${bar('Last 100', s.recentMean, s.recentN)}${bar('Before', s.beforeMean, s.beforeN)}</ul>`;
  }
  const row = gateRowOf(focus, s.id);
  let gate = '';
  if (row?.gate) {
    const p = gateProgressOf(row);
    const segs = Array.from({ length: p.total }, (_, i) => `<i class="${i < p.good ? 'on' : ''}"></i>`).join('');
    gate = `<h3 class="sh-sec">Test windows</h3><div class="gate2-seg" role="img" aria-label="${p.good} of ${p.total} test windows profitable">${segs}</div><p class="sh-note">${p.good} of ${p.total} profitable. Every window has to be before real money.</p>`;
  }
  const flag = s.flag === 'decaying' ? '<span class="flag dn">▼ fading</span>' : s.flag === 'improving' ? '<span class="flag up">▲ rising</span>' : '';
  return `<div class="sh-bot" style="--ac:${a.color}">
<header class="sh-head"><span class="agent-ic sh-ic" aria-hidden="true">${a.icon}</span><span class="sh-id"><h2 id="sheetTitle">${esc(s.id)}</h2><small>${esc(a.name)} · ${esc(st.label)}</small></span>${flag}</header>
<div class="sh-big"><b class="is-${tone(s.net)}">${usd(s.net)}</b><span>all-time, after fees</span></div>
<div class="sh-chart">${chart ? `${chart}<span class="sh-chart-k">Last ${Number(s.recentN || 0).toLocaleString('en-US')} bets, running total after fees</span>` : '<p class="sh-note">Not enough bets for a chart yet.</p>'}</div>
<div class="sh-stats">${stat('Bets', n.toLocaleString('en-US'))}${stat('Avg / bet', usd(s.mean))}${stat('Wins, last 100', win)}${stat('Last 100', s.recentN ? usd(s.recentNet) : '—')}</div>
${form}${gate}
<p class="sh-note">Paper only. Practice bots trade with $0 until they win every test window.</p>
</div>`;
}

export function agentGridHtml(decay, brain, { top = 6, focus } = {}) {
  const list = (decay || []).filter((s) => s && s.n).slice().sort((a, b) => (a.small - b.small) || (b.net ?? 0) - (a.net ?? 0));
  if (!list.length) return '<section class="agents2"><h2 class="sec">Bots</h2><p class="note">Bot results have not loaded yet.</p></section>';
  const ctx = { brain, focus };
  const head = list.slice(0, top).map((s) => agentCard(s, ctx)).join('');
  const rest = list.slice(top).map((s) => agentCard(s, ctx)).join('');
  return `<section class="agents2" aria-label="Bots ranked by paper profit after fees">
    <div class="sec-row"><h2 class="sec">Top bots</h2><span class="sec-note">all-time, after fees</span></div>
    <p class="agents2-hint">${esc(PRACTICE_HINT)}</p>
    <ul class="agent-grid">${head}</ul>
    ${rest ? `<details class="more" data-fold="home-bots"><summary>All ${list.length} bots</summary><ul class="agent-grid">${rest}</ul></details>` : ''}
  </section>`;
}

export function gateMeterHtml(focus) {
  const g = gateSummary(focus);
  if (!g.total) return '';
  const c = g.closest;
  const p = gateProgressOf(c);
  const segs = Array.from({ length: p.total }, (_, i) => `<i class="${i < p.good ? 'on' : ''}"></i>`).join('');
  return `<section class="gate2" aria-label="Ready for real money">
    <div class="gate2-row"><span class="gate2-q">Ready for real money?</span><b class="gate2-a ${g.passed ? 'yes' : 'no'}">${g.passed ? `${g.passed} ready` : 'Not yet'}</b></div>
    ${c ? `<div class="gate2-seg" role="img" aria-label="${esc(c.id)}: ${p.good} of ${p.total} test windows profitable">${segs}</div>
    <p class="gate2-sub">Closest: <b>${esc(c.id)}</b>, ${p.good} of ${p.total} test windows profitable. Every window has to be.</p>` : ''}
  </section>`;
}

export function gateListHtml(focus, { limit = 8 } = {}) {
  const rows = [...(focus?.near || []), ...(focus?.research || [])].filter((r) => r && r.gate && r.n);
  if (!rows.length) return '';
  const list = rows.sort((a, b) => gateProgressOf(b).ratio - gateProgressOf(a).ratio || (b.mean ?? -9) - (a.mean ?? -9)).slice(0, limit).map((r) => {
    const p = gateProgressOf(r);
    const segs = Array.from({ length: p.total }, (_, i) => `<i class="${i < p.good ? 'on' : ''}"></i>`).join('');
    return `<li><span class="gl-name">${esc(r.id)}</span><span class="gl-seg" aria-label="${p.good} of ${p.total} windows">${segs}</span><b class="is-${tone(r.mean)}">${usd(r.mean)}</b></li>`;
  }).join('');
  return `<section class="gl"><div class="sec-row"><h2 class="sec">Test windows</h2><span class="sec-note">avg per $2 bet</span></div><ul>${list}</ul></section>`;
}

// Live event log: newest open paper bets plus coin alerts, colored by family.
export function logEvents({ openDoc, alerts, limit = 8 } = {}) {
  const bets = (openDoc?.entries || []).filter((e) => e && e.openedAt).map((e) => {
    const fam = familyOf({ id: e.variant, family: e.family });
    const what = String(e.title || e.ticker || '').replace(/ price up in next 15 mins\?$/i, '');
    const px = finite(e.ask) ? ` ${Math.round(e.ask * 100)}¢` : '';
    return { at: Date.parse(e.openedAt), color: accent(fam).color, who: e.variant || e.family, text: `${String(e.side || '').toUpperCase()} ${what}${px}` };
  });
  const coins = (alerts?.sent || []).filter((a) => a && a.at).map((a) => ({ at: Date.parse(a.at), color: FAMILY.meme.color, who: 'coin alert', text: a.symbol || 'coin' }));
  return [...bets, ...coins].filter((e) => Number.isFinite(e.at)).sort((a, b) => b.at - a.at).slice(0, limit);
}

export function liveLogHtml({ openDoc, alerts, now = Date.now(), limit = 8 } = {}) {
  const ev = logEvents({ openDoc, alerts, limit });
  if (!ev.length) return '';
  const ago = (t) => { const m = Math.max(0, Math.round((now - t) / 60000)); return m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`; };
  const rows = ev.map((e) => `<li style="--ac:${e.color}"><i aria-hidden="true"></i><span class="log-who">${esc(e.who)}</span><span class="log-what">${esc(e.text)}</span><time>${ago(e.at)}</time></li>`).join('');
  return `<section class="log2" aria-label="Live paper activity"><div class="sec-row"><h2 class="sec">Live</h2><span class="sec-note">paper bets &amp; alerts</span></div><ul>${rows}</ul></section>`;
}

export function deskHomeHtml(data = {}) {
  const now = data.now ?? Date.now();
  if (data.state === 'loading' && !data.today) return '<section class="hero2" aria-busy="true"><p class="hero2-k">Paper P&amp;L</p><b class="hero2-num skel">$——</b></section>';
  return [
    botChipsHtml(data.today?.decay),
    data.beforeHero || '',
    heroHtml({ curve: data.curve, today: data.today, brain: data.brain, openN: data.openDoc?.entries?.length, now }),
    data.afterHero || '',
    statusRowHtml({ today: data.today, focus: data.focus, now }),
    agentGridHtml(data.today?.decay, data.brain, { focus: data.focus }),
    gateMeterHtml(data.focus),
    liveLogHtml({ openDoc: data.openDoc, alerts: data.alerts, now }),
  ].join('');
}
