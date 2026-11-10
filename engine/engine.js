// Paper trading desk orchestrator. Six agents per tick: Scout -> Filter -> Copy -> Own(JUDGE) -> Risk -> Banker.
// PAPER ONLY: positions are numbers in this object. There is no wallet, key or order code anywhere.
import * as C from './core.js';

const r2 = (x) => Math.round(x * 100) / 100;
const MAX_LOG = 600, MAX_WT = 15000, MAX_VERDICTS = 1500, MAX_PASS = 1500;

export function newState(settings, now, mode = 'live') {
  return {
    v: 1, mode, running: false, sessionId: null, startedAt: null, endedAt: null,
    settings: { ...settings }, startBank: settings.bank, cash: settings.bank,
    open: [], closed: [], equity: [], markers: [], log: [], verdicts: [], passChecks: [],
    watch: {}, judged: {}, infoCache: {}, holderSnaps: {}, lastPrices: {},
    counts: { signals: 0, pools: 0, tradesScanned: 0, filtered: 0, judged: 0, judgeBuy: 0, copySignals: 0, copied: 0, own: 0, riskBlocked: 0, edgeFlat: 0, closed: 0 },
    edgeBook: [],
    walletTrades: [], followed: [], walletBoard: [], strikes: {}, fired: [], firedCards: [],
    halted: false, haltReason: null, tick: 0, lastTickAt: null, errors: 0, recap: null, createdAt: now,
  };
}

export function startSession(state, now) {
  const s = state.settings;
  Object.assign(state, {
    running: true, sessionId: 'S' + now.toString(36), startedAt: now, endedAt: null, startBank: s.bank, cash: s.bank,
    open: [], closed: [], equity: [{ t: now, v: s.bank }], markers: [], halted: false, haltReason: null, recap: null, tick: 0,
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
    state.haltReason = `Loss cap hit: realized $${r2(lc.realized)} <= -${s.lossCapPct}% of bank ($${r2(lc.cap)}). New entries halted for this session. No "make it back" mode.`;
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

async function enter(state, src, now, emit, { pool, token, symbol, source, sizeUsd, reason, wallets = [], leadId = null, liq = null }) {
  const s = state.settings;
  const part = C.participationDecision(C.strategyHealth(state.edgeBook || []), s);
  if (!(part.scale > 0)) {
    state.counts.edgeFlat = (state.counts.edgeFlat || 0) + 1;
    log(state, now, 'RISK', `flat ${symbol} (${source}): ${part.reason}`);
    return null;
  }
  const rc = C.riskCheck(state, s, { token, sizeUsd: sizeUsd * part.scale });
  if (!rc.ok) { state.counts.riskBlocked++; log(state, now, 'RISK', `blocked ${symbol} (${source}): ${rc.reason}`); return null; }
  const px = (await src.prices([token]))[token];
  if (!px) { state.counts.riskBlocked++; log(state, now, 'RISK', `blocked ${symbol}: no live price`); return null; }
  const feePct = s.impactModel ? s.feePct + C.roundTripImpactPct(rc.sizeUsd, liq) : s.feePct;
  const lv = C.stopLevels(px, s);
  const fill = C.fillPrice(px, 'buy', feePct);
  const why = part.scale === 1 ? reason : `${reason} · ${part.mode} ×${part.scale}`;
  const p = {
    id: 'T' + now.toString(36) + state.counts.copied + state.counts.own, pool, token, symbol, source, wallets, leadId,
    entryMid: px, entryFill: fill, qty: rc.sizeUsd / fill, sizeUsd: rc.sizeUsd, feePct, stop: lv.stop, tp: lv.tp, peak: px, lastPrice: px, openedAt: now, reason: why,
  };
  state.cash -= rc.sizeUsd; state.open.push(p);
  state.counts[source === 'copy' ? 'copied' : 'own']++;
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
}

// Price open positions between scout ticks. DexScreener, not the GeckoTerminal budget.
export async function mark(state, src, now, emit = () => {}) {
  if (!state.running || !state.open.length || !(state.settings.markSec > 0)) return state;
  state.lastMarkAt = now;
  const safe = async (label, fn) => { try { return await fn(); } catch (e) { state.errors++; log(state, now, 'ERR', `${label}: ${e.message}`); return null; } };
  const tokens = [...new Set(state.open.map((p) => p.token))];
  const prices = (await safe('mark', () => src.prices(tokens))) || {};
  await managePositions(state, src, now, emit, prices, null, safe);
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
  const np = await safe('scout new pools', () => src.newPools(1 + (state.tick % 2)));
  const tp = await safe('scout trending', () => src.trendingPools(1, state.tick % 3 === 0 ? '5m' : '1h'));
  for (const p of [...(np || []), ...(tp || [])]) if (!pools.some((x) => x.pool === p.pool)) pools.push(p);
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

  const entriesOpen = !state.halted && !C.lossCapHit(state, s).hit;

  // leads to judge: due watch re-asks first, then hottest unjudged
  const due = Object.entries(state.watch).filter(([, w]) => now >= w.dueAt).slice(0, 2);
  const fresh = passed.filter((p) => !state.judged[p.pool] || now - state.judged[p.pool] > 60 * 60000)
    .filter((p) => !state.watch[p.pool] && !state.open.some((o) => o.pool === p.pool))
    .sort((a, b) => (b.vol.h1 || 0) - (a.vol.h1 || 0)).slice(0, Math.max(0, 3 - due.length));
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

  // 3) COPY: followed wallets buying the same token inside the window
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
  const tokens = [...new Set(state.open.map((p) => p.token))];
  const prices = tokens.length ? (await safe('prices', () => src.prices(tokens))) || {} : {};
  await managePositions(state, src, now, emit, prices, tradesByPool, safe);
  state.lastMarkAt = now;

  // calibration: passes that would have been green after 24h
  const dueChecks = state.passChecks.filter((x) => !x.checked && now - x.t >= 24 * 3600000).slice(0, 30);
  if (dueChecks.length) {
    const pr = (await safe('24h check', () => src.prices([...new Set(dueChecks.map((x) => x.token))]))) || {};
    for (const x of dueChecks) if (pr[x.token]) { x.checked = true; x.later = pr[x.token]; x.green = C.fillPrice(pr[x.token], 'sell', s.feePct) > C.fillPrice(x.price, 'buy', s.feePct); }
  }

  state.equity.push({ t: now, v: r2(equityNow(state)) });
  if (state.equity.length > 3000) state.equity.splice(1, 1);
  return state;
}

export function serialize(state) { const { _seen, ...rest } = state; return JSON.stringify(rest); }
