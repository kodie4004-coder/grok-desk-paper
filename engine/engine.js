// Paper trading desk orchestrator. Six agents per tick: Scout -> Filter -> Copy -> Own(JUDGE) -> Risk -> Banker.
// PAPER ONLY: positions are numbers in this object. There is no wallet, key or order code anywhere.
import * as C from './core.js';
import { SLOT_IDS, SLOT_SPEC, liveSignals, slotStatus, emptySlots, momentumAllowed } from './strategies.js';
import { SLOT_PRIOR } from './slot-prior.js';
import { PREDICT_RULES } from './predict.js';
import { PREDICT_PRIOR } from './predict-prior.js';
import { isMajor, MAJOR_FEE } from './majors.js';
import { MAJORS_PRIOR } from './majors-prior.js';
import { ACTIVE, ACTIVE_COIN_RULES, ACTIVE_PREDICT_RULES, activeSignals, activePredictPicks, dayKey, flatFee, predictRoundTrip } from './active.js';
import { REPAIR_SIZE_USD, repairGate } from './repair.js';

const r2 = (x) => Math.round(x * 100) / 100;
const MAX_LOG = 600, MAX_WT = 15000, MAX_VERDICTS = 1500, MAX_PASS = 1500;

export function newState(settings, now, mode = 'live') {
  return {
    v: 1, mode, running: false, sessionId: null, startedAt: null, endedAt: null,
    settings: { ...settings }, startBank: settings.bank, cash: settings.bank,
    open: [], closed: [], equity: [], markers: [], log: [], verdicts: [], passChecks: [],
    watch: {}, judged: {}, infoCache: {}, holderSnaps: {}, lastPrices: {},
    counts: { signals: 0, pools: 0, tradesScanned: 0, filtered: 0, judged: 0, judgeBuy: 0, copySignals: 0, copied: 0, own: 0, riskBlocked: 0, edgeFlat: 0, slotTrades: 0, closed: 0 },
    edgeBook: [],
    slots: emptySlots(),
    scan: { at: null, markets: 0, chains: 0, feed: [], note: '' },
    predictions: [],
    walletTrades: [], followed: [], walletBoard: [], strikes: {}, fired: [], firedCards: [],
    halted: false, haltReason: null, repairOpen: [], repairClosed: [], tick: 0, lastTickAt: null, errors: 0, recap: null, createdAt: now,
  };
}

export function startSession(state, now) {
  const s = state.settings;
  Object.assign(state, {
    running: true, sessionId: 'S' + now.toString(36), startedAt: now, endedAt: null, startBank: s.bank, cash: s.bank,
    open: [], closed: [], equity: [{ t: now, v: s.bank }], markers: [], halted: false, haltReason: null, repairOpen: [], repairClosed: [], recap: null, tick: 0,
    counts: Object.fromEntries(Object.keys(state.counts).map((k) => [k, 0])), firedCards: [], strikes: {}, fired: [], watch: {},
  });
  const part = C.participationDecision(C.strategyHealth(state.edgeBook || []), s);
  log(state, now, 'INFO', `session ${state.sessionId} started · bank $${s.bank} · stop -${s.stopPct}% · TP +${s.takeProfitPct}% · loss cap ${s.lossCapPct}% · fees ${s.feePct}% RT · entries ${part.mode}`);
  return state;
}

export function endSession(state, now, prices = state.lastPrices) {
  for (const p of [...state.open]) closePosition(state, p, prices[p.token] ?? p.lastPrice ?? p.entryMid, now, 'SESSION END', 'end');
  state.running = false; state.endedAt = now;
  state.recap = recap(state, now);
  log(state, now, 'INFO', `session ended · ${state.recap.trades} trades · net ${state.recap.net >= 0 ? '+' : ''}$${state.recap.net}`);
  return state.recap;
}

export function recap(state, now) {
  const c = state.closed, wins = c.filter((t) => t.pnl > 0);
  const net = r2(c.reduce((a, t) => a + t.pnl, 0));
  const fees = r2(c.reduce((a, t) => a + t.fees, 0));
  const eq = equityNow(state);
  return {
    sessionId: state.sessionId, durationMin: Math.round(((state.endedAt || now) - state.startedAt) / 60000),
    trades: c.length, wins: wins.length, losses: c.length - wins.length,
    winRate: c.length ? Math.round((100 * wins.length) / c.length) : 0,
    net, gross: r2(net + fees), fees, equity: r2(eq), multiplier: Math.round((eq / state.startBank) * 1000) / 1000,
    best: c.length ? c.reduce((a, t) => (t.pnl > a.pnl ? t : a)) : null,
    worst: c.length ? c.reduce((a, t) => (t.pnl < a.pnl ? t : a)) : null,
    halted: state.halted, haltReason: state.haltReason,
  };
}

export function equityNow(state) {
  return state.cash + state.open.reduce((a, p) => a + p.qty * C.fillPrice(p.lastPrice ?? p.entryMid, 'sell', p.feePct ?? state.settings.feePct), 0);
}

function log(state, t, type, text, extra) {
  state.log.push({ t, type, text, ...extra });
  if (state.log.length > MAX_LOG) state.log.splice(0, state.log.length - MAX_LOG);
}

