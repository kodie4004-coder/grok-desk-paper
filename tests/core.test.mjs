import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../engine/core.js';
import { newState, startSession, tick, endSession } from '../engine/engine.js';

const S = { ...C.DEFAULT_SETTINGS };
const good = { leadId: 'L1', buyersRatio: 0.9, top10: 15, dev: 1, social: true, pcH1: 5, pcH6: 10, pcH24: 20, liq: 250000, buys5a: 20, sells5a: 8, buys5b: 15, sells5b: 10, mintAuthority: false, freezeAuthority: false, honeypot: false };

test('judge: clean lead passes the gate', () => {
  const v = C.judge(good);
  assert.equal(v.organic.answer, 'yes');
  assert.equal(v.late.answer, 'no');
  assert.ok(v.exitRisk.answer <= 3);
  assert.equal(v.action.answer, 'buy');
  assert.equal(C.gate(v, S).decision, 'buy');
});

test('judge: missing field writes "missing" and the gate passes on it', () => {
  const v = C.judge({ ...good, top10: null });
  assert.equal(v.organic.answer, 'missing');
  assert.equal(v.action.answer, 'missing');
  const g = C.gate(v, S);
  assert.equal(g.decision, 'pass');
  assert.match(g.killedBy, /missing: top10/);
});

test('gate: no answer = pass', () => {
  assert.deepEqual(C.gate(null, S), { decision: 'pass', killedBy: 'no answer' });
});

test('gate: late=yes kills even a high buy score', () => {
  const v = C.judge(good);
  v.late = { answer: 'yes', p: 0.8 };
  assert.match(C.gate(v, S).killedBy, /late=yes/);
});

test('gate: buy p below 0.70 is a pass', () => {
  const v = C.judge(good); v.action = { answer: 'buy', p: 0.69 };
  assert.match(C.gate(v, S).killedBy, /0.69 < 0.7/);
});

test('gate: organic p below 0.65 is a pass', () => {
  const v = C.judge(good); v.organic = { answer: 'yes', p: 0.6, pYes: 0.6 };
  assert.match(C.gate(v, S).killedBy, /organic=yes p=0.6 < 0.65/);
});

test('gate: exit_risk above 3 is a pass', () => {
  const v = C.judge(good); v.exitRisk = { answer: 4, p: 0.9 };
  assert.match(C.gate(v, S).killedBy, /exit_risk=4/);
});

test('gate: first watch re-asks, second watch = pass', () => {
  const v = C.judge(good); v.action = { answer: 'watch', p: 0.7 };
  assert.equal(C.gate(v, S, 0).decision, 'watch');
  const g2 = C.gate(v, S, 1);
  assert.equal(g2.decision, 'pass'); assert.equal(g2.killedBy, 'second watch');
});

test('judge: concentrated, pumped, dumping lead is not a buy', () => {
  const v = C.judge({ ...good, buyersRatio: 0.3, top10: 60, dev: 20, pcH1: 120, pcH6: 400, sells5a: 40, buys5a: 5, liq: 30000 });
  assert.notEqual(C.gate(v, S).decision, 'buy');
  assert.equal(v.exitRisk.answer, 5);
});

test('fees: flat price round trip loses exactly the fee', () => {
  const r = C.tradePnl({ entryMid: 1, exitMid: 1, sizeUsd: 100, feePct: 1 });
  assert.ok(Math.abs(r.pnl - -0.995) < 0.01, r.pnl); // ~1% round trip
  const r2 = C.tradePnl({ entryMid: 1, exitMid: 1.1, sizeUsd: 100, feePct: 1 });
  assert.ok(r2.pnl < 10 && r2.pnl > 8.8);
});

