// Scalper math from EVAL_PROTOCOL.md section v6. Costs were fixed before the run.
import { kalshiTakerFee } from './kalshi.js';

export const TAKER_PCT = 0.90;
export const SPREAD_BPS = 1;

export function cryptoFill(price, side) {
  const fee = TAKER_PCT / 100;
  const spr = SPREAD_BPS / 10000;
  if (!(price > 0)) return null;
  return side === 'buy' ? price * (1 + fee + spr) : price * (1 - fee - spr);
}

export function cryptoPnl(entry, exit, sizeUsd) {
  const buy = cryptoFill(entry, 'buy');
  const sell = cryptoFill(exit, 'sell');
  if (!(buy > 0) || !(sell > 0)) return null;
  const qty = sizeUsd / buy;
  const pnl = qty * sell - sizeUsd;
  const gross = sizeUsd * (exit / entry - 1);
  return { pnl, fees: gross - pnl, entry: buy, exit: sell };
}

function vwap(bars, i) {
  const from = bars[i].t - 30 * 60 * 1000;
  let pv = 0, vol = 0;
  for (let k = i; k >= 0 && bars[k].t >= from; k--) {
    const tp = (bars[k].h + bars[k].l + bars[k].c) / 3;
    const v = bars[k].v || 0;
    pv += tp * v;
    vol += v;
  }
  return vol > 0 ? pv / vol : null;
}

export function microSignal(bars, i) {
  if (i < 3) return false;
  for (let k = 0; k < 3; k++) if (!(bars[i - k].c >= bars[i - k - 1].c)) return false;
  const ret = bars[i].c / bars[i - 3].c - 1;
  return ret >= 0.002 && ret <= 0.01;
}

export function vwapSignal(bars, i) {
  const w = vwap(bars, i);
  if (!(w > 0) || !(bars[i].c > 0)) return false;
  const gap = w / bars[i].c - 1;
  return gap >= 0.003 && gap >= 0.004 && gap <= 0.015 ? w : false;
}

function walk(bars, i, entry, { stopPct, takePct, holdMin, target }) {
  const stop = entry * (1 - stopPct);
  const tp = target != null ? target : entry * (1 + takePct);
  const deadline = bars[i].t + holdMin * 60 * 1000;
  for (let k = i; k < bars.length; k++) {
    const b = bars[k];
    if (b.t > deadline) return { exit: bars[k - 1]?.c, kind: 'time', index: k - 1 };
    if (b.l <= stop) return { exit: Math.min(stop, b.l), kind: 'stop', index: k };
    if (b.h >= tp) return { exit: tp, kind: 'tp', index: k };
    if (k === bars.length - 1 || bars[k + 1].t > deadline) return { exit: b.c, kind: 'time', index: k };
  }
  return null;
}

export function runMicro(bars, sizeUsd = 2) {
  const out = [];
  let next = 0;
  for (let i = 3; i < bars.length - 1; i++) {
    if (bars[i].t < next || !microSignal(bars, i)) continue;
    const entryIdx = i + 1;
    const entry = bars[entryIdx].o;
    const hit = walk(bars, entryIdx, entry, { stopPct: 0.003, takePct: 0.0045, holdMin: 5 });
    if (!hit || !(hit.exit > 0)) continue;
    const deal = cryptoPnl(entry, hit.exit, sizeUsd);
    if (!deal) continue;
    out.push({ t: bars[entryIdx].t, pnl: deal.pnl, fees: deal.fees, kind: hit.kind, pool: 'crypto' });
    next = bars[hit.index].t + 5 * 60 * 1000;
    i = hit.index;
  }
  return out;
}

