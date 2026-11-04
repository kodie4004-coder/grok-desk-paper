// Grok Desk UI. PAPER ONLY: the engine below moves numbers, never money.
import { DEFAULT_SETTINGS, calibration, settingsLocked, updateSettings } from './engine/core.js';
import { createLiveSource, createReplaySource } from './engine/data.js';
import { newState, startSession, endSession, tick, recap, equityNow, serialize, fmtP, short } from './engine/engine.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const money = (x, sign) => (x == null ? '–' : (sign && x > 0 ? '+' : x < 0 ? '−' : '') + '$' + Math.abs(x).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
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

const ui = { tab: 'home', tf: 'all', logFilter: 'all', replay: null, busy: false, notify: localStorage.getItem('gd.notify') === '1' };
let live = null;          // live state
let state = null;         // what is on screen (live or replay)
const src = createLiveSource();

async function persist() { if (live) await idb.set('state', serialize(live)); }

// ---------- toasts / notifications ----------
function toast(e) {
  const el = document.createElement('div');
  el.className = 'toast ' + (e.side === 'buy' ? 'buy' : e.pnl > 0 ? 'win' : e.pnl < 0 ? 'loss' : '');
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
setInterval(() => {
  if (live && live.running && !ui.replay && Date.now() - (live.lastTickAt || 0) >= live.settings.tickSec * 1000) liveTick();
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
    ui.replay.timer = setTimeout(step, 350);
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
  c.fillStyle = '#0f1317'; c.fillRect(0, 0, W, H);
  if (pts.length < 2) { c.fillStyle = '#8a96a3'; c.font = '12px sans-serif'; c.fillText('Equity line appears after the first ticks', 12, H / 2); return; }
  const t0 = pts[0].t, t1 = pts.at(-1).t || t0 + 1;
  let lo = Math.min(...pts.map((p) => p.v), st.startBank), hi = Math.max(...pts.map((p) => p.v), st.startBank);
  const pad = Math.max(1, (hi - lo) * 0.15); lo -= pad; hi += pad;
  const X = (t) => 8 + ((t - t0) / Math.max(1, t1 - t0)) * (W - 16), Y = (v) => H - 14 - ((v - lo) / (hi - lo)) * (H - 28);
  c.strokeStyle = '#3b4652'; c.setLineDash([4, 4]); c.beginPath(); c.moveTo(0, Y(st.startBank)); c.lineTo(W, Y(st.startBank)); c.stroke(); c.setLineDash([]);
  const up = pts.at(-1).v >= st.startBank;
  c.strokeStyle = up ? '#2fd27a' : '#ff5468'; c.lineWidth = 2; c.beginPath();
  pts.forEach((p, i) => (i ? c.lineTo(X(p.t), Y(p.v)) : c.moveTo(X(p.t), Y(p.v)))); c.stroke();
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
    lt.innerHTML = ago > (state.settings.tickSec + 30) * 1000 ? `<span class="y">Last market check ${Math.round(ago / 1000)}s ago. Phones pause background tabs; the desk only runs while this page is open.</span>` : `Next market check in ${Math.max(0, Math.round(state.settings.tickSec - ago / 1000))}s`;
  }
}

function home(st) {
  const r = st.startedAt ? recap(st, Date.now()) : null;
  const eq = equityNow(st), net = eq - st.startBank;
  const wins = st.closed.filter((t) => t.pnl > 0).length, losses = st.closed.length - wins;
  const realized = st.closed.reduce((a, t) => a + t.pnl, 0), fees = st.closed.reduce((a, t) => a + t.fees, 0);
  const unreal = st.open.reduce((a, p) => a + (p.qty * (p.lastPrice ?? p.entryMid) * (1 - st.settings.feePct / 200) - p.sizeUsd), 0);
  const isReplay = st.mode === 'replay';
  return `
  ${st.halted ? `<div class="halt"><b>New entries halted.</b> ${esc(st.haltReason)}</div>` : ''}
  <div class="card">
    <div class="row"><h3 style="margin:0">${isReplay ? 'Replay balance' : 'Paper balance'}</h3><span class="note" id="timer"></span></div>
    <div class="big ${net >= 0 ? '' : 'r'}">${money(eq)}</div>
    <div class="row"><span class="${net >= 0 ? 'g' : 'r'}">${money(net, true)} (${((eq / st.startBank - 1) * 100).toFixed(2)}%)</span><span class="note">${(eq / st.startBank).toFixed(3)}× of ${money(st.startBank)}</span></div>
    <div class="grid" style="margin-top:10px">
      <div class="stat"><small>Trades</small><b>${st.closed.length}<span class="m" style="font-size:12px"> +${st.open.length} open</span></b></div>
      <div class="stat"><small>Green / red</small><b><span class="g">${wins}</span> / <span class="r">${losses}</span></b></div>
      <div class="stat"><small>Win rate</small><b>${st.closed.length ? Math.round((100 * wins) / st.closed.length) + '%' : '–'}</b></div>
    </div>
    <div class="note" id="lastTick" style="margin-top:8px"></div>
  </div>
  <div class="card">
    <div class="row" style="margin-bottom:8px"><h3 style="margin:0">Equity</h3>
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
  <div class="card"><h3>Honesty panel</h3>
    <table>
      <tr><td>Realized P&L (after fees)</td><td class="${realized >= 0 ? 'g' : 'r'}">${money(realized, true)}</td></tr>
      <tr><td>Before fees/slippage</td><td>${money(realized + fees, true)}</td></tr>
      <tr><td>Fees + slippage paid (${st.settings.feePct}% round trip)</td><td class="r">${money(-fees)}</td></tr>
      <tr><td>Unrealized (open, marked to live price, exit fee included)</td><td class="${unreal >= 0 ? 'g' : 'r'}">${money(unreal, true)}</td></tr>
      <tr><td>Win rate</td><td>${st.closed.length ? `${wins}/${st.closed.length} (${Math.round((100 * wins) / st.closed.length)}%)` : 'no closed trades'}</td></tr>
      <tr><td>Data errors this session</td><td>${st.errors}</td></tr>
    </table>
    <div class="note" style="margin-top:6px">Paper fills use the live mid price when the engine checks (every ${st.settings.tickSec}s), plus the fee assumption. Real fills on thin meme pools are usually worse.</div>
  </div>
  <div class="card"><h3>Open positions (${st.open.length})</h3>
    ${st.open.length ? st.open.map((p) => { const ch = ((p.lastPrice ?? p.entryMid) / p.entryMid - 1) * 100; return `<div class="pos"><div><b>${esc(p.symbol)}</b> <span class="chip">${p.source}</span><br><span class="note">${money(p.sizeUsd)} @ ${fmtP(p.entryMid)} · stop ${fmtP(p.stop)} · tp ${fmtP(p.tp)}</span></div><div style="text-align:right"><b class="${ch >= 0 ? 'g' : 'r'}">${ch >= 0 ? '+' : ''}${ch.toFixed(2)}%</b><br><span class="note">${fmtP(p.lastPrice)}</span></div></div>`; }).join('') : '<div class="note">None.</div>'}
  </div>
  <div class="card"><h3>Closed trades (${st.closed.length})</h3>
    ${st.closed.slice().reverse().slice(0, 25).map((t) => `<div class="pos"><div><b>${esc(t.symbol)}</b> <span class="chip">${t.source}</span><br><span class="note">${esc(t.exitReason)} · ${tm(t.closedAt)}</span></div><div style="text-align:right"><b class="${t.pnl >= 0 ? 'g' : 'r'}">${money(t.pnl, true)}</b><br><span class="note">${t.retPct}%</span></div></div>`).join('') || '<div class="note">None yet.</div>'}
  </div>`;
}

function recapCard(r, isReplay) {
  return `<div class="card recap"><h3>${isReplay ? 'Replay recap' : 'Session recap'} · ${esc(r.sessionId)}</h3>
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
    ['🛰', 'Scout', 'new + trending Solana pools, pool trades (GeckoTerminal)', c.signals, 'signals'],
    ['🧹', 'Filter', `liq ≥ $${s.minLiquidity / 1000}k, alive in 5m, 1h vol ≥ $${s.minVolH1 / 1000}k`, c.filtered, 'passed'],
    ['👥', 'Copy', `${st.followed.length} wallets followed · ${c.copySignals} signals`, c.copied, 'copied'],
    ['⚖️', 'Own · JUDGE', `${c.judged} leads judged · ${c.judgeBuy} passed the gate`, c.own, 'own buys'],
    ['🛡', 'Risk', `stop -${s.stopPct}% set before buy · max ${s.maxPositionPct}%/position · loss cap ${s.lossCapPct}%`, c.riskBlocked, 'blocked'],
    ['🏦', 'Banker', 'marks positions to live price, closes, records', c.closed, 'closed'],
  ];
  const mx = Math.max(1, ...stages.map((x) => x[3]));
  const cal = calibration(st.verdicts, [...st.closed, ...st.open], st.passChecks);
  const ver = st.verdicts.slice().reverse().slice(0, 30);
  return `
  <div class="card funnel"><h3>Pipeline</h3>
    <div class="note" style="margin-bottom:6px">${c.signals.toLocaleString()} signals → ${c.filtered} filtered → ${c.copied} copied → ${c.own} own</div>
    ${stages.map(([ic, nm, sub, n, unit]) => `<div class="st"><div class="ic">${ic}</div><div class="nm"><b>${nm}</b><small>${esc(sub)}</small><div class="bar"><i style="width:${Math.max(2, (100 * Math.log10(1 + n)) / Math.log10(1 + mx))}%"></i></div></div><div class="ct">${n.toLocaleString()}<div class="note" style="font-weight:400;text-align:right">${unit}</div></div></div>`).join('')}
  </div>
  ${st.firedCards.slice().reverse().map((f) => `<div class="fired"><b>UNFOLLOWED</b> <span class="note">${tm(f.t)}</span><div style="font-family:var(--mono);margin-top:4px">${short(f.wallet)} · ${esc(f.reason)} · last loss ${esc(f.last)}</div></div>`).join('')}
  <div class="card"><h3>JUDGE · last ${ver.length} verdicts</h3>
    <div class="note">Gate: buy only if action=buy p≥${s.judgeBuyP}, organic=yes p≥${s.judgeOrganicP}, late=no, exit_risk≤${s.judgeMaxExitRisk}. Watch → re-ask once in ${s.watchRecheckMin}m. Missing data = pass. Confidence never changes size.</div>
    ${ver.map((v) => `<div class="verdict"><div class="row"><b>${esc(v.symbol)} <span class="note">${esc(v.leadId)}</span></b><span class="chip ${v.decision}">${v.decision.toUpperCase()}</span></div>
      <span class="chip">organic ${esc(v.organic ?? 'missing')}</span><span class="chip">late ${esc(v.late ?? 'missing')}</span><span class="chip">exit_risk ${esc(v.exitRisk ?? 'missing')}</span><span class="chip">action ${esc(v.action)}</span>
      ${v.killedBy ? `<div class="note" style="margin-top:3px">killed by: ${esc(v.killedBy)}</div>` : ''}
      <div class="note">top10 ${esc(fmtN(v.dossier.top10))}% · dev ${esc(fmtN(v.dossier.dev))}% · liq $${Math.round(v.dossier.liq || 0).toLocaleString()} · 5m b/s ${v.dossier.b5}/${v.dossier.s5} prev ${v.dossier.b5p}/${v.dossier.s5p} · holders ${v.dossier.holders} (1h ago ${v.dossier.holders1h}) · uniq buyers ${v.dossier.buyersRatio} · LP ${v.dossier.lp}</div></div>`).join('') || '<div class="note">No verdicts yet.</div>'}
  </div>
  <div class="card"><h3>Calibration (Sunday check)</h3>
    <table><tr><th>JUDGE buy p</th><th>Buys</th><th>Closed</th><th>Green</th></tr>
    ${cal.buckets.map((b) => `<tr><td>${b.label}</td><td>${b.buys}</td><td>${b.closed}</td><td>${b.closed ? `${b.green} (${Math.round((100 * b.green) / b.closed)}%)` : '–'}</td></tr>`).join('')}</table>
    <div class="note" style="margin-top:6px">Passes: ${cal.passes.total} logged · ${cal.passes.checked} checked after 24h · ${cal.passes.wouldBeGreen} would have been green after fees. ${cal.passes.total > cal.passes.checked ? 'Unchecked passes get checked once they are 24h old and the desk is running.' : ''}</div>
  </div>
  <div class="card"><h3>Wallet board (observed)</h3>
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
  return `<div class="seg" style="margin-bottom:10px">${['all', 'trades', 'judge', 'risk'].map((k) => `<button data-lf="${k}" class="${f === k ? 'on' : ''}">${k.toUpperCase()}</button>`).join('')}</div>
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
  ['Market check every (s, ≥30)', 'tickSec'],
];
function settingsView(st) {
  const locked = settingsLocked(live) || st.mode === 'replay';
  const s = live.settings;
  return `${locked ? `<div class="lock">🔒 Locked while a session runs${st.mode === 'replay' ? ' or a replay plays' : ''}. End it on Home to change rules.</div>` : ''}
  <div class="card"><h3>Rules</h3>
  <form id="sform">${FIELDS.map(([lab, k, type]) => `<label class="f">${lab}${type === 'bool' ? `<input type="checkbox" name="${k}" ${s[k] ? 'checked' : ''} ${locked ? 'disabled' : ''}>` : `<input type="number" step="any" inputmode="decimal" name="${k}" value="${s[k]}" ${locked ? 'disabled' : ''}>`}</label>`).join('')}
  <button class="btn pri wide" style="margin-top:10px" ${locked ? 'disabled' : ''}>Save rules</button>
  <button type="button" class="btn wide" id="defaults" style="margin-top:8px" ${locked ? 'disabled' : ''}>Reset to defaults</button></form>
  <div class="note" style="margin-top:8px">There is no "make it back" setting on purpose. Raising size or loosening rules after a loss is loss-chasing and drains accounts; the loss cap stops new entries instead.</div></div>
  <div class="card"><h3>Notifications</h3><label class="f">Browser notifications when the app is in the background<input type="checkbox" id="notify" ${ui.notify ? 'checked' : ''}></label><div class="note">In-app toasts always show. Nothing is sent outside this device.</div></div>
  <div class="card"><h3>Live execution</h3><label class="f">live_execution<input type="checkbox" disabled></label>
    <div class="note">Disabled and not built. This app has no wallet connection, no private keys and no order code. Going live would need a separate build (wallet signing, a swap router such as Jupiter, priority fees, real slippage handling, kill switch) and Kodie's explicit approval. See <code>LIVE_EXECUTION.md</code>.</div></div>
  <div class="card"><h3>Data</h3><div class="note">Sources (free, no keys): GeckoTerminal (pools, trades, holders), DexScreener (prices), Jupiter lite price API (fallback). State lives only in this browser.</div>
    <button class="btn dng wide" id="wipe" style="margin-top:10px" ${live.running ? 'disabled' : ''}>Erase local data</button></div>
  <div class="note" style="text-align:center;margin-bottom:10px">Grok Desk paper v1 · not financial advice</div>`;
}

function render() {
  if (!state) return;
  const v = $('#view');
  v.innerHTML = ui.tab === 'home' ? home(state) : ui.tab === 'agents' ? agents(state) : ui.tab === 'activity' ? activity(state) : settingsView(state);
  if (ui.tab === 'home') { drawChart($('#chart'), state); updateTimer(); }
  bind();
}

function bind() {
  document.querySelectorAll('[data-tf]').forEach((b) => (b.onclick = () => { ui.tf = b.dataset.tf; render(); }));
  document.querySelectorAll('[data-lf]').forEach((b) => (b.onclick = () => { ui.logFilter = b.dataset.lf; render(); }));
  const sb = $('#startBtn'); if (sb) sb.onclick = async () => { live = newState(live.settings, Date.now()); startSession(live, Date.now()); state = live; await persist(); render(); liveTick(); };
  const eb = $('#endBtn'); if (eb) eb.onclick = async () => { if (!confirm('End this paper session? Open positions close at the last live price.')) return; endSession(live, Date.now()); await persist(); render(); };
  const rb = $('#replayBtn'); if (rb) rb.onclick = startReplay;
  const f = $('#sform'); if (f) f.onsubmit = (e) => {
    e.preventDefault();
    const patch = {};
    for (const [, k, type] of FIELDS) { const el = f.elements[k]; patch[k] = type === 'bool' ? el.checked : Number(el.value); }
    patch.tickSec = Math.max(30, patch.tickSec || 60);
    const r = updateSettings(live, live.settings, patch);
    if (!r.ok) return toast({ text: r.reason });
    live.settings = r.settings; saveSettings(r.settings); persist(); toast({ text: 'Rules saved. They apply to the next session.' }); render();
  };
  const d = $('#defaults'); if (d) d.onclick = () => { const r = updateSettings(live, live.settings, { ...DEFAULT_SETTINGS }); if (r.ok) { live.settings = r.settings; saveSettings(r.settings); persist(); render(); } };
  const n = $('#notify'); if (n) n.onchange = async () => { ui.notify = n.checked; if (n.checked && 'Notification' in window) { const p = await Notification.requestPermission(); ui.notify = p === 'granted'; } localStorage.setItem('gd.notify', ui.notify ? '1' : '0'); render(); };
  const w = $('#wipe'); if (w) w.onclick = async () => { if (!confirm('Erase all local paper data?')) return; live = newState(loadSettings(), Date.now()); state = live; await persist(); render(); };
}
document.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => { ui.tab = b.dataset.tab; document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x === b)); render(); window.scrollTo(0, 0); }));
window.addEventListener('resize', () => ui.tab === 'home' && state && drawChart($('#chart'), state));
document.addEventListener('visibilitychange', () => { if (!document.hidden) liveTick(); });

(async () => {
  const saved = await idb.get('state');
  live = saved ? JSON.parse(saved) : newState(loadSettings(), Date.now());
  state = live; render();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  const q = new URLSearchParams(location.search);
  if (q.get('replay') === '1') startReplay();
  if (q.get('tab')) document.querySelector(`[data-tab="${q.get('tab')}"]`)?.click();
})();