test('stop logic: stop, take profit, trailing, time exit', () => {
  const lv = C.stopLevels(1, S);
  const pos = { entryMid: 1, ...lv, openedAt: 0, peak: 1 };
  assert.equal(C.exitCheck(pos, 0.959, 1000, S).kind, 'stop');
  assert.equal(C.exitCheck(pos, 1.13, 1000, S).kind, 'tp');
  assert.equal(C.exitCheck(pos, 1.0, 1000, S).reason, null);
  assert.equal(C.exitCheck(pos, 1.0, 121 * 60000, S).kind, 'time');
  const T = { ...S, trailingPct: 5 };
  assert.equal(C.exitCheck({ ...pos, peak: 1.3 }, 1.25, 1000, T).reason, null);
  assert.equal(C.exitCheck({ ...pos, peak: 1.3 }, 1.2, 1000, T).kind, 'tp');
});

test('risk: max 8% of bank per position, cash and duplicate checks', () => {
  const st = { startBank: 1000, cash: 1000, open: [], closed: [], halted: false };
  assert.equal(C.riskCheck(st, S, { token: 'A', sizeUsd: 500 }).sizeUsd, 80);
  st.open.push({ token: 'A' });
  assert.equal(C.riskCheck(st, S, { token: 'A', sizeUsd: 10 }).ok, false);
});

test('loss cap halts new entries (no make-it-back mode)', () => {
  const st = { startBank: 1000, cash: 900, open: [], closed: [{ pnl: -60 }, { pnl: -45 }], halted: false };
  assert.equal(C.lossCapHit(st, S).hit, true);
  const r = C.riskCheck(st, S, { token: 'B', sizeUsd: 50 });
  assert.equal(r.ok, false); assert.match(r.reason, /loss cap/);
  // the cap never raises size to recover
  assert.ok(!('recover' in C));
});

test('firing rule: 2 losses in a row unfollows, a win resets', () => {
  let r = C.applyStrike({}, 'W', -1, S); assert.equal(r.count, 1); assert.equal(r.fired, false);
  r = C.applyStrike(r.strikes, 'W', 2, S); assert.equal(r.count, 0);
  r = C.applyStrike(r.strikes, 'W', -1, S); r = C.applyStrike(r.strikes, 'W', -3, S);
  assert.equal(r.count, 2); assert.equal(r.fired, true);
});

test('settings are locked while a session runs', () => {
  const r = C.updateSettings({ running: true }, S, { stopPct: 50 });
  assert.equal(r.ok, false); assert.equal(r.settings.stopPct, 4);
  assert.equal(C.updateSettings({ running: false }, S, { stopPct: 6 }).settings.stopPct, 6);
});

test('wallet stats + selection from observed trades', () => {
  const tr = [];
  for (let i = 0; i < 6; i++) {
    tr.push({ wallet: 'W', token: 'T' + i, kind: 'buy', price: 1, usd: 100, t: 0 });
    tr.push({ wallet: 'W', token: 'T' + i, kind: 'sell', price: i < 4 ? 1.2 : 0.9, usd: 100, t: 15 * 60000 });
  }
  const [w] = C.walletStats(tr);
  assert.equal(w.roundTrips, 6); assert.equal(Math.round(w.winRate), 67); assert.ok(w.pnl > 0); assert.equal(w.avgHoldMin, 15);
  assert.equal(C.selectWallets([w], S).length, 1);
  assert.equal(C.selectWallets([w], S, new Set(['W'])).length, 0);
  assert.equal(C.selectWallets([{ ...w, avgHoldMin: 5 }], S).length, 0);
});