function closePosition(state, p, price, now, reason, kind, emit) {
  const s = state.settings;
  const r = C.tradePnl({ entryMid: p.entryMid, exitMid: price, sizeUsd: p.sizeUsd, feePct: p.feePct ?? s.feePct });
  state.cash += r.proceeds;
  state.open = state.open.filter((x) => x !== p);
  const t = { ...p, exitMid: price, closedAt: now, pnl: r2(r.pnl), fees: r2(r.fees), retPct: r2((r.pnl / p.sizeUsd) * 100), exitReason: reason, exitKind: kind };
  state.closed.push(t); state.counts.closed++;
  (state.edgeBook ||= []).push({ pnl: t.pnl, fees: t.fees, sizeUsd: t.sizeUsd, retPct: t.retPct, closedAt: now, pool: t.pool, symbol: t.symbol });
  if (state.edgeBook.length > 500) state.edgeBook.splice(0, state.edgeBook.length - 500);
  if (p.slot && state.slots?.[p.slot]) {
    const book = state.slots[p.slot].book;
    book.push({ pnl: t.pnl, fees: t.fees, sizeUsd: t.sizeUsd, retPct: t.retPct, closedAt: now, symbol: t.symbol });
    if (book.length > 400) book.splice(0, book.length - 400);
    const st = slotStatus(book, s);
    if (st.mode === 'off' && !state.slots[p.slot].off) {
      state.slots[p.slot].off = true;
      state.slots[p.slot].offReason = st.reason;
      log(state, now, 'HALT', `${SLOT_SPEC[p.slot]?.label || p.slot} off. ${st.reason}`);
    }
  }
  state.markers.push({ t: now, v: r2(equityNow(state)), kind, label: `${t.symbol} ${t.retPct}%` });
  const line = `SELL ${t.symbol} @ ${fmtP(price)} · ${reason} · ${t.pnl >= 0 ? '+' : ''}$${t.pnl} (${t.retPct}% after fees)`;
  log(state, now, 'SELL', line, { pnl: t.pnl });
  emit && emit({ type: 'trade', side: 'sell', text: line, pnl: t.pnl });
  // firing rule for copied wallets
  if (p.source === 'copy') {
    for (const w of p.wallets) {
      const r = C.applyStrike(state.strikes, w, t.pnl, s);
      state.strikes = r.strikes;
      if (r.fired && !state.fired.includes(w)) {
        state.fired.push(w);
        state.followed = state.followed.filter((x) => x !== w);
        const card = { t: now, wallet: w, reason: `${s.strikesToFire} losses in a row`, last: t.symbol };
        state.firedCards.push(card);
        log(state, now, 'FIRE', `UNFOLLOWED ${short(w)} · ${r.count}/${s.strikesToFire} strikes · last loss ${t.symbol}`);
        emit && emit({ type: 'fire', text: `Unfollowed ${short(w)} after ${s.strikesToFire} losses in a row` });
      } else log(state, now, 'COPY', `strike ${short(w)} ${r.count}/${s.strikesToFire}`);
    }
  }
  const lc = C.lossCapHit(state, s);
  if (lc.hit && !state.halted) {
    state.halted = true;
    state.haltReason = `Loss cap hit: realized $${r2(lc.realized)} <= -${s.lossCapPct}% of bank ($${r2(lc.cap)}). Repair mode: live entries stay halted and shadow trades keep logging. No "make it back" mode.`;
    log(state, now, 'HALT', state.haltReason);
    emit && emit({ type: 'halt', text: state.haltReason });
  }
  return t;
}

export const fmtP = (p) => (p == null ? '?' : p >= 1 ? p.toFixed(4) : p.toPrecision(4));
export const short = (w) => (w ? w.slice(0, 4) + '…' + w.slice(-4) : '?');

function filterPool(p, s) {
  if (!p.token || !p.pool) return 'no token';
  if (!(p.liq >= s.minLiquidity)) return `liquidity $${Math.round(p.liq || 0)} < $${s.minLiquidity}`;
  const m5 = p.tx.m5; if (!m5 || m5.b + m5.s === 0) return 'dead pool (no trades in 5m)';
  if (!(p.vol.h1 >= s.minVolH1)) return `cold: 1h volume $${Math.round(p.vol.h1 || 0)} < $${s.minVolH1}`;
  return null;
}

function buildDossier(leadId, p, info, trades, snaps, now) {
  const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
  const win = (a, b) => {
    const ts = trades.filter((x) => now - x.t >= a * 60000 && now - x.t < b * 60000);
    return { b: ts.filter((x) => x.kind === 'buy').length, s: ts.filter((x) => x.kind === 'sell').length };
  };
  const oldest = trades.length ? Math.min(...trades.map((x) => x.t)) : now;
  const covered = (min) => trades.length > 0 && now - oldest >= min * 60000;
  const w1 = win(0, 5), w2 = win(5, 10);
  const h1 = p.tx.h1;
  const recentPx = trades.filter((x) => x.price > 0 && now - x.t <= 5 * 60000).map((x) => x.price);
  let rangePct = null;
  if (recentPx.length >= 4) {
    const hi = Math.max(...recentPx), lo = Math.min(...recentPx), mid = (hi + lo) / 2;
    if (mid > 0) rangePct = ((hi - lo) / mid) * 100;
  }
  // holders now vs ~1h ago from our own snapshots (GT updates holder counts slowly)
  let growth = null, holders1h = null;
  const old = (snaps || []).filter((x) => now - x.t >= 50 * 60000).pop();
  if (old && isNum(info.holders) && old.count > 0) { holders1h = old.count; growth = ((info.holders - old.count) / old.count) * 100; }
  return {
    leadId, pool: p.pool, token: p.token, symbol: p.symbol, dex: p.dex,
    ageMin: p.createdAt ? Math.round((now - p.createdAt) / 60000) : null,
    price: p.priceUsd, liq: p.liq, volH1: p.vol.h1,
    pcH1: p.pc.h1, pcH6: p.pc.h6, pcH24: p.pc.h24,
    holdersNow: info.holders, holders1h, holdersGrowthPct: growth,
    buyersRatio: h1 && h1.b > 0 && isNum(h1.buyers) ? Math.min(1, h1.buyers / h1.b) : null,
    buys5a: covered(5) || trades.length >= 3 ? w1.b : null, sells5a: covered(5) || trades.length >= 3 ? w1.s : null,
    buys5b: covered(10) ? w2.b : null, sells5b: covered(10) ? w2.s : null,
    top10: info.top10, dev: info.dev, mintAuthority: info.mintAuthority, freezeAuthority: info.freezeAuthority,
    honeypot: info.honeypot,     social: info.social, lp: 'missing', rangePct,
  };
}

function addWalletTrades(state, trades) {
  const seen = state._seen || (state._seen = new Set(state.walletTrades.map((x) => x.id + x.wallet)));
  let n = 0;
  for (const t of trades) {
    const k = t.id + t.wallet; if (seen.has(k)) continue;
    seen.add(k); state.walletTrades.push(t); n++;
  }
  if (state.walletTrades.length > MAX_WT) {
    state.walletTrades.splice(0, state.walletTrades.length - MAX_WT);
    state._seen = new Set(state.walletTrades.map((x) => x.id + x.wallet));
  }
  state.counts.tradesScanned += trades.length; state.counts.signals += n;
  return n;
}

async function getInfo(state, src, token, now) {
  const c = state.infoCache[token];
  if (c && now - c.t < 30 * 60000) return c.info;
  const info = await src.tokenInfo(token);
  state.infoCache[token] = { t: now, info };
  if (info.holders) (state.holderSnaps[token] ||= []).push({ t: now, count: info.holders });
  const keys = Object.keys(state.infoCache);
  if (keys.length > 400) for (const k of keys.slice(0, keys.length - 400)) { delete state.infoCache[k]; delete state.holderSnaps[k]; }
  return info;
}

