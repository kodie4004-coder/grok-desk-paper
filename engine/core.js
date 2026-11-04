// Pure, deterministic trading-desk logic. No network, no clock, no wallet.
// Shared by the browser app, the headless runner and the unit tests.

export const DEFAULT_SETTINGS = Object.freeze({
  bank: 500,             // starting paper bank, USD
  ownPositionPct: 5,     // own-pick size, % of bank (confidence never changes it)
  maxPositionPct: 8,     // hard cap per position, % of bank
  maxOpen: 5,
  stopPct: 4,            // stop loss, % below entry
  takeProfitPct: 12,     // take profit / trailing activation, % above entry
  trailingPct: 0,        // 0 = plain take profit; >0 = trail this % from the peak after TP is reached
  maxHoldMin: 120,
  lossCapPct: 10,        // session loss cap, % of starting bank -> halts new entries
  feePct: 1,             // round-trip fees + slippage assumption, %
  minLiquidity: 40000,
  minVolH1: 5000,
  maxTop10: 30,          // copy filter + exit-risk input
  // JUDGE gate
  judgeBuyP: 0.70,
  judgeOrganicP: 0.65,
  judgeMaxExitRisk: 3,
  watchRecheckMin: 30,
  // copy trading
  copyEnabled: true,
  copyMinWallets: 2,
  copyWindowMin: 10,
  copyMaxRunupPct: 15,
  copyRatio: 0.25,
  strikesToFire: 2,
  walletMinWinRate: 55,
  walletMinRoundTrips: 5,  // observed round trips (30-day history is not available from free APIs)
  walletMinHoldMin: 10,
  tickSec: 60,
});

export const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
export const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const r2 = (x) => Math.round(x * 100) / 100;
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

// ---------- fees ----------
// Half of the round-trip cost is charged on each side.
export function fillPrice(price, side, feePct) {
  const half = feePct / 200;
  return side === 'buy' ? price * (1 + half) : price * (1 - half);
}
export function tradePnl({ entryMid, exitMid, sizeUsd, feePct }) {
  const buy = fillPrice(entryMid, 'buy', feePct);
  const sell = fillPrice(exitMid, 'sell', feePct);
  const qty = sizeUsd / buy;
  const proceeds = qty * sell;
  const gross = sizeUsd * (exitMid / entryMid - 1);
  return { qty, proceeds, pnl: proceeds - sizeUsd, gross, fees: gross - (proceeds - sizeUsd) };
}

