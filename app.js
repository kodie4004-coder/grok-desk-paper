// Grok Desk UI. PAPER ONLY: the engine below moves numbers, never money.
import { DEFAULT_SETTINGS, RESEARCH_PRIOR, calibration, settingsLocked, updateSettings, strategyHealth, participationDecision, equityDrawdown } from './engine/core.js';
import { SLOT_IDS, SLOT_SPEC, slotStatus, emptySlots } from './engine/strategies.js';
import { SLOT_PRIOR } from './engine/slot-prior.js';
import { ACTIVE, activePace } from './engine/active.js';
import { PREDICT_PRIOR } from './engine/predict-prior.js';
import { KALSHI_PRIOR } from './engine/kalshi-prior.js';
import { loadKalshiBoard, reviewKalshi, quoteAge } from './engine/kalshi.js';
import { reviewArena, placePick, loadSpots, loadBook, ARENA_SIZE } from './engine/arena.js';
import { levelOf, streak, achievements } from './engine/game.js';
import { migrate, exportHistory, importHistory, historyCsv } from './engine/store.js';
import { GATE_PRIOR } from './engine/gate-prior.js';
import { MAJORS_PRIOR } from './engine/majors-prior.js';
import { createLiveSource, createReplaySource } from './engine/data.js';
import { newState, startSession, endSession, tick, mark, recap, equityNow, serialize, fmtP, short } from './engine/engine.js';
import { bestPair, scoreCoin, memeGate } from './engine/meme.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const money = (x, sign) => (x == null ? '–' : (sign && x > 0 ? '+' : x < 0 ? '−' : '') + '$' + Math.abs(x).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
function eqHtml(x) {
  const parts = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).formatToParts(Math.abs(x));
  let head = '', cents = '';
  let seen = false;
  for (const p of parts) {
    if (p.type === 'decimal') { seen = true; cents += p.value; continue; }
    if (seen && p.type === 'fraction') cents += p.value;
    else head += p.value;
  }
  return `<span class="eq ${x < 0 ? 'r' : ''}">${x < 0 ? '−' : ''}$${head}<small>${cents}</small></span>`;
}
const tm = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const dur = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m ${String(s % 60).padStart(2, '0')}s`; };

// ---------- storage (IndexedDB for state, localStorage for settings) ----------
const db = new Promise((res, rej) => { const r = indexedDB.open('grokdesk', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const idb = {
  async get(k) { const d = await db; return new Promise((res) => { const q = d.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(null); }); },
  async set(k, v) { const d = await db; return new Promise((res) => { const tx = d.transaction('kv', 'readwrite'); tx.objectStore('kv').put(v, k); tx.oncomplete = res; tx.onerror = res; }); },
};
const loadSettings = () => { try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem('gd.settings') || '{}') }; } catch { return { ...DEFAULT_SETTINGS }; } };
const saveSettings = (s) => localStorage.setItem('gd.settings', JSON.stringify(s));

const ui = { tab: 'home', tf: 'all', market: 'all', logFilter: 'all', replay: null, busy: false, notify: localStorage.getItem('gd.notify') === '1', arena: 'feed', sound: localStorage.getItem('gd.sound') === '1', coinAlerts: localStorage.getItem('gd.coinAlerts') === '1', memeJournal: [] };
let live = null;          // live state
let state = null;         // what is on screen (live or replay)
const src = createLiveSource();

async function persist() { if (live) await idb.set('state', serialize(live)); }

// ---------- toasts / notifications ----------
function toast(e) {
  const el = document.createElement('div');
  el.className = 'toast ' + (e.side === 'buy' ? 'buy' : e.pnl > 0 ? 'win' : e.pnl < 0 ? 'loss' : '');
  el.setAttribute('role', 'status');
  el.textContent = (state?.mode === 'replay' ? '[REPLAY] ' : '[PAPER] ') + e.text;
  $('#toasts').prepend(el); setTimeout(() => el.remove(), 5000);
  if (ui.notify && state?.mode !== 'replay' && 'Notification' in window && Notification.permission === 'granted' && document.hidden) {
    try { new Notification('Grok Desk (paper)', { body: e.text, icon: 'icons/icon-192.png' }); } catch {}
  }
}

// ---------- live loop ----------
async function liveTick() {
  if (!live || !live.running || ui.busy || ui.replay) return;
  ui.busy = true;
  try { await tick(live, src, Date.now(), toast); await persist(); } finally { ui.busy = false; }
  render();
}
function scanEveryMs(st) {
  if (!st?.settings) return 60000;
  return (st.settings.activeMode === true ? (st.settings.activeTickSec || ACTIVE.tickSec) : (st.settings.tickSec || 60)) * 1000;
}
async function liveMark() {
  const activeOpen = live?.settings?.activeMode === true && (live.activeOpen || []).length;
  if (!live?.running || ui.busy || ui.replay || (!live.open.length && !activeOpen)) return;
  const markSec = live.settings.markSec || 0;
  if (!(markSec > 0)) return;
  if (Date.now() - Math.max(live.lastMarkAt || 0, live.lastTickAt || 0) < markSec * 1000) return;
  ui.busy = true;
  try { await mark(live, src, Date.now(), toast); await persist(); } finally { ui.busy = false; }
  render();
}
setInterval(() => {
  if (live?.running && !ui.replay) {
    const due = Date.now() - (live.lastTickAt || 0) >= scanEveryMs(live);
    if (due) liveTick(); else liveMark();
  }
  if (ui.tab === 'home') updateTimer();
}, 1000);

// ---------- replay ----------
async function startReplay() {
  let tape;
  try {
    if (!('DecompressionStream' in window)) throw new Error('no gzip');
    const res = await fetch('replay/tape.json.gz'); if (!res.ok) throw new Error('no gz');
    tape = await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).json();
  } catch {
    try { tape = await (await fetch('replay/tape.json.gz')).json(); } // server already decoded it
    catch { tape = await (await fetch('replay/tape.json')).json(); }
  }
  const rs = createReplaySource(tape);
  const st = JSON.parse(JSON.stringify(tape.meta.initialState));
  st.mode = 'replay';
  ui.replay = { tape, i: 0, timer: null };
  state = st;
  $('#modeBadge').className = 'badge replay'; $('#modeBadge').textContent = 'REPLAY · paper, recorded';
  const b = $('#replayBanner'); b.classList.remove('hidden');
  b.innerHTML = `REPLAY of a paper session recorded ${esc(new Date(tape.meta.recordedAt).toLocaleString())} from live public data. Not live, not real money. <button class="btn" id="exitReplay" style="padding:4px 8px;font-size:12px;margin-left:6px">Exit</button>`;
  $('#exitReplay').onclick = stopReplay;
  const step = async () => {
    if (!ui.replay) return;
    const tk = tape.ticks[ui.replay.i++];
    if (!tk) { endSession(state, tape.ticks.at(-1).t); render(); return; }
    await tick(state, rs, tk.t, toast); render();
    const delay = new URLSearchParams(location.search).get('fast') === '1' ? 0 : 350;
    ui.replay.timer = setTimeout(step, delay);
  };
  render(); step();
}
function stopReplay() {
  if (ui.replay?.timer) clearTimeout(ui.replay.timer);
  ui.replay = null; state = live;
  $('#modeBadge').className = 'badge paper'; $('#modeBadge').textContent = 'PAPER MODE · fake money';
  $('#replayBanner').classList.add('hidden'); render();
}

// ---------- chart ----------
function drawChart(cv, st) {
  const dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr; const c = cv.getContext('2d'); c.scale(dpr, dpr);
  const nowT = st.running ? (st.lastTickAt || Date.now()) : (st.endedAt || st.lastTickAt || Date.now());
  const span = { '15m': 15 * 60000, '1h': 3600000, all: Infinity }[ui.tf];
  const pts = st.equity.filter((p) => nowT - p.t <= span);
  c.fillStyle = '#07090c'; c.fillRect(0, 0, W, H);
  if (pts.length < 2) { c.fillStyle = '#8a96a3'; c.font = '12px sans-serif'; c.fillText('Equity line appears after the first ticks', 12, H / 2); return; }
  const t0 = pts[0].t, t1 = pts.at(-1).t || t0 + 1;
  let lo = Math.min(...pts.map((p) => p.v), st.startBank), hi = Math.max(...pts.map((p) => p.v), st.startBank);
  const pad = Math.max(1, (hi - lo) * 0.15); lo -= pad; hi += pad;
  const X = (t) => 8 + ((t - t0) / Math.max(1, t1 - t0)) * (W - 16), Y = (v) => H - 14 - ((v - lo) / (hi - lo)) * (H - 28);
  c.strokeStyle = '#243040'; c.setLineDash([4, 4]); c.beginPath(); c.moveTo(0, Y(st.startBank)); c.lineTo(W, Y(st.startBank)); c.stroke(); c.setLineDash([]);
  const up = pts.at(-1).v >= st.startBank;
  const stroke = up ? '#3dff9a' : '#ff5d73';
  c.beginPath();
  pts.forEach((p, i) => (i ? c.lineTo(X(p.t), Y(p.v)) : c.moveTo(X(p.t), Y(p.v))));
  c.lineTo(X(pts.at(-1).t), H); c.lineTo(X(pts[0].t), H); c.closePath();
  const grad = c.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, up ? 'rgba(61,255,154,.28)' : 'rgba(255,93,115,.22)');
  grad.addColorStop(1, 'rgba(7,9,12,0)');
  c.fillStyle = grad; c.fill();
  c.beginPath();
  pts.forEach((p, i) => (i ? c.lineTo(X(p.t), Y(p.v)) : c.moveTo(X(p.t), Y(p.v))));
  c.strokeStyle = stroke; c.lineWidth = 2; c.stroke();
  const end = pts.at(-1);
  c.fillStyle = stroke; c.beginPath(); c.arc(X(end.t), Y(end.v), 3.5, 0, 7); c.fill();
  for (const m of st.markers.filter((m) => m.t >= t0)) {
    const x = X(m.t), y = Y(m.v);
    c.fillStyle = m.kind === 'buy' ? '#5aa8ff' : m.kind === 'tp' ? '#2fd27a' : m.kind === 'stop' ? '#ff5468' : '#ffc94d';
    c.beginPath();
    if (m.kind === 'stop') { c.moveTo(x - 4, y - 4); c.lineTo(x + 4, y + 4); c.moveTo(x + 4, y - 4); c.lineTo(x - 4, y + 4); c.strokeStyle = c.fillStyle; c.lineWidth = 2; c.stroke(); }
    else { c.arc(x, y, m.kind === 'buy' ? 3 : 4, 0, 7); c.fill(); }
  }
  c.fillStyle = '#8a96a3'; c.font = '10px sans-serif';
  c.fillText(money(hi - pad), 4, 11); c.fillText(money(lo + pad), 4, H - 3);
}

// ---------- views ----------
function updateTimer() {
  const el = $('#timer'); if (!el || !state) return;
  if (!state.startedAt) { el.textContent = 'no session yet'; return; }
  const end = state.running ? (state.mode === 'replay' ? state.lastTickAt : Date.now()) : state.endedAt;
  el.textContent = dur(end - state.startedAt) + (state.running ? ' · running' : ' · ended');
  const lt = $('#lastTick');
  if (lt && state.mode !== 'replay' && state.running) {
    const ago = Date.now() - (state.lastTickAt || state.startedAt);
    const every = Math.round(scanEveryMs(state) / 1000);
    lt.innerHTML = ago > (every + 30) * 1000 ? `<span class="y">Last market check ${Math.round(ago / 1000)}s ago. Phones pause background tabs; the desk only runs while this page is open.</span>` : `Next market check in ${Math.max(0, Math.round(every - ago / 1000))}s`;
  }
  const link = $('#linkState');
  if (link && state.mode !== 'replay') {
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    const limit = ((state.settings?.tickSec || 20) * 3 + 20) * 1000;
    const stale = !!(state.running && state.lastScanAt && Date.now() - state.lastScanAt > limit);
    if (offline) { link.hidden = false; link.className = 'link bad'; link.textContent = 'Offline. Quotes are stale. This page cannot trade.'; }
    else if (stale) { link.hidden = false; link.className = 'link bad'; link.textContent = 'Scan is stale. New entries wait until a market check succeeds.'; }
    else { link.hidden = true; link.textContent = ''; }
  }
}

function fmtPf(h) {
  if (!h.n) return '–';
  if (h.profitFactorInfinite) return 'no losing trades';
  if (h.profitFactor == null) return '–';
  return h.profitFactor.toFixed(2);
}
function sampleTrades(st) {
  if (Array.isArray(st.edgeBook) && st.edgeBook.length) return st.edgeBook;
  return st.closed || [];
}
function healthCard(st) {
  const trades = sampleTrades(st);
  const h = strategyHealth(trades);
  const part = participationDecision(h, st.settings);
  const label = { full: 'FULL SIZE', reduced: 'HALF SIZE', explore: 'HALF SIZE · EXPLORING', flat: 'FLAT · ENTRIES OFF', off: 'EDGE GATE OFF · FULL SIZE' }[part.mode] || part.mode;
  const sess = st.equity && st.equity.length > 1 ? equityDrawdown(st.equity, st.startBank) : null;
  const drag = h.costDrag == null ? (h.n ? 'no gross profit' : '–') : `${Math.round(h.costDrag * 100)}% of gross`;
  const ci = h.ci80 ? `${money(h.ci80[0], true)} to ${money(h.ci80[1], true)}` : (h.n ? `need 8 closed trades (have ${h.n})` : '–');
  const exp = h.expectancyPct == null || !h.n ? '' : ` (${(h.expectancyPct * 100).toFixed(2)}% of size)`;
  const strategies = RESEARCH_PRIOR.strategies || [];
  return `<div class="card health ${part.mode}">
    <h2>Strategy health</h2>
    <p class="health-status" role="status">${esc(label)}</p>
    <p class="note">${esc(part.reason)}</p>
    <dl class="metrics">
      <div><dt>Expectancy</dt><dd class="${h.n && h.expectancy > 0 ? 'g' : h.n && h.expectancy < 0 ? 'r' : ''}">${h.n ? money(h.expectancy, true) + exp : '–'}</dd></div>
      <div class="wide"><dt>80% interval</dt><dd>${esc(ci)}</dd></div>
      <div><dt>Profit factor</dt><dd>${fmtPf(h)}</dd></div>
      <div><dt>Realized drawdown</dt><dd>${h.n ? money(h.maxDrawdown) : '–'}</dd></div>
      <div><dt>Sample size</dt><dd>${h.n}<span class="note"> / ${st.settings.edgeMinN || 30}</span></dd></div>
      <div><dt>Cost drag</dt><dd>${esc(drag)}</dd></div>
      <div><dt>Win rate</dt><dd>${h.n ? Math.round(h.winRate * 100) + '%' : '–'}</dd></div>
    </dl>
    ${sess ? `<p class="note" style="margin-top:8px">This session's equity drawdown is ${money(sess.maxDrawdown)} from the peak.</p>` : ''}
    <h3 class="subh">Holdout study</h3>
    ${strategies.length ? `<ul class="study">${strategies.map((s) => `<li><span class="study-name">${esc(s.name)}</span><span>n ${s.n} · ${s.nPools} pools</span><span>expectancy ${money(s.mean, true)}</span><span>90% ${money(s.lo, true)} to ${money(s.hi, true)}</span>${s.note ? `<span class="note">${esc(s.note)}</span>` : ''}</li>`).join('')}</ul>` : '<p class="note">No study table in this build yet.</p>'}
    <p class="note" style="margin-top:8px">The 80% interval treats trades as independent, so clustered losses make it look too sure. Size is 0, half, or the full amount you set. A loss never increases it. One lead's confidence does not change it.</p>
  </div>`;
}

function scanCard(st) {
  const chips = ['all', 'solana', 'ethereum', 'base', 'bsc', 'arbitrum', 'predict'];
  const ago = st.lastScanAt ? Math.max(0, Math.round((Date.now() - st.lastScanAt) / 1000)) : null;
  const feed = (st.scan?.feed || []).filter((f) => ui.market === 'all' || f.chain === ui.market);
  const preds = st.predictions || [];
  const rows = ui.market === 'predict'
    ? (preds.length ? preds.map((p) => `<li><span><b>${esc(p.venue)}</b><br><span class="note">${esc(p.title)}</span></span><span class="note">${p.price == null ? '—' : esc(String(p.price))}</span></li>`).join('') : '<li><span class="note">No prediction markets on the last scan.</span></li>')
    : (feed.length ? feed.map((f) => `<li><span><b>${esc(f.symbol)}</b> <span class="note">${esc(f.chain)} · ${esc(f.dex || '')}</span></span><span class="note">${f.liq ? '$' + Math.round(f.liq).toLocaleString() : ''}</span></li>`).join('') : '<li><span class="note">No quotes on this filter yet. Start a paper session to scan.</span></li>');
  return `<div class="card"><div class="row"><h2 style="margin:0">Scan</h2><span class="note" id="scanAge">${st.scan?.markets || 0} markets · ${st.scan?.chains || 0} chains${ago == null ? '' : ` · last ${ago}s ago`}</span></div>
    <div class="chips">${chips.map((k) => `<button type="button" data-mkt="${k}" class="${ui.market === k ? 'on' : ''}">${k}</button>`).join('')}</div>
    <ul class="feed">${rows}</ul>
    ${st.scan?.note ? `<p class="note">${esc(st.scan.note)}</p>` : '<p class="note">Boost lists are paid promotion. They are a way to see more markets, not a reason to buy. Prediction rows are read-only.</p>'}
  </div>`;
}
function spark(values) {
  if (!values || values.length < 2) return '<p class="empty">No sparkline yet. It draws after two closed paper trades.</p>';
  const w = 280, h = 42;
  let acc = 0;
  const pts = values.map((v) => (acc += v));
  const min = Math.min(0, ...pts), max = Math.max(0, ...pts);
  const d = pts.map((v, i) => {
    const x = (i / (pts.length - 1)) * (w - 4) + 2;
    const y = h - 6 - ((v - min) / ((max - min) || 1)) * (h - 12);
    return `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(' ');
  const up = pts.at(-1) >= pts[0];
  return `<svg class="spark ${up ? 'up' : 'down'}" viewBox="0 0 ${w} ${h}" role="img" aria-label="Cumulative paper P&amp;L for this slot"><path d="${d}" /></svg>`;
}
function whyCard(st) {
  const rows = (st.decisions || []).slice(-8).reverse();
  if (!rows.length) return `<div class="card"><h2>Why</h2><p class="empty">No takes or skips yet. Start a paper session and this list will say why a slot traded or passed.</p></div>`;
  return `<div class="card"><h2>Why</h2><ul class="feed">${rows.map((d) => `<li><span><b>${esc(d.symbol || '?')}</b> <span class="tag ${d.action === 'take' ? 'normal' : 'off'}">${esc(d.action)}</span><br><span class="note">${esc(d.slot || '')} · ${esc(d.reason || '')}</span></span></li>`).join('')}</ul></div>`;
}
function leaderCard(st) {
  const rows = SLOT_IDS.map((id) => {
    const spec = SLOT_SPEC[id];
    const book = st.slots?.[id]?.book || [];
    const h = strategyHealth(book);
    const stt = slotStatus(book, st.settings || {});
    const off = !!(st.slots?.[id]?.off);
    const edge = SLOT_PRIOR.edges?.[id] === true || stt.mode === 'promoted';
    const bucket = off ? 'off' : edge ? 'normal' : 'exploration';
    const drag = h.costDrag == null ? '—' : `${Math.round(h.costDrag * 100)}%`;
    const ci = h.ci80 ? `${money(h.ci80[0], true)} to ${money(h.ci80[1], true)}` : '—';
    const priorRow = (SLOT_PRIOR.rows || []).find((r) => r.id === id);
    const hold = priorRow ? `Latest unseen window n ${priorRow.n} · ${money(priorRow.mean, true)} · 90% ${money(priorRow.lo, true)} to ${money(priorRow.hi, true)}` : 'Walk-forward numbers are not in this build yet.';
    const line = spark(book.map((t) => t.pnl));
    return `<li class="slot"><div class="row"><b>${esc(spec.label)}</b><span class="tag ${bucket}">${bucket}</span></div>${line}<p class="note">${esc(spec.blurb)}</p><p class="note">${hold}</p><p class="note">${h.n ? `This phone: n ${h.n} · expectancy ${money(h.expectancy, true)} · 80% ${ci} · win ${Math.round(h.winRate * 100)}% · drawdown ${money(h.maxDrawdown)} · cost drag ${drag}` : 'No closed paper trades on this phone yet.'}${off ? ' Slot is off.' : ''}</p></li>`;
  }).join('');
  return `<div class="card"><h2>Strategy slots</h2><p class="note">${esc(SLOT_PRIOR.summary || '')}</p><ul class="feed">${rows}</ul></div>`;
}
function studyRows(rows) {
  if (!rows.length) return '<p class="empty">No study row yet.</p>';
  return `<ul class="feed">${rows.map((r) => `<li class="slot"><div class="row"><b>${esc(r.label || r.id)}</b><span class="tag ${r.graduated ? 'normal' : 'exploration'}">${r.graduated ? 'graduated' : 'exploration'}</span></div><p class="note">Trades ${r.n ?? 0} · windows ${r.windows ?? 0}${r.mean == null ? '' : ` · expectancy ${money(r.mean, true)}`}${r.lo == null ? '' : ` · lower bound ${money(r.lo, true)}`}</p></li>`).join('')}</ul>`;
}
function majorsCard() {
  return `<div class="card"><h2>Liquid majors</h2><p class="note">${esc(MAJORS_PRIOR.summary || '')}</p><p class="note">Expectancy is dollars on a $25 paper trade after a 0.30% round trip. The lower bound is the 90% bootstrap over the whole sample. Graduation still needs three separate weeks of 20 trades.</p>${studyRows(MAJORS_PRIOR.rows || [])}</div>`;
}
function cents(x) {
  return typeof x === 'number' && Number.isFinite(x) ? x.toFixed(2) : '—';
}
function leftLabel(close, now) {
  const ms = Date.parse(close) - now;
  if (!Number.isFinite(ms)) return '—';
  const s = Math.round(ms / 1000);
  const sign = s < 0 ? '−' : '';
  const a = Math.abs(s);
  return `${sign}${Math.floor(a / 60)}m ${String(a % 60).padStart(2, '0')}s`;
}
function kalshiCard(st) {
  const board = st.kalshiBoard || {};
  const now = Date.now();
  const rows = (board.markets || [])
    .filter((m) => !m.result)
    .sort((a, b) => Date.parse(a.closeTime) - Date.parse(b.closeTime))
    .slice(0, 12);
  const k1 = (KALSHI_PRIOR.rows || []).find((r) => r.id === 'k1');
  const edge = KALSHI_PRIOR.edges?.k1 === true;
  const controls = KALSHI_PRIOR.controls || {};
  const ctl = (name, row) => row && row.n ? `${name} n ${row.n} · win ${Math.round(row.winRate * 100)}% · mean ${money(row.mean, true)}` : `${name} not in this build`;
  const list = rows.length ? rows.map((m) => `<li class="slot"><div class="row"><b>${esc(m.series || '')}</b><span class="note">${leftLabel(m.closeTime, now)}</span></div><p class="note">${esc(m.title || '')}${m.floorStrike == null ? '' : ` · target ${esc(String(m.floorStrike))}`}</p><p class="kmeta">Up ${cents(m.yesBid)} / ${cents(m.yesAsk)} · Down ${cents(m.noBid)} / ${cents(m.noAsk)} · vol ${m.volume ? Math.round(m.volume).toLocaleString() : '—'}</p></li>`).join('') : '<li><span class="empty">No open 15-minute market in the latest snapshot.</span></li>';
  const log = (st.kalshiLog || []).slice(-6).reverse();
  const why = log.length ? log.map((d) => `<li><span><b>${esc(d.title || 'K1')}</b> <span class="tag ${d.action === 'take' ? 'normal' : 'off'}">${esc(d.action)}</span><br><span class="note">${esc(d.reason || '')}</span></span></li>`).join('') : '<li><span class="empty">No K1 take or skip yet. A bet needs a quote under two minutes old and 3 to 5 minutes left.</span></li>';
  const phone = st.kalshiClosed || [];
  const phoneNet = phone.reduce((a, t) => a + (t.pnl || 0), 0);
  const age = quoteAge(board.fetchedAt, now);
  const ageText = age.ms == null ? 'Kalshi quote age unknown' : `Kalshi quote is ${age.label} old`;
  return `<div class="card"><h2>Kalshi 15-minute</h2>
    <p class="age ${age.stale ? 'stale' : 'fresh'}" role="status">${esc(ageText)} · ${age.stale ? 'STALE' : 'fresh'}</p>
    <p class="note">The public API refuses every page Origin except https://kalshi.com. This board reads <code>data/kalshi-15m.json</code>. A quote older than 15 minutes is stale. Collected ${esc(board.fetchedAt || 'not loaded')} · ${esc(board.via || 'snapshot')}.</p>
    <ul class="feed">${list}</ul></div>
  <div class="card"><div class="row"><h2 style="margin:0">K1 late favorite</h2><span class="tag ${edge ? 'normal' : 'exploration'}">${edge ? 'graduated' : 'exploration'}</span></div>
    <p class="note">${esc(KALSHI_PRIOR.summary || '')}</p>
    <p class="note">${k1 ? `Study trades ${k1.n} · days ${k1.windows} · win ${k1.winRate == null ? '—' : Math.round(k1.winRate * 100) + '%'} · ask ${k1.avgAsk == null ? '—' : k1.avgAsk.toFixed(3)} · mean ${k1.mean == null ? '—' : money(k1.mean, true)} · lower bound ${k1.lo == null ? '—' : money(k1.lo, true)}` : 'No study row yet.'}</p>
    <p class="note">${esc(ctl('Always Up', controls.alwaysUp))} · ${esc(ctl('Coin-flip', controls.coinFlip))}</p>
    <p class="note">This phone: ${phone.length} settled · net ${money(phoneNet, true)} · ${(st.kalshiOpen || []).length} open. Fixed $5. Not part of the coin edge book.</p>
    <ul class="feed">${why}</ul></div>`;
}
function predictMark(p) {
  if (!(p.mark > 0 && p.mark < 1) || !(p.price > 0)) return null;
  const nowPx = p.side === 'yes' ? p.mark : 1 - p.mark;
  return (nowPx - p.price) * p.sizeUsd;
}
function predictView(st) {
  const open = st.predictOpen || [];
  const log = (st.predictLog || []).slice(-8).reverse();
  const rules = [
    { id: 'p1', label: 'Favorite, one week out' },
    { id: 'p2', label: 'Longshot fade, one week out' },
    { id: 'p3', label: 'Late favorite' },
    { id: 'p4', label: 'Cross-venue' },
  ];
  const cards = rules.map((rule) => {
    const row = (PREDICT_PRIOR.rows || []).find((r) => r.id === rule.id);
    const live = open.filter((p) => p.rule === rule.id);
    const edge = PREDICT_PRIOR.edges?.[rule.id] === true;
    const stat = rule.id === 'p4'
      ? 'Cross-venue gaps are still untested. The 15-minute board is a separate rule.'
      : (row ? `Trades ${row.n} · windows ${row.windows} · expectancy ${row.mean == null ? '—' : money(row.mean, true)} per $1 · lower bound ${row.lo == null ? '—' : money(row.lo, true)}` : 'No resolved sample in this build yet.');
    return `<li class="slot"><div class="row"><b>${esc(rule.label)}</b><span class="tag ${edge ? 'normal' : 'exploration'}">${edge ? 'graduated' : 'exploration'}</span></div><p class="note">${esc(stat)}</p><p class="note">${live.length ? live.map((p) => { const mk = predictMark(p); return `${esc(p.title)} · ${esc(p.side)} ${p.price.toFixed(3)} · $${p.sizeUsd.toFixed(2)} paper${mk == null ? '' : ` · mark ${money(mk, true)}`}`; }).join('<br>') : 'No open paper bet on this phone.'}</p></li>`;
  }).join('');
  const why = log.length
    ? log.map((d) => `<li><span><b>${esc(d.title || d.rule || '?')}</b> <span class="tag ${d.action === 'take' ? 'normal' : 'off'}">${esc(d.action)}</span><br><span class="note">${esc(d.rule || '')} · ${esc(d.reason || '')}</span></span></li>`).join('')
    : '<li><span class="empty">No prediction takes or skips yet. Start a paper session. A bet is recorded only inside a pre-registered window.</span></li>';
  const quotes = (st.predictions || []).slice(0, 8);
  return `${kalshiCard(st)}
  <div class="card"><h2>Prediction</h2><p class="note">${esc(PREDICT_PRIOR.summary || 'Paper quotes only. No wallet.')}</p><p class="note">These bets are a separate paper book. They do not move the coin balance. A session end does not pay 1 or 0; only a resolution does, and that is what the study counts.</p><ul class="feed">${cards}</ul></div>
  <div class="card"><h2>Why</h2><ul class="feed">${why}</ul></div>
  <div class="card"><h2>Live quotes</h2><ul class="feed">${quotes.length ? quotes.map((p) => `<li><span><b>${esc(p.venue)}</b><br><span class="note">${esc(p.title)}</span></span><span class="note">${p.price == null ? '—' : esc(String(p.price))}</span></li>`).join('') : '<li><span class="empty">No prediction quote on the last scan.</span></li>'}</ul></div>`;
}
function activeCard(st) {
  const on = st.settings?.activeMode === true;
  const pace = activePace();
  const open = st.activeOpen || [];
  const closed = st.activeClosed || [];
  const fees = closed.reduce((a, t) => a + (t.fees || 0), 0) + open.reduce((a, t) => a + (t.fee || 0), 0);
  const net = closed.reduce((a, t) => a + (t.pnl || 0), 0);
  const paused = st.activePausedDay && st.activePausedDay === new Date().toISOString().slice(0, 10);
  const rows = (st.activeFeed || []).slice(-8).reverse();
  const list = rows.length
    ? rows.map((d, i) => `<li class="${i === 0 ? 'in' : ''}"><span><b>${esc(d.symbol || d.rule || 'scan')}</b> <span class="tag explore">Active (exploration)</span><br><span class="note">${esc(d.text || '')}</span></span></li>`).join('')
    : '<li><span class="empty">Feed starts when a paper session is running. Entries, exits, and skips show up here. They are not the gated book.</span></li>';
  return `<div class="card active-card">
    <div class="row"><h2 style="margin:0">Active mode</h2><button type="button" class="switch ${on ? 'on' : ''}" id="activeToggle" aria-pressed="${on}">${on ? 'ON' : 'OFF'}</button></div>
    <p class="tag explore">Active (exploration)</p>
    <p class="note">Separate paper book. These trades do not count toward the edge gate or graduation. Each fill is $${ACTIVE.sizeUsd} and a loss does not raise that. A $${ACTIVE.dayLossUsd} daily drawdown pauses new Active entries until the next UTC day. Fees are on every line.</p>
    <p class="note">Scan every ${pace.tickSec}s while this is on. About ${Math.round(pace.steadyPerHour)} paper entries an hour once 12 positions are turning over, and a feed line every scan.</p>
    <div class="grid" style="margin:8px 0">
      <div class="stat"><small>Open</small><b>${open.length}</b><span class="note">of ${ACTIVE.maxOpen}</span></div>
      <div class="stat"><small>Closed net</small><b class="${net < 0 ? 'r' : 'g'}">${money(net, true)}</b></div>
      <div class="stat"><small>Fees shown</small><b>${money(fees)}</b></div>
    </div>
    ${paused ? '<p class="note r">Paused for the day. The drawdown cap hit. Size is still $5.</p>' : ''}
    <ul class="feed">${list}</ul>
  </div>`;
}
function paintTicker(st) {
  const bar = $('#ticker');
  const track = $('#tickerTrack');
  if (!bar || !track) return;
  const rows = (st.activeFeed || []).slice(-10);
  if (!rows.length || st.mode === 'replay') { bar.hidden = true; track.textContent = ''; return; }
  const text = rows.map((d) => d.text).join('   ·   ');
  track.innerHTML = `<span>${esc(text)}</span><span>${esc(text)}</span>`;
  bar.hidden = false;
}
function blip(win) {
  if (!ui.sound) return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  const ctx = new Ctx();
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.frequency.value = win ? 740 : 180;
  g.gain.value = 0.04;
  o.connect(g); g.connect(ctx.destination);
  o.start();
  o.stop(ctx.currentTime + 0.12);
}
function burst(kind) {
  const fx = document.getElementById('fx');
  if (!fx) return;
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  fx.className = reduce ? 'fx' : `fx ${kind}`;
  fx.innerHTML = reduce ? '' : Array.from({ length: 16 }, (_, i) => `<i style="--i:${i}"></i>`).join('');
  if (navigator.vibrate) navigator.vibrate(kind === 'win' ? [12, 28, 12] : 8);
  blip(kind === 'win');
  setTimeout(() => { fx.className = 'fx'; fx.innerHTML = ''; }, 1000);
}
function countdown(close, now) {
  const s = Math.max(0, Math.round((Date.parse(close) - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function cockpit(st) {
  const now = Date.now();
  const day = new Date(now).toISOString().slice(0, 10);
  const today = (st.arenaClosed || []).concat(st.picksClosed || []).filter((t) => new Date(t.closedAt || 0).toISOString().slice(0, 10) === day);
  const pnl = today.reduce((a, t) => a + (t.pnl || 0), 0);
  const last = (st.arenaLog || []).slice().reverse().find((d) => d.action === 'settle');
  const soon = (st.kalshiBoard?.markets || []).filter((m) => !m.result && Date.parse(m.closeTime) > now).sort((a, b) => Date.parse(a.closeTime) - Date.parse(b.closeTime))[0];
  const openN = (st.arenaOpen || []).length + (st.picksOpen || []).length;
  const xp = st.game?.xp || 0;
  const loading = !st.kalshiBoard;
  const age = st.kalshiBoard ? quoteAge(st.kalshiBoard.fetchedAt, now) : null;
  return `<section class="card cockpit arcade" aria-label="Paper cockpit">
    <div class="row"><h2 style="margin:0">Cockpit</h2><span class="tag explore">PAPER · not real money</span></div>
    ${loading ? '<div class="skel" aria-busy="true" aria-label="Loading markets"></div>' : ''}
    <div class="grid">
      <div class="stat"><small>Live now</small><b>${openN}</b><span class="note">open</span></div>
      <div class="stat"><small>Today</small><b class="${pnl > 0 ? 'g' : pnl < 0 ? 'r' : ''}">${money(pnl, true)}</b><span class="note">after fees</span></div>
      <div class="stat"><small>Streak</small><b>${streak(st.game || {}, now)}d</b><span class="note">Level ${levelOf(xp)} · ${xp} XP</span></div>
    </div>
    ${age ? `<p class="age ${age.stale ? 'stale' : 'fresh'}" role="status">Kalshi quote ${esc(age.label)} · ${age.stale ? 'STALE' : 'fresh'}</p>` : ''}
    <p class="lvl">${soon ? `Next close ${countdown(soon.closeTime, now)}` : 'Waiting for the next window'}</p>
    <p class="note">${last ? `Just settled: ${esc(last.title || last.rule)} · ${esc(last.reason || '')}` : 'Nothing has settled on this phone yet.'}</p>
    <button class="btn pri wide" id="goArena" type="button">Open the arena</button>
    <div class="row" style="margin-top:8px"><button type="button" class="btn" data-tabjump="agents">Agents</button><button type="button" class="btn" data-tabjump="activity">Log</button></div>
  </section>`;
}
function arenaView(st) {
  const now = Date.now();
  const seg = ui.arena;
  const labels = { feed: 'Feed', pick: 'Pick', badges: 'Badges', score: 'Score' };
  const tabs = Object.keys(labels).map((k) => `<button type="button" data-arena="${k}" class="${seg === k ? 'on' : ''}" aria-current="${seg === k ? 'true' : 'false'}">${labels[k]}</button>`).join('');
  const sound = `<button type="button" id="soundBtn" class="switch ${ui.sound ? 'on' : ''}" aria-pressed="${ui.sound}">${ui.sound ? 'Sound on' : 'Sound off'}</button>`;
  if (seg === 'badges') {
    const rows = achievements(st).map((a) => `<li class="slot"><div class="row"><b>${esc(a.label)}</b><span class="tag ${a.on ? 'normal' : 'off'}">${a.on ? 'earned' : 'locked'}</span></div></li>`).join('');
    return `<div class="card arcade"><div class="row"><h2 style="margin:0">Badges</h2>${sound}</div><p class="note">Badges mark paper habits. A win does not mint a bigger badge.</p><div class="seg">${tabs}</div><ul class="feed">${rows}</ul></div>`;
  }
  if (seg === 'score') return scoreView(st, tabs, sound);
  if (seg === 'pick') {
    const age = quoteAge(st.kalshiBoard?.fetchedAt, now);
    const rows = (st.kalshiBoard?.markets || []).filter((m) => !m.result && Date.parse(m.closeTime) > now).sort((a, b) => Date.parse(a.closeTime) - Date.parse(b.closeTime)).slice(0, 8);
    const list = rows.map((m) => `<li class="slot"><div class="row"><b>${esc(m.series || m.ticker)}</b><span class="note">${countdown(m.closeTime, now)}</span></div><p class="note">${esc(m.title || '')} · PAPER chip $${ARENA_SIZE}</p><div class="row"><button type="button" class="btn pri" data-pick="yes" data-ticker="${esc(m.ticker)}">Up</button><button type="button" class="btn" data-pick="no" data-ticker="${esc(m.ticker)}">Down</button></div></li>`).join('');
    const empty = age.stale ? `Snapshot is ${esc(age.label)} old and marked STALE. No open window to pick.` : 'No live 15-minute market in the snapshot.';
    const mine = (st.picksOpen || []).concat(st.picksClosed || []).slice(-6).reverse().map((p) => `<li><span><b>${esc(p.title || p.ticker)}</b> ${esc(p.side)} $${p.sizeUsd}<br><span class="note">${p.pnl == null ? 'open' : money(p.pnl, true) + ' after fees'}</span></span></li>`).join('');
    return `<div class="card arcade"><div class="row"><h2 style="margin:0">Pick a side</h2>${sound}</div><p class="note">One $${ARENA_SIZE} paper chip. A loss does not raise the next chip. Bots are on the feed.</p><div class="seg">${tabs}</div><ul class="feed">${list || `<li><span class="empty">${empty}</span></li>`}</ul><h2>Your paper</h2><ul class="feed">${mine || '<li><span class="empty">No picks yet.</span></li>'}</ul></div>`;
  }
  const feed = (st.arenaLog || []).slice(-10).reverse();
  const won = feed.find((d) => d.won);
  const soon = (st.kalshiBoard?.markets || []).filter((m) => !m.result && Date.parse(m.closeTime) > now).sort((a, b) => Date.parse(a.closeTime) - Date.parse(b.closeTime))[0];
  const spots = Object.entries(st.spots || {}).slice(0, 6).map(([k, v]) => `<span class="chip">${esc(k)} ${v.px?.toFixed ? v.px.toFixed(2) : esc(v.px)}</span>`).join('');
  const rows = feed.map((d, i) => `<li class="${i === 0 ? 'in' : ''}"><span><b>${esc(d.title || d.rule)}</b> <span class="tag ${d.won ? 'normal' : 'explore'}">${esc(d.action)}</span><br><span class="note">${esc(d.rule)} · ${esc(d.reason || '')}</span></span></li>`).join('');
  return `<div class="card arcade"><div class="row"><h2 style="margin:0">Arena feed</h2>${sound}</div>${won ? '<p class="lvl">PAPER WIN</p>' : ''}<p class="tag explore">PAPER exploration · not the edge gate</p><p class="note">${st.arenaPausedDay ? 'Paused for the day. Size stays $2.' : 'Bots bet $2. Estimates are Coinbase or OKX spots, not Kalshi prints.'}</p><p class="note">${spots || 'Spot estimates load with the arena.'}</p>
    ${st.arenaError ? `<p class="note r">${esc(st.arenaError)}</p>` : ''}
    <p class="lvl">${soon ? `Next close ${countdown(soon.closeTime, now)}` : 'Waiting for the next window'}</p>
    <p class="note">${(st.arenaLog || []).length} paper lines · ${(st.kalshiBoard?.markets || []).filter((m) => !m.result && Date.parse(m.closeTime) > now).length} windows still open.</p><div class="seg">${tabs}</div><ul class="feed">${rows || '<li><span class="empty">The feed fills as windows open. Countdown is on each market in Pick.</span></li>'}</ul></div>`;
}
function scoreView(st, tabs, sound) {
  const rules = GATE_PRIOR.rules || [];
  const gate = rules.map((r) => `<li class="slot"><div class="row"><b>${esc(r.label)}</b><span class="tag ${r.graduated ? 'normal' : 'off'}">${r.graduated ? 'passed' : 'not ready'}</span></div><p class="note">${esc(r.venue || '')} · ${esc(r.windowLabel || '')} · n ${r.n ?? 0} · mean ${r.mean == null ? '—' : money(r.mean, true)} · low ${r.lo == null ? '—' : money(r.lo, true)}</p>${r.note ? `<p class="note">${esc(r.note)}</p>` : ''}</li>`).join('');
  const phone = (st.arenaClosed || []).concat(st.picksClosed || []);
  const net = phone.reduce((a, t) => a + (t.pnl || 0), 0);
  const fees = phone.reduce((a, t) => a + (t.fees || 0), 0);
  const by = new Map();
  for (const t of phone) {
    const row = by.get(t.rule) || { n: 0, pnl: 0, fees: 0 };
    row.n += 1; row.pnl += t.pnl || 0; row.fees += t.fees || 0;
    by.set(t.rule, row);
  }
  const race = [...by.entries()].sort((a, b) => b[1].pnl - a[1].pnl).map(([rule, row]) => `<li><span><b>${esc(rule)}</b><br><span class="note">n ${row.n} · fees ${money(row.fees)} · PAPER</span></span><b class="${row.pnl >= 0 ? 'g' : 'r'}">${money(row.pnl, true)}</b></li>`).join('');
  return `<div class="card arcade"><div class="row"><h2 style="margin:0">Honest scoreboard</h2>${sound || ''}</div>
    <p class="tag explore">PAPER · after fees · not real money</p>
    <p class="note">${esc(GATE_PRIOR.summary || '')} Crypto and Kalshi means are on a $2 paper bet. The 13F copy is on $100 paper per name, entered on the filing date.</p>
    <div class="hype"><b>Hype check.</b> Posts that say a bot turned $68 into $500k are not a track record. This desk does not copy them. A scalp that cannot pay the fee is a loss, even if the screenshot looks green.</div>
    <h2>Ready for real money?</h2>
    <p class="note">Informational only. live_execution is disabled. Passing a study does not turn on a wallet.</p>
    <ul class="feed">${gate || '<li><span class="empty">No gate table in this build yet.</span></li>'}</ul>
    <h2>This phone, arena only</h2>
    <p class="note">n ${phone.length} · net ${money(net, true)} · fees ${money(fees)}. These trades are not in the edge gate.</p>
    <ul class="feed">${race || '<li><span class="empty">No settled arena bets on this phone yet.</span></li>'}</ul>
    ${tabs ? `<div class="seg">${tabs}</div>` : ''}</div>`;
}
function home(st) {
  const r = st.startedAt ? recap(st, Date.now()) : null;
  const eq = equityNow(st), net = eq - st.startBank;
  const wins = st.closed.filter((t) => t.pnl > 0).length, losses = st.closed.length - wins;
  const realized = st.closed.reduce((a, t) => a + t.pnl, 0), fees = st.closed.reduce((a, t) => a + t.fees, 0);
  const unreal = st.open.reduce((a, p) => a + (p.qty * (p.lastPrice ?? p.entryMid) * (1 - st.settings.feePct / 200) - p.sizeUsd), 0);
  const isReplay = st.mode === 'replay';
  return `
  ${cockpit(st)}
  ${morningCard()}
  ${activeCard(st)}
  ${st.halted ? `<div class="halt"><b>New entries halted.</b> ${esc(st.haltReason)}</div>` : ''}
  <div class="card hero ${net < 0 ? 'down' : ''}">
    <div class="row"><h2 style="margin:0">${isReplay ? 'Replay balance' : 'Paper balance'}</h2><span class="note" id="timer"></span></div>
    ${eqHtml(eq)}
    <div class="row" style="margin-top:8px"><span class="pnlchip ${net < 0 ? 'dn' : 'up'}">${money(net, true)} · ${((eq / st.startBank - 1) * 100).toFixed(2)}%</span><span class="note">${(eq / st.startBank).toFixed(3)}× of ${money(st.startBank)} paper</span></div>
    <div class="grid" style="margin-top:10px">
      <div class="stat"><small>Closed trades</small><b>${st.closed.length}</b><span class="note">${st.open.length} open</span></div>
      <div class="stat"><small>Green / red</small><b><span class="g">${wins}</span> / <span class="r">${losses}</span></b></div>
      <div class="stat"><small>Win rate</small><b>${st.closed.length ? Math.round((100 * wins) / st.closed.length) + '%' : '–'}</b></div>
    </div>
    <div class="note" id="lastTick" style="margin-top:8px"></div>
  </div>
  <details class="card fold"><summary>Desk detail</summary><div class="fold-body">
  ${healthCard(st)}
  ${scanCard(st)}
  ${leaderCard(st)}
  ${majorsCard()}
  ${whyCard(st)}
  </div></details>
  <div class="card">
    <div class="row" style="margin-bottom:8px"><h2 style="margin:0">Equity</h2>
      <div class="seg" style="width:170px">${['15m', '1h', 'all'].map((k) => `<button data-tf="${k}" class="${ui.tf === k ? 'on' : ''}">${k === 'all' ? 'All' : k}</button>`).join('')}</div></div>
    <canvas id="chart"></canvas>
    <div class="note" style="margin-top:6px"><span class="b">●</span> buy <span class="g">●</span> take profit <span class="r">✕</span> stop <span class="y">●</span> other exit · dashed = start</div>
  </div>
  ${isReplay ? '' : `<div class="card">${st.running
    ? `<button class="btn dng wide" id="endBtn">End session</button><div class="note" style="margin-top:8px">Settings are locked until you end it. Rules never loosen mid-session.</div>`
    : `<button class="btn pri wide" id="startBtn">${st.startedAt ? 'Run again (new session)' : 'Start paper session'}</button>
       <button class="btn wide" id="replayBtn" style="margin-top:8px">Watch replay of a recorded session</button>
       <div class="note" style="margin-top:8px">Uses live Solana market data and fake money. Bank ${money(st.settings.bank)} · change it in Settings.</div>`}</div>`}
  ${st.recap ? recapCard(st.recap, isReplay) : ''}
  <div class="card"><h2>Honesty panel</h2>
    <table>
      <tr><td>Realized P&L (after fees)</td><td class="${realized >= 0 ? 'g' : 'r'}">${money(realized, true)}</td></tr>
      <tr><td>Before fees/slippage</td><td>${money(realized + fees, true)}</td></tr>
      <tr><td>Fees + slippage paid (${st.settings.feePct}% round trip${st.settings.impactModel ? ' plus size/liquidity impact' : ''})</td><td class="r">${money(-fees)}</td></tr>
      <tr><td>Unrealized (open, marked to live price, exit fee included)</td><td class="${unreal >= 0 ? 'g' : 'r'}">${money(unreal, true)}</td></tr>
      <tr><td>Win rate</td><td>${st.closed.length ? `${wins}/${st.closed.length} (${Math.round((100 * wins) / st.closed.length)}%)` : 'no closed trades'}</td></tr>
      <tr><td>Data errors this session</td><td>${st.errors}</td></tr>
    </table>
    <div class="note" style="margin-top:6px">Paper fills use the polled price. Open positions reprice every ${st.settings.markSec || st.settings.tickSec}s; pool discovery stays on ${st.settings.tickSec}s. A stop can still fill worse than its level between checks. The walk-forward study fills stops at the minute low, which is harsher than this desk.</div>
  </div>
  <div class="card"><h2>Open positions (${st.open.length})</h2>
    ${st.open.length ? st.open.map((p) => { const ch = ((p.lastPrice ?? p.entryMid) / p.entryMid - 1) * 100; return `<div class="pos"><div><b>${esc(p.symbol)}</b> <span class="chip">${p.source}</span><br><span class="note">${money(p.sizeUsd)} @ ${fmtP(p.entryMid)} · stop ${fmtP(p.stop)} · tp ${fmtP(p.tp)}</span></div><div style="text-align:right"><b class="${ch >= 0 ? 'g' : 'r'}">${ch >= 0 ? '+' : ''}${ch.toFixed(2)}%</b><br><span class="note">${fmtP(p.lastPrice)}</span></div></div>`; }).join('') : '<div class="note">None.</div>'}
  </div>
  <div class="card"><h2>Closed trades (${st.closed.length})</h2>
    ${st.closed.slice().reverse().slice(0, 25).map((t) => `<div class="pos"><div><b>${esc(t.symbol)}</b> <span class="chip">${t.source}</span><br><span class="note">${esc(t.exitReason)} · ${tm(t.closedAt)}</span></div><div style="text-align:right"><b class="${t.pnl >= 0 ? 'g' : 'r'}">${money(t.pnl, true)}</b><br><span class="note">${t.retPct}%</span></div></div>`).join('') || '<div class="note">None yet.</div>'}
  </div>`;
}

function recapCard(r, isReplay) {
  return `<div class="card recap"><h2>${isReplay ? 'Replay recap' : 'Session recap'} · ${esc(r.sessionId)}</h2>
  <div class="grid">
    <div class="stat"><small>Duration</small><b>${r.durationMin}m</b></div>
    <div class="stat"><small>Trades</small><b>${r.trades}</b></div>
    <div class="stat"><small>Win rate</small><b>${r.winRate}%</b></div>
    <div class="stat"><small>Net after fees</small><b class="${r.net >= 0 ? 'g' : 'r'}">${money(r.net, true)}</b></div>
    <div class="stat"><small>Fees paid</small><b>${money(r.fees)}</b></div>
    <div class="stat"><small>Multiplier</small><b>${r.multiplier}×</b></div>
  </div>
  ${r.best ? `<div class="note" style="margin-top:8px">Best: ${esc(r.best.symbol)} ${money(r.best.pnl, true)} · Worst: ${esc(r.worst.symbol)} ${money(r.worst.pnl, true)}</div>` : ''}
  ${r.halted ? `<div class="note r" style="margin-top:6px">${esc(r.haltReason)}</div>` : ''}</div>`;
}

function agents(st) {
  const c = st.counts, s = st.settings;
  const stages = [
    ['S', 's', 'Scout', 'new + trending Solana pools, pool trades (GeckoTerminal)', c.signals, 'signals'],
    ['F', 'f', 'Filter', `liq ≥ $${s.minLiquidity / 1000}k, alive in 5m, 1h vol ≥ $${s.minVolH1 / 1000}k`, c.filtered, 'passed'],
    ['C', 'c', 'Copy', `${st.followed.length} wallets followed · ${c.copySignals} signals`, c.copied, 'copied'],
    ['O', 'o', 'Own · JUDGE', `${c.judged} leads judged · ${c.judgeBuy} passed the gate`, c.own, 'own buys'],
    ['R', 'r', 'Risk', `stop -${s.stopPct}% set before buy · max ${s.maxPositionPct}%/position · loss cap ${s.lossCapPct}%`, c.riskBlocked, 'blocked'],
    ['B', 'b', 'Banker', 'marks positions to live price, closes, records', c.closed, 'closed'],
  ];
  const mx = Math.max(1, ...stages.map((x) => x[3]));
  const cal = calibration(st.verdicts, [...st.closed, ...st.open], st.passChecks);
  const ver = st.verdicts.slice().reverse().slice(0, 30);
  return `
  <div class="card funnel"><h2>Pipeline</h2>
    <div class="note" style="margin-bottom:6px">${c.signals.toLocaleString()} signals → ${c.filtered} filtered → ${c.copied} copied → ${c.own} own</div>
    ${stages.map(([letter, tone, nm, sub, n, unit]) => `<div class="st"><div class="ic ${tone}" aria-hidden="true">${letter}</div><div class="nm"><b>${nm}</b><small>${esc(sub)}</small><div class="bar"><i style="width:${Math.max(2, (100 * Math.log10(1 + n)) / Math.log10(1 + mx))}%"></i></div></div><div class="ct">${n.toLocaleString()}<div class="note" style="font-weight:400;text-align:right">${unit}</div></div></div>`).join('')}
  </div>
  ${st.firedCards.slice().reverse().map((f) => `<div class="fired"><b>UNFOLLOWED</b> <span class="note">${tm(f.t)}</span><div style="font-family:var(--mono);margin-top:4px">${short(f.wallet)} · ${esc(f.reason)} · last loss ${esc(f.last)}</div></div>`).join('')}
  <div class="card"><h2>JUDGE · last ${ver.length} verdicts</h2>
    <div class="note">Gate: buy only if action=buy p≥${s.judgeBuyP}, organic=yes p≥${s.judgeOrganicP}, late=no, exit_risk≤${s.judgeMaxExitRisk}. Watch → re-ask once in ${s.watchRecheckMin}m. Missing data = pass. Confidence never changes size.</div>
    ${ver.map((v) => `<div class="verdict"><div class="row"><b>${esc(v.symbol)} <span class="note">${esc(v.leadId)}</span></b><span class="chip ${v.decision}">${v.decision.toUpperCase()}</span></div>
      <span class="chip">organic ${esc(v.organic ?? 'missing')}</span><span class="chip">late ${esc(v.late ?? 'missing')}</span><span class="chip">exit_risk ${esc(v.exitRisk ?? 'missing')}</span><span class="chip">action ${esc(v.action)}</span>
      ${v.killedBy ? `<div class="note" style="margin-top:3px">killed by: ${esc(v.killedBy)}</div>` : ''}
      <div class="note">top10 ${esc(fmtN(v.dossier.top10))}% · dev ${esc(fmtN(v.dossier.dev))}% · liq $${Math.round(v.dossier.liq || 0).toLocaleString()} · 5m b/s ${v.dossier.b5}/${v.dossier.s5} prev ${v.dossier.b5p}/${v.dossier.s5p} · holders ${v.dossier.holders} (1h ago ${v.dossier.holders1h}) · uniq buyers ${v.dossier.buyersRatio} · LP ${v.dossier.lp}</div></div>`).join('') || '<div class="note">No verdicts yet.</div>'}
  </div>
  <div class="card"><h2>Calibration (Sunday check)</h2>
    <table><tr><th>JUDGE buy p</th><th>Buys</th><th>Closed</th><th>Green</th></tr>
    ${cal.buckets.map((b) => `<tr><td>${b.label}</td><td>${b.buys}</td><td>${b.closed}</td><td>${b.closed ? `${b.green} (${Math.round((100 * b.green) / b.closed)}%)` : '–'}</td></tr>`).join('')}</table>
    <div class="note" style="margin-top:6px">Passes: ${cal.passes.total} logged · ${cal.passes.checked} checked after 24h · ${cal.passes.wouldBeGreen} would have been green after fees. ${cal.passes.total > cal.passes.checked ? 'Unchecked passes get checked once they are 24h old and the desk is running.' : ''}</div>
  </div>
  <div class="card"><h2>Wallet board (observed)</h2>
    <div class="note">Stats come only from trades this desk has seen (GeckoTerminal pool trades ≥ $20). Free APIs have no 30-day wallet history, so these are approximate. Follow rule: win rate ≥ ${s.walletMinWinRate}%, ≥ ${s.walletMinRoundTrips} round trips, avg hold > ${s.walletMinHoldMin}m, P&L > 0. Fired after ${s.strikesToFire} losses in a row.</div>
    <table><tr><th>Wallet</th><th>RT</th><th>Win</th><th>Hold</th><th>P&L</th><th>Strikes</th></tr>
    ${(st.walletBoard || []).slice(0, 15).map((w) => `<tr><td style="font-family:var(--mono)">${short(w.wallet)} ${w.followed ? '<span class="g">●</span>' : ''}${w.fired ? '<span class="r">✕</span>' : ''}</td><td>${w.roundTrips}</td><td>${Math.round(w.winRate)}%</td><td>${Math.round(w.avgHoldMin)}m</td><td class="${w.pnl >= 0 ? 'g' : 'r'}">${money(w.pnl)}</td><td>${w.strikes}/${s.strikesToFire}</td></tr>`).join('') || '<tr><td colspan="6" class="note">No round trips observed yet.</td></tr>'}</table>
    <div class="note" style="margin-top:4px"><span class="g">●</span> followed <span class="r">✕</span> fired</div>
  </div>`;
}
const fmtN = (x) => (typeof x === 'number' ? x.toFixed(1) : x);

function activity(st) {
  const f = ui.logFilter;
  const keep = { all: () => true, trades: (l) => l.type === 'BUY' || l.type === 'SELL', judge: (l) => ['JUDGE', 'PASS', 'WATCH'].includes(l.type), risk: (l) => ['RISK', 'HALT', 'FIRE', 'COPY', 'ERR'].includes(l.type) }[f];
  const lines = st.log.filter(keep).slice().reverse().slice(0, 300);
  return `<div class="row" style="margin-bottom:8px"><h2 style="margin:0">Paper log</h2>${st.running ? '<span class="stream">checking</span>' : '<span class="note">idle</span>'}</div>
  <div class="seg" style="margin-bottom:10px">${['all', 'trades', 'judge', 'risk'].map((k) => `<button data-lf="${k}" class="${f === k ? 'on' : ''}">${k.toUpperCase()}</button>`).join('')}</div>
  <div class="term">${lines.map((l) => `<div class="${l.type} ${l.pnl > 0 ? 'win' : l.pnl < 0 ? 'loss' : ''}">${tm(l.t)} ${l.type.padEnd(5)} ${esc(l.text)}</div>`).join('') || 'No activity yet. Start a paper session on Home.'}</div>`;
}

const FIELDS = [
  ['Paper bank ($)', 'bank'], ['Own position size (% of bank)', 'ownPositionPct'], ['Max per position (% of bank)', 'maxPositionPct'], ['Max open positions', 'maxOpen'],
  ['Stop loss (%)', 'stopPct'], ['Take profit (%)', 'takeProfitPct'], ['Trailing exit after TP (%, 0 = off)', 'trailingPct'], ['Max hold (min)', 'maxHoldMin'],
  ['Session loss cap (% of bank)', 'lossCapPct'], ['Fees + slippage, round trip (%)', 'feePct'],
  ['Min liquidity ($)', 'minLiquidity'], ['Min 1h volume ($)', 'minVolH1'], ['Max top-10 holders (%)', 'maxTop10'],
  ['JUDGE: min buy p', 'judgeBuyP'], ['JUDGE: min organic p', 'judgeOrganicP'], ['JUDGE: max exit_risk', 'judgeMaxExitRisk'], ['JUDGE: watch re-ask (min)', 'watchRecheckMin'],
  ['Copy trading on', 'copyEnabled', 'bool'], ['Copy: min wallets', 'copyMinWallets'], ['Copy: window (min)', 'copyWindowMin'], ['Copy: max run-up since wallet entry (%)', 'copyMaxRunupPct'], ['Copy size ratio (×)', 'copyRatio'],
  ['Fire trader after N losses in a row', 'strikesToFire'], ['Wallet: min win rate (%)', 'walletMinWinRate'], ['Wallet: min observed round trips', 'walletMinRoundTrips'], ['Wallet: min avg hold (min)', 'walletMinHoldMin'],
  ['Market check every (s, ≥15)', 'tickSec'], ['Reprice open positions every (s, 0 = off)', 'markSec'],
  ['Fast multi-chain scan', 'fastScan', 'bool'], ['Strategy slots', 'strategySlots', 'bool'],
  ['Exploration size (% of bank)', 'explorePct'], ['Slot off after N non-positive trades', 'slotKillN'],
  ['Edge gate', 'edgeGate', 'bool'], ['Allow exploratory entries at half size', 'allowExplore', 'bool'], ['Closed trades before full size', 'edgeMinN'],
  ['Skip entries when 5m range eats the stop', 'volGate', 'bool'], ['Range limit, as a fraction of the stop', 'volRangeFrac'],
  ['Add liquidity impact on top of the flat fee', 'impactModel', 'bool'],
];
function settingsView(st) {
  const locked = settingsLocked(live) || st.mode === 'replay';
  const s = live.settings;
  return `${locked ? `<div class="lock">🔒 Locked while a session runs${st.mode === 'replay' ? ' or a replay plays' : ''}. End it on Home to change rules.</div>` : ''}
  <div class="card"><h2>Rules</h2>
  <form id="sform">${FIELDS.map(([lab, k, type]) => `<label class="f">${lab}${type === 'bool' ? `<input type="checkbox" name="${k}" ${s[k] ? 'checked' : ''} ${locked ? 'disabled' : ''}>` : `<input type="number" step="any" inputmode="decimal" name="${k}" value="${s[k]}" ${locked ? 'disabled' : ''}>`}</label>`).join('')}
  <button class="btn pri wide" style="margin-top:10px" ${locked ? 'disabled' : ''}>Save rules</button>
  <button type="button" class="btn wide" id="defaults" style="margin-top:8px" ${locked ? 'disabled' : ''}>Reset to defaults</button></form>
  <div class="note" style="margin-top:8px">There is no "make it back" setting on purpose. Raising size or loosening rules after a loss is loss-chasing and drains accounts; the loss cap stops new entries instead. The edge gate only shrinks or stops. It never sizes above the position you set, and a loss never increases size.</div></div>
  <div class="card"><h2>Notifications</h2><label class="f">Browser notifications when the app is in the background<input type="checkbox" id="notify" ${ui.notify ? 'checked' : ''}></label><div class="note">In-app toasts always show. Nothing is sent outside this device.</div></div>
  <div class="card"><h2>Live execution</h2><label class="f">live_execution<input type="checkbox" disabled></label>
    <div class="note">Disabled and not built. This app has no wallet connection, no private keys and no order code. Going live would need a separate build (wallet signing, a swap router such as Jupiter, priority fees, real slippage handling, kill switch) and Kodie's explicit approval. See <code>LIVE_EXECUTION.md</code>.</div></div>
  <div class="card"><h2>Data</h2><div class="note">Sources (free, no keys): GeckoTerminal, DexScreener, Jupiter, Coinbase, Kalshi snapshot, EDGAR. State lives only in this browser.</div>
    <button class="btn wide" id="exportJson" type="button">Export paper JSON</button>
    <button class="btn wide" id="exportCsv" type="button" style="margin-top:8px">Export paper CSV</button>
    <label class="btn wide" style="margin-top:8px;display:block;text-align:center">Import paper JSON<input id="importJson" type="file" accept="application/json" hidden></label>
    <button class="btn dng wide" id="wipe" style="margin-top:8px" ${live.running ? 'disabled' : ''}>Erase local data</button></div>
  <div class="note" style="text-align:center;margin-bottom:10px">Grok Desk paper v1 · not financial advice</div>`;
}

function loadMorning() {
  if (ui.morningState === 'ready' || ui.morningState === 'loading') return;
  ui.morningState = 'loading';
  Promise.all([
    fetch('data/morning.json?v=' + Date.now(), { cache: 'no-store' }).then((r) => r.ok ? r.json() : null),
    fetch('data/heartbeat.json?v=' + Date.now(), { cache: 'no-store' }).then((r) => r.ok ? r.json() : null),
  ]).then(([morning, heartbeat]) => {
    ui.morning = morning;
    ui.heartbeat = heartbeat;
    ui.morningState = 'ready';
    if (ui.tab === 'home') render();
  }).catch(() => { ui.morningState = 'error'; if (ui.tab === 'home') render(); });
}
function morningCard() {
  if (ui.morningState !== 'ready') loadMorning();
  const report = ui.morning;
  const beat = ui.heartbeat;
  const beatLine = beat?.at ? `Heartbeat ${beat.at.slice(0, 16).replace('T', ' ')} UTC · ${beat.open ?? 0} open · ${beat.settled ?? 0} settled` : 'Heartbeat waiting for the next snapshot.';
  if (!report) return `<section class="card" aria-label="Morning report"><h2>Morning report</h2><p class="note">${esc(beatLine)}</p><p class="note">The report is written with the daily lesson job. Paper only.</p></section>`;
  const best = report.best ? `${report.best.id} ${money(report.best.mean, true)}` : '—';
  const worst = report.worst ? `${report.worst.id} ${money(report.worst.mean, true)}` : '—';
  const lessons = (report.lessons || []).slice(0, 2).map((l) => `<li>${esc(l)}</li>`).join('');
  const changed = (report.changed || []).slice(0, 3).map((l) => `<li>${esc(l)}</li>`).join('');
  return `<section class="card" aria-label="Morning report"><h2>Morning report</h2><p class="note">${esc(beatLine)}</p><p class="note">${esc(report.day || '')} · n ${report.trades ?? 0} · net ${money(report.net, true)} after fees</p><p class="note">Best ${esc(best)} · Worst ${esc(worst)}</p><ul class="feed">${lessons}</ul>${changed ? `<ul class="feed">${changed}</ul>` : ''}</section>`;
}
function loadBrain() {
  if (ui.brainState === 'ready' || ui.brainState === 'loading') return;
  ui.brainState = 'loading';
  Promise.all([
    fetch('data/lessons.json?v=' + Date.now(), { cache: 'no-store' }).then((r) => { if (!r.ok) throw new Error('lessons unavailable'); return r.json(); }),
    fetch('data/journal-open.json?v=' + Date.now(), { cache: 'no-store' }).then((r) => r.ok ? r.json() : { entries: [] }),
  ]).then(([lessons, open]) => {
    ui.lessons = lessons;
    ui.journalOpen = open;
    ui.brainState = 'ready';
    if (ui.tab === 'brain') render();
  }).catch((e) => {
    ui.brainState = 'error';
    ui.brainError = e.message;
    if (ui.tab === 'brain') render();
  });
}
function brainView() {
  if (ui.brainState !== 'ready') {
    loadBrain();
    if (ui.brainState === 'error') return `<div class="card"><h2>Bot brain</h2><p class="empty">${esc(ui.brainError || 'The lessons file did not load.')}</p></div>`;
    return `<section class="card arcade" aria-busy="true" aria-label="Bot brain"><h2>Bot brain</h2><div class="skel"></div><p class="note">Loading the paper journal.</p></section>`;
  }
  const doc = ui.lessons || {};
  const bots = doc.bots || [];
  const openN = (ui.journalOpen?.entries || []).length;
  const quiet = (bot) => bot.shadow || bot.benched || bot.status === 'benched-shadow';
  const share = (bot) => {
    if (quiet(bot)) return 'shadow, $0 allocation';
    const mates = bots.filter((b) => b.family === bot.family && !quiet(b));
    const total = mates.reduce((a, b) => a + (b.weight || 0), 0);
    if (!total) return 'no new bets';
    return Math.round((100 * (bot.weight || 0)) / total) + '% of new paper bets';
  };
  const started = Date.parse(doc.experimentSince || '');
  const hours = Number.isFinite(started) ? Math.max(0, Math.floor((Date.now() - started) / 3600000)) : null;
  const since = Number.isFinite(started) ? `Experiment running nonstop since ${new Date(started).toISOString().slice(0, 16).replace('T', ' ')} UTC · ${hours}h` : 'Experiment clock starts with the first journal line.';
  const cards = bots.map((bot) => `<li class="slot"><div class="row"><b>${esc(bot.label)}</b><span class="tag ${quiet(bot) ? 'off' : bot.role === 'champion' ? 'normal' : 'explore'}">${quiet(bot) ? 'benched-shadow' : esc(bot.role)}</span></div><p class="note">Level ${bot.level} · ${share(bot)} · n ${bot.n} · mean ${bot.mean == null ? '—' : money(bot.mean, true)} after fees · 90% ${bot.lo == null ? '—' : money(bot.lo, true)} to ${bot.hi == null ? '—' : money(bot.hi, true)} · ${esc(bot.sample || '')}</p><p class="note">${bot.graduated ? 'Gate cleared on this journal. Live execution stays off.' : `Gate progress ${bot.gateWindows || 0}/3 windows of 20+. Not ready for real money.`}</p></li>`).join('');
  const summary = (doc.summary || []).map((l) => `<li>${esc(l)}</li>`).join('');
  const learned = (doc.lessons || []).slice(0, 6).map((l) => `<li>${esc(l.text)}</li>`).join('');
  const frozen = (doc.frozen || []).map((l) => `<li>${esc(l.text)}</li>`).join('');
  const decisions = (doc.decisions || []).map((l) => `<li>${esc(l)}</li>`).join('');
  return `<section class="card arcade" aria-label="Bot brain">
    <div class="row"><h2 style="margin:0">Bot brain</h2><span class="tag explore">PAPER · after fees</span></div>
    <p class="lvl" id="runFor">${esc(since)}</p>
    <p class="note">Level counts settled paper bets, not profit. A loss does not raise the $2 size. A bot that loses $6 of its own allocated paper goes to shadow. The others keep trading. ${openN} paper line${openN === 1 ? '' : 's'} are waiting on a result.</p>
    <h2>Last night</h2>
    <ul class="feed">${summary || '<li><span class="empty">No summary yet.</span></li>'}</ul>
    <h2>Bots</h2>
    <ul class="feed">${cards || '<li><span class="empty">No bot roster in this lessons file.</span></li>'}</ul>
    <h2>Learned from settled trades</h2>
    <ul class="feed">${learned || '<li><span class="empty">No feature bucket has 8 settled paper trades yet. Nothing was retuned.</span></li>'}</ul>
    <h2>What changed</h2>
    <ul class="feed">${decisions || '<li><span class="empty">No holdout has been judged yet.</span></li>'}</ul>
    <details class="fold"><summary>Frozen studies</summary><div class="fold-body"><ul class="feed">${frozen}</ul><p class="note">${esc(doc.note || '')}</p></div></details>
  </section>`;
}
function dexReady(pair, now) {
  const scored = scoreCoin(pair, { holders: { distribution_percentage: { top_10: '0' } }, mint_authority: 'no', freeze_authority: 'no' }, now);
  return scored.reasons.filter((r) => ['liquidity', 'volume', 'age', 'quote', '1h move'].includes(r.name)).every((r) => r.ok === true);
}
async function loadCoins() {
  if (ui.coinsState === 'loading') return;
  ui.coinsState = 'loading';
  if (ui.tab === 'coins') render();
  try {
    const boosts = await fetch('https://api.dexscreener.com/token-boosts/latest/v1', { cache: 'no-store' }).then((r) => { if (!r.ok) throw new Error('DexScreener ' + r.status); return r.json(); });
    const sols = (Array.isArray(boosts) ? boosts : []).filter((b) => b.chainId === 'solana' && b.tokenAddress).slice(0, 8);
    const joined = sols.map((b) => b.tokenAddress).join(',');
    const book = joined ? await fetch('https://api.dexscreener.com/latest/dex/tokens/' + joined, { cache: 'no-store' }).then((r) => r.json()) : { pairs: [] };
    const now = Date.now();
    const prelim = sols.map((b) => ({ b, pair: bestPair(book.pairs, b.tokenAddress) }));
    const need = prelim.filter((row) => dexReady(row.pair, now)).slice(0, 4);
    const info = {};
    for (const row of need) {
      try {
        const res = await fetch('https://api.geckoterminal.com/api/v2/networks/solana/tokens/' + row.b.tokenAddress + '/info', { cache: 'no-store' });
        if (res.ok) info[row.b.tokenAddress] = (await res.json())?.data?.attributes || null;
      } catch { info[row.b.tokenAddress] = null; }
      await new Promise((r) => setTimeout(r, 1100));
    }
    ui.coins = prelim.map(({ b, pair }) => {
      const score = scoreCoin(pair, info[b.tokenAddress] || null, now);
      return {
        ca: b.tokenAddress,
        symbol: pair?.baseToken?.symbol || '?',
        name: pair?.baseToken?.name || 'Unknown',
        priceUsd: Number(pair?.priceUsd),
        dexUrl: pair?.url || `https://dexscreener.com/solana/${b.tokenAddress}`,
        ...score,
      };
    });
    ui.coinsState = 'ready';
    ui.coinsAt = now;
    const fresh = ui.coins.filter((c) => c.pass && !(ui.seenCoins || new Set()).has(c.ca));
    if (ui.coinAlerts && fresh.length && 'Notification' in window && Notification.permission === 'granted' && !document.hidden) {
      try { new Notification('Grok Desk paper signal', { body: fresh.map((c) => c.symbol).join(', ') + ' passed the paper safety list. Not advice.' }); } catch {}
    }
    ui.seenCoins = new Set([...(ui.seenCoins || []), ...ui.coins.map((c) => c.ca)]);
  } catch (e) {
    ui.coinsState = 'error';
    ui.coinsError = e.message || 'Coin feed failed';
  }
  if (ui.tab === 'coins') render();
}
function coinsView() {
  if (ui.coinsState !== 'ready' && ui.coinsState !== 'error') loadCoins();
  const note = `<p class="note">Signals are paper-tested ideas, not advice. You buy in your own pump.fun or fomo account. This app has no wallet and cannot place an order.</p>`;
  const alert = `<button type="button" id="coinAlert" class="switch ${ui.coinAlerts ? 'on' : ''}" aria-pressed="${!!ui.coinAlerts}">${ui.coinAlerts ? 'Alerts on' : 'Alerts off'}</button>`;
  if (ui.coinsState !== 'ready') {
    return `<section class="card" aria-label="Coin signals">${note}<div class="row"><h2 style="margin:0">Coins</h2>${alert}</div>${ui.coinsState === 'error' ? `<p class="empty">${esc(ui.coinsError)}</p>` : '<div class="skel" aria-busy="true"></div><p class="note">Loading the public Solana feed.</p>'}</section>`;
  }
  const cards = (ui.coins || []).map((coin) => {
    const why = coin.reasons.map((r) => `<li><span class="tag ${r.ok === true ? 'normal' : r.ok === false ? 'off' : ''}">${r.ok === true ? 'pass' : r.ok === false ? 'fail' : 'missing'}</span> ${esc(r.name)} · ${esc(r.detail)}</li>`).join('');
    const actions = coin.pass ? `<p class="ca" aria-label="Contract address">${esc(coin.ca)}</p><div class="row" style="flex-wrap:wrap"><button type="button" class="btn pri" data-copy="${esc(coin.ca)}">Copy CA</button><a class="btn" href="https://pump.fun/coin/${esc(coin.ca)}" target="_blank" rel="noopener">Pump.fun</a><a class="btn" href="https://fomo.family/tokens/solana/${esc(coin.ca)}" target="_blank" rel="noopener">FOMO</a><a class="btn" href="${esc(coin.dexUrl)}" target="_blank" rel="noopener">DexScreener</a></div>` : '';
    return `<article class="card"><div class="row"><h2 style="margin:0">${esc(coin.symbol)} · ${esc(coin.name)}</h2><span class="tag ${coin.pass ? 'normal' : 'off'}">${coin.pass ? 'paper buy' : 'no buy'}</span></div>${actions}<ul class="feed">${why}</ul></article>`;
  }).join('');
  const gate = memeGate(ui.memeJournal || []);
  const net = (ui.memeJournal || []).reduce((sum, row) => sum + (row.pnl || 0), 0);
  return `<section aria-label="Coin signals">${note}<div class="card"><div class="row"><h2 style="margin:0">Coins</h2>${alert}</div><p class="note">Paper meme book: n ${gate.n}, net ${money(net, true)} after the 1.25% fee and 1% slippage each side. ${gate.graduated ? 'Gate cleared. Live execution stays off.' : 'Not ready for real money. The edge gate still needs 3 days of 20+ trades.'}</p><p class="note">pump.fun's API did not answer from this network. Prices are DexScreener. Holder, mint, and freeze checks are GeckoTerminal when it answers. FOMO opens https://fomo.family/tokens/solana/&lt;CA&gt;.</p></div>${cards || '<div class="card"><p class="empty">No Solana coins in the latest public boost list.</p></div>'}</section>`;
}
function render() {
  if (!state) return;
  const v = $('#view');
  v.innerHTML = ui.tab === 'home' ? home(state) : ui.tab === 'arena' ? arenaView(state) : ui.tab === 'coins' ? coinsView() : ui.tab === 'score' ? scoreView(state) : ui.tab === 'brain' ? brainView() : ui.tab === 'predict' ? predictView(state) : ui.tab === 'agents' ? agents(state) : ui.tab === 'activity' ? activity(state) : settingsView(state);
  const badge = $('#modeBadge');
  if (badge && state.mode !== 'replay') badge.className = 'badge paper' + (state.running ? ' live' : '');
  paintTicker(state);
  if (ui.tab === 'home') { drawChart($('#chart'), state); updateTimer(); }
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-current', b.classList.contains('on') ? 'page' : 'false'));
  bind();
}

function bind() {
  document.querySelectorAll('[data-tf]').forEach((b) => (b.onclick = () => { ui.tf = b.dataset.tf; render(); }));
  document.querySelectorAll('[data-mkt]').forEach((b) => (b.onclick = () => { ui.market = b.dataset.mkt; render(); }));
  document.querySelectorAll('[data-lf]').forEach((b) => (b.onclick = () => { ui.logFilter = b.dataset.lf; render(); }));
  const at = $('#activeToggle'); if (at) at.onclick = async () => {
    const next = live.settings.activeMode !== true;
    live.settings = { ...live.settings, activeMode: next };
    if (state && state !== live) state.settings = { ...state.settings, activeMode: next };
    saveSettings(live.settings); await persist(); render();
  };
  const sb = $('#startBtn'); if (sb) sb.onclick = async () => {
    const book = live.edgeBook?.length ? live.edgeBook : (live.closed || []);
    const settings = live.settings;
    live = newState(settings, Date.now());
    live.edgeBook = book.slice(-500);
    startSession(live, Date.now());
    state = live; await persist(); render(); liveTick();
  };
  const eb = $('#endBtn'); if (eb) eb.onclick = async () => { if (!confirm('End this paper session? Open positions close at the last live price.')) return; endSession(live, Date.now()); await persist(); render(); };
  const rb = $('#replayBtn'); if (rb) rb.onclick = startReplay;
  const f = $('#sform'); if (f) f.onsubmit = (e) => {
    e.preventDefault();
    const patch = {};
    for (const [, k, type] of FIELDS) { const el = f.elements[k]; patch[k] = type === 'bool' ? el.checked : Number(el.value); }
    patch.tickSec = Math.max(15, patch.tickSec || 20);
    patch.markSec = patch.markSec ? Math.max(10, patch.markSec) : 0;
    patch.edgeMinN = Math.max(8, patch.edgeMinN || 30);
    patch.volRangeFrac = Math.min(2, Math.max(0.1, patch.volRangeFrac || 0.75));
    const r = updateSettings(live, live.settings, patch);
    if (!r.ok) return toast({ text: r.reason });
    live.settings = r.settings; saveSettings(r.settings); persist(); toast({ text: 'Rules saved. They apply to the next session.' }); render();
  };
  const d = $('#defaults'); if (d) d.onclick = () => { const r = updateSettings(live, live.settings, { ...DEFAULT_SETTINGS }); if (r.ok) { live.settings = r.settings; saveSettings(r.settings); persist(); render(); } };
  const n = $('#notify'); if (n) n.onchange = async () => { ui.notify = n.checked; if (n.checked && 'Notification' in window) { const p = await Notification.requestPermission(); ui.notify = p === 'granted'; } localStorage.setItem('gd.notify', ui.notify ? '1' : '0'); render(); };
  const w = $('#wipe'); if (w) w.onclick = async () => { if (!confirm('Erase all local paper data?')) return; live = newState(loadSettings(), Date.now()); state = live; await persist(); render(); };
  const download = (name, text, type) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); };
  const ej = $('#exportJson'); if (ej) ej.onclick = () => download('grok-desk-paper.json', JSON.stringify(exportHistory(live), null, 2), 'application/json');
  const ec = $('#exportCsv'); if (ec) ec.onclick = () => download('grok-desk-paper.csv', historyCsv([...(live.arenaClosed || []), ...(live.picksClosed || []), ...(live.closed || [])].map((r) => ({ book: r.rule ? 'arena' : 'desk', ...r }))), 'text/csv');
  const im = $('#importJson'); if (im) im.onchange = async () => {
    try {
      const doc = JSON.parse(await im.files[0].text());
      importHistory(live, doc);
      state = live; await persist(); toast({ text: 'Paper history imported.' }); render();
    } catch (e) { toast({ text: e.message }); }
  };
  const go = $('#goArena'); if (go) go.onclick = () => { ui.tab = 'arena'; document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x.dataset.tab === 'arena')); render(); };
  document.querySelectorAll('[data-tabjump]').forEach((b) => (b.onclick = () => { ui.tab = b.dataset.tabjump; render(); }));
  document.querySelectorAll('[data-arena]').forEach((b) => (b.onclick = () => { ui.arena = b.dataset.arena; render(); }));
  const sound = $('#soundBtn'); if (sound) sound.onclick = () => { ui.sound = !ui.sound; localStorage.setItem('gd.sound', ui.sound ? '1' : '0'); render(); };
  const alertBtn = $('#coinAlert'); if (alertBtn) alertBtn.onclick = async () => {
    ui.coinAlerts = !ui.coinAlerts;
    if (ui.coinAlerts && 'Notification' in window) { const p = await Notification.requestPermission(); ui.coinAlerts = p === 'granted'; }
    localStorage.setItem('gd.coinAlerts', ui.coinAlerts ? '1' : '0');
    render();
  };
  document.querySelectorAll('[data-copy]').forEach((b) => (b.onclick = async () => {
    const ca = b.dataset.copy;
    try { await navigator.clipboard.writeText(ca); } catch { /* the address stays on screen */ }
    if (navigator.vibrate) navigator.vibrate(12);
    toast({ text: 'Contract address copied. Buy it in your own account.' });
  }));
  document.querySelectorAll('[data-pick]').forEach((b) => (b.onclick = async () => {
    const market = (live.kalshiBoard?.markets || []).find((m) => m.ticker === b.dataset.ticker);
    if (!market) return;
    const res = placePick(live, market, b.dataset.pick, Date.now());
    if (!res.ok) toast({ text: res.reason });
    else { burst('loss'); await persist(); }
    render();
  }));
}
async function refreshKalshi() {
  if (!live || ui.replay || ui.kalshiBusy) return;
  ui.kalshiBusy = true;
  try {
    const board = await loadKalshiBoard(fetch);
    live.kalshiBoard = board;
    reviewKalshi(live, board, Date.now());
    const [spots, book] = await Promise.all([loadSpots(fetch), loadBook(fetch)]);
    live.spots = spots;
    const before = (live.arenaClosed || []).length + (live.picksClosed || []).length;
    const notes = reviewArena(live, board, Date.now(), spots, book);
    const after = (live.arenaClosed || []).length + (live.picksClosed || []).length;
    if (after > before) {
      const last = (live.arenaClosed || []).concat(live.picksClosed || []).at(-1);
      burst(last?.won ? 'win' : 'loss');
    }
    if (location.hash === '#shot' && !live._shot && (live.arenaOpen || []).some((p) => p.contracts >= 1)) {
      const bet = live.arenaOpen.find((p) => p.contracts >= 1);
      live._shot = true;
      reviewArena(live, { markets: [{ ticker: bet.ticker, title: bet.title, series: bet.series, result: bet.side, yesAsk: bet.ask, noAsk: 1 - bet.ask, closeTime: new Date(Date.now() + 60000).toISOString() }] }, Date.now(), spots, book);
      burst('win');
    }
    if (state === live) { await persist(); if (ui.tab === 'predict' || ui.tab === 'arena' || ui.tab === 'score' || ui.tab === 'home') render(); }
  } catch (e) { if (live) live.arenaError = e.message; if (state === live) render(); }
  finally { ui.kalshiBusy = false; }
}
document.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => { ui.tab = b.dataset.tab; document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x === b)); render(); window.scrollTo(0, 0); if (b.dataset.tab === 'predict') refreshKalshi(); }));
window.addEventListener('resize', () => ui.tab === 'home' && state && drawChart($('#chart'), state));
document.addEventListener('visibilitychange', () => { if (!document.hidden) liveTick(); });

(async () => {
  const saved = await idb.get('state');
  live = migrate(saved ? JSON.parse(saved) : newState(loadSettings(), Date.now()));
  if (live.settings && live.settings.activeMode == null) live.settings = { ...live.settings, activeMode: true, activeTickSec: ACTIVE.tickSec };
  if (!live.slots) live.slots = emptySlots();
  if (!Array.isArray(live.decisions)) live.decisions = [];
  state = live; render();
  refreshKalshi();
  setInterval(refreshKalshi, 20000);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  const q = new URLSearchParams(location.search);
  if (q.get('replay') === '1') startReplay();
  if (q.get('tab')) document.querySelector(`[data-tab="${q.get('tab')}"]`)?.click();
})();