function repairLive(state) {
  const s = state.settings;
  const lc = C.lossCapHit(state, s);
  const gate = repairGate(state.repairClosed || []);
  const active = !!(lc.hit || state.halted);
  state.repair = { active, ...gate };
  return { active, pass: active && gate.pass, gate };
}

function openRepairShadow(state, now, emit, { pool, token, symbol, source, reason, chain, slot, px, feePct, stopPct, takeProfitPct, maxHoldMin, trailActivatePct, trailPct }) {
  state.repairOpen ||= [];
  state.repairClosed ||= [];
  if (!token || state.repairOpen.some((p) => p.token === token) || state.repairOpen.length >= 5) return null;
  const sizeUsd = REPAIR_SIZE_USD;
  const levels = { stopPct, takeProfitPct };
  const lv = C.stopLevels(px, levels);
  const fill = C.fillPrice(px, 'buy', feePct);
  const pos = {
    id: 'R' + now.toString(36) + (state.repairClosed.length + state.repairOpen.length),
    pool, token, symbol, source, chain, slot, shadow: true, allocated: false,
    entryMid: px, entryFill: fill, qty: sizeUsd / fill, sizeUsd, feePct,
    stop: lv.stop, tp: lv.tp, stopPct, takeProfitPct, maxHoldMin, trailActivatePct, trailPct,
    peak: px, lastPrice: px, openedAt: now, reason,
  };
  state.repairOpen.push(pos);
  const line = `SHADOW ${symbol} $${sizeUsd} @ ${fmtP(px)} · ${source} · repair log, not the live balance`;
  log(state, now, 'SHADOW', line);
  emit && emit({ type: 'shadow', text: line });
  return pos;
}

function closeRepairShadow(state, p, price, now, reason, emit) {
  const r = C.tradePnl({ entryMid: p.entryMid, exitMid: price, sizeUsd: p.sizeUsd, feePct: p.feePct });
  state.repairOpen = (state.repairOpen || []).filter((x) => x !== p);
  const row = { ...p, exitMid: price, closedAt: now, pnl: r2(r.pnl), fees: r2(r.fees), exitReason: reason, allocated: false, shadow: true };
  state.repairClosed.push(row);
  const line = `SHADOW EXIT ${p.symbol} ${reason} · ${row.pnl >= 0 ? '+' : ''}$${row.pnl} · not added to the balance`;
  log(state, now, 'SHADOW', line, { pnl: row.pnl });
  emit && emit({ type: 'shadow', text: line, pnl: row.pnl });
  return row;
}

async function markRepair(state, src, now, emit, safe) {
  const open = state.repairOpen || [];
  if (!open.length) return;
  const prices = (await safe('repair marks', () => fetchOpenPrices(src, open))) || {};
  for (const p of [...open]) {
    const px = prices[p.token];
    if (px) { p.lastPrice = px; p.peak = Math.max(p.peak || p.entryMid, px); }
    const ex = C.exitCheck(p, p.lastPrice, now, state.settings);
    if (!ex?.reason) continue;
    closeRepairShadow(state, p, p.lastPrice, now, ex.reason, emit);
  }
}

async function enter(state, src, now, emit, { pool, token, symbol, source, sizeUsd, reason, wallets = [], leadId = null, liq = null, chain = 'solana', slot = null, stopPct = null, takeProfitPct = null, maxHoldMin = null, trailActivatePct = 0, trailPct = 0, explore = false, graduated = false, feeBase = null }) {
  const s = state.settings;
  let sized = sizeUsd;
  let why = reason;
  let bucket = null;
  if (slot) {
    state.slots ||= emptySlots();
    const slotState = state.slots[slot] || (state.slots[slot] = { book: [], off: false, offReason: null });
    if (slotState.off) return null;
    const st = slotStatus(slotState.book, s);
    if (st.mode === 'off') {
      slotState.off = true; slotState.offReason = st.reason;
      log(state, now, 'HALT', `${SLOT_SPEC[slot]?.label || slot} off. ${st.reason}`);
      return null;
    }
    const studyEdge = SLOT_PRIOR.edges?.[slot] === true || st.mode === 'promoted';
    const pct = studyEdge ? s.ownPositionPct : (s.explorePct ?? 1);
    sized = (pct / 100) * state.startBank;
    bucket = studyEdge ? 'normal' : 'exploration';
    why = `${reason} · ${bucket}`;
  } else if (explore) {
    const pct = graduated ? s.ownPositionPct : (s.explorePct ?? 1);
    sized = (pct / 100) * state.startBank;
    bucket = graduated ? 'normal' : 'exploration';
    why = `${reason} · ${bucket}`;
  } else {
    const part = C.participationDecision(C.strategyHealth(state.edgeBook || []), s);
    if (!(part.scale > 0)) {
      state.counts.edgeFlat = (state.counts.edgeFlat || 0) + 1;
      log(state, now, 'RISK', `flat ${symbol} (${source}): ${part.reason}`);
      return null;
    }
    sized = sizeUsd * part.scale;
    why = part.scale === 1 ? reason : `${reason} · ${part.mode} ×${part.scale}`;
  }
  const levelsPreview = { stopPct: stopPct ?? s.stopPct, takeProfitPct: takeProfitPct ?? s.takeProfitPct };
  const baseFee = feeBase == null ? s.feePct : feeBase;
  if (!C.targetClearsFees({ feePct: baseFee, takeProfitPct: levelsPreview.takeProfitPct })) {
    state.counts.riskBlocked++;
    log(state, now, 'RISK', `blocked ${symbol} (${source}): take-profit does not clear the round-trip fee`);
    return null;
  }
  const mode = repairLive(state);
  const rc = C.riskCheck(state, s, { token, sizeUsd: sized, repairPass: mode.pass, repairSize: REPAIR_SIZE_USD });
  if (!rc.ok && !rc.repair) { state.counts.riskBlocked++; log(state, now, 'RISK', `blocked ${symbol} (${source}): ${rc.reason}`); return null; }
  const quote = chain && chain !== 'solana' ? await src.prices([token], chain) : await src.prices([token]);
  const px = quote?.[token];
  if (!px) { state.counts.riskBlocked++; log(state, now, 'RISK', `blocked ${symbol}: no live price`); return null; }
  if (!rc.ok) {
    state.counts.riskBlocked++;
    log(state, now, 'RISK', `blocked ${symbol} (${source}): ${rc.reason}`);
    const feePct = s.impactModel ? baseFee + C.roundTripImpactPct(REPAIR_SIZE_USD, liq) : baseFee;
    openRepairShadow(state, now, emit, {
      pool, token, symbol, source, reason: why, chain, px, feePct,
      stopPct: levelsPreview.stopPct, takeProfitPct: levelsPreview.takeProfitPct,
      maxHoldMin: maxHoldMin ?? s.maxHoldMin, trailActivatePct, trailPct,
    });
    return null;
  }
  const feePct = s.impactModel ? baseFee + C.roundTripImpactPct(rc.sizeUsd, liq) : baseFee;
  const levels = levelsPreview;
  const lv = C.stopLevels(px, levels);
  const fill = C.fillPrice(px, 'buy', feePct);
  const p = {
    id: 'T' + now.toString(36) + state.counts.copied + state.counts.own, pool, token, symbol, source, wallets, leadId, chain, slot, bucket,
    entryMid: px, entryFill: fill, qty: rc.sizeUsd / fill, sizeUsd: rc.sizeUsd, feePct, stop: lv.stop, tp: lv.tp,
    stopPct: levels.stopPct, takeProfitPct: levels.takeProfitPct, maxHoldMin: maxHoldMin ?? s.maxHoldMin,
    trailActivatePct, trailPct,
    peak: px, lastPrice: px, openedAt: now, reason: why,
  };
  state.cash -= rc.sizeUsd; state.open.push(p);
  if (source === 'copy') state.counts.copied++;
  else if (source === 'own') state.counts.own++;
  else state.counts.slotTrades = (state.counts.slotTrades || 0) + 1;
  state.markers.push({ t: now, v: r2(equityNow(state)), kind: 'buy', label: symbol });
  const line = `BUY ${symbol} $${rc.sizeUsd} @ ${fmtP(px)} · ${source.toUpperCase()} · ${why} · stop ${fmtP(lv.stop)} tp ${fmtP(lv.tp)}`;
  log(state, now, 'BUY', line);
  emit && emit({ type: 'trade', side: 'buy', text: line });
  return p;
}