// ---------- JUDGE: four closed questions ----------
// Returns answers with probabilities, or "missing" when a required field is absent. Never guesses.
export function judge(d) {
  const missing = (f) => f.filter((k) => !isNum(d[k]));
  const out = { leadId: d.leadId, organic: null, late: null, exitRisk: null, action: null, missing: [] };

  // Q1 organic?
  const m1 = missing(['buyersRatio', 'top10']);
  if (m1.length) out.organic = { answer: 'missing', fields: m1 };
  else {
    let z = 3.0 * (d.buyersRatio - 0.55) - 0.07 * (d.top10 - 25);
    if (isNum(d.holdersGrowthPct)) z += 0.08 * clamp(d.holdersGrowthPct, -20, 20);
    if (isNum(d.dev)) z -= 0.08 * Math.max(0, d.dev - 5);
    if (d.social === true) z += 0.3;
    if (isNum(d.buys5a) && isNum(d.sells5a) && d.buys5a + d.sells5a > 0) z += 0.8 * (d.buys5a / (d.buys5a + d.sells5a) - 0.5);
    const p = sigmoid(z);
    out.organic = p >= 0.5 ? { answer: 'yes', p: r2(p), pYes: p } : { answer: 'no', p: r2(1 - p), pYes: p };
  }

  // Q2 late? (already pumped / distribution phase)
  const m2 = missing(['pcH1', 'pcH6']);
  if (m2.length) out.late = { answer: 'missing', fields: m2 };
  else {
    let z = 0.04 * (d.pcH1 - 25) + 0.012 * (d.pcH6 - 80);
    if (isNum(d.pcH24) && d.pcH24 > 300) z += 1;
    if (isNum(d.buys5a) && isNum(d.sells5a) && d.sells5a > 1.5 * Math.max(1, d.buys5a)) z += 0.6;
    const p = sigmoid(z);
    out.late = p >= 0.5 ? { answer: 'yes', p: r2(p), pYes: p } : { answer: 'no', p: r2(1 - p), pYes: p };
  }

  // Q3 exit_risk 1-5
  const m3 = missing(['liq', 'top10']);
  if (m3.length) out.exitRisk = { answer: 'missing', fields: m3 };
  else {
    let pts = 0;
    if (d.liq < 40000) pts += 2; else if (d.liq < 100000) pts += 1;
    if (d.top10 > 50) pts += 2; else if (d.top10 > 30) pts += 1;
    if (isNum(d.dev) && d.dev > 10) pts += 1;
    if (d.mintAuthority === true) pts += 1;
    if (d.freezeAuthority === true) pts += 1;
    if (d.honeypot === true) pts += 3;
    if (isNum(d.sells5a) && isNum(d.sells5b) && isNum(d.buys5a) && d.sells5a > 1.5 * Math.max(1, d.sells5b) && d.sells5a > d.buys5a) pts += 1;
    const opt = ['dev', 'sells5a', 'sells5b', 'buys5a'];
    const known = opt.filter((k) => isNum(d[k])).length + (d.mintAuthority !== undefined && d.mintAuthority !== null ? 1 : 0);
    out.exitRisk = { answer: clamp(1 + pts, 1, 5), p: r2(0.55 + 0.08 * known) }; // p = data coverage of this answer
  }

  // Q4 action
  const anyMissing = [out.organic, out.late, out.exitRisk].some((a) => a.answer === 'missing');
  out.missing = [out.organic, out.late, out.exitRisk].flatMap((a) => (a.answer === 'missing' ? a.fields : []));
  if (anyMissing) out.action = { answer: 'missing' };
  else {
    let raw = 0.45 * out.organic.pYes + 0.35 * (1 - out.late.pYes) + 0.2 * ((5 - out.exitRisk.answer) / 4);
    if (isNum(d.buys5a) && isNum(d.sells5a) && d.buys5a < d.sells5a) raw -= 0.12;
    raw = clamp(raw, 0, 1);
    if (raw >= 0.6) out.action = { answer: 'buy', p: r2(raw) };
    else if (raw >= 0.45) out.action = { answer: 'watch', p: r2(clamp(1 - Math.abs(raw - 0.525) / 0.15, 0.5, 1)) };
    else out.action = { answer: 'pass', p: r2(1 - raw) };
  }
  return out;
}

// Gate. priorWatches = how many times this lead already got "watch".
// Returns { decision: 'buy'|'watch'|'pass', killedBy }
export function gate(v, s, priorWatches = 0) {
  if (!v || !v.action) return { decision: 'pass', killedBy: 'no answer' };
  if (v.action.answer === 'missing') return { decision: 'pass', killedBy: `missing: ${v.missing.join(', ')}` };
  if (v.action.answer === 'watch') {
    return priorWatches >= 1
      ? { decision: 'pass', killedBy: 'second watch' }
      : { decision: 'watch', killedBy: `action=watch p=${v.action.p} (re-ask in ${s.watchRecheckMin}m)` };
  }
  if (v.action.answer !== 'buy') return { decision: 'pass', killedBy: `action=${v.action.answer} p=${v.action.p}` };
  if (v.action.p < s.judgeBuyP) return { decision: 'pass', killedBy: `action=buy p=${v.action.p} < ${s.judgeBuyP}` };
  if (v.organic.answer !== 'yes') return { decision: 'pass', killedBy: `organic=${v.organic.answer} p=${v.organic.p}` };
  if (v.organic.p < s.judgeOrganicP) return { decision: 'pass', killedBy: `organic=yes p=${v.organic.p} < ${s.judgeOrganicP}` };
  if (v.late.answer !== 'no') return { decision: 'pass', killedBy: `late=${v.late.answer} p=${v.late.p}` };
  if (v.exitRisk.answer > s.judgeMaxExitRisk) return { decision: 'pass', killedBy: `exit_risk=${v.exitRisk.answer} > ${s.judgeMaxExitRisk}` };
  return { decision: 'buy', killedBy: null };
}