test('copy signal: needs 2 wallets in 10 min, top10 < 30, run-up <= 15%', () => {
  const now = 20 * 60000, followed = new Set(['A', 'B']);
  const buys = [{ wallet: 'A', token: 'X', price: 1, usd: 100, t: now - 60000 }, { wallet: 'B', token: 'X', price: 1.02, usd: 200, t: now - 120000 }];
  const ok = C.copySignal({ token: 'X', buys, followed, nowMs: now, price: 1.05, top10: 20 }, S);
  assert.equal(ok.ok, true); assert.equal(ok.sizeUsd, 37.5);
  assert.equal(C.copySignal({ token: 'X', buys: buys.slice(0, 1), followed, nowMs: now, price: 1.05, top10: 20 }, S).ok, false);
  assert.match(C.copySignal({ token: 'X', buys, followed, nowMs: now, price: 1.2, top10: 20 }, S).reason, /price up/);
  assert.match(C.copySignal({ token: 'X', buys, followed, nowMs: now, price: 1.05, top10: 35 }, S).reason, /top-10/);
  assert.match(C.copySignal({ token: 'X', buys, followed, nowMs: now, price: 1.05, top10: null }, S).reason, /missing/);
});

test('calibration buckets count closed greens', () => {
  const c = C.calibration(
    [{ decision: 'buy', actionP: 0.75, tradeId: 'a' }, { decision: 'buy', actionP: 0.85, tradeId: 'b' }, { decision: 'pass' }],
    [{ id: 'a', closedAt: 1, pnl: 2 }, { id: 'b', closedAt: 1, pnl: -1 }],
    [{ checked: true, green: true }, { checked: false }],
  );
  assert.deepEqual(c.buckets[0], { label: '0.70-0.79', buys: 1, closed: 1, green: 1 });
  assert.deepEqual(c.buckets[1], { label: '0.80-0.89', buys: 1, closed: 1, green: 0 });
  assert.deepEqual(c.passes, { total: 2, checked: 1, wouldBeGreen: 1 });
});

test('engine tick end to end with a fake source: own buy, stop out, loss cap', async () => {
  let t = 1_000_000_000_000, price = 1;
  const pool = { pool: 'P1', token: 'TK', symbol: 'TEST', dex: 'x', createdAt: t - 3600e3, priceUsd: 1, liq: 300000, fdv: 1e6, pc: { m5: 1, h1: 5, h6: 10, h24: 20 }, tx: { m5: { b: 20, s: 8 }, h1: { b: 100, s: 60, buyers: 95, sellers: 50 } }, vol: { m5: 1e3, h1: 5e4, h24: 1e6 } };
  const src = {
    newPools: async () => [pool], trendingPools: async () => [],
    tokenInfo: async () => ({ holders: 5000, top10: 15, dev: 1, mintAuthority: false, freezeAuthority: false, honeypot: false, social: true }),
    poolTrades: async () => Array.from({ length: 30 }, (_, i) => ({ id: 'x' + i + t, t: t - i * 20000, wallet: 'w' + (i % 7), kind: i % 3 ? 'buy' : 'sell', usd: 50, price: 1, token: 'TK', pool: 'P1' })),
    prices: async (toks) => Object.fromEntries(toks.map((k) => [k, price])),
  };
  const st = newState({ ...S, bank: 1000, lossCapPct: 0.1, edgeGate: false, impactModel: false, strategySlots: false, fastScan: false }, t);
  startSession(st, t);
  await tick(st, src, t);
  assert.equal(st.open.length, 1, JSON.stringify(st.log.slice(-3)));
  assert.equal(st.open[0].sizeUsd, 50);
  price = 0.9; t += 60000;
  await tick(st, src, t);
  assert.equal(st.open.length, 0);
  assert.equal(st.closed[0].exitKind, 'stop');
  assert.ok(st.closed[0].pnl < -5);
  assert.equal(st.halted, true);
  assert.match(st.haltReason, /No "make it back"/);
  const rc = endSession(st, t);
  assert.equal(rc.trades, 1);
});

test('strategy health: expectancy, profit factor, cost drag, drawdown', () => {
  const h = C.strategyHealth([
    { pnl: 3, fees: 1, sizeUsd: 25 },
    { pnl: -1, fees: 1, sizeUsd: 25 },
  ]);
  assert.equal(h.n, 2);
  assert.ok(Math.abs(h.expectancy - 1) < 1e-9);
  assert.ok(Math.abs(h.profitFactor - 3) < 1e-9);
  assert.ok(Math.abs(h.costDrag - 0.5) < 1e-9);
  assert.equal(h.ci80, null);
  assert.ok(Math.abs(h.maxDrawdown - 1) < 1e-9);
  assert.equal(C.strategyHealth([]).n, 0);
});