// One engine tick. src = live, recorder or replay source. Never throws for data errors.
async function managePositions(state, src, now, emit, prices, tradesByPool, safe) {
  const s = state.settings;
  Object.assign(state.lastPrices, prices);
  for (const p of [...state.open]) {
    const px = prices[p.token];
    if (px) { p.lastPrice = px; p.lastMarkedAt = now; }
    if (p.source === 'copy' && p.pool && tradesByPool) {
      if (!tradesByPool[p.pool] && state.tick % 2 === 0) {
        const tr = await safe('exit watch', () => src.poolTrades(p.pool, p.token));
        if (tr) { tradesByPool[p.pool] = tr; addWalletTrades(state, tr); }
      }
      const sold = (tradesByPool[p.pool] || []).find((t) => t.kind === 'sell' && p.wallets.includes(t.wallet) && t.t > p.openedAt);
      if (sold) { closePosition(state, p, p.lastPrice, now, `COPIED WALLET ${short(sold.wallet)} EXITED`, 'copyexit', emit); continue; }
    }
    const ex = C.exitCheck(p, p.lastPrice, now, s);
    if (!ex) continue;
    p.peak = ex.peak;
    if (ex.reason) closePosition(state, p, p.lastPrice, now, ex.reason, ex.kind, emit);
  }
  await markRepair(state, src, now, emit, safe);
}

async function fetchOpenPrices(src, positions) {
  const groups = new Map();
  for (const p of positions) {
    const chain = p.chain || 'solana';
    if (!groups.has(chain)) groups.set(chain, []);
    groups.get(chain).push(p.token);
  }
  const out = {};
  for (const [chain, toks] of groups) {
    const got = chain === 'solana' ? await src.prices([...new Set(toks)]) : await src.prices([...new Set(toks)], chain);
    Object.assign(out, got || {});
  }
  return out;
}

function noteDecision(state, now, row) {
  (state.decisions ||= []).push({ t: now, ...row });
  if (state.decisions.length > 120) state.decisions.splice(0, state.decisions.length - 120);
}

async function runSlotEntries(state, src, passed, now, emit, safe) {
  state.slots ||= emptySlots();
  const used = new Set();
  const ranked = [...passed].sort((a, b) => (b.liq || 0) - (a.liq || 0)).slice(0, 16);
  for (const pool of ranked) {
    if (state.open.some((o) => o.token === pool.token)) continue;
    for (const sig of liveSignals(pool, now)) {
      if (used.has(sig.slot) || state.slots[sig.slot]?.off) {
        noteDecision(state, now, { symbol: pool.symbol, chain: pool.chain, slot: sig.slot, action: 'skip', reason: state.slots[sig.slot]?.off ? 'slot is off' : 'already used this scan' });
        continue;
      }
      if (sig.slot === 'momentum' && !momentumAllowed(pool, SLOT_PRIOR.graduated, now)) {
        noteDecision(state, now, { symbol: pool.symbol, chain: pool.chain, slot: sig.slot, action: 'skip', reason: `graduated filter ${SLOT_PRIOR.graduated}` });
        continue;
      }
      const spec = SLOT_SPEC[sig.slot];
      if (!spec) continue;
      const trail = sig.slot === 'momentum' && SLOT_PRIOR.graduated === 'trail';
      const pos = await safe(`slot ${sig.slot}`, () => enter(state, src, now, emit, {
        pool: pool.pool, token: pool.token, symbol: pool.symbol, source: sig.slot, slot: sig.slot,
        chain: pool.chain || 'solana', liq: pool.liq, sizeUsd: 0,
        stopPct: spec.stopPct, takeProfitPct: trail ? 1000 : spec.takeProfitPct, maxHoldMin: spec.maxHoldMin,
        trailActivatePct: trail ? 6 : 0, trailPct: 4,
        reason: sig.reason,
      }));
      noteDecision(state, now, { symbol: pool.symbol, chain: pool.chain, slot: sig.slot, action: pos ? 'take' : 'skip', reason: pos ? sig.reason : 'risk or no price' });
      if (pos) used.add(sig.slot);
    }
  }
}

