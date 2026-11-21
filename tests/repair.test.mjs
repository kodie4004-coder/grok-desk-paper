import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DEFAULT_SETTINGS, lossCapHit, riskCheck, targetClearsFees } from '../engine/core.js';
import { newState, startSession, tick } from '../engine/engine.js';
import { diagnoseMeme, isEarlyBook, repairGate, sleeveBenched, REPAIR_MIN_N, REPAIR_SIZE_USD } from '../engine/repair.js';

const S = DEFAULT_SETTINGS;

test('the loss cap stays at 10% and repair does not raise size', () => {
  assert.equal(S.lossCapPct, 10);
  assert.equal(REPAIR_SIZE_USD, 2);
  assert.equal(REPAIR_MIN_N, 20);
  const st = { startBank: 1000, cash: 900, open: [], closed: [{ pnl: -100 }], halted: false };
  const cap = lossCapHit(st, S);
  assert.equal(cap.hit, true);
  assert.equal(cap.cap, -100);
  const blocked = riskCheck(st, S, { token: 'T', sizeUsd: 50 });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.repair, true);
  const small = riskCheck({ ...st, halted: true }, S, { token: 'T', sizeUsd: 50, repairPass: true, repairSize: REPAIR_SIZE_USD });
  assert.equal(small.ok, true);
  assert.equal(small.sizeUsd, 2);
  assert.equal(targetClearsFees({ feePct: 1, takeProfitPct: 12 }), true);
  assert.equal(targetClearsFees({ feePct: 1, takeProfitPct: 0.2 }), false);
});

test('resume needs 20 shadow trades with a positive mean', () => {
  const wins = Array.from({ length: 19 }, () => ({ pnl: 0.1, allocated: false }));
  assert.equal(repairGate(wins).pass, false);
  assert.equal(repairGate([...wins, { pnl: 0.1, allocated: false }]).pass, true);
  assert.equal(repairGate(Array.from({ length: 20 }, () => ({ pnl: -0.1, allocated: false }))).pass, false);
  assert.equal(repairGate(Array.from({ length: 20 }, () => ({ pnl: 0.2, allocated: false }))).sizeUsd, 2);
  const earlyWins = Array.from({ length: 20 }, (_, i) => ({ pnl: 0.4, allocated: false, variant: 'early-exit-fast', ca: 'E' + i }));
  const memeLosses = Array.from({ length: 5 }, (_, i) => ({ pnl: -0.2, allocated: false, variant: 'meme-safety', ca: 'M' + i }));
  const mixed = diagnoseMeme([...earlyWins, ...memeLosses]);
  assert.equal(mixed.repair.n, 5);
  assert.equal(mixed.repair.pass, false);
  assert.equal(mixed.incident.n, 5);
  assert.equal(sleeveBenched(Array.from({ length: 20 }, () => ({ pnl: -0.1, allocated: true }))).benched, true);
  assert.equal(sleeveBenched(Array.from({ length: 19 }, () => ({ pnl: -0.1, allocated: true }))).benched, false);
});

test('the stored meme journal is summed, not invented, and the sleeve bench follows the repair rule', () => {
  const rows = fs.readFileSync('data/meme-journal.jsonl', 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const report = diagnoseMeme(rows);
  const incident = report.incident;
  assert.equal(incident.n, incident.wins + incident.losses);
  const picked = rows.filter((row) => row.pnl != null && !isEarlyBook(row.variant));
  assert.ok(picked.length >= incident.n);
  assert.ok(Math.abs(incident.pnl - incident.mean * incident.n) < 1e-6);
  assert.equal(report.findings.length, 3);
  // The journal is live data, so check the rule rather than a frozen state.
  // On the 2026-11-21 journal the repair gate passed (30 shadow trades, mean
  // above zero), so the sleeve is no longer benched.
  assert.equal(report.repair.pass, report.repair.n >= REPAIR_MIN_N && report.repair.mean > 0);
  assert.equal(report.benched, sleeveBenched(picked).benched);
  if (!report.repair.pass && report.repair.n > 0) assert.equal(report.benched, true);
  assert.equal(report.repair.sizeUsd, 2);
  // The incident is a 34-trade window. Later safety rows can fall outside it,
  // so the window's exits are bounded by, and sum to, its own rows.
  assert.equal(Object.values(incident.exits).reduce((sum, bucket) => sum + bucket.n, 0), incident.n);
  assert.ok(incident.exits.stop.n <= picked.filter((row) => row.exit === 'stop').length);
  assert.ok(incident.exits['time-stop'].n <= picked.filter((row) => row.exit === 'time-stop').length);
  assert.ok(incident.exits.stop.n > 0);
  assert.ok(incident.exits['time-stop'].n > 0);
});

test('a loss-cap halt logs a shadow and does not touch the balance, then resumes at $2', async () => {
  let t = 1_000_000_000_000;
  let price = 1;
  const pool = { pool: 'P1', token: 'TK', symbol: 'TEST', dex: 'x', createdAt: t - 3600e3, priceUsd: 1, liq: 300000, fdv: 1e6, pc: { m5: 1, h1: 5, h6: 10, h24: 20 }, tx: { m5: { b: 20, s: 8 }, h1: { b: 100, s: 60, buyers: 95, sellers: 50 } }, vol: { m5: 1e3, h1: 5e4, h24: 1e6 } };
  const src = {
    newPools: async () => [pool], trendingPools: async () => [],
    tokenInfo: async () => ({ holders: 5000, top10: 15, dev: 1, mintAuthority: false, freezeAuthority: false, honeypot: false, social: true }),
    poolTrades: async () => Array.from({ length: 30 }, (_, i) => ({ id: 'x' + i + t, t: t - i * 20000, wallet: 'w' + (i % 7), kind: i % 3 ? 'buy' : 'sell', usd: 50, price, token: 'TK', pool: 'P1' })),
    prices: async (toks) => Object.fromEntries(toks.map((k) => [k, price])),
  };
  const st = newState({ ...S, bank: 1000, lossCapPct: 10, edgeGate: false, impactModel: false, strategySlots: false, fastScan: false }, t);
  startSession(st, t);
  st.closed.push({ pnl: -100, fees: 1, sizeUsd: 50 });
  st.cash = 900;
  st.halted = true;
  st.haltReason = 'loss cap test';
  const cash = st.cash;
  await tick(st, src, t);
  assert.equal(st.open.length, 0);
  assert.equal(st.cash, cash);
  assert.equal(st.repairOpen.length, 1);
  assert.equal(st.repairOpen[0].sizeUsd, 2);
  assert.equal(st.repairOpen[0].allocated, false);
  st.repairOpen = [];
  st.repairClosed = Array.from({ length: 20 }, (_, i) => ({ pnl: 0.05, allocated: false, closedAt: t + i }));
  st.judged = {};
  price = 1;
  t += 61 * 60000;
  await tick(st, src, t);
  assert.equal(st.open.length, 1);
  assert.equal(st.open[0].sizeUsd, 2);
  assert.equal(st.cash, cash - 2);
  assert.equal(lossCapHit(st, st.settings).cap, -100);
});
