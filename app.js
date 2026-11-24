// Grok Desk UI. PAPER ONLY: the engine below moves numbers, never money.
import { DEFAULT_SETTINGS, RESEARCH_PRIOR, calibration, settingsLocked, updateSettings, strategyHealth, participationDecision, equityDrawdown } from './engine/core.js';
import { SLOT_IDS, SLOT_SPEC, slotStatus, emptySlots } from './engine/strategies.js';
import { SLOT_PRIOR } from './engine/slot-prior.js';
import { ACTIVE, activePace } from './engine/active.js';
import { PREDICT_PRIOR } from './engine/predict-prior.js';
import { KALSHI_PRIOR } from './engine/kalshi-prior.js';
import { loadKalshiBoard, reviewKalshi, quoteAge } from './engine/kalshi.js';
import { reviewArena, placePick, loadSpots, loadBook, ARENA_SIZE, arenaIdeas } from './engine/arena.js';
import { levelOf, streak, achievements } from './engine/game.js';
import { migrate, exportHistory, importHistory, historyCsv } from './engine/store.js';
import { GATE_PRIOR } from './engine/gate-prior.js';
import { MAJORS_PRIOR } from './engine/majors-prior.js';
import { createLiveSource, createReplaySource } from './engine/data.js';
import { newState, startSession, endSession, tick, mark, recap, equityNow, serialize, fmtP, short } from './engine/engine.js';
import { memeBooks, watchHealth, watchHealthLine } from './engine/meme.js';
import { upgradeLines, challengerRows } from './engine/upgrades.js';
import { diagnoseMeme, repairGate, REPAIR_MIN_N, REPAIR_SIZE_USD } from './engine/repair.js';
import { focusCardHtml } from './engine/focus-view.js';
import { setRollingBench } from './engine/focus-plan.js';
import { todayHeaderHtml } from './engine/today-view.js';
import { freshCalibration } from './engine/calibration.js';
import { freshDecay, recentFormChipHtml } from './engine/decay.js';
import { deskHomeHtml, agentGridHtml, botChipsHtml, gateMeterHtml, gateListHtml } from './engine/home-view.js';
import { withoutQuoteErrors } from './engine/quote-guard.js';
import { emptyTrainer, placeTrainerCall, settleTrainer, trainerStats, trainerTips, brierVerdict, lessonText, feeBreakEvenTable, feeAskNote, TRAINER_STAKE } from './engine/trainer.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const money = (x, sign) => (x == null ? '–' : (sign && x > 0 ? '+' : x < 0 ? '−' : '') + '$' + Math.abs(x).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
function eqParts(x) {
  const parts = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).formatToParts(Math.abs(x));
  let head = '', cents = '';
  let seen = false;
  for (const p of parts) {
    if (p.type === 'decimal') { seen = true; cents += p.value; continue; }
    if (seen && p.type === 'fraction') cents += p.value;
    else head += p.value;
  }
  return `${x < 0 ? '−' : ''}$${head}<small>${cents}</small>`;
}
function eqHtml(x) {
  return `<span class="eq count ${x < 0 ? 'r' : ''}" data-count="${x}" data-count-key="equity">${eqParts(x)}</span>`;
}
function countSpan(n, signed, key, raw) {
  const shown = raw != null ? '$' + raw : money(n, signed);
  return `<span class="count" data-count="${n}" data-count-key="${key}"${signed ? ' data-sign="1"' : ''}${raw != null ? ` data-raw="${esc(String(raw))}"` : ''}>${shown}</span>`;
}
function runCounts() {
  if (!ui.counts) ui.counts = new Map();
  const reduce = !motionOn();
  document.querySelectorAll('[data-count]').forEach((el) => {
    const key = el.dataset.countKey;
    const target = Number(el.dataset.count);
    if (!key || !Number.isFinite(target)) return;
    const prev = ui.counts.get(key);
    ui.counts.set(key, target);
    if (prev == null || reduce || Math.abs(target - prev) < 0.0000001) return;
    const from = prev;
    const t0 = performance.now();
    const paint = (val, done) => {
      if (!el.isConnected) return;
      if (el.classList.contains('eq')) {
        el.classList.toggle('r', val < 0);
        el.innerHTML = eqParts(done ? target : val);
      } else if (el.dataset.raw != null && !done) {
        const digits = (el.dataset.raw.split('.')[1] || '').length;
        el.textContent = (val < 0 ? '−' : '') + '$' + Math.abs(val).toFixed(Math.min(8, Math.max(2, digits)));
      } else if (done && el.dataset.raw != null) {
        el.textContent = '$' + el.dataset.raw;
      } else el.textContent = money(done ? target : val, el.dataset.sign === '1');
    };
    const step = (now) => {
      const p = Math.min(1, (now - t0) / 420);
      const eased = 1 - (1 - p) ** 3;
      paint(from + (target - from) * eased, p === 1);
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
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

const ui = { tab: 'home', tf: 'all', market: 'all', logFilter: 'all', replay: null, busy: false, notify: localStorage.getItem('gd.notify') === '1', arena: 'feed', sound: localStorage.getItem('gd.sound') === '1', coinAlerts: localStorage.getItem('gd.coinAlerts') === '1', memeJournal: [], train: 'call', haptics: localStorage.getItem('gd.haptics') !== '0', motion: localStorage.getItem('gd.motion') !== '0', remind: localStorage.getItem('gd.remind') === '1', coinFilter: 'all', trainSide: '', trainConf: '60' };
if (localStorage.getItem('gd.motion') === '0') document.documentElement.classList.add('motion-off');
if (localStorage.getItem('gd.theme') === 'light') document.documentElement.dataset.theme = 'light';
let live = null;          // live state
let state = null;         // what is on screen (live or replay)
const src = createLiveSource();

async function persist() { if (ui.shotLock || !live) return; await idb.set('state', serialize(live)); }
function motionOn() {
  if (document.documentElement.classList.contains('motion-off')) return false;
  return !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}
function haptic(pattern = 12) {
  if (!ui.gestured || localStorage.getItem('gd.haptics') === '0') return;
  try { navigator.vibrate?.(pattern); } catch { /* this phone has no vibration */ }
}
document.addEventListener('pointerdown', () => { ui.gestured = true; }, { passive: true });
let audioCtx;
function blip(win) {
  if (!ui.sound) return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  const ctx = audioCtx || (audioCtx = new Ctx());
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.frequency.value = win ? 740 : 180;
  g.gain.value = 0.04;
  o.connect(g); g.connect(ctx.destination);
  o.start();
  o.stop(ctx.currentTime + 0.12);
}
let trainerBook = null;
function loadTrainer() {
  if (trainerBook) return trainerBook;
  try { trainerBook = { ...emptyTrainer(), ...JSON.parse(localStorage.getItem('gd.trainer') || '{}') }; }
  catch { trainerBook = emptyTrainer(); }
  trainerBook.open ||= [];
  trainerBook.closed ||= [];
  trainerBook.xp ||= 0;
  trainerBook.stakeUsd = TRAINER_STAKE;
  return trainerBook;
}
function saveTrainer() {
  if (!trainerBook || ui.shotLock) return;
  trainerBook.stakeUsd = TRAINER_STAKE;
  localStorage.setItem('gd.trainer', JSON.stringify(trainerBook));
}
function watchSet() {
  try { return new Set(JSON.parse(localStorage.getItem('gd.watch') || '[]')); } catch { return new Set(); }
}
function saveWatch(set) { localStorage.setItem('gd.watch', JSON.stringify([...set])); }

// ---------- toasts / notifications ----------
function toast(e) {
  const el = document.createElement('div');
  const copy = e.kind === 'copy';
  el.className = 'toast ' + (copy ? 'copied' : e.side === 'buy' ? 'buy' : e.pnl > 0 ? 'win' : e.pnl < 0 ? 'loss' : '');
  el.setAttribute('role', 'status');
  el.textContent = copy ? 'Copied' : (state?.mode === 'replay' ? '[REPLAY] ' : '[PAPER] ') + e.text;
  $('#toasts').prepend(el); setTimeout(() => el.remove(), copy ? 1400 : 5000);
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
  updateTimer();
  maybeHealQuote();
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
  if (state) { paintRings(); paintQuoteClock(); }
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
    ${watchStatus()}
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
  return `<div class="card"><h2>Kalshi 15-minute</h2>
    ${quoteBox(st)}
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
function burst(kind) {
  haptic(kind === 'loss' ? [8, 30, 8] : [12, 28, 12]);
  if (kind !== 'loss') blip(true);
  if (!motionOn()) return;
  const fx = document.getElementById('fx');
  const view = document.getElementById('view');
  if (kind === 'loss') {
    view?.classList.add('loss-pulse');
    view?.animate?.([
      { transform: 'translateX(0)' },
      { transform: 'translateX(-4px)' },
      { transform: 'translateX(3px)' },
      { transform: 'translateX(-2px)' },
      { transform: 'translateX(0)' },
    ], { duration: 320, easing: 'ease-out' });
    setTimeout(() => view?.classList.remove('loss-pulse'), 480);
    return;
  }
  if (!fx) return;
  fx.replaceChildren();
  const n = kind === 'level' ? 26 : 22;
  const colors = ['#3DFF9A', '#FFD56A', '#9ec5ff'];
  const dur = ui.shotLock ? 1400 : 760;
  for (let i = 0; i < n; i++) {
    const dot = document.createElement('i');
    dot.style.background = colors[i % colors.length];
    dot.style.width = i % 3 === 0 ? '12px' : '8px';
    dot.style.height = i % 3 === 0 ? '12px' : '8px';
    dot.style.left = '50%';
    dot.style.top = '22%';
    fx.appendChild(dot);
    const angle = (Math.PI * 2 * i) / n;
    const dist = 90 + (i % 5) * 28;
    dot.animate([
      { transform: 'translate(-50%, -50%) scale(0.5)', opacity: 1 },
      { transform: `translate(calc(-50% + ${Math.cos(angle) * dist * 0.6}px), calc(-50% + ${Math.sin(angle) * dist * 0.55}px)) scale(1)`, opacity: 1, offset: 0.35 },
      { transform: `translate(calc(-50% + ${Math.cos(angle) * dist}px), calc(-50% + ${Math.sin(angle) * dist + 36}px)) scale(0.8)`, opacity: 0 },
    ], { duration: dur, easing: 'cubic-bezier(.2,.7,.2,1)', fill: 'forwards' });
  }
  setTimeout(() => fx.replaceChildren(), dur + 40);
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
  const dayStreak = streak(st.game || {}, now);
  const pct = ((xp % 50) / 50) * 100;
  return `<section class="card cockpit arcade" aria-label="Paper cockpit">
    <div class="row"><h2 style="margin:0">Cockpit</h2><span class="tag explore">PAPER · not real money</span></div>
    ${shotNote()}
    ${loading ? '<div class="quote-box is-fresh" role="status" aria-busy="true"><div class="row"><p class="quote-clock">Checking the snapshot</p></div><p class="note">The Kalshi file is loading.</p></div>' : quoteBox(st)}
    <div class="grid">
      <div class="stat"><small>Live now</small><b>${openN}</b><span class="note">open</span></div>
      <div class="stat"><small>Today</small><b class="${pnl > 0 ? 'g' : pnl < 0 ? 'r' : ''}">${money(pnl, true)}</b><span class="note">after fees</span></div>
      <div class="stat"><small>Streak</small><b>${flame(dayStreak)}${dayStreak}d</b><span class="xpbar" role="progressbar" aria-valuemin="0" aria-valuemax="50" aria-valuenow="${xp % 50}" aria-label="XP toward the next level"><i data-w="${pct}%"></i></span><span class="note">Level ${levelOf(xp)} · ${xp} XP</span></div>
    </div>
    <div class="ring-row">${soon ? `${ringHtml(soon.closeTime, true)}<div><p class="lvl">This window</p><p class="note">Paper countdown. Not an order.</p></div>` : '<p class="empty">No open 15-minute window in the latest snapshot.</p>'}</div>
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
    const empty = age.stale ? `Updated ${esc(age.label)} ago, so this snapshot is too old to pick. Retry from Home.` : 'No live 15-minute market in the snapshot.';
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
function loadUpgrades() {
  if (ui.upgradeState === 'ready' || ui.upgradeState === 'loading' || ui.upgradeState === 'error') return;
  ui.upgradeState = 'loading';
  Promise.all([
    fetch('data/research-upgrades.json?v=' + Date.now(), { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)),
    fetch('data/meme-stops.json?v=' + Date.now(), { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)),
  ]).then(([doc, stops]) => {
    if (!doc && !stops) throw new Error('upgrades unavailable');
    const report = { ...(doc || {}), meme: stops || doc?.meme, settlement: doc?.settlement || { n: 0 } };
    ui.upgrades = report;
    ui.upgradeLines = upgradeLines(report);
    ui.upgradeState = 'ready';
    if (ui.tab === 'brain' || ui.tab === 'score' || ui.arena === 'score') render();
  }).catch(() => {
    ui.upgradeState = 'error';
    ui.upgradeLines = upgradeLines({ maker: { measured: false }, settlement: { n: 0 } });
    if (ui.tab === 'brain' || ui.tab === 'score') render();
  });
}
function challengerCard() {
  const report = ui.upgrades || { maker: { measured: false }, settlement: { n: 0 }, jev: { n: 0, weight: 0, status: 'shadow', unknownRate: null } };
  const items = challengerRows(report).map((row) => {
    const mean = row.mean == null ? '—' : money(row.mean, true);
    const base = row.baselineMean == null ? '—' : money(row.baselineMean, true);
    const tone = (n) => (n > 0 ? 'g' : n < 0 ? 'r' : '');
    const unknown = row.unknownRate == null ? '—' : `${Math.round(row.unknownRate * 100)}%`;
    const weight = row.id === 'jev-check' ? `<p class="note">Weight ${row.weight}. Unknown ${unknown} of settled verdicts. DexScreener, public X facts, RugCheck, age, liquidity, and similar tickers are in the prompt. A flag drops that trade from this mean only.</p>` : '';
    const age = row.id === 'early-entry' ? `<p class="note">Median age at entry ${row.medianAgeMin == null ? '—' : `${Math.round(row.medianAgeMin)} min`}. Weight ${row.weight}. Discovery scans about every 60 seconds. The Kalshi chain starts that job when it is not already running.</p>` : '';
    const exitNote = String(row.id || '').startsWith('early-exit') ? '<p class="note">Weight 0. Same early entries, this exit, after fees.</p>' : '';
    return `<li class="slot" data-challenger="${esc(row.id)}"><div class="row"><b>${esc(row.name)}</b><span class="tag explore">${esc(row.status)}</span></div><dl class="challenger-metrics"><div><dt>Sample</dt><dd>${row.n}</dd></div><div><dt>After fees</dt><dd class="${tone(row.mean)}">${mean}</dd></div><div><dt>Baseline</dt><dd class="${tone(row.baselineMean)}">${base}</dd></div></dl>${weight}${age}${exitNote}</li>`;
  }).join('');
  return `<section class="card" aria-label="Shadow challengers"><h2>Shadow challengers</h2><ul class="feed">${items}</ul><p class="note">Paper only. These bots do not place or block a live order. Jev check starts at weight 0 and can move only through the existing edge gate. Early entry starts at weight 0 the same way. live_execution stays off.</p></section>`;
}
function upgradesCard() {
  if (!ui.upgradeLines) loadUpgrades();
  const lines = ui.upgradeLines || upgradeLines({ maker: { measured: false }, settlement: { n: 0 } });
  const body = lines.slice(1).map((line) => `<li>${esc(line)}</li>`).join('');
  return `${challengerCard()}<section class="card" aria-label="New research upgrades"><h2>New research upgrades</h2><ul class="upgrades">${body}</ul><p class="note">Paper only. The $2 size stays put. The edge gate is unchanged. live_execution stays off.</p></section>`;
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
  const next = nextOpenMarket(st);
  const feeCard = feeBreakEvenTable(next ? { yesAsk: next.yesAsk, noAsk: next.noAsk, captionId: 'fee-cap-score', context: 'Next open window in this snapshot.' } : null);
  return `${focusCard()}${upgradesCard()}<div class="card arcade"><div class="row"><h2 style="margin:0">Honest scoreboard</h2>${sound || ''}</div>
    <p class="tag explore">PAPER · after fees · not real money</p>
    <p class="note">${esc(GATE_PRIOR.summary || '')} Crypto and Kalshi means are on a $2 paper bet. The 13F copy is on $100 paper per name, entered on the filing date.</p>
    <div class="hype"><b>Hype check.</b> Posts that say a bot turned $68 into $500k are not a track record. This desk does not copy them. A scalp that cannot pay the fee is a loss, even if the screenshot looks green.</div>
    ${feeCard}
    <h2>Ready for real money?</h2>
    <p class="note">Informational only. live_execution is disabled. Passing a study does not turn on a wallet.</p>
    <ul class="feed">${gate || '<li><span class="empty">No gate table in this build yet.</span></li>'}</ul>
    <h2>This phone, arena only</h2>
    <p class="note">n ${phone.length} · net ${money(net, true)} · fees ${money(fees)}. These trades are not in the edge gate.</p>
    <ul class="feed">${race || '<li><span class="empty">No settled arena bets on this phone yet.</span></li>'}</ul>
    ${tabs ? `<div class="seg">${tabs}</div>` : ''}</div>`;
}
function repairCard(st) {
  const desk = ui.deskRepair;
  const session = repairGate(st.repairClosed || []);
  const halted = !!st.halted;
  if (!halted && !(desk && desk.benched)) return '';
  const gate = desk?.repair || session;
  const n = gate.n || 0;
  const need = gate.need || REPAIR_MIN_N;
  const mean = gate.mean == null ? 'no shadow trades yet' : `${money(gate.mean, true)} per trade`;
  const findings = (desk?.findings || []).map((line) => `<li>${esc(line)}</li>`).join('');
  const note = desk?.note ? `<p>${esc(desk.note)}</p>` : '';
  const sessionLine = halted
    ? `<p>This session's loss cap is hit. Realized losses stay on the book. Shadow fills this session: ${session.n} of ${session.need}. They are not added to the balance.</p>`
    : '';
  return `<section class="card repair" role="status" aria-label="Repair mode">
    <h2>Repair mode</h2>
    <p><b>Live paper entries on the benched sleeve stay off.</b> The loss cap is unchanged. Shadow trades keep a log. A resume is ${REPAIR_SIZE_USD} dollars, and that size does not go up after a loss.</p>
    ${note}
    ${sessionLine}
    <label for="repairProgress">Shadow trades toward resuming, ${n} of ${need}. Mean after fees: ${mean}.</label>
    <progress id="repairProgress" max="${need}" value="${Math.min(n, need)}">${n} of ${need}</progress>
    <h2>What went wrong</h2>
    <ol class="findings">${findings || '<li>The trade log has not loaded yet.</li>'}</ol>
    <p class="note">Paper only. live_execution stays off. This does not reset the balance.</p>
  </section>`;
}
function todayCard() {
  if (ui.morningState !== 'ready' && ui.morningState !== 'error') loadMorning();
  const doc = ui.today ? {
    ...ui.today,
    kalshiFetchedAt: ui.today.kalshiFetchedAt || ui.heartbeat?.fetchedAt || ui.heartbeat?.at || null,
    memeFetchedAt: ui.today.memeFetchedAt || ui.memeUpdatedAt || null,
  } : ui.today;
  const state = ui.today ? 'ready' : ui.morningState === 'error' ? 'error' : 'loading';
  return todayHeaderHtml(doc, { state, now: Date.now() });
}
function loadDesk() {
  if (ui.deskState === 'ready' || ui.deskState === 'loading') return;
  ui.deskState = 'loading';
  const get = (f, fb) => fetch(`data/${f}?v=` + Date.now(), { cache: 'no-store' }).then((r) => (r.ok ? r.json() : fb)).catch(() => fb);
  Promise.all([get('brain.json', null), get('journal-open.json', { entries: [] }), get('phone-alerts.json', null)]).then(([brain, open, alerts]) => {
    ui.brainDoc = brain;
    ui.journalOpen = open;
    ui.alerts = alerts;
    ui.deskState = 'ready';
    if (ui.tab === 'home' || ui.tab === 'brain') render();
  });
}
function deskTop() {
  loadDesk();
  if (!ui.focusState) loadFocus();
  if (ui.morningState !== 'ready' && ui.morningState !== 'error') loadMorning();
  return deskHomeHtml({ state: ui.today ? 'ready' : ui.morningState === 'error' ? 'error' : 'loading', today: ui.today, curve: ui.allocCurve, brain: ui.brainDoc, focus: ui.focus, openDoc: ui.journalOpen, alerts: ui.alerts, now: Date.now() });
}
function home(st) {
  const r = st.startedAt ? recap(st, Date.now()) : null;
  const eq = equityNow(st), net = eq - st.startBank;
  const wins = st.closed.filter((t) => t.pnl > 0).length, losses = st.closed.length - wins;
  const realized = st.closed.reduce((a, t) => a + t.pnl, 0), fees = st.closed.reduce((a, t) => a + t.fees, 0);
  const unreal = st.open.reduce((a, p) => a + (p.qty * (p.lastPrice ?? p.entryMid) * (1 - st.settings.feePct / 200) - p.sizeUsd), 0);
  const isReplay = st.mode === 'replay';
  return `
  ${deskTop()}
  <details class="card fold deep" data-fold="home-detail"><summary>Full desk detail<span>today, repair, cockpit, session</span></summary><div class="fold-body">
  ${todayCard()}
  ${repairCard(st)}
  ${cockpit(st)}
  ${focusCard()}
  ${reminderBanner()}
  ${allocCard()}
  ${morningCard()}
  <section class="card" aria-label="Live signals"><h2>Live signals</h2><p class="note">${ui.coinsState === 'ready' ? `${(ui.coins || []).filter((c) => c.pass).length} paper buy${(ui.coins || []).filter((c) => c.pass).length === 1 ? '' : 's'} in the latest Solana list.` : 'Open Coins for the live Solana list. Only a paper buy shows a contract address to copy.'}</p><button type="button" class="btn wide" data-tabjump="coins">Open coins</button></section>
  ${activeCard(st)}
  ${st.halted ? `<div class="halt"><b>Repair mode.</b> ${esc(st.haltReason)}</div>` : ''}
  <div class="card hero ${net < 0 ? 'down' : ''}">
    <div class="row"><h2 style="margin:0">${isReplay ? 'Replay balance' : 'Paper balance'}</h2><span class="note" id="timer"></span></div>
    ${eqHtml(eq)}
    <div class="row" style="margin-top:8px"><span class="pnlchip ${net < 0 ? 'dn' : 'up'}">${countSpan(net, true, 'session-net')} · ${((eq / st.startBank - 1) * 100).toFixed(2)}%</span><span class="note">${(eq / st.startBank).toFixed(3)}× of ${money(st.startBank)} paper</span></div>
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
    ${st.closed.length ? st.closed.slice().reverse().slice(0, 25).map((t) => `<div class="pos"><div><b>${esc(t.symbol)}</b> <span class="chip">${t.source}</span><br><span class="note">${esc(t.exitReason)} · ${tm(t.closedAt)}</span></div><div style="text-align:right"><b class="${t.pnl >= 0 ? 'g' : 'r'}">${money(t.pnl, true)}</b><br><span class="note">${t.retPct}%</span></div></div>`).join('') : (st.open.length ? '<div class="note">None yet.</div>' : emptyArt('empty-trades.webp', 'A quiet chart frame with a single mint dot, waiting for a paper trade.', 'No trades yet. Start a paper session and closed trades land here.'))}
  </div>
  </div></details>`;
}
function foldWrap(id, title, sub, inner) {
  return `<details class="card fold deep" data-fold="${id}"><summary>${esc(title)}<span>${esc(sub)}</span></summary><div class="fold-body">${inner}</div></details>`;
}
function botsTop() {
  loadDesk();
  if (!ui.focusState) loadFocus();
  if (ui.morningState !== 'ready' && ui.morningState !== 'error') loadMorning();
  const decay = freshDecay(ui.lessons, ui.today);
  return `${botChipsHtml(decay)}${agentGridHtml(decay, ui.brainDoc, { top: 8, focus: ui.focus }).replace('Top bots', 'Bots')}`;
}
function scoreTop() {
  if (!ui.focusState) loadFocus();
  return `${gateMeterHtml(ui.focus)}${gateListHtml(ui.focus)}`;
}
const MORE_TABS = ['score', 'predict', 'train', 'settings', 'agents', 'activity'];
function moreView() {
  const tiles = [
    ['score', '★', 'Scoreboard', 'Real-money gate, fees'],
    ['predict', '◎', 'Predict', 'Live 15-min markets'],
    ['train', '◷', 'Train', 'Practice your own calls'],
    ['settings', '⚙', 'Settings', 'Rules, export, theme'],
  ];
  return `<section class="more-grid" aria-label="More">${tiles.map(([id, ic, name, sub]) => `<button type="button" class="tile" data-tabjump="${id}"><span class="tile-ic" aria-hidden="true">${ic}</span><b>${name}</b><small>${sub}</small></button>`).join('')}</section>`;
}
function emptyArt(file, alt, line) {
  return `<figure class="empty-art"><img src="empty/${file}" alt="${esc(alt)}" width="640" height="640" loading="lazy" decoding="async"><figcaption>${esc(line)}</figcaption></figure>`;
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
  <div class="card"><h2>Notifications</h2><label class="f">Browser notifications when the app is in the background<input type="checkbox" id="notify" ${ui.notify ? 'checked' : ''}></label><div class="note">In-app toasts always show. Browser notifications stay on this device.</div></div>
  <div class="card"><h2>Phone alerts</h2><p class="note">Install the ntfy app and subscribe to the topic your assistant gave you. A push means a coin passed the early paper checks. It is an unproven paper signal. The strategy has not passed the edge gate. This page does not show the topic.</p></div>
  <div class="card" id="pro"><h2>Pro</h2><p class="note">Coming soon. There is no payment and no account. If you would pay for a finished version, you can leave an email on this phone. It is stored only in this browser and is not sent anywhere.</p><label class="f">Email on this phone<input id="proEmail" type="email" inputmode="email" autocomplete="off" value="${esc(localStorage.getItem('gd.proEmail') || '')}"></label><button type="button" class="btn wide" id="proSave">Save on this phone</button></div>
  <div class="card"><h2>Feel</h2>
  <label class="f">Sounds<input type="checkbox" id="soundSet" ${ui.sound ? 'checked' : ''}></label>
  <label class="f">Haptics<input type="checkbox" id="hapticSet" ${ui.haptics ? 'checked' : ''}></label>
  <label class="f">Motion<input type="checkbox" id="motionSet" ${ui.motion ? 'checked' : ''}></label>
  <label class="f">Daily practice reminder, in this app only<input type="checkbox" id="remindSet" ${ui.remind ? 'checked' : ''}></label>
  <p class="note">Sounds, haptics, and motion stay on this phone. The system reduced-motion setting turns motion off even when this switch is on. The reminder is a line in the app, not a notification. Haptics need a phone that supports vibration.</p>
  <button type="button" class="btn wide" id="themeBtn">${document.documentElement.dataset.theme === 'light' ? 'Use dark theme' : 'Use light theme'}</button></div>
  <div class="card"><h2>Live execution</h2><label class="f">live_execution<input type="checkbox" disabled></label>
    <div class="note">Disabled and not built. This app has no wallet connection, no private keys and no order code. Going live would need a separate build (wallet signing, a swap router such as Jupiter, priority fees, real slippage handling, kill switch) and Kodie's explicit approval. See <code>LIVE_EXECUTION.md</code>.</div></div>
  <div class="card"><h2>Data</h2><div class="note">Sources (free, no keys): GeckoTerminal, DexScreener, Jupiter, Coinbase, Kalshi snapshot, EDGAR. State lives only in this browser.</div>
    <button class="btn wide" id="exportJson" type="button">Export paper JSON</button>
    <button class="btn wide" id="exportCsv" type="button" style="margin-top:8px">Export paper CSV</button>
    <label class="btn wide" style="margin-top:8px;display:block;text-align:center">Import paper JSON<input id="importJson" type="file" accept="application/json" hidden></label>
    <button class="btn dng wide" id="wipe" style="margin-top:8px" ${live.running ? 'disabled' : ''}>Erase local data</button></div>
  <div class="note" style="text-align:center;margin-bottom:10px">Grok Desk paper v1 · not financial advice. Phone alerts: install the ntfy app and subscribe to the topic your assistant gave you.</div>`;
}

function loadFocus() {
  if (ui.focusState === 'ready' || ui.focusState === 'loading') return;
  ui.focusState = 'loading';
  fetch('data/focus.json?v=' + Date.now(), { cache: 'no-store' })
    .then((r) => { if (!r.ok) throw new Error('focus ' + r.status); return r.json(); })
    .then((doc) => { ui.focus = doc; ui.focusState = 'ready'; setRollingBench(doc.rolled || []); if (ui.tab === 'home' || ui.tab === 'brain' || ui.tab === 'score' || ui.arena === 'score') render(); })
    .catch(() => { ui.focusState = 'error'; if (ui.tab === 'home' || ui.tab === 'brain' || ui.tab === 'score') render(); });
}
function focusCard() {
  if (!ui.focusState) loadFocus();
  return focusCardHtml(ui.focus, { state: ui.focus ? 'ready' : ui.focusState === 'error' ? 'error' : 'loading' });
}
function loadMorning() {
  if (ui.morningState === 'ready' || ui.morningState === 'loading') return;
  ui.morningState = 'loading';
  Promise.all([
    fetch('data/morning.json?v=' + Date.now(), { cache: 'no-store' }).then((r) => r.ok ? r.json() : null),
    fetch('data/heartbeat.json?v=' + Date.now(), { cache: 'no-store' }).then((r) => r.ok ? r.json() : null),
    fetch('data/alloc-curve.json?v=' + Date.now(), { cache: 'no-store' }).then((r) => r.ok ? r.json() : null),
    fetch('data/meme-open.json?v=' + Date.now(), { cache: 'no-store' }).then((r) => r.ok ? r.json() : { entries: [] }).catch(() => ({ entries: [] })),
    fetch('data/meme-watch.json?v=' + Date.now(), { cache: 'no-store' }).then((r) => r.ok ? r.json() : null).catch(() => null),
    fetch('data/today.json?v=' + Date.now(), { cache: 'no-store' }).then((r) => r.ok ? r.json() : null).catch(() => null),
  ]).then(([morning, heartbeat, curve, openDoc, watchDoc, today]) => {
    ui.morning = morning;
    ui.heartbeat = heartbeat;
    ui.allocCurve = curve;
    ui.today = today;
    ui.memeUpdatedAt = openDoc?.updatedAt || null;
    noteMemeWatch(openDoc, watchDoc);
    ui.morningState = 'ready';
    if (ui.tab === 'home' || ui.tab === 'brain') render();
  }).catch(() => { ui.morningState = 'error'; ui.today = null; if (ui.tab === 'home') render(); });
}
function allocCard() {
  const curve = ui.allocCurve;
  const net = curve ? curve.net : 0;
  const day = curve ? curve.day : 0;
  const fees = curve ? curve.fees : 0;
  const ready = curve && curve.n > 0;
  return `<section class="card" aria-label="Allocated paper P and L"><h2>Allocated P&amp;L</h2><p class="note">Today ${countSpan(day, true, 'alloc-day')} after fees. All journaled allocated bets ${countSpan(net, true, 'alloc-net')}. Fees inside that result ${countSpan(fees, false, 'alloc-fees')}.</p><canvas id="allocChart" height="140" aria-label="Allocated paper P and L after fees"></canvas><p class="note">Allocated paper bets only, after fees. A falling line is a loss. This is not a promise.</p>${ready ? '' : '<p class="empty">No allocated journal trades have loaded. If this stays empty, the snapshot journal is missing.</p>'}</section>`;
}
function drawAlloc(cv) {
  if (!cv) return;
  const rows = ui.allocCurve?.points || [];
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 320;
  const h = 140;
  cv.width = w * dpr; cv.height = h * dpr;
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  if (rows.length < 2) return;
  const ys = rows;
  const min = Math.min(...ys, 0);
  const max = Math.max(...ys, 0);
  const span = max - min || 1;
  g.strokeStyle = '#8b97a6';
  g.beginPath();
  const zero = h - 12 - ((0 - min) / span) * (h - 24);
  g.moveTo(8, zero); g.lineTo(w - 8, zero); g.stroke();
  g.strokeStyle = ys[ys.length - 1] < 0 ? '#ff6b7d' : '#3dff9a';
  g.lineWidth = 2;
  g.beginPath();
  ys.forEach((val, i) => {
    const x = 8 + (i / (ys.length - 1)) * (w - 16);
    const py = h - 12 - ((val - min) / span) * (h - 24);
    if (i === 0) g.moveTo(x, py); else g.lineTo(x, py);
  });
  g.stroke();
}
function noteMemeWatch(openDoc, watchDoc) {
  ui.memeOpen = openDoc?.entries || [];
  ui.memeWatchedAt = watchDoc?.watchedAt || null;
  ui.watchReady = true;
}
function watchStatus() {
  if (!ui.watchReady) return '';
  const line = watchHealthLine(watchHealth({ open: ui.memeOpen || [], watchedAt: ui.memeWatchedAt, now: Date.now() }));
  if (!line) return '';
  return `<p class="halt" role="status">${esc(line)}</p>`;
}
function morningCard() {
  if (ui.morningState !== 'ready') loadMorning();
  const report = ui.morning;
  const beat = ui.heartbeat;
  const beatLine = beat?.at ? `Heartbeat ${beat.at.slice(0, 16).replace('T', ' ')} UTC · ${beat.open ?? 0} open · ${beat.settled ?? 0} settled` : 'Heartbeat waiting for the next snapshot.';
  if (!report) return `<section class="card" aria-label="Morning report"><h2>Morning report</h2>${watchStatus()}<p class="note">${esc(beatLine)}</p><p class="note">The report is written with the daily lesson job. Paper only.</p></section>`;
  const best = report.best ? `${report.best.id} ${money(report.best.mean, true)}` : '—';
  const worst = report.worst ? `${report.worst.id} ${money(report.worst.mean, true)}` : '—';
  const lessons = (report.lessons || []).filter((l) => !(report.recentForm || []).includes(l)).slice(0, 2).map((l) => `<li>${esc(l)}</li>`).join('');
  const changed = (report.changed || []).slice(0, 3).map((l) => `<li>${esc(l)}</li>`).join('');
  const mvm = (report.modelVsMarket || []).slice(0, 2).map((l) => `<li>${esc(l)}</li>`).join('');
  const form = (report.recentForm || []).slice(0, 3).map((l) => `<li>${esc(l)}</li>`).join('');
  return `<section class="card" aria-label="Morning report"><h2>Morning report</h2>${watchStatus()}<p class="note">${esc(beatLine)}</p><p class="note">${esc(report.day || '')} · n ${report.trades ?? 0} · net ${money(report.net, true)} after fees</p><p class="note">Best ${esc(best)} · Worst ${esc(worst)}</p><ul class="feed">${lessons}</ul>${form ? `<p class="note"><b>Recent form</b></p><ul class="feed">${form}</ul>` : ''}${mvm ? `<p class="note"><b>Model vs market</b></p><ul class="feed">${mvm}</ul>` : ''}${changed ? `<ul class="feed">${changed}</ul>` : ''}</section>`;
}
function loadBrain() {
  if (ui.brainState === 'ready' || ui.brainState === 'loading') return;
  ui.brainState = 'loading';
  Promise.all([
    fetch('data/lessons.json?v=' + Date.now(), { cache: 'no-store' }).then((r) => { if (!r.ok) throw new Error('lessons unavailable'); return r.json(); }),
    fetch('data/journal-open.json?v=' + Date.now(), { cache: 'no-store' }).then((r) => r.ok ? r.json() : { entries: [] }),
    fetch('data/today.json?v=' + Date.now(), { cache: 'no-store' }).then((r) => r.ok ? r.json() : null).catch(() => null),
  ]).then(([lessons, open, today]) => {
    ui.lessons = lessons;
    if (today) ui.today = today;
    ui.journalOpen = open;
    ui.brainState = 'ready';
    if (ui.tab === 'brain') render();
  }).catch((e) => {
    ui.brainState = 'error';
    ui.brainError = e.message;
    if (ui.tab === 'brain') render();
  });
}
// Model vs market: Brier of each model-priced bot against Kalshi's own ask.
// Numbers come from data/today.json (every snapshot) or data/lessons.json
// (nightly), whichever is newer; nothing here is hard-coded.
function modelMarketCard(doc, today) {
  const pick = freshCalibration(doc, today);
  const rows = pick.rows || [];
  const stamp = pick.at ? `<p class="note mvm-at">Updated ${esc(pick.at.slice(0, 16).replace('T', ' '))} UTC · ${pick.source === 'snapshot' ? 'every snapshot' : 'nightly lessons'}</p>` : '';
  if (!rows.length) {
    const why = pick.rows ? 'No model-priced bot has a settled paper line since it was added.' : 'The nightly lessons run has not written this audit yet. It appears after the next run.';
    return `<section class="card mvm" aria-label="Model vs market"><div class="row"><h2 style="margin:0">Model vs market</h2><span class="tag explore">PAPER</span></div><p class="note">${why}</p></section>`;
  }
  const form = new Map(freshDecay(doc, today).map((s) => [s.id, s]));
  const top = Math.max(0.25, ...rows.map((r) => Math.max(Number(r.brierModel) || 0, Number(r.brierMarket) || 0)));
  const pct = (v) => Math.max(2, Math.min(100, Math.round((100 * (Number(v) || 0)) / top)));
  const items = rows.map((r) => {
    const better = r.beatsMarket === true;
    const same = Number(r.brierModel).toFixed(3) === Number(r.brierMarket).toFixed(3);
    const verdict = same ? 'about even' : better ? 'beats Kalshi' : 'behind Kalshi';
    return `<li class="mvm-row">
      <div class="row"><b>${esc(r.id)}</b><span class="mvm-pill ${same ? 'even' : better ? 'up' : 'down'}">${verdict}</span></div>
      <div class="mvm-bars" role="img" aria-label="Brier ${esc(r.id)} ${Number(r.brierModel).toFixed(3)}, Kalshi ${Number(r.brierMarket).toFixed(3)}. Lower is better.">
        <span class="mvm-k">Model</span><span class="mvm-bar"><i class="m" style="width:${pct(r.brierModel)}%"></i></span><span class="mvm-v">${Number(r.brierModel).toFixed(3)}</span>
        <span class="mvm-k">Kalshi</span><span class="mvm-bar"><i class="k" style="width:${pct(r.brierMarket)}%"></i></span><span class="mvm-v">${Number(r.brierMarket).toFixed(3)}</span>
      </div>
      <dl class="mvm-stats"><div><dt>Won</dt><dd>${r.wins}/${r.n}</dd></div><div><dt>Model expected</dt><dd>${Number(r.sumPEst).toFixed(1)}</dd></div><div><dt>Kalshi implied</dt><dd>${Number(r.sumAsk).toFixed(1)}</dd></div><div><dt>Mean / $2</dt><dd class="${r.mean < 0 ? 'neg' : 'pos'}">${money(r.mean, true)}</dd></div></dl>
      <p class="note">${esc(r.text || '')}</p>
      ${form.has(r.id) ? `<div class="rf">${recentFormChipHtml(form.get(r.id))}<p class="note rf-text">${esc(form.get(r.id).text)}</p></div>` : ''}
    </li>`;
  }).join('');
  return `<section class="card mvm" aria-label="Model vs market">
    <div class="row"><h2 style="margin:0">Model vs market</h2><span class="tag explore">PAPER · Brier, lower is better</span></div>
    <p class="note">How close each model's win chance was to what happened, next to the price Kalshi asked. Settled paper lines since each bot was added, after fees.</p>
    <ul class="mvm-list">${items}</ul>
    ${stamp}
  </section>`;
}
function brainView() {
  if (ui.brainState !== 'ready') {
    loadBrain();
    if (ui.brainState === 'error') return `<div class="card"><h2>Bot brain</h2><p class="empty">The lessons file did not load. ${esc(ui.brainError || 'Check the connection and try again.')}</p><button type="button" class="btn" id="brainRetry">Retry</button></div>`;
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
  const repairLine = (bot) => {
    if (!quiet(bot) || !(bot.repairNeed > 0)) return '';
    const n = bot.repairN || 0;
    const mean = bot.repairMean == null ? 'no settled practice yet' : `${money(bot.repairMean, true)} per trade`;
    return `<p class="note"><label for="repair-${esc(bot.id)}">Repair practice ${n} of ${bot.repairNeed}. Mean after fees: ${mean}.</label></p><progress id="repair-${esc(bot.id)}" max="${bot.repairNeed}" value="${Math.min(n, bot.repairNeed)}">${n} of ${bot.repairNeed}</progress>`;
  };
  const form = new Map(freshDecay(doc, ui.today).map((s) => [s.id, s]));
  const formChip = (bot) => (form.get(bot.id)?.flag ? `<div class="rf">${recentFormChipHtml(form.get(bot.id))}</div>` : '');
  const cards = bots.map((bot) => `<li class="slot"><div class="row"><b>${esc(bot.label)}</b><span class="tag ${quiet(bot) ? 'off' : bot.role === 'champion' ? 'normal' : 'explore'}">${quiet(bot) ? 'benched-shadow' : esc(bot.role)}</span></div>${formChip(bot)}<p class="note">Level ${bot.level} · ${share(bot)} · n ${bot.n} · mean ${bot.mean == null ? '—' : money(bot.mean, true)} after fees · 90% ${bot.lo == null ? '—' : money(bot.lo, true)} to ${bot.hi == null ? '—' : money(bot.hi, true)} · ${esc(bot.sample || '')}</p><p class="note">${bot.graduated ? 'Gate cleared on this journal. Live execution stays off.' : `Gate progress ${bot.gateWindows || 0}/3 windows of 20+. Not ready for real money.`}</p>${repairLine(bot)}</li>`).join('');
  const summary = (doc.summary || []).map((l) => `<li>${esc(l)}</li>`).join('');
  const learned = (doc.lessons || []).slice(0, 6).map((l) => `<li>${esc(l.text)}</li>`).join('');
  const frozen = (doc.frozen || []).map((l) => `<li>${esc(l.text)}</li>`).join('');
  const decisions = (doc.decisions || []).map((l) => `<li>${esc(l)}</li>`).join('');
  return `${upgradesCard()}${modelMarketCard(doc, ui.today)}<section class="card arcade" aria-label="Bot brain">
    <div class="row"><h2 style="margin:0">Bot brain</h2><span class="tag explore">PAPER · after fees</span></div>
    <p class="lvl" id="runFor">${esc(since)}</p>
    <p class="note">Level counts settled paper bets, not profit. A loss does not raise the $2 size. A bot that loses $6 of its own allocated paper goes to shadow. The others keep trading. ${openN} paper line${openN === 1 ? '' : 's'} are waiting on a result.</p>
    ${(bots.some(quiet) || bots.some((b) => !b.graduated) || !bots.length) ? emptyArt('empty-bot.webp', 'A small bot reading on a bench while a gold ring spins overhead.', bots.some(quiet) ? 'A bot is benched and still learning. Shadow only, until the paper record turns up.' : 'The bots are still learning on paper. None are benched.') : ''}
    <h2>What the bots learned today</h2>
    <ul class="feed">${(bots.filter((b) => b.shadow || b.benched).map((b) => `<li>benched ${esc(b.id)}: ${b.mean == null ? '—' : money(b.mean)}/trade over n ${b.n}. Shadow only until the shadow record turns positive.</li>`).join('')) || '<li><span class="empty">No bot was moved to shadow in this lessons file.</span></li>'}</ul>
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
async function loadDeskRepair() {
  try {
    const text = await fetch('data/meme-journal.jsonl?v=' + Date.now(), { cache: 'no-store' }).then((r) => (r.ok ? r.text() : ''));
    const rows = String(text || '').trim() ? String(text).trim().split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean) : [];
    ui.deskRepair = diagnoseMeme(withoutQuoteErrors(rows)); // bad-quote rows stay out of every display total
  } catch {
    ui.deskRepair = null;
  }
  if (state && ui.tab === 'home') render();
}
async function loadCoins() {
  if (ui.coinsState === 'loading') return;
  ui.coinsState = 'loading';
  if (ui.tab === 'coins') render();
  try {
    const [board, openDoc, journalText, watchDoc, earlyDoc] = await Promise.all([
      fetch('data/meme-board.json?v=' + Date.now(), { cache: 'no-store' }).then((r) => { if (!r.ok) throw new Error('Coin board ' + r.status); return r.json(); }),
      fetch('data/meme-open.json?v=' + Date.now(), { cache: 'no-store' }).then((r) => r.ok ? r.json() : { entries: [] }).catch(() => ({ entries: [] })),
      fetch('data/meme-journal.jsonl?v=' + Date.now(), { cache: 'no-store' }).then((r) => r.ok ? r.text() : '').catch(() => ''),
      fetch('data/meme-watch.json?v=' + Date.now(), { cache: 'no-store' }).then((r) => r.ok ? r.json() : null).catch(() => null),
      fetch('data/early-board.json?v=' + Date.now(), { cache: 'no-store' }).then((r) => r.ok ? r.json() : { coins: [] }).catch(() => ({ coins: [] })),
    ]);
    noteMemeWatch(openDoc, watchDoc);
    ui.memeJournal = String(journalText || '').trim() ? String(journalText).trim().split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean) : [];
    ui.coins = mergeEarly(Array.isArray(board?.coins) ? board.coins : [], earlyDoc);
    ui.coinsState = 'ready';
    ui.coinsAt = Date.parse(board?.fetchedAt) || Date.now();
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
function mergeEarly(board, early) {
  const extra = new Map((early?.coins || []).filter((row) => row?.ca).map((row) => [row.ca, row]));
  const seen = new Set();
  const coins = (board || []).map((coin) => {
    seen.add(coin.ca);
    const row = extra.get(coin.ca);
    if (!row) return coin;
    return { ...coin, earlyAction: row.action, earlyReason: row.reason };
  });
  for (const row of extra.values()) {
    if (seen.has(row.ca)) continue;
    coins.push({
      ...row,
      pass: false,
      dexUrl: row.dexUrl || `https://dexscreener.com/solana/${row.ca}`,
      earlyAction: row.action,
      earlyReason: row.reason,
    });
  }
  return coins;
}
function coinsView() {
  if (ui.coinsState !== 'ready' && ui.coinsState !== 'error') loadCoins();
  const note = `<p class="note">Signals are paper-tested ideas, not advice. You buy in your own pump.fun or fomo account. This app has no wallet and cannot place an order.</p>`;
  const alert = `<button type="button" id="coinAlert" class="switch ${ui.coinAlerts ? 'on' : ''}" aria-pressed="${!!ui.coinAlerts}">${ui.coinAlerts ? 'Alerts on' : 'Alerts off'}</button>`;
  if (ui.coinsState !== 'ready') {
    const bones = [0, 1, 2].map(() => '<div class="skel-card" aria-hidden="true"><div class="skel logo"></div><div class="skel-col"><div class="skel"></div><div class="skel short"></div><div class="skel wide"></div></div></div>').join('');
    return `<section class="card" aria-label="Coin signals">${note}<div class="row"><h2 style="margin:0">Coins</h2>${alert}</div>${ui.coinsState === 'error' ? `<p class="empty">The coin list did not load. ${esc(ui.coinsError || '')} Check the connection and try again. Nothing was ordered.</p><button type="button" class="btn" id="coinRetry">Retry</button>` : `<div aria-busy="true" aria-label="Loading coins">${bones}</div><p class="note">Reading mint accounts and holders.</p>`}</section>`;
  }
  const watch = watchSet();
  const filtered = (ui.coins || []).filter((c) => ui.coinFilter === 'watch' ? watch.has(c.ca) : ui.coinFilter === 'pass' ? c.pass : true);
  const cards = filtered.map((coin) => coinCard(coin, watch)).join('');
  const passed = (ui.coins || []).filter((c) => c.pass).length;
  const filters = `<div class="chips" role="group" aria-label="Coin filters"><button type="button" data-coinfilter="all" class="${ui.coinFilter === 'all' ? 'on' : ''}">All</button><button type="button" data-coinfilter="pass" class="${ui.coinFilter === 'pass' ? 'on' : ''}">Paper buys</button><button type="button" data-coinfilter="watch" class="${ui.coinFilter === 'watch' ? 'on' : ''}">Watching</button></div>`;
  const watchEmpty = ui.coinFilter === 'watch' && !filtered.length
    ? `<div class="card">${emptyArt('empty-coins.webp', 'A shield with a mint rim, for a watchlist that is still empty.', 'Nothing on your watchlist yet. Tap Watch on a coin. The list stays on this phone.')}</div>`
    : '';
  const coinEmpty = ui.coinFilter !== 'watch' && passed === 0
    ? `<div class="card">${emptyArt('empty-coins.webp', 'A shield with a mint rim, for coins that have not cleared the safety checks.', cards ? 'Nothing passed the safety checks yet.' : 'Nothing passed the safety checks yet. Pull down to try the next scan.')}</div>`
    : watchEmpty;
  const justOpened = !!(ui.coinOpen && ui.coinOpen !== ui.sheetFor);
  ui.sheetFor = ui.coinOpen || null;
  const sheet = ui.coinOpen ? coinSheet(ui.coins.find((c) => c.ca === ui.coinOpen), justOpened) : '';
  const books = memeBooks(ui.memeJournal || []);
  const gate = books.gate;
  const age = ui.coinsAt ? `Prices checked ${Math.max(0, Math.round((Date.now() - ui.coinsAt) / 60000))}m ago.` : '';
  return `<section aria-label="Coin signals">${note}<div class="card"><div class="row"><h2 style="margin:0">Coins</h2>${alert}</div>${filters}<p class="note">Paper meme book: n ${gate.n}, net ${money(books.net, true)} after the 1.25% fee and 1% slippage each side. Shadow and early logs are separate: n ${books.shadowN}, net ${money(books.shadowNet, true)} after fees, and they are not in that total. ${gate.graduated ? 'Gate cleared. Live execution stays off.' : 'Not ready for real money. The edge gate still needs 3 days of 20+ trades.'}</p>${watchStatus()}<p class="note">${esc(age)} The paper chain writes this list. pump.fun's API did not answer here. Prices are DexScreener. Mint and freeze come from the mint account. Top 10 holders come from the largest token accounts, and the pool vault is left out when that account is owned by the pair. Dev wallet share is unknown and does not block. A missed lookup fails that check.</p></div>${coinEmpty}${filtered.length || ui.coinFilter === 'watch' ? '' : ''}${cards}${sheet}</section>`;
}
function coinLinks(ca, dexUrl) {
  const item = (href, icon, label) => `<a class="btn coin-link" href="${esc(href)}" target="_blank" rel="noopener"><img src="${icon}" alt="" width="18" height="18">${label}</a>`;
  return `<div class="linkrow">${item(`https://pump.fun/coin/${ca}`, 'icons/pump.svg', 'Pump.fun')}${item(`https://fomo.family/tokens/solana/${ca}`, 'icons/fomo.svg', 'FOMO')}${item(dexUrl || `https://dexscreener.com/solana/${ca}`, 'icons/dex.svg', 'DexScreener')}${item(`https://solscan.io/token/${ca}`, 'icons/solscan.svg', 'Solscan')}</div>`;
}
function coinLogo(coin) {
  const initials = esc(String(coin.symbol || '?').replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase() || '?');
  const hue = [...String(coin.ca || '')].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 360;
  if (!coin.imageUrl) return `<span class="logo fallback" style="--h:${hue}" aria-hidden="true">${initials}</span>`;
  return `<img class="logo" alt="" loading="lazy" data-initials="${initials}" data-h="${hue}" src="${esc(coin.imageUrl)}">`;
}
function caChip(ca) {
  const short = ca.length > 12 ? `${ca.slice(0, 4)}…${ca.slice(-4)}` : ca;
  return `<button type="button" class="ca-chip" data-expand-ca aria-expanded="false" aria-label="Contract address, tap to expand"><span class="ca-short">${esc(short)}</span><span class="ca-full">${esc(ca)}</span></button><button type="button" class="btn pri" data-copy="${esc(ca)}">Copy</button>`;
}
function coinCard(coin, watch = watchSet()) {
  const on = watch.has(coin.ca);
  const early = coin.earlyAction ? `<p class="note">${esc(coin.earlyAction)} · ${esc(coin.earlyReason || '')}</p>` : '';
  return `<article class="card coin"><button type="button" class="coin-open" data-open-coin="${esc(coin.ca)}">${coinLogo(coin)}<span class="coin-id"><b>${esc(coin.name)}</b><small>$${esc(coin.symbol)}</small></span><span class="tag ${coin.pass ? 'normal' : 'off'}">${coin.pass ? 'paper buy' : 'no buy'}</span></button><div class="row">${caChip(coin.ca)}<button type="button" class="btn" data-watch="${esc(coin.ca)}" aria-pressed="${on}">${on ? 'Watching' : 'Watch'}</button></div>${coinLinks(coin.ca, coin.dexUrl)}${early}</article>`;
}
function coinSheet(coin, animate) {
  if (!coin) return '';
  const why = (coin.reasons || []).map((r) => `<li><span class="tag ${r.ok === true ? 'normal' : r.ok === false ? 'off' : ''}">${r.ok === true ? 'pass' : r.ok === false ? 'fail' : 'unknown'}</span> ${esc(r.name)} · ${esc(r.detail)}</li>`).join('');
  const paper = (ui.memeOpen || []).find((row) => row.ca === coin.ca) || [...(ui.memeJournal || [])].reverse().find((row) => row.ca === coin.ca);
  const paperLine = !paper ? 'No paper trade on this coin yet.' : paper.pnl == null ? `Paper open · $${paper.sizeUsd || 2}` : `Paper ${paper.exit || 'open'} · ${money(paper.pnl, true)} after fees`;
  const age = coin.ageMin == null ? 'age unknown' : `${Math.round(coin.ageMin)} min old`;
  const liq = coin.liq == null ? 'liquidity unknown' : `liquidity $${Math.round(Number(coin.liq)).toLocaleString('en-US')}`;
  const vol = coin.vol == null ? 'volume unknown' : `24h volume $${Math.round(Number(coin.vol)).toLocaleString('en-US')}`;
  return `<div class="sheet${animate ? ' in' : ''}" role="dialog" aria-label="${esc(coin.name)}"><div class="card">${coinLogo(coin)}<h2>${esc(coin.name)} · $${esc(coin.symbol)}</h2><div class="row">${caChip(coin.ca)}</div>${coinLinks(coin.ca, coin.dexUrl)}<p class="note">${esc(liq)} · ${esc(vol)} · ${esc(age)} · price ${coin.priceUsd ? countSpan(Number(coin.priceUsd), false, 'px-' + coin.ca, coin.priceUsd) : 'unknown'}</p><p class="note">${paperLine}</p><ul class="feed">${why}</ul><button type="button" class="btn wide" data-close-sheet>Close</button></div></div>`;
}
function shotNote() {
  if (!ui.shotLock) return '';
  return '<p class="note shot-note">Screenshot data on this load. Not a live quote. Paper only.</p>';
}
function flame(n) { return n > 0 ? '<i class="flame" aria-hidden="true"></i>' : ''; }
function ringHtml(close, primary) {
  return `<div class="ring" data-ring ${primary ? 'data-primary="1"' : ''} data-close="${esc(close)}" data-span="900" role="timer"><svg viewBox="0 0 36 36" aria-hidden="true"><circle class="ring-track" cx="18" cy="18" r="15.5"></circle><circle class="ring-val" cx="18" cy="18" r="15.5"></circle></svg><span class="ring-num">–:––</span></div>`;
}
function quoteBox(st) {
  const board = st?.kalshiBoard;
  const busy = ui.kalshiBusy ? '<p class="note">Checking for a newer snapshot.</p>' : '';
  const retry = `<button type="button" class="btn" id="quoteRetry">${ui.kalshiBusy ? 'Checking…' : 'Retry'}</button>`;
  if (!board?.markets) {
    return `<div id="quoteBox" class="quote-box is-stale" role="status"><p class="quote-clock">No snapshot yet</p><p>The Kalshi file has not loaded. The desk will try again. You can retry now. Nothing here places an order.</p>${st?.quoteError ? `<p>${esc(st.quoteError)}</p>` : ''}${busy}${retry}</div>`;
  }
  const age = quoteAge(board.fetchedAt, Date.now());
  const clock = age.ms == null ? 'Updated time unknown' : `Updated ${age.label} ago`;
  return `<div id="quoteBox" class="quote-box ${age.stale ? 'is-stale' : 'is-fresh'}" role="status"><div class="row"><p id="quoteClock" class="quote-clock">${esc(clock)}</p>${retry}</div><p class="when-stale note">Too old for a live window. The file reloads on its own. You can retry. No order is sent.</p><p class="when-fresh note">Inside 15 minutes.</p>${st?.quoteError ? `<p>${esc(st.quoteError)}</p>` : ''}${busy}</div>`;
}
function paintRings(now = Date.now()) {
  const circ = 2 * Math.PI * 15.5;
  document.querySelectorAll('[data-ring]').forEach((el) => {
    const close = Date.parse(el.dataset.close);
    const span = Number(el.dataset.span) || 900;
    const left = Number.isFinite(close) ? Math.max(0, Math.round((close - now) / 1000)) : 0;
    const frac = Math.max(0, Math.min(1, left / span));
    const val = el.querySelector('.ring-val');
    if (val) {
      val.style.strokeDasharray = String(circ);
      val.style.strokeDashoffset = String(circ * (1 - frac));
    }
    const num = el.querySelector('.ring-num');
    if (num) num.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    const mins = Math.floor(left / 60);
    el.setAttribute('aria-label', left > 0 ? `${mins} minutes ${left % 60} seconds left in this 15-minute window` : 'This 15-minute window has locked');
  });
}
function paintQuoteClock() {
  const el = document.getElementById('quoteClock');
  const board = state?.kalshiBoard;
  if (!el || !board) return;
  const age = quoteAge(board.fetchedAt, Date.now());
  el.textContent = age.ms == null ? 'Updated time unknown' : `Updated ${age.label} ago`;
  const box = document.getElementById('quoteBox');
  if (box) {
    box.classList.toggle('is-stale', !!age.stale);
    box.classList.toggle('is-fresh', !age.stale);
  }
}
function moveTabIndicator() {
  const nav = document.querySelector('.tabs');
  const on = nav?.querySelector('button.on');
  const bar = nav?.querySelector('.tab-indicator');
  if (!bar) return;
  if (!on) { bar.style.width = '0px'; return; }
  bar.style.width = `${on.offsetWidth}px`;
  bar.style.transform = `translateX(${on.offsetLeft}px)`;
  const left = on.offsetLeft - (nav.clientWidth - on.offsetWidth) / 2;
  nav.scrollTo({ left: Math.max(0, left), behavior: motionOn() ? 'smooth' : 'auto' });
}
function fillXp() {
  document.querySelectorAll('.xpbar i, .focus-bar i, .today-bar i').forEach((el) => {
    const w = el.dataset.w || '0%';
    if (!motionOn()) { el.style.width = w; return; }
    el.style.width = '0%';
    requestAnimationFrame(() => { if (el.isConnected) el.style.width = w; });
  });
}
function practicedToday(book, now = Date.now()) {
  const day = new Date(now).toISOString().slice(0, 10);
  return [...(book?.open || []), ...(book?.closed || [])].some((c) => new Date(c.calledAt || 0).toISOString().slice(0, 10) === day);
}
function reminderBanner() {
  if (localStorage.getItem('gd.remind') !== '1') return '';
  const day = new Date().toISOString().slice(0, 10);
  if ((localStorage.getItem('gd.remindSnooze') || '') === day) return '';
  if (practicedToday(loadTrainer())) return '';
  return `<div class="card remind" role="status"><p><b>Practice reminder.</b> No 15-minute paper call yet today. This stays in the app. It is not a phone notification and not advice.</p><div class="row"><button type="button" class="btn pri" id="remindOpen">Open trainer</button><button type="button" class="btn" id="remindSnooze">Not today</button></div></div>`;
}
function nextOpenMarket(st, now = Date.now()) {
  return openMarkets(st, now)[0] || null;
}
function openMarkets(st, now) {
  return (st.kalshiBoard?.markets || [])
    .filter((m) => m && m.result !== 'yes' && m.result !== 'no' && Date.parse(m.closeTime) > now)
    .sort((a, b) => Date.parse(a.closeTime) - Date.parse(b.closeTime));
}
function marketYesText(market) {
  const bid = Number(market.yesBid);
  const ask = Number(market.yesAsk);
  if (bid > 0 && bid < 1 && ask > 0 && ask < 1 && bid <= ask) return ((bid + ask) / 2).toFixed(2);
  if (ask > 0 && ask < 1) return ask.toFixed(2);
  return 'not in the quote';
}
function callPanel(st, book, age, now) {
  const markets = openMarkets(st, now);
  const waiting = (book.open || []).map((c) => {
    const left = Date.parse(c.closeTime) - now;
    return `<li class="slot"><div class="row"><b>${esc(c.title || c.ticker)}</b><span class="note">${esc(String(c.side).toUpperCase())} ${esc(c.confidence)}%</span></div><p class="note">${left > 0 ? 'Open. Waiting for the result.' : 'Locked. Waiting for the snapshot to publish a result.'} Size stays $${TRAINER_STAKE}.</p></li>`;
  }).join('');
  const waitList = `<h2>Waiting</h2><ul class="feed">${waiting || '<li><span class="empty">No open practice call.</span></li>'}</ul>`;
  if (age.stale || !markets.length) {
    const extra = age.stale ? '' : '<p class="empty">No 15-minute window is still open in this snapshot. Settled calls stay on Lesson and Progress.</p>';
    const shown = markets[0];
    const fee = shown
      ? feeBreakEvenTable({ yesAsk: shown.yesAsk, noAsk: shown.noAsk, captionId: 'fee-cap-call', context: 'This snapshot is stale, so this is not a live call. The rate below is the fee math for that ask.' })
      : feeBreakEvenTable(null);
    return `${quoteBox(st)}${extra}${fee}${waitList}`;
  }
  if (!markets.some((m) => m.ticker === ui.trainTicker)) ui.trainTicker = markets[0].ticker;
  const market = markets.find((m) => m.ticker === ui.trainTicker) || markets[0];
  const ideas = arenaIdeas(market, now, st.spots || {}, st.arenaQuotes || {});
  const botLine = ideas.length ? ideas.map((b) => `${b.rule} ${String(b.side).toUpperCase()}`).join(', ') : 'No paper bot setup on this quote.';
  const feeCard = feeBreakEvenTable({ yesAsk: market.yesAsk, noAsk: market.noAsk, captionId: 'fee-cap-call', looking: ui.trainSide, context: 'This window.' });
  const left = Math.max(0, Math.round((Date.parse(market.closeTime) - now) / 1000));
  const late = left < 60 ? '<p class="note">Under a minute left. The fee still applies. Size stays $2.</p>' : '';
  const options = markets.map((m) => `<option value="${esc(m.ticker)}" ${m.ticker === market.ticker ? 'selected' : ''}>${esc(m.series || m.ticker)} · ${esc(m.title || '')}</option>`).join('');
  return `${quoteBox(st)}<div class="ring-row">${ringHtml(market.closeTime, true)}<div><p class="lvl">${esc(market.series || '15m')}</p><p class="note">${esc(market.title || '')}</p></div></div><label class="stack">Window<select id="trainMarket">${options}</select></label><p class="note">Bots on this quote: ${esc(botLine)}. Quote YES ${esc(marketYesText(market))}.</p>${feeCard}${late}<form data-train-form="${esc(market.ticker)}"><div class="yesno"><button type="button" class="btn" data-side="yes" aria-pressed="${ui.trainSide === 'yes'}">YES</button><button type="button" class="btn" data-side="no" aria-pressed="${ui.trainSide === 'no'}">NO</button></div><label class="f">Confidence %<input name="confidence" type="number" inputmode="numeric" min="51" max="99" step="1" required value="${esc(ui.trainConf || '60')}"></label><button class="btn pri wide" type="submit">Record paper call</button></form><p class="note">A whole number from 51 to 99. Under 50 means pick the other side. One call per window.</p>${waitList}`;
}
function lessonPanel(book) {
  const rows = [...(book.closed || [])].sort((a, b) => (b.settledAt || 0) - (a.settledAt || 0));
  if (!rows.length) return '<p class="empty">No settled practice call yet. Record one on Call. The lesson uses the snapshot, the strike, and the spot estimate. It does not invent a reason.</p>';
  const row = rows.find((r) => r.id === ui.lessonId) || rows[0];
  ui.lessonId = row.id;
  const picks = rows.slice(0, 8).map((r) => `<option value="${esc(r.id)}" ${r.id === row.id ? 'selected' : ''}>${esc(r.series || r.ticker)} · ${r.won ? 'hit' : 'miss'}</option>`).join('');
  const bots = row.bots?.length ? row.bots.map((b) => `${b.rule} ${String(b.side).toUpperCase()}`).join(', ') : 'No setup fired';
  const quote = row.marketYes == null ? 'No YES price' : `YES ${Number(row.marketYes).toFixed(2)}`;
  return `<label class="stack">Settled call<select id="lessonPick">${picks}</select></label><article class="card" id="lessonCard"><p class="${row.won ? 'g' : 'r'}">${row.won ? 'Hit' : 'Miss'}</p><ul class="compare"><li><b>You</b><span>${esc(String(row.side || '').toUpperCase())} ${esc(row.confidence)}%</span></li><li><b>Bots</b><span>${esc(bots)}</span></li><li><b>Quote</b><span>${esc(quote)}</span></li></ul><p>${countSpan(row.pnl, true, 'train-' + row.id)} after fees</p>${feeAskNote(row.ask, row.side)}<p class="note">${esc(lessonText(row))}</p><button type="button" class="btn wide" data-share="${esc(row.id)}">Save result card</button></article>`;
}
function bucketChart(buckets) {
  const w = 320;
  const h = 120;
  const gap = 10;
  const bw = (w - gap * (buckets.length + 1)) / Math.max(1, buckets.length);
  const inner = h - 28;
  const marks = buckets.map((b, i) => {
    const x = gap + i * (bw + gap);
    const rh = b.rate == null ? 0 : b.rate * inner;
    const eh = b.expected * inner;
    return `<rect x="${x.toFixed(1)}" y="${(h - 16 - rh).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, rh).toFixed(1)}" rx="3" fill="#3DFF9A"></rect><line x1="${x.toFixed(1)}" x2="${(x + bw).toFixed(1)}" y1="${(h - 16 - eh).toFixed(1)}" y2="${(h - 16 - eh).toFixed(1)}" stroke="#FFD56A" stroke-width="2"></line>`;
  }).join('');
  return `<svg class="cal" viewBox="0 0 ${w} ${h}" aria-hidden="true">${marks}</svg>`;
}
function progressPanel(stats) {
  const ready = stats.ready;
  const pct = ((stats.xp % 50) / 50) * 100;
  const days = ready.windows.map((w) => {
    const flag = w.n < 20 ? 'needs 20 calls' : (w.mean > 0 && w.lo > 0 ? 'clears' : 'does not clear');
    return `<li>${esc(w.key)} · n ${w.n} · mean ${w.mean == null ? '—' : money(w.mean, true)} · 90% low ${w.lo == null ? '—' : money(w.lo, true)} · ${flag}</li>`;
  }).join('');
  const buckets = stats.buckets.map((b) => `<tr><td>${b.lo}–${b.hi}%</td><td>${b.n}</td><td>${b.n ? Math.round(b.rate * 100) + '%' : '—'}</td><td>${Math.round(b.expected * 100)}%</td></tr>`).join('');
  const hit = stats.hitRate == null ? '—' : `${Math.round(stats.hitRate * 100)}%`;
  return `<div class="grid"><div class="stat"><small>Calls</small><b>${stats.calls}</b><span class="note">${stats.open} open</span></div><div class="stat"><small>Hit rate</small><b>${hit}</b><span class="note">${stats.settled ? `${stats.hits} of ${stats.settled}` : 'no settles'}</span></div><div class="stat"><small>After fees</small><b>${countSpan(stats.pnl, true, 'train-net')}</b></div></div><p class="note">Fees inside that result ${money(stats.fees)}. ${esc(brierVerdict(stats.brier, stats.marketBrier, stats.settled))}</p><p class="lvl">${flame(stats.streak)}${stats.streak} hit streak</p><span class="xpbar" role="progressbar" aria-valuemin="0" aria-valuemax="50" aria-valuenow="${stats.xp % 50}" aria-label="Practice XP toward the next level"><i data-w="${pct}%"></i></span><p class="note">Level ${stats.level} · ${stats.xp} XP. XP is for showing up. A win does not raise the $2 chip.</p><h2>When you're good enough</h2><p class="note">${esc(ready.text)}</p><ul class="ready-list">${days || '<li>No settled day yet.</li>'}</ul><h2>Calibration</h2>${bucketChart(stats.buckets)}<table><caption class="note">Green bars are how often that band was right. Gold ticks are the confidence you claimed. Paper practice, not a promise.</caption><tr><th>Confidence</th><th>n</th><th>Hit</th><th>Claimed</th></tr>${buckets}</table>`;
}
function trainerView(st) {
  const now = Date.now();
  const book = loadTrainer();
  const stats = trainerStats(book);
  const age = st.kalshiBoard ? quoteAge(st.kalshiBoard.fetchedAt, now) : { stale: true };
  const tips = `<details class="fold tips"><summary>Quick tips</summary><div class="fold-body">${trainerTips().map((t) => `<h2>${esc(t.title)}</h2><p class="note">${esc(t.body)}</p>`).join('')}</div></details>`;
  const seg = ['call', 'lesson', 'progress'].map((k) => `<button type="button" data-train="${k}" class="${ui.train === k ? 'on' : ''}" aria-current="${ui.train === k ? 'true' : 'false'}">${k[0].toUpperCase()}${k.slice(1)}</button>`).join('');
  const head = `<section class="card arcade" aria-label="15 minute trainer"><div class="row"><h2 style="margin:0">15-Min Trainer</h2><span class="tag explore">PAPER · not advice</span></div>${shotNote()}<p class="note">Your own YES or NO call, before the window locks. Scored after the real taker fee. The chip stays $${TRAINER_STAKE}. This does not place an order and it does not change the bots.</p><div class="seg">${seg}</div>${tips}`;
  if (!st.kalshiBoard) return `${head}<div class="skel" aria-busy="true" aria-label="Loading the 15-minute board"></div><p class="note">Loading the snapshot.</p></section>`;
  const body = ui.train === 'lesson' ? lessonPanel(book) : ui.train === 'progress' ? progressPanel(stats) : callPanel(st, book, age, now);
  return `${head}${body}</section>`;
}
function setPtr(mode) {
  const el = document.getElementById('ptr');
  if (!el) return;
  const text = document.getElementById('ptrText');
  if (mode === 'off') { el.hidden = true; el.classList.remove('busy'); return; }
  el.hidden = false;
  el.classList.toggle('busy', mode === 'busy');
  if (text) text.textContent = mode === 'busy' ? 'Refreshing quotes' : mode === 'ready' ? 'Release to refresh' : 'Pull to refresh';
}
async function downloadCallCard(row) {
  const c = document.createElement('canvas');
  c.width = 1080;
  c.height = 1350;
  const g = c.getContext('2d');
  g.fillStyle = '#07090C';
  g.fillRect(0, 0, 1080, 1350);
  g.fillStyle = '#3DFF9A';
  g.fillRect(0, 0, 1080, 18);
  g.fillStyle = '#FFD56A';
  g.font = '700 40px sans-serif';
  g.fillText('GROK DESK', 72, 150);
  g.font = '700 28px sans-serif';
  g.fillText('PAPER PRACTICE · NOT ADVICE', 72, 200);
  g.fillStyle = '#F4F7FB';
  g.font = '800 48px sans-serif';
  let title = String(row.title || row.ticker || 'Call');
  while (g.measureText(title).width > 936 && title.length > 8) title = title.slice(0, -2);
  g.fillText(title, 72, 310);
  g.font = '800 64px sans-serif';
  g.fillStyle = row.won ? '#3DFF9A' : '#ff6b7d';
  g.fillText(row.won ? 'HIT' : 'MISS', 72, 410);
  g.fillStyle = '#F4F7FB';
  g.font = '600 34px sans-serif';
  const pnl = row.pnl >= 0 ? `+$${Number(row.pnl).toFixed(2)}` : `−$${Math.abs(row.pnl).toFixed(2)}`;
  const lines = [
    `You called ${String(row.side || '').toUpperCase()} at ${row.confidence}%`,
    `After fees ${pnl} · fee $${Number(row.fees || 0).toFixed(2)}`,
    `Your Brier ${row.brier == null ? '—' : Number(row.brier).toFixed(3)}`,
    `Quote Brier ${row.marketBrier == null ? '—' : Number(row.marketBrier).toFixed(3)}`,
    'The next chip is still $2.',
    'No wallet. No order. Not a promise.',
  ];
  lines.forEach((line, i) => g.fillText(line, 72, 510 + i * 70));
  const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
  if (!blob) return toast({ text: 'Could not draw the card.' });
  const file = new File([blob], 'grok-desk-paper-call.png', { type: 'image/png' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Grok Desk paper call', text: 'Paper practice. Not advice.' }); return; }
    catch { /* download instead */ }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast({ text: 'Saved a paper result card on this phone.' });
}
function render() {
  if (!state) return;
  const v = $('#view');
  const tabChanged = ui.paintedTab !== ui.tab;
  if (!ui.folds) ui.folds = new Set();
  v.querySelectorAll('details[data-fold]').forEach((d) => { if (d.open) ui.folds.add(d.dataset.fold); else ui.folds.delete(d.dataset.fold); });
  v.innerHTML = ui.tab === 'more' ? moreView() : ui.tab === 'home' ? home(state) : ui.tab === 'arena' ? arenaView(state) : ui.tab === 'coins' ? coinsView() : ui.tab === 'score' ? `${scoreTop()}${foldWrap('score-detail', 'Full scoreboard', 'fees, gate table, research, phone arena', scoreView(state))}` : ui.tab === 'brain' ? `${botsTop()}${foldWrap('brain-detail', 'Lessons and research', 'what each bot learned, model vs market, upgrades', brainView())}` : ui.tab === 'predict' ? predictView(state) : ui.tab === 'train' ? trainerView(state) : ui.tab === 'agents' ? agents(state) : ui.tab === 'activity' ? activity(state) : settingsView(state);
  if (tabChanged) {
    ui.paintedTab = ui.tab;
    if (ui.didPaint) {
      v.classList.add('enter');
      clearTimeout(ui.enterTimer);
      ui.enterTimer = setTimeout(() => v.classList.remove('enter'), 560);
    }
  }
  ui.didPaint = true;
  v.querySelectorAll('details[data-fold]').forEach((d) => {
    if (ui.folds.has(d.dataset.fold)) d.open = true;
    d.addEventListener('toggle', () => {
      if (d.open) ui.folds.add(d.dataset.fold); else ui.folds.delete(d.dataset.fold);
      if (d.open && ui.tab === 'home') { const c = $('#chart'); if (c && d.contains(c)) drawChart(c, state); const a = $('#allocChart'); if (a && d.contains(a)) drawAlloc(a); }
    });
  });
  const badge = $('#modeBadge');
  if (badge && state.mode !== 'replay') badge.className = 'badge paper' + (state.running ? ' live' : '');
  paintTicker(state);
  if (ui.tab === 'home') { drawChart($('#chart'), state); drawAlloc($('#allocChart')); updateTimer(); }
  const navTab = MORE_TABS.includes(ui.tab) ? 'more' : ui.tab;
  document.querySelectorAll('.tabs button').forEach((b) => {
    const on = b.dataset.tab === navTab;
    b.classList.toggle('on', on);
    b.setAttribute('aria-current', on ? 'page' : 'false');
  });
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
  const w = $('#wipe'); if (w) w.onclick = async () => { if (!confirm('Erase all local paper data, including 15-minute practice calls?')) return; live = newState(loadSettings(), Date.now()); state = live; trainerBook = emptyTrainer(); localStorage.removeItem('gd.trainer'); await persist(); render(); };
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
  document.querySelectorAll('[data-tabjump]').forEach((b) => (b.onclick = () => { haptic(); ui.tab = b.dataset.tabjump; render(); window.scrollTo(0, 0); if (ui.tab === 'predict' || ui.tab === 'train') refreshKalshi(); }));
  document.querySelectorAll('[data-arena]').forEach((b) => (b.onclick = () => { ui.arena = b.dataset.arena; render(); }));
  const sound = $('#soundBtn'); if (sound) sound.onclick = () => { ui.sound = !ui.sound; localStorage.setItem('gd.sound', ui.sound ? '1' : '0'); render(); };
  const themeBtn = $('#themeBtn'); if (themeBtn) themeBtn.onclick = () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('gd.theme', next);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = next === 'light' ? '#f4f6f8' : '#07090C';
    render();
  };
  const pro = $('#proSave'); if (pro) pro.onclick = () => {
    const email = ($('#proEmail')?.value || '').trim();
    if (email && !/^[^\s@]+@[^\s@]+$/.test(email)) return toast({ text: 'That does not look like an email. Nothing was saved.' });
    if (email) localStorage.setItem('gd.proEmail', email); else localStorage.removeItem('gd.proEmail');
    toast({ text: email ? 'Saved on this phone only.' : 'Cleared on this phone.' });
  };
  const alertBtn = $('#coinAlert'); if (alertBtn) alertBtn.onclick = async () => {
    ui.coinAlerts = !ui.coinAlerts;
    if (ui.coinAlerts && 'Notification' in window) { const p = await Notification.requestPermission(); ui.coinAlerts = p === 'granted'; }
    localStorage.setItem('gd.coinAlerts', ui.coinAlerts ? '1' : '0');
    render();
  };
  document.querySelectorAll('[data-copy]').forEach((b) => (b.onclick = async (e) => {
    e.stopPropagation();
    const ca = b.dataset.copy;
    let copied = false;
    try { await navigator.clipboard.writeText(ca); copied = true; } catch { copied = false; }
    haptic(12);
    if (!copied) {
      const chip = b.parentElement?.querySelector('[data-expand-ca]');
      if (chip) chip.setAttribute('aria-expanded', 'true');
      toast({ text: 'Copy did not stick. The full address is on the card.' });
      return;
    }
    b.classList.add('is-copied');
    b.textContent = 'Copied';
    toast({ kind: 'copy' });
    setTimeout(() => { if (b.isConnected) { b.textContent = 'Copy'; b.classList.remove('is-copied'); } }, 1200);
  }));
  document.querySelectorAll('[data-expand-ca]').forEach((b) => (b.onclick = (e) => {
    e.stopPropagation();
    const open = b.getAttribute('aria-expanded') === 'true';
    b.setAttribute('aria-expanded', open ? 'false' : 'true');
  }));
  document.querySelectorAll('[data-open-coin]').forEach((b) => (b.onclick = () => { ui.coinOpen = b.dataset.openCoin; render(); }));
  document.querySelectorAll('[data-close-sheet]').forEach((b) => (b.onclick = () => { ui.coinOpen = null; render(); }));
  runCounts();
  document.querySelectorAll('img.logo').forEach((img) => {
    img.onerror = () => {
      const fallback = document.createElement('span');
      fallback.className = 'logo fallback';
      fallback.style.setProperty('--h', img.dataset.h || '200');
      fallback.textContent = img.dataset.initials || '?';
      img.replaceWith(fallback);
    };
  });
  document.querySelectorAll('[data-pick]').forEach((b) => (b.onclick = async () => {
    const market = (live.kalshiBoard?.markets || []).find((m) => m.ticker === b.dataset.ticker);
    if (!market) return;
    const res = placePick(live, market, b.dataset.pick, Date.now());
    haptic();
    if (!res.ok) toast({ text: res.reason });
    else { toast({ text: 'Paper chip recorded. Size stays $2.' }); await persist(); }
    render();
  }));
  const soundSet = $('#soundSet'); if (soundSet) soundSet.onchange = () => { ui.sound = soundSet.checked; localStorage.setItem('gd.sound', ui.sound ? '1' : '0'); };
  const hapticSet = $('#hapticSet'); if (hapticSet) hapticSet.onchange = () => { ui.haptics = hapticSet.checked; localStorage.setItem('gd.haptics', ui.haptics ? '1' : '0'); if (ui.haptics) haptic(12); };
  const motionSet = $('#motionSet'); if (motionSet) motionSet.onchange = () => {
    ui.motion = motionSet.checked;
    localStorage.setItem('gd.motion', ui.motion ? '1' : '0');
    document.documentElement.classList.toggle('motion-off', !ui.motion);
    render();
  };
  const remindSet = $('#remindSet'); if (remindSet) remindSet.onchange = () => { ui.remind = remindSet.checked; localStorage.setItem('gd.remind', ui.remind ? '1' : '0'); };
  const quoteRetry = $('#quoteRetry'); if (quoteRetry) quoteRetry.onclick = () => { haptic(); ui.quoteManual = true; refreshKalshi(); };
  const coinRetry = $('#coinRetry'); if (coinRetry) coinRetry.onclick = () => { haptic(); ui.coinsState = null; loadCoins(); };
  const brainRetry = $('#brainRetry'); if (brainRetry) brainRetry.onclick = () => { haptic(); ui.brainState = null; loadBrain(); };
  const remindOpen = $('#remindOpen'); if (remindOpen) remindOpen.onclick = () => { ui.tab = 'train'; haptic(); render(); };
  const remindSnooze = $('#remindSnooze'); if (remindSnooze) remindSnooze.onclick = () => { localStorage.setItem('gd.remindSnooze', new Date().toISOString().slice(0, 10)); render(); };
  document.querySelectorAll('[data-train]').forEach((b) => (b.onclick = () => { ui.train = b.dataset.train; haptic(); render(); }));
  document.querySelectorAll('[data-coinfilter]').forEach((b) => (b.onclick = () => { ui.coinFilter = b.dataset.coinfilter; render(); }));
  document.querySelectorAll('[data-watch]').forEach((b) => (b.onclick = (e) => {
    e.stopPropagation();
    const set = watchSet();
    if (set.has(b.dataset.watch)) set.delete(b.dataset.watch); else set.add(b.dataset.watch);
    saveWatch(set);
    haptic();
    render();
  }));
  const trainMarket = $('#trainMarket'); if (trainMarket) trainMarket.onchange = () => { ui.trainTicker = trainMarket.value; render(); };
  const lessonPick = $('#lessonPick'); if (lessonPick) lessonPick.onchange = () => { ui.lessonId = lessonPick.value; render(); };
  document.querySelectorAll('[data-side]').forEach((b) => (b.onclick = () => {
    ui.trainSide = b.dataset.side;
    const input = b.closest('form')?.confidence;
    if (input) ui.trainConf = input.value;
    haptic();
    render();
  }));
  document.querySelectorAll('[data-train-form]').forEach((form) => (form.onsubmit = (e) => {
    e.preventDefault();
    const confidence = Number(form.confidence.value);
    ui.trainConf = String(form.confidence.value);
    if (ui.trainSide !== 'yes' && ui.trainSide !== 'no') return toast({ text: 'Pick YES or NO first. Nothing was recorded.' });
    const market = (live.kalshiBoard?.markets || []).find((m) => m.ticker === form.dataset.trainForm);
    if (!market) return toast({ text: 'That window is not in the snapshot.' });
    const book = loadTrainer();
    const res = placeTrainerCall(book, market, ui.trainSide, confidence, Date.now(), {
      fetchedAt: live.kalshiBoard?.fetchedAt,
      spots: live.spots || {},
      prev: live.arenaQuotes || {},
    });
    if (!res.ok) return toast({ text: res.reason });
    saveTrainer();
    haptic([10, 20, 10]);
    toast({ text: 'Paper call recorded. The chip stays $2.' });
    if (res.levelUp) burst('level');
    render();
  }));
  document.querySelectorAll('[data-share]').forEach((b) => (b.onclick = () => {
    const row = (loadTrainer().closed || []).find((c) => c.id === b.dataset.share);
    if (row) downloadCallCard(row);
  }));
  runCounts();
  fillXp();
  paintRings();
  moveTabIndicator();
}
function maybeHealQuote() {
  if (!live || ui.replay || ui.kalshiBusy || ui.shotLock) return;
  const age = live.kalshiBoard ? quoteAge(live.kalshiBoard.fetchedAt, Date.now()) : { stale: true };
  const wait = (!live.kalshiBoard || age.stale || live.quoteError) ? 8000 : 20000;
  if (Date.now() - (ui.kalshiAt || 0) >= wait) refreshKalshi();
}
async function refreshKalshi() {
  if (!live || ui.replay || ui.kalshiBusy || ui.shotLock) return;
  ui.kalshiBusy = true;
  ui.kalshiAt = Date.now();
  const now = Date.now();
  let kind = null;
  try {
    const board = await loadKalshiBoard(fetch);
    live.kalshiBoard = board;
    live.quoteError = '';
    reviewKalshi(live, board, now);
    const show = () => { if (state === live && ['predict', 'arena', 'score', 'home', 'train'].includes(ui.tab)) render(); };
    show();
    const [spots, book] = await Promise.all([loadSpots(fetch), loadBook(fetch)]);
    live.spots = spots;
    const lvl0 = levelOf(live.game?.xp || 0);
    reviewArena(live, board, now, spots, book);
    const lvl1 = levelOf(live.game?.xp || 0);
    const practice = loadTrainer();
    const outcome = settleTrainer(practice, board, now, spots);
    saveTrainer();
    const arenaSettled = (live.arenaClosed || []).concat(live.picksClosed || []).filter((t) => t.closedAt === now);
    if (lvl1 > lvl0 || outcome.levelUp) kind = 'level';
    else if (arenaSettled.some((t) => t.won) || outcome.settled.some((t) => t.won)) kind = 'win';
    else if (arenaSettled.length || outcome.settled.length) kind = 'loss';
    if (outcome.settled.length === 1) {
      const row = outcome.settled[0];
      toast({ text: row.won ? `Paper hit on ${row.title}. The next call is still $2.` : `Paper miss on ${row.title}. The next call is still $2.`, pnl: row.won ? 1 : -1 });
    } else if (outcome.settled.length) toast({ text: `Settled ${outcome.settled.length} paper calls. The chip stays $2.` });
    if (outcome.levelUp) toast({ text: `Level ${outcome.level}. XP marks practice, not profit. Size stays $2.` });
    if (location.hash === '#shot' && !live._shot && (live.arenaOpen || []).some((p) => p.contracts >= 1)) {
      const bet = live.arenaOpen.find((p) => p.contracts >= 1);
      live._shot = true;
      reviewArena(live, { markets: [{ ticker: bet.ticker, title: bet.title, series: bet.series, result: bet.side, yesAsk: bet.ask, noAsk: 1 - bet.ask, closeTime: new Date(Date.now() + 60000).toISOString() }] }, Date.now(), spots, book);
      kind = 'win';
    }
  } catch (e) {
    if (live) {
      live.quoteError = 'The last refresh did not load. The previous snapshot stays on screen.';
      live.arenaError = live.quoteError;
    }
  } finally {
    ui.kalshiBusy = false;
    ui.quoteManual = false;
    if (kind) burst(kind);
    if (state === live) {
      await persist();
      if (['predict', 'arena', 'score', 'home', 'train'].includes(ui.tab)) render();
    }
  }
}
document.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => {
  haptic();
  ui.tab = b.dataset.tab;
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
  render();
  window.scrollTo(0, 0);
  if (b.dataset.tab === 'predict' || b.dataset.tab === 'train') refreshKalshi();
}));
window.addEventListener('resize', () => ui.tab === 'home' && state && drawChart($('#chart'), state));
document.addEventListener('visibilitychange', () => { if (!document.hidden) liveTick(); });

let splashSettled = false;
function splashMotionOk() {
  if (!motionOn()) return false;
  if (navigator.connection && navigator.connection.saveData) return false;
  return true;
}
function mountSplash() {
  const arm = () => {
    if (splashSettled || document.getElementById('splash')) return;
    const el = document.createElement('div');
    el.id = 'splash';
    el.setAttribute('aria-hidden', 'true');
    const title = '<p class="splash-title">Grok Desk<span>Paper</span></p>';
    if (splashMotionOk()) {
      el.innerHTML = `<video class="splash-media" width="720" height="1280" poster="splash/splash.webp" muted autoplay loop playsinline preload="metadata" fetchpriority="low"><source src="splash/splash.webm" type="video/webm"><source src="splash/splash.mp4" type="video/mp4"></video>${title}`;
      const video = el.querySelector('video');
      video.muted = true;
      video.defaultMuted = true;
      video.playsInline = true;
      video.setAttribute('webkit-playsinline', '');
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
      reduced.addEventListener?.('change', () => { if (reduced.matches) { video.removeAttribute('autoplay'); video.pause(); } });
      video.play?.().catch(() => {});
    } else {
      el.innerHTML = `<img class="splash-media" alt="" width="1080" height="1920" decoding="async" fetchpriority="low" src="splash/splash.webp">${title}`;
    }
    document.body.appendChild(el);
  };
  requestAnimationFrame(() => requestAnimationFrame(arm));
}
function dismissSplash() {
  splashSettled = true;
  const el = document.getElementById('splash');
  if (!el) return;
  el.classList.add('out');
  const drop = () => { if (el.isConnected) el.remove(); };
  el.addEventListener('transitionend', drop, { once: true });
  setTimeout(drop, 1200);
}
(async () => {
  if (new URLSearchParams(location.search).get('shot')) document.getElementById('intro')?.remove();
  if (localStorage.getItem('gd.intro') === '1') mountSplash();
  const saved = await idb.get('state');
  live = migrate(saved ? JSON.parse(saved) : newState(loadSettings(), Date.now()));
  if (live.settings && live.settings.activeMode == null) live.settings = { ...live.settings, activeMode: true, activeTickSec: ACTIVE.tickSec };
  if (!live.slots) live.slots = emptySlots();
  if (!Array.isArray(live.decisions)) live.decisions = [];
  state = live; render();
  loadDeskRepair();
  dismissSplash();
  const q = new URLSearchParams(location.search);
  if (q.get('shot')) ui.shotLock = true;
  if (!ui.shotLock) refreshKalshi();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
  if (q.get('replay') === '1') startReplay();
  if (q.get('tab')) { const btn = document.querySelector(`.tabs [data-tab="${q.get('tab')}"]`); if (btn) btn.click(); else { ui.tab = q.get('tab'); render(); } }
  if (q.get('shot')) applyShot(q.get('shot'));
  else showIntro();
})();
function setInert(on) {
  for (const sel of ['header.top', 'main', 'nav.tabs', '#ticker', '#linkState', '#ptr']) {
    const node = document.querySelector(sel);
    if (node) node.inert = on;
  }
}
function showIntro() {
  const el = document.getElementById('intro');
  if (!el || localStorage.getItem('gd.intro') === '1' || ui.shotLock) { el?.remove(); return; }
  const track = el.querySelector('#introTrack');
  const pages = track ? track.children.length : 3;
  const finish = () => { localStorage.setItem('gd.intro', '1'); document.documentElement.classList.add('intro-done'); setInert(false); el.remove(); };
  const sync = () => {
    const page = Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
    el.querySelectorAll('[data-intro]').forEach((dot, i) => dot.setAttribute('aria-current', i === page ? 'true' : 'false'));
    const next = el.querySelector('#introNext');
    if (next) next.textContent = page >= pages - 1 ? 'Start paper desk' : 'Next';
  };
  const go = (page) => track.scrollTo({ left: page * track.clientWidth, behavior: motionOn() ? 'smooth' : 'auto' });
  track?.addEventListener('scroll', sync, { passive: true });
  const next = el.querySelector('#introNext');
  if (next) next.onclick = () => {
    const page = Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
    if (page >= pages - 1) finish();
    else go(page + 1);
  };
  const skip = el.querySelector('#introSkip');
  if (skip) skip.onclick = finish;
  el.querySelectorAll('[data-intro]').forEach((dot) => (dot.onclick = () => go(Number(dot.dataset.intro))));
  const copy = el.querySelector('#introCopy');
  if (copy) copy.onclick = async () => {
    const text = 'Copy the contract address from the Coins tab, then paste it into pump.fun or fomo yourself. Grok Desk cannot place that order.';
    try { await navigator.clipboard.writeText(text); } catch { /* the card still says the step */ }
    haptic(12);
    toast({ kind: 'copy', text: 'Copied the reminder. Not a contract address.' });
  };
  el.addEventListener('keydown', (e) => {
    const page = Math.round((track?.scrollLeft || 0) / Math.max(1, track?.clientWidth || 1));
    if (e.key === 'Escape') finish();
    if (e.key === 'ArrowRight') go(page + 1);
    if (e.key === 'ArrowLeft') go(Math.max(0, page - 1));
  });
  setInert(true);
  sync();
  next?.focus();
}
function demoMarket(now, extra = {}) {
  return {
    ticker: 'KXBTC15M-DEMO',
    series: 'KXBTC15M',
    title: 'BTC price up in next 15 mins?',
    floorStrike: 61500,
    yesBid: 0.46,
    yesAsk: 0.52,
    noBid: 0.48,
    noAsk: 0.54,
    closeTime: new Date(now + 8 * 60 * 1000).toISOString(),
    volume: 1200,
    result: '',
    status: 'active',
    ...extra,
  };
}
function applyShot(kind) {
  ui.shotLock = true;
  const now = Date.now();
  live.spots = { BTC: { px: 61640.25, source: 'Coinbase estimate' } };
  live.kalshiBoard = { fetchedAt: new Date(now).toISOString(), via: 'snapshot', markets: [demoMarket(now)] };
  if (kind === 'lesson' || kind === 'progress') {
    const book = emptyTrainer();
    const calledAt = now - 6 * 60 * 1000;
    const past = demoMarket(calledAt, { ticker: 'KXBTC15M-PAST', closeTime: new Date(calledAt + 4 * 60 * 1000).toISOString(), floorStrike: 61500 });
    placeTrainerCall(book, past, 'yes', 64, calledAt, {
      fetchedAt: new Date(calledAt).toISOString(),
      spots: { BTC: { px: 61420, source: 'Coinbase estimate' } },
    });
    settleTrainer(book, { markets: [{ ...past, result: 'yes' }] }, now - 60 * 1000, { BTC: { px: 61640.25, source: 'Coinbase estimate' } });
    if (kind === 'progress') {
      for (let i = 0; i < 6; i++) {
        const day = i < 3 ? '2026-11-18' : '2026-11-19';
        const at = Date.parse(`${day}T12:00:00Z`) + i * 1000;
        const side = i % 2 ? 'yes' : 'no';
        const row = demoMarket(at, { ticker: `KXBTC15M-S${i}`, closeTime: new Date(at + 8 * 60 * 1000).toISOString(), floorStrike: 60000 + i });
        placeTrainerCall(book, row, side, 55 + i * 5, at, { fetchedAt: new Date(at).toISOString(), spots: { BTC: { px: 60010 + i, source: 'Coinbase estimate' } } });
        const won = i % 3 !== 0;
        settleTrainer(book, { markets: [{ ...row, result: won ? side : (side === 'yes' ? 'no' : 'yes') }] }, at + 9 * 60 * 1000, { BTC: { px: 60020 + i, source: 'Coinbase estimate' } });
      }
    }
    trainerBook = book;
    ui.tab = 'train';
    ui.train = kind === 'progress' ? 'progress' : 'lesson';
    ui.lessonId = book.closed[0]?.id;
  } else if (kind === 'call') {
    ui.tab = 'train';
    ui.train = 'call';
    ui.trainSide = '';
  } else if (kind === 'win') {
    ui.tab = 'home';
    live.arenaLog = [{ t: now, action: 'settle', rule: 'pick', title: 'BTC 15-minute', won: true, reason: 'PAPER win · result yes · fee $0.06' }];
  } else ui.tab = 'home';
  render();
  if (kind === 'win') {
    toast({ text: 'Paper win. The next chip is still $2.', pnl: 1 });
    burst('win');
  }
}
let pullY = null;
document.addEventListener('touchstart', (e) => {
  if (window.scrollY > 2) { pullY = null; return; }
  pullY = e.touches[0].clientY;
}, { passive: true });
document.addEventListener('touchmove', (e) => {
  if (pullY == null) return;
  const dy = e.touches[0].clientY - pullY;
  if (dy < 8 || window.scrollY > 8) { setPtr('off'); return; }
  setPtr(dy > 64 ? 'ready' : 'pull');
}, { passive: true });
document.addEventListener('touchend', (e) => {
  if (pullY == null) return;
  const dy = e.changedTouches[0].clientY - pullY;
  pullY = null;
  if (dy < 70 || window.scrollY > 8) { setPtr('off'); return; }
  setPtr('busy');
  haptic(10);
  const done = () => setTimeout(() => setPtr('off'), 600);
  if (ui.tab === 'coins') { ui.coinsState = null; loadCoins().finally(done); }
  else {
    if (ui.morningState) { ui.morningState = null; loadMorning(); }
    if (ui.focusState) { ui.focusState = null; loadFocus(); }
    ui.quoteManual = true;
    refreshKalshi().finally(done);
  }
}, { passive: true });
const tickerPause = document.getElementById('tickerPause');
if (tickerPause) tickerPause.addEventListener('click', () => {
  const track = document.getElementById('tickerTrack');
  const paused = track?.style.animationPlayState === 'paused';
  if (track) track.style.animationPlayState = paused ? 'running' : 'paused';
  tickerPause.textContent = paused ? 'Pause' : 'Play';
});
window.addEventListener('offline', () => { const n = $('#linkState'); if (!n) return; n.hidden = false; n.textContent = 'Offline. The saved app shell is still here. Live prices are not.'; });
window.addEventListener('online', () => { const n = $('#linkState'); if (n) n.hidden = true; });
if (localStorage.getItem('gd.theme') === 'light') document.documentElement.dataset.theme = 'light';