async function runMajorEntries(state, src, passed, now, emit, safe) {
  if (!state.settings.majorsPaper) return;
  state.majorSeen ||= {};
  for (const pool of passed) {
    if (!isMajor(pool)) continue;
    const h = pool.pc?.h24;
    const key = pool.pool;
    if (state.majorSeen[key]) continue;
    if (typeof h !== 'number' || !(h >= 1 && h <= 8)) {
      state.majorSeen[key] = true;
      noteDecision(state, now, { symbol: pool.symbol, chain: pool.chain, slot: 'c1', action: 'skip', reason: '24h move is outside +1% to +8%, or missing' });
      continue;
    }
    const recent = [...state.open, ...state.closed].some((p) => p.pool === pool.pool && p.source === 'c1' && now - (p.openedAt || p.closedAt || 0) < 24 * 3600000);
    if (recent) {
      noteDecision(state, now, { symbol: pool.symbol, chain: pool.chain, slot: 'c1', action: 'skip', reason: 'already traded this pool in the last 24 hours' });
      continue;
    }
    state.majorSeen[key] = true;
    const pos = await safe('major c1', () => enter(state, src, now, emit, {
      pool: pool.pool, token: pool.token, symbol: pool.symbol, source: 'c1',
      chain: pool.chain || 'solana', liq: pool.liq, sizeUsd: 0,
      explore: true, graduated: MAJORS_PRIOR.edges?.c1 === true, feeBase: MAJOR_FEE,
      stopPct: 4, takeProfitPct: 1000, maxHoldMin: 24 * 60,
      reason: `deep major, 24h move ${h.toFixed(1)}%`,
    }));
    noteDecision(state, now, { symbol: pool.symbol, chain: pool.chain, slot: 'c1', action: pos ? 'take' : 'skip', reason: pos ? `deep major, 24h move ${h.toFixed(1)}%` : 'risk or no price' });
  }
}

function notePredict(state, now, row) {
  (state.predictLog ||= []).push({ t: now, ...row });
  if (state.predictLog.length > 80) state.predictLog.splice(0, state.predictLog.length - 80);
}

function considerPredictions(state, now) {
  state.predictOpen ||= [];
  state.predictSeen ||= {};
  const bank = state.startBank || state.settings.bank || 500;
  for (const m of state.predictions || []) {
    if (m.venue === 'Kalshi') {
      if (!state.predictSeen.p4) {
        state.predictSeen.p4 = true;
        notePredict(state, now, { action: 'skip', rule: 'p4', title: 'Kalshi', reason: 'Kalshi did not answer, so the cross-venue rule is not traded' });
      }
      continue;
    }
    if (m.venue !== 'Polymarket' || !(m.price > 0 && m.price < 1) || !(m.end > now)) continue;
    for (const rule of PREDICT_RULES) {
      const key = `${rule.id}:${m.id || m.title}`;
      if (state.predictSeen[key]) {
        const open = state.predictOpen.find((p) => p.key === key);
        if (open) open.mark = m.price;
        continue;
      }
      if (!((now >= m.end - rule.lo) && (now <= m.end - rule.hi))) continue;
      state.predictSeen[key] = true;
      const picked = rule.pick(m.price);
      if (!picked) {
        notePredict(state, now, { action: 'skip', rule: rule.id, title: m.title, reason: `YES ${Number(m.price).toFixed(3)} is outside the band` });
        continue;
      }
      const edge = PREDICT_PRIOR.edges?.[rule.id] === true;
      const pct = edge ? (state.settings.ownPositionPct || 5) : (state.settings.explorePct ?? 1);
      state.predictOpen.push({
        key, rule: rule.id, title: m.title, side: picked.side, price: picked.price, yes: m.price,
        sizeUsd: (pct / 100) * bank, openedAt: now, end: m.end, mark: m.price,
        bucket: edge ? 'normal' : 'exploration',
      });
      notePredict(state, now, { action: 'take', rule: rule.id, title: m.title, reason: `buy ${picked.side} at ${picked.price.toFixed(3)} · ${edge ? 'normal' : 'exploration'} size` });
    }
  }
}

function pushActive(state, now, row) {
  (state.activeFeed ||= []).push({ t: now, bucket: 'Active (exploration)', ...row });
  if (state.activeFeed.length > 80) state.activeFeed.splice(0, state.activeFeed.length - 80);
}

function activeEquity(state) {
  const cash = state.activeCash ?? state.startBank ?? state.settings.bank;
  return cash + (state.activeOpen || []).reduce((a, p) => a + activeMarkValue(p), 0);
}

function activeMarkValue(p) {
  if (p.kind === 'predict') {
    const mark = p.mark ?? p.entry;
    const r = predictRoundTrip(p.entry, mark, p.sizeUsd, p.rate ?? 0);
    return p.sizeUsd + r.pnl;
  }
  const px = p.lastPrice ?? p.entryMid;
  return p.qty * C.fillPrice(px, 'sell', p.feePct);
}

async function quoteToken(src, token, chain) {
  if (!token) return null;
  const quote = chain && chain !== 'solana' ? await src.prices([token], chain) : await src.prices([token]);
  return quote?.[token] || null;
}

function closeActive(state, p, now, emit, result, reason) {
  state.activeCash += p.sizeUsd + result.pnl;
  state.activeOpen = state.activeOpen.filter((x) => x !== p);
  const row = {
    ...p, closedAt: now, pnl: r2(result.pnl), fees: r2(result.fees), exitReason: reason, bucket: 'Active (exploration)',
  };
  state.activeClosed.push(row);
  pushActive(state, now, { kind: 'exit', rule: p.rule, symbol: p.symbol, text: `EXIT ${p.symbol} ${reason} · ${result.pnl >= 0 ? '+' : ''}$${r2(result.pnl)} · fee $${r2(result.fees)}`, pnl: r2(result.pnl), fee: r2(result.fees) });
  emit && emit({ type: 'trade', side: 'sell', pnl: result.pnl, text: `Active exit ${p.symbol} ${reason} · fee $${r2(result.fees)}` });
}

async function markActive(state, src, now, emit, safe) {
  const open = state.activeOpen || [];
  const coins = open.filter((p) => p.kind !== 'predict');
  const prices = coins.length ? (await safe('active marks', () => fetchOpenPrices(src, coins))) || {} : {};
  for (const p of [...open]) {
    if (p.kind === 'predict') {
      const live = (state.predictions || []).find((m) => m.id && m.id === p.marketId);
      if (live && live.price > 0 && live.price < 1) p.mark = p.side === 'yes' ? live.price : 1 - live.price;
      if (now - p.openedAt >= ACTIVE.predictHoldMin * 60000 && p.mark > 0) {
        closeActive(state, p, now, emit, predictRoundTrip(p.entry, p.mark, p.sizeUsd, p.rate ?? 0), `TIME ${ACTIVE.predictHoldMin}m`);
      }
      continue;
    }
    const px = prices[p.token];
    if (px) { p.lastPrice = px; p.peak = Math.max(p.peak || p.entryMid, px); }
    const ex = C.exitCheck(p, p.lastPrice, now, { trailingPct: 0, stopPct: p.stopPct, takeProfitPct: p.takeProfitPct, maxHoldMin: p.maxHoldMin });
    if (ex) p.peak = ex.peak;
    if (!ex?.reason) continue;
    const r = C.tradePnl({ entryMid: p.entryMid, exitMid: p.lastPrice, sizeUsd: p.sizeUsd, feePct: p.feePct });
    closeActive(state, p, now, emit, r, ex.reason);
  }
}