test('participation scale is only 0, 0.5, or 1 and losses do not raise it', () => {
  const flat = C.participationDecision(C.strategyHealth([]), { edgeGate: true, allowExplore: false, edgeMinN: 30 }, { verdict: 'no-edge', summary: 'none' });
  assert.equal(flat.scale, 0);
  assert.equal(flat.mode, 'flat');
  const explore = C.participationDecision(C.strategyHealth([]), { edgeGate: true, allowExplore: true, edgeMinN: 30 }, { verdict: 'no-edge', summary: 'none' });
  assert.equal(explore.scale, 0.5);
  const wins = C.strategyHealth(Array.from({ length: 30 }, () => ({ pnl: 1, fees: 0.2, sizeUsd: 25 })));
  assert.ok(wins.ci80[0] > 0);
  assert.equal(C.participationDecision(wins, { edgeGate: true, allowExplore: false, edgeMinN: 30 }, { verdict: 'no-edge' }).scale, 1);
  const losses = C.strategyHealth(Array.from({ length: 30 }, () => ({ pnl: -1, fees: 0.2, sizeUsd: 25 })));
  assert.equal(C.participationDecision(losses, { edgeGate: true, allowExplore: true, edgeMinN: 30 }, { verdict: 'edge' }).scale, 0);
  assert.equal(C.participationDecision(C.strategyHealth([]), { edgeGate: false }, { verdict: 'no-edge' }).scale, 1);
});

test('range gate blocks when the 5m range swallows the stop, missing range does not', () => {
  assert.equal(C.rangeAllowsEntry(null, 4, 0.75).ok, true);
  assert.equal(C.rangeAllowsEntry(2.9, 4, 0.75).ok, true);
  assert.equal(C.rangeAllowsEntry(3, 4, 0.75).ok, false);
});

test('liquidity impact grows as the pool thins and stays capped', () => {
  assert.ok(Math.abs(C.roundTripImpactPct(25, 40000) - 0.25) < 1e-9);
  assert.ok(C.roundTripImpactPct(25, 10000) > C.roundTripImpactPct(25, 40000));
  assert.equal(C.roundTripImpactPct(25, 0), 0);
  assert.equal(C.roundTripImpactPct(100000, 1000), 3);
});

test('edge gate stays flat when the prior says no edge', async () => {
  let t = 1_000_000_000_000;
  const pool = { pool: 'P1', token: 'TK', symbol: 'TEST', dex: 'x', createdAt: t - 3600e3, priceUsd: 1, liq: 300000, fdv: 1e6, pc: { m5: 1, h1: 5, h6: 10, h24: 20 }, tx: { m5: { b: 20, s: 8 }, h1: { b: 100, s: 60, buyers: 95, sellers: 50 } }, vol: { m5: 1e3, h1: 5e4, h24: 1e6 } };
  const src = {
    newPools: async () => [pool], trendingPools: async () => [],
    tokenInfo: async () => ({ holders: 5000, top10: 15, dev: 1, mintAuthority: false, freezeAuthority: false, honeypot: false, social: true }),
    poolTrades: async () => Array.from({ length: 30 }, (_, i) => ({ id: 'x' + i + t, t: t - i * 20000, wallet: 'w' + (i % 7), kind: i % 3 ? 'buy' : 'sell', usd: 50, price: 1, token: 'TK', pool: 'P1' })),
    prices: async (toks) => Object.fromEntries(toks.map((k) => [k, 1])),
  };
  const st = newState({ ...S, edgeGate: true, allowExplore: false, impactModel: false, strategySlots: false, fastScan: false, edgePrior: { verdict: 'no-edge', summary: 'study: no edge' } }, t);
  startSession(st, t);
  await tick(st, src, t);
  assert.equal(st.open.length, 0);
  assert.ok(st.counts.edgeFlat >= 1);
  assert.match(st.log.map((l) => l.text).join('\n'), /flat TEST/);
});