// ---------- calibration ----------
export function calibration(verdicts, trades, passChecks) {
  const buckets = [
    { label: '0.70-0.79', lo: 0.7, hi: 0.8 },
    { label: '0.80-0.89', lo: 0.8, hi: 0.9 },
    { label: '0.90+', lo: 0.9, hi: 1.01 },
  ].map((b) => ({ ...b, buys: 0, closed: 0, green: 0 }));
  const byId = new Map(trades.map((t) => [t.id, t]));
  for (const v of verdicts) {
    if (v.decision !== 'buy' || !v.tradeId) continue;
    const p = v.actionP;
    const b = buckets.find((x) => p >= x.lo && p < x.hi);
    if (!b) continue;
    b.buys++;
    const t = byId.get(v.tradeId);
    if (t && t.closedAt) { b.closed++; if (t.pnl > 0) b.green++; }
  }
  const checked = passChecks.filter((p) => p.checked);
  return {
    buckets: buckets.map(({ label, buys, closed, green }) => ({ label, buys, closed, green })),
    passes: { total: passChecks.length, checked: checked.length, wouldBeGreen: checked.filter((p) => p.green).length },
  };
}

// ---------- risk (stop before buy) ----------
export function lossCapHit(state, s) {
  const realized = state.closed.reduce((a, t) => a + t.pnl, 0);
  const cap = -(s.lossCapPct / 100) * state.startBank;
  return { hit: realized <= cap, realized, cap };
}

export function riskCheck(state, s, { token, sizeUsd }) {
  const lc = lossCapHit(state, s);
  if (state.halted || lc.hit) return { ok: false, reason: `loss cap hit: realized ${r2(lc.realized)} <= ${r2(lc.cap)} (new entries halted)` };
  if (state.open.length >= s.maxOpen) return { ok: false, reason: `max open positions (${s.maxOpen})` };
  if (state.open.some((p) => p.token === token)) return { ok: false, reason: 'already holding token' };
  const cap = (s.maxPositionPct / 100) * state.startBank;
  const size = Math.min(sizeUsd, cap);
  if (size < 1) return { ok: false, reason: 'size below $1' };
  if (size > state.cash) return { ok: false, reason: `not enough cash (${r2(state.cash)})` };
  return { ok: true, sizeUsd: r2(size) };
}

export function stopLevels(entryMid, s) {
  return { stop: entryMid * (1 - s.stopPct / 100), tp: entryMid * (1 + s.takeProfitPct / 100) };
}

// Decide exit for an open position given current mid price.
export function exitCheck(pos, price, nowMs, s) {
  if (!isNum(price) || price <= 0) return null;
  const peak = Math.max(pos.peak || pos.entryMid, price);
  if (price <= pos.stop) return { reason: `STOP -${s.stopPct}%`, kind: 'stop', peak };
  if (s.trailingPct > 0) {
    if (peak >= pos.tp && price <= peak * (1 - s.trailingPct / 100)) return { reason: `TRAIL ${s.trailingPct}% off peak`, kind: 'tp', peak };
  } else if (price >= pos.tp) return { reason: `TAKE PROFIT +${s.takeProfitPct}%`, kind: 'tp', peak };
  if (nowMs - pos.openedAt >= s.maxHoldMin * 60000) return { reason: `TIME ${s.maxHoldMin}m`, kind: 'time', peak };
  return { reason: null, peak };
}