async function runActive(state, src, pools, now, emit, safe) {
  if (state.settings.activeMode !== true) return;
  state.activeOpen ||= [];
  state.activeClosed ||= [];
  state.activeLast ||= {};
  if (state.activeCash == null) state.activeCash = state.startBank || state.settings.bank;
  const day = dayKey(now);
  if (state.activeDayKey !== day) {
    state.activeDayKey = day;
    state.activeDayStart = activeEquity(state);
    if (state.activePausedDay && state.activePausedDay !== day) state.activePausedDay = null;
  }
  await markActive(state, src, now, emit, safe);
  if (state.activePausedDay === day) {
    pushActive(state, now, { kind: 'skip', rule: 'pause', symbol: 'ACTIVE', text: 'Paused for the day. Paper drawdown hit $25. Size stays $5.' });
    return;
  }
  for (const rule of ACTIVE_COIN_RULES) {
    if (now - (state.activeLast[rule] || 0) < ACTIVE.ruleGapMs) continue;
    const hit = [];
    for (const pool of pools) {
      if (state.activeOpen.some((p) => p.token === pool.token)) continue;
      const sig = activeSignals(pool).find((s) => s.slot === rule);
      if (sig) hit.push({ pool, sig });
    }
    if (!hit.length) {
      pushActive(state, now, { kind: 'skip', rule, symbol: rule, text: `${rule} skipped · no pool in the loose band` });
      continue;
    }
    if (state.activeOpen.length >= ACTIVE.maxOpen || state.activeCash < ACTIVE.sizeUsd - 1e-6) {
      pushActive(state, now, { kind: 'skip', rule, symbol: hit[0].pool.symbol, text: `${rule} skipped · book full or cash reserved. Size stays $${ACTIVE.sizeUsd}.` });
      continue;
    }
    const { pool, sig } = hit[0];
    const chain = pool.chain || 'solana';
    const px = (await safe(`active ${rule}`, () => quoteToken(src, pool.token, chain))) || pool.priceUsd;
    if (!(px > 0)) {
      pushActive(state, now, { kind: 'skip', rule, symbol: pool.symbol, text: `${pool.symbol} skipped · no price` });
      continue;
    }
    const feePct = ACTIVE.feePct + (state.settings.impactModel ? C.roundTripImpactPct(ACTIVE.sizeUsd, pool.liq) : 0);
    const fill = C.fillPrice(px, 'buy', feePct);
    const fee = flatFee(ACTIVE.sizeUsd, feePct);
    const pos = {
      id: 'A' + now.toString(36) + rule, kind: 'coin', rule, symbol: pool.symbol, token: pool.token, pool: pool.pool, chain,
      entryMid: px, entryFill: fill, qty: ACTIVE.sizeUsd / fill, sizeUsd: ACTIVE.sizeUsd, feePct, fee: r2(fee),
      stop: px * (1 - ACTIVE.stopPct / 100), tp: px * (1 + ACTIVE.takeProfitPct / 100),
      stopPct: ACTIVE.stopPct, takeProfitPct: ACTIVE.takeProfitPct, maxHoldMin: ACTIVE.holdMin, trailActivatePct: 0,
      peak: px, lastPrice: px, openedAt: now, bucket: 'Active (exploration)', reason: sig.reason,
    };
    state.activeCash -= ACTIVE.sizeUsd;
    state.activeOpen.push(pos);
    state.activeLast[rule] = now;
    pushActive(state, now, { kind: 'entry', rule, symbol: pool.symbol, text: `ENTRY ${pool.symbol} $${ACTIVE.sizeUsd} · ${rule} · ${sig.reason} · fee $${r2(fee)}`, fee: r2(fee) });
    emit && emit({ type: 'trade', side: 'buy', text: `Active ${pool.symbol} $${ACTIVE.sizeUsd} · ${rule} · fee $${r2(fee)}` });
  }
  for (const rule of ACTIVE_PREDICT_RULES) {
    if (now - (state.activeLast[rule] || 0) < ACTIVE.ruleGapMs) continue;
    let took = false;
    for (const market of state.predictions || []) {
      if (market.venue !== 'Polymarket') continue;
      const pick = activePredictPicks(market, now).find((p) => p.rule === rule);
      if (!pick) continue;
      if (state.activeOpen.some((p) => p.marketId === market.id && p.rule === rule)) continue;
      if (state.activeOpen.length >= ACTIVE.maxOpen || state.activeCash < ACTIVE.sizeUsd - 1e-6) {
        pushActive(state, now, { kind: 'skip', rule, symbol: 'POLY', text: `${rule} skipped · book full. Size stays $${ACTIVE.sizeUsd}.` });
        took = true;
        break;
      }
      const rate = typeof market.feeRate === 'number' ? market.feeRate : 0.07;
      const fee = predictRoundTrip(pick.price, pick.price, ACTIVE.sizeUsd, rate).fees;
      state.activeCash -= ACTIVE.sizeUsd;
      state.activeOpen.push({
        id: 'A' + now.toString(36) + rule, kind: 'predict', rule, symbol: pick.side.toUpperCase(), title: market.title,
        marketId: market.id, side: pick.side, entry: pick.price, mark: pick.price, rate, sizeUsd: ACTIVE.sizeUsd,
        fee: r2(fee), openedAt: now, bucket: 'Active (exploration)', reason: pick.reason,
      });
      state.activeLast[rule] = now;
      pushActive(state, now, { kind: 'entry', rule, symbol: market.title || rule, text: `ENTRY ${rule} ${pick.side} ${pick.price.toFixed(3)} · $${ACTIVE.sizeUsd} · ${pick.reason} · fee $${r2(fee)}`, fee: r2(fee) });
      emit && emit({ type: 'trade', side: 'buy', text: `Active ${rule} $${ACTIVE.sizeUsd} · fee $${r2(fee)}` });
      took = true;
      break;
    }
    if (!took) pushActive(state, now, { kind: 'skip', rule, symbol: rule, text: `${rule} skipped · no Polymarket quote in the loose band` });
  }
  const eq = activeEquity(state);
  if (state.activeDayStart - eq >= ACTIVE.dayLossUsd) {
    state.activePausedDay = day;
    pushActive(state, now, { kind: 'skip', rule: 'pause', symbol: 'ACTIVE', text: `Paused for the day. Down $${r2(state.activeDayStart - eq)} from the day's start. Size stays $${ACTIVE.sizeUsd}.` });
  }
}