test('exploratory mode buys at half size, a proven book buys full size', async () => {
  let t = 1_000_000_000_000;
  const pool = { pool: 'P1', token: 'TK', symbol: 'TEST', dex: 'x', createdAt: t - 3600e3, priceUsd: 1, liq: 300000, fdv: 1e6, pc: { m5: 1, h1: 5, h6: 10, h24: 20 }, tx: { m5: { b: 20, s: 8 }, h1: { b: 100, s: 60, buyers: 95, sellers: 50 } }, vol: { m5: 1e3, h1: 5e4, h24: 1e6 } };
  const src = {
    newPools: async () => [pool], trendingPools: async () => [],
    tokenInfo: async () => ({ holders: 5000, top10: 15, dev: 1, mintAuthority: false, freezeAuthority: false, honeypot: false, social: true }),
    poolTrades: async () => Array.from({ length: 30 }, (_, i) => ({ id: 'x' + i + t, t: t - i * 20000, wallet: 'w' + (i % 7), kind: i % 3 ? 'buy' : 'sell', usd: 50, price: 1, token: 'TK', pool: 'P1' })),
    prices: async (toks) => Object.fromEntries(toks.map((k) => [k, 1])),
  };
  const half = newState({ ...S, bank: 1000, edgeGate: true, allowExplore: true, impactModel: false, volGate: false, strategySlots: false, fastScan: false, edgePrior: { verdict: 'no-edge', summary: 'x' } }, t);
  startSession(half, t);
  await tick(half, src, t);
  assert.equal(half.open[0].sizeUsd, 25);
  const full = newState({ ...S, bank: 1000, edgeGate: true, allowExplore: false, impactModel: false, volGate: false, strategySlots: false, fastScan: false, edgePrior: { verdict: 'no-edge', summary: 'x' } }, t);
  full.edgeBook = Array.from({ length: 30 }, () => ({ pnl: 1, fees: 0.1, sizeUsd: 25 }));
  startSession(full, t);
  await tick(full, src, t);
  assert.equal(full.open[0].sizeUsd, 50);
});

test('vol gate passes a lead whose 5m range is wider than the stop', async () => {
  let t = 1_000_000_000_000;
  const pool = { pool: 'P9', token: 'TK', symbol: 'WIDE', dex: 'x', createdAt: t - 3600e3, priceUsd: 1, liq: 300000, fdv: 1e6, pc: { m5: 1, h1: 5, h6: 10, h24: 20 }, tx: { m5: { b: 20, s: 8 }, h1: { b: 100, s: 60, buyers: 95, sellers: 50 } }, vol: { m5: 1e3, h1: 5e4, h24: 1e6 } };
  const src = {
    newPools: async () => [pool], trendingPools: async () => [],
    tokenInfo: async () => ({ holders: 5000, top10: 15, dev: 1, mintAuthority: false, freezeAuthority: false, honeypot: false, social: true }),
    poolTrades: async () => Array.from({ length: 12 }, (_, i) => ({ id: 'r' + i, t: t - i * 10000, wallet: 'w' + i, kind: i % 3 ? 'buy' : 'sell', usd: 50, price: i % 2 ? 1 : 1.2, token: 'TK', pool: 'P9' })),
    prices: async (toks) => Object.fromEntries(toks.map((k) => [k, 1])),
  };
  const st = newState({ ...S, edgeGate: false, impactModel: false, volGate: true, volRangeFrac: 0.75, strategySlots: false, fastScan: false }, t);
  startSession(st, t);
  await tick(st, src, t);
  assert.equal(st.open.length, 0);
  assert.match(st.verdicts.at(-1).killedBy, /range/);
});