// ---------- copy trading: wallet stats from observed trades ----------
// trades: [{wallet, token, kind:'buy'|'sell', price, usd, t}]
export function walletStats(trades) {
  const by = new Map();
  for (const tr of trades) {
    const k = tr.wallet + '|' + tr.token;
    let w = by.get(k);
    if (!w) by.set(k, (w = { wallet: tr.wallet, token: tr.token, bUsd: 0, bQty: 0, sUsd: 0, sQty: 0, firstBuy: null, firstSell: null, n: 0 }));
    w.n++;
    if (!(tr.price > 0)) continue;
    if (tr.kind === 'buy') { w.bUsd += tr.usd; w.bQty += tr.usd / tr.price; if (w.firstBuy === null || tr.t < w.firstBuy) w.firstBuy = tr.t; }
    else { w.sUsd += tr.usd; w.sQty += tr.usd / tr.price; if (w.firstSell === null || tr.t < w.firstSell) w.firstSell = tr.t; }
  }
  const wallets = new Map();
  for (const w of by.values()) {
    let s = wallets.get(w.wallet);
    if (!s) wallets.set(w.wallet, (s = { wallet: w.wallet, trades: 0, roundTrips: 0, wins: 0, pnl: 0, holdSum: 0, tokens: 0 }));
    s.trades += w.n; s.tokens++;
    // a round trip = observed buy followed by an observed sell of the same token
    if (w.bQty > 0 && w.sQty > 0 && w.firstSell > w.firstBuy) {
      const avgB = w.bUsd / w.bQty, avgS = w.sUsd / w.sQty;
      const ret = avgS / avgB - 1;
      s.roundTrips++; if (ret > 0) s.wins++;
      s.pnl += Math.min(w.sQty, w.bQty) * (avgS - avgB);
      s.holdSum += (w.firstSell - w.firstBuy) / 60000;
    }
  }
  return [...wallets.values()].map((s) => ({
    ...s,
    winRate: s.roundTrips ? (100 * s.wins) / s.roundTrips : 0,
    avgHoldMin: s.roundTrips ? s.holdSum / s.roundTrips : 0,
    pnl: r2(s.pnl),
  }));
}

export function selectWallets(stats, s, fired = new Set()) {
  return stats
    .filter((w) => !fired.has(w.wallet) && w.roundTrips >= s.walletMinRoundTrips && w.winRate >= s.walletMinWinRate && w.avgHoldMin > s.walletMinHoldMin && w.pnl > 0)
    .sort((a, b) => b.pnl - a.pnl);
}

// Copy signal: >= copyMinWallets followed wallets bought the token within copyWindowMin.
export function copySignal({ token, buys, followed, nowMs, price, top10, lp }, s) {
  const recent = buys.filter((b) => b.token === token && followed.has(b.wallet) && nowMs - b.t <= s.copyWindowMin * 60000);
  const wallets = [...new Set(recent.map((b) => b.wallet))];
  if (wallets.length < s.copyMinWallets) return { ok: false, reason: `${wallets.length}/${s.copyMinWallets} top wallets in ${s.copyWindowMin}m`, wallets };
  if (lp === 'unlocked') return { ok: false, reason: 'LP not locked/burned', wallets };
  if (!isNum(top10)) return { ok: false, reason: 'top-10 share missing', wallets };
  if (top10 >= s.maxTop10) return { ok: false, reason: `top-10 holders ${r2(top10)}% >= ${s.maxTop10}%`, wallets };
  const entry = Math.min(...recent.map((b) => b.price));
  const runup = (price / entry - 1) * 100;
  if (runup > s.copyMaxRunupPct) return { ok: false, reason: `price up ${r2(runup)}% since wallet entry > ${s.copyMaxRunupPct}%`, wallets };
  const avgUsd = recent.reduce((a, b) => a + b.usd, 0) / recent.length;
  return { ok: true, wallets, sizeUsd: avgUsd * s.copyRatio, runup: r2(runup) };
}

// Firing rule: a loss adds a strike, a win resets; strikesToFire in a row = unfollow.
export function applyStrike(strikes, wallet, pnl, s) {
  const cur = strikes[wallet] || 0;
  const next = pnl > 0 ? 0 : cur + 1;
  return { strikes: { ...strikes, [wallet]: next }, fired: next >= s.strikesToFire, count: next };
}

export function settingsLocked(state) { return !!(state && state.running); }
export function updateSettings(state, cur, patch) {
  if (settingsLocked(state)) return { ok: false, settings: cur, reason: 'Settings are locked while a session runs. Rules never loosen mid-session.' };
  return { ok: true, settings: { ...cur, ...patch } };
}