// Price open positions between scout ticks. DexScreener, not the GeckoTerminal budget.
export async function mark(state, src, now, emit = () => {}) {
  const activeOpen = state.settings.activeMode === true && (state.activeOpen || []).length;
  const repairOpen = (state.repairOpen || []).length;
  if (!state.running || !(state.settings.markSec > 0) || (!state.open.length && !activeOpen && !repairOpen)) return state;
  state.lastMarkAt = now;
  const safe = async (label, fn) => { try { return await fn(); } catch (e) { state.errors++; log(state, now, 'ERR', `${label}: ${e.message}`); return null; } };
  const prices = state.open.length ? (await safe('mark', () => fetchOpenPrices(src, state.open))) || {} : {};
  await managePositions(state, src, now, emit, prices, null, safe);
  if (activeOpen) await markActive(state, src, now, emit, safe);
  state.equity.push({ t: now, v: r2(equityNow(state)) });
  if (state.equity.length > 3000) state.equity.splice(1, 1);
  return state;
}

export async function tick(state, src, now, emit = () => {}) {
  const s = state.settings;
  if (!state.running) return state;
  state.tick++; state.lastTickAt = now;
  src.beginTick && src.beginTick(now);
  const safe = async (label, fn) => { try { return await fn(); } catch (e) { state.errors++; log(state, now, 'ERR', `${label}: ${e.message}`); return null; } };

  // 1) SCOUT
  const pools = [];
  if (s.fastScan && typeof src.discover === 'function') {
    const d = await safe('discover', () => src.discover(state.tick, s.activeMode === true ? { wide: true } : undefined));
    if (d) {
      for (const p of d.pools || []) if (p.pool && !pools.some((x) => x.pool === p.pool)) pools.push(p);
      state.predictions = d.predictions || [];
      state.scan = {
        at: now, markets: pools.length, chains: new Set(pools.map((p) => p.chain || 'solana')).size,
        feed: d.feed || [], note: d.note || '',
      };
    }
  } else {
    const np = await safe('scout new pools', () => src.newPools(1 + (state.tick % 2)));
    const tp = await safe('scout trending', () => src.trendingPools(1, state.tick % 3 === 0 ? '5m' : '1h'));
    for (const p of [...(np || []), ...(tp || [])]) if (!pools.some((x) => x.pool === p.pool)) pools.push(p);
  }
  state.lastScanAt = now;
  state.counts.pools += pools.length; state.counts.signals += pools.length;

  // 2) FILTER
  const passed = [];
  for (const p of pools) { const why = filterPool(p, s); if (!why) passed.push(p); }
  state.counts.filtered += passed.length;

  // re-follow board
  const stats = C.walletStats(state.walletTrades);
  const fired = new Set(state.fired);
  const board = C.selectWallets(stats, s, fired);
  state.followed = board.slice(0, 25).map((w) => w.wallet);
  state.walletBoard = stats.filter((w) => w.roundTrips > 0).sort((a, b) => b.pnl - a.pnl).slice(0, 30)
    .map((w) => ({ ...w, followed: state.followed.includes(w.wallet), fired: fired.has(w.wallet), strikes: state.strikes[w.wallet] || 0 }));

  const repair = repairLive(state);
  const entriesOpen = !state.halted && !C.lossCapHit(state, s).hit || repair.active;
  if (s.strategySlots && entriesOpen) await runSlotEntries(state, src, passed, now, emit, safe);
  if (entriesOpen) await runMajorEntries(state, src, passed, now, emit, safe);
  considerPredictions(state, now);

  // leads to judge: due watch re-asks first, then hottest unjudged.
  // With fastScan, JUDGE runs on odd ticks only so GeckoTerminal stays under its public limit.
  const judgeNow = !s.fastScan || state.tick % 2 === 1;
  const due = judgeNow ? Object.entries(state.watch).filter(([, w]) => now >= w.dueAt).slice(0, s.fastScan ? 1 : 2) : [];
  const fresh = (judgeNow ? passed : []).filter((p) => !s.fastScan || (p.chain || 'solana') === 'solana')
    .filter((p) => !state.judged[p.pool] || now - state.judged[p.pool] > 60 * 60000)
    .filter((p) => !state.watch[p.pool] && !state.open.some((o) => o.pool === p.pool))
    .sort((a, b) => (b.vol.h1 || 0) - (a.vol.h1 || 0)).slice(0, Math.max(0, (s.fastScan ? 1 : 3) - due.length));
  const leads = [...due.map(([pool, w]) => ({ ...(passed.find((p) => p.pool === pool) || w.p), _watch: w })), ...fresh];

  const tradesByPool = {};
  for (const p of leads) {
    if (!entriesOpen) break;
    const trades = await safe(`trades ${p.symbol}`, () => src.poolTrades(p.pool, p.token));
    const info = await safe(`info ${p.symbol}`, () => getInfo(state, src, p.token, now));
    if (trades) { tradesByPool[p.pool] = trades; addWalletTrades(state, trades); }
    state.judged[p.pool] = now;
    // 4) OWN: JUDGE
    const leadId = p._watch ? p._watch.leadId : `L${now.toString(36)}-${p.pool.slice(0, 4)}`;
    const d = buildDossier(leadId, p, info || {}, trades || [], state.holderSnaps[p.token], now);
    const v = info && trades ? C.judge(d) : { leadId, action: null, missing: ['no answer: data fetch failed'] };
    const priorWatches = p._watch ? p._watch.count : 0;
    let g = C.gate(v, s, priorWatches);
    if (g.decision === 'buy' && s.volGate) {
      const rg = C.rangeAllowsEntry(d.rangePct, s.stopPct, s.volRangeFrac ?? 0.75);
      if (!rg.ok) g = { decision: 'pass', killedBy: rg.reason };
    }
    state.counts.judged++;
    const rec = {
      t: now, leadId, pool: p.pool, token: p.token, symbol: p.symbol, price: d.price,
      organic: v.organic && (v.organic.answer === 'missing' ? 'missing' : `${v.organic.answer} ${v.organic.p}`),
      late: v.late && (v.late.answer === 'missing' ? 'missing' : `${v.late.answer} ${v.late.p}`),
      exitRisk: v.exitRisk && (v.exitRisk.answer === 'missing' ? 'missing' : v.exitRisk.answer),
      action: v.action ? (v.action.answer === 'missing' ? 'missing' : `${v.action.answer} ${v.action.p}`) : 'no answer',
      actionP: v.action?.p ?? null, decision: g.decision, killedBy: g.killedBy, missing: v.missing || [], tradeId: null,
      dossier: { liq: d.liq, top10: d.top10 ?? 'missing', dev: d.dev ?? 'missing', holders: d.holdersNow ?? 'missing', holders1h: d.holders1h ?? 'missing', b5: d.buys5a ?? 'missing', s5: d.sells5a ?? 'missing', b5p: d.buys5b ?? 'missing', s5p: d.sells5b ?? 'missing', pcH1: d.pcH1, buyersRatio: d.buyersRatio == null ? 'missing' : r2(d.buyersRatio), social: d.social ?? 'missing', lp: 'missing', range: d.rangePct == null ? 'missing' : r2(d.rangePct) },
    };
    state.verdicts.push(rec);
    if (state.verdicts.length > MAX_VERDICTS) state.verdicts.splice(0, state.verdicts.length - MAX_VERDICTS);
    if (g.decision === 'watch') {
      state.watch[p.pool] = { leadId, count: priorWatches + 1, dueAt: now + s.watchRecheckMin * 60000, p };
      log(state, now, 'WATCH', `${p.symbol} ${leadId} · ${g.killedBy}`);
    } else {
      delete state.watch[p.pool];
      if (g.decision === 'pass') {
        log(state, now, 'PASS', `${p.symbol} ${leadId} · killed by ${g.killedBy}`);
        if (d.price) { state.passChecks.push({ t: now, leadId, token: p.token, symbol: p.symbol, price: d.price, checked: false, green: null }); if (state.passChecks.length > MAX_PASS) state.passChecks.shift(); }
      } else {
        state.counts.judgeBuy++;
        log(state, now, 'JUDGE', `${p.symbol} ${leadId} · BUY gate passed (action ${rec.action}, organic ${rec.organic}, late ${rec.late}, exit_risk ${rec.exitRisk})`);
        const pos = await safe('enter', () => enter(state, src, now, emit, { pool: p.pool, token: p.token, symbol: p.symbol, source: 'own', sizeUsd: (s.ownPositionPct / 100) * state.startBank, reason: `JUDGE p=${v.action.p}`, leadId, liq: p.liq }));
        if (pos) rec.tradeId = pos.id;
      }
    }
  }

  // 3) COPY: followed wallets buying the same token inside the window.
  // During repair, enter() writes a shadow line instead of a live fill.
  if (s.copyEnabled && entriesOpen && state.followed.length) {
    const followed = new Set(state.followed);
    // also re-poll pools where followed wallets traded in the last 30 min
    const hot = [...new Set(state.walletTrades.filter((t) => followed.has(t.wallet) && now - t.t < 30 * 60000).map((t) => t.token))]
      .filter((tok) => !state.open.some((o) => o.token === tok)).slice(0, 2);
    for (const tok of hot) {
      const pool = (pools.find((p) => p.token === tok) || state.walletTrades.find((t) => t.token === tok && t.pool))?.pool;
      if (pool && !tradesByPool[pool]) { const tr = await safe('copy trades', () => src.poolTrades(pool, tok)); if (tr) { tradesByPool[pool] = tr; addWalletTrades(state, tr); } }
    }
    const buys = state.walletTrades.filter((t) => t.kind === 'buy' && followed.has(t.wallet) && now - t.t <= s.copyWindowMin * 60000);
    for (const tok of [...new Set(buys.map((b) => b.token))]) {
      if (state.open.some((o) => o.token === tok)) continue;
      const pinfo = pools.find((p) => p.token === tok);
      const info = await safe('copy info', () => getInfo(state, src, tok, now));
      const px = pinfo?.priceUsd ?? buys.filter((b) => b.token === tok).slice(-1)[0].price;
      const sig = C.copySignal({ token: tok, buys, followed, nowMs: now, price: px, top10: info?.top10, lp: 'unknown' }, s);
      if (!sig.wallets.length || sig.wallets.length < s.copyMinWallets) continue;
      state.counts.copySignals++;
      const sym = pinfo?.symbol || tok.slice(0, 5);
      if (!sig.ok) { log(state, now, 'COPY', `skip ${sym}: ${sig.reason}`); continue; }
      const pool = pinfo?.pool || state.walletTrades.find((t) => t.token === tok && t.pool)?.pool || null;
      await safe('enter copy', () => enter(state, src, now, emit, { pool, token: tok, symbol: sym, source: 'copy', sizeUsd: sig.sizeUsd, wallets: sig.wallets, liq: pinfo?.liq, reason: `${sig.wallets.length} wallets in ${s.copyWindowMin}m (${sig.wallets.map(short).join(', ')}) · ${s.copyRatio}x · LP missing` }));
    }
  }

  // 6) BANKER: mark to market, exits
  const prices = state.open.length ? (await safe('prices', () => fetchOpenPrices(src, state.open))) || {} : {};
  await managePositions(state, src, now, emit, prices, tradesByPool, safe);
  state.lastMarkAt = now;

  // calibration: passes that would have been green after 24h
  const dueChecks = state.passChecks.filter((x) => !x.checked && now - x.t >= 24 * 3600000).slice(0, 30);
  if (dueChecks.length) {
    const pr = (await safe('24h check', () => src.prices([...new Set(dueChecks.map((x) => x.token))]))) || {};
    for (const x of dueChecks) if (pr[x.token]) { x.checked = true; x.later = pr[x.token]; x.green = C.fillPrice(pr[x.token], 'sell', s.feePct) > C.fillPrice(x.price, 'buy', s.feePct); }
  }

  await runActive(state, src, pools, now, emit, safe);

  state.equity.push({ t: now, v: r2(equityNow(state)) });
  if (state.equity.length > 3000) state.equity.splice(1, 1);
  return state;
}

export function serialize(state) { const { _seen, ...rest } = state; return JSON.stringify(rest); }