export function runVwap(bars, sizeUsd = 2) {
  const out = [];
  let next = 0;
  for (let i = 30; i < bars.length - 1; i++) {
    if (bars[i].t < next) continue;
    const w = vwapSignal(bars, i);
    if (!w) continue;
    const entryIdx = i + 1;
    const entry = bars[entryIdx].o;
    const hit = walk(bars, entryIdx, entry, { stopPct: 0.005, takePct: 0, holdMin: 15, target: w });
    if (!hit || !(hit.exit > 0)) continue;
    const deal = cryptoPnl(entry, hit.exit, sizeUsd);
    if (!deal) continue;
    out.push({ t: bars[entryIdx].t, pnl: deal.pnl, fees: deal.fees, kind: hit.kind, pool: 'crypto' });
    next = bars[hit.index].t + 5 * 60 * 1000;
    i = hit.index;
  }
  return out;
}

export function blockOf(t, hours) {
  const ms = hours * 3600000;
  return new Date(Math.floor(t / ms) * ms).toISOString().slice(0, 13);
}

function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function kalshiDeal(entry, exitBid, sizeUsd) {
  if (!(entry > 0 && entry < 1) || !(exitBid > 0 && exitBid < 1)) return null;
  const contracts = Math.floor(sizeUsd / entry);
  if (contracts < 1) return null;
  const fees = kalshiTakerFee(entry, contracts) + kalshiTakerFee(exitBid, contracts);
  const pnl = contracts * exitBid - contracts * entry - fees;
  return { contracts, fees, pnl };
}

export function runKalshiScalp(candles, closeMs, sizeUsd = 2) {
  const rows = [...(candles || [])].sort((a, b) => a.end_period_ts - b.end_period_ts);
  const asks = rows.map((c) => num(c.yes_ask?.close_dollars));
  const bids = rows.map((c) => num(c.yes_bid?.close_dollars));
  for (let i = 2; i < rows.length; i++) {
    const t = rows[i].end_period_ts * 1000;
    if (closeMs - t < 2 * 60 * 1000) break;
    const ask = asks[i], prev = asks[i - 2], bid = bids[i];
    if (!(ask > 0) || !(prev > 0) || !(bid >= 0)) continue;
    if (ask - prev < 0.04 || ask - bid > 0.03) continue;
    let exit = null;
    for (let k = i + 1; k < rows.length; k++) {
      const tk = rows[k].end_period_ts * 1000;
      const b = bids[k];
      if (!(b > 0 && b < 1)) continue;
      if (closeMs - tk <= 2 * 60 * 1000) { exit = b; break; }
      if (b <= ask - 0.04 || b >= ask + 0.03) { exit = b; break; }
    }
    const deal = kalshiDeal(ask, exit, sizeUsd);
    return deal ? [{ t, pnl: deal.pnl, fees: deal.fees, pool: 'kalshi' }] : [];
  }
  return [];
}

export function runMaker(candles, closeMs, sizeUsd = 2) {
  const rows = [...(candles || [])].sort((a, b) => a.end_period_ts - b.end_period_ts);
  const target = closeMs - 8 * 60 * 1000;
  const lo = closeMs - 10 * 60 * 1000;
  const hi = closeMs - 6 * 60 * 1000;
  let best = -1, dist = Infinity;
  for (let i = 0; i < rows.length - 1; i++) {
    const t = rows[i].end_period_ts * 1000;
    if (t < lo || t > hi) continue;
    const d = Math.abs(t - target);
    if (d < dist) { dist = d; best = i; }
  }
  if (best < 0) return [];
  const bid = num(rows[best].yes_bid?.close_dollars);
  const low = num(rows[best + 1].price?.low_dollars);
  const exitBid = num(rows[best + 1].yes_bid?.close_dollars);
  if (!(bid > 0 && bid < 1) || !(low > 0) || !(low <= bid)) return [];
  const deal = kalshiDeal(bid, exitBid, sizeUsd);
  if (!deal) return [];
  deal.fees = kalshiTakerFee(exitBid, deal.contracts);
  deal.pnl = deal.contracts * exitBid - deal.contracts * bid - deal.fees;
  return [{ t: rows[best].end_period_ts * 1000, pnl: deal.pnl, fees: deal.fees, pool: 'kalshi' }];
}
