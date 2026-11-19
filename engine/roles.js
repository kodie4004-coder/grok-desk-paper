// Paper role pipeline. Thresholds are frozen in EVAL_PROTOCOL.md section v8.
// Nothing here moves money or the edge gate.

import { kalshiTakerFee } from './kalshi.js';

export const COOLDOWN_WINDOWS = 2;
export const WINDOW_MS = 15 * 60 * 1000;
export const RISK_MAX_SPREAD = 0.10;
export const SCALP_TP = 0.03;
export const SCALP_STOP = 0.04;
export const SCALP_TIME_MS = 120000;

export function onCooldown(settledRows, series, closeTime, n = COOLDOWN_WINDOWS) {
  const close = Date.parse(closeTime);
  if (!series || !Number.isFinite(close)) return false;
  const losses = (settledRows || []).filter((row) => row.allocated && row.pnl < 0 && row.series === series && row.closeTime);
  if (!losses.length) return false;
  const last = Math.max(...losses.map((row) => Date.parse(row.closeTime)).filter(Number.isFinite));
  if (!(close > last)) return false;
  const steps = Math.ceil((close - last) / WINDOW_MS);
  return steps >= 1 && steps <= n;
}

export function shouldExit(entry, market, now) {
  if (!entry?.exit || entry.skipped) return null;
  const bid = entry.side === 'no' ? Number(market.noBid) : Number(market.yesBid);
  if (!(bid > 0 && bid < 1)) return null;
  if (entry.exit === 'tp' && bid >= entry.ask + SCALP_TP) return { bid, why: 'take-profit' };
  if (entry.exit === 'stop' && bid <= entry.ask - SCALP_STOP) return { bid, why: 'stop' };
  const opened = Date.parse(entry.openedAt);
  if (entry.exit === 'time' && Number.isFinite(opened) && now - opened >= SCALP_TIME_MS) return { bid, why: 'time-stop' };
  return null;
}

export function settleExit(entry, bid, why, now) {
  if (entry.sizeUsd !== 2) throw new Error('paper size is fixed at $2');
  const contracts = entry.contracts;
  const entryFee = kalshiTakerFee(entry.ask, contracts);
  const exitFee = kalshiTakerFee(bid, contracts);
  const pnl = contracts * bid - contracts * entry.ask - entryFee - exitFee;
  return {
    ...entry,
    exit: why,
    exitPx: bid,
    pnl,
    fees: entryFee + exitFee,
    won: pnl > 0,
    result: 'exit',
    settledAt: new Date(now).toISOString(),
    window: (entry.closeTime || '').slice(0, 10) || new Date(now).toISOString().slice(0, 10),
    paper: true,
    roles: [...(entry.roles || []), { role: 'risk', action: 'exit', reason: `risk: ${why} at bid ${bid}` }],
  };
}

export function reviewRoles({ variant, market, sig, quiet, settledRows, room, feeVeto = null }) {
  const logs = [];
  const close = Date.parse(market?.closeTime);
  const live = !!(market && market.result !== 'yes' && market.result !== 'no' && Number.isFinite(close) && close > 0);
  logs.push({ role: 'scanner', action: live ? 'pass' : 'skip', reason: live ? `scanner: ${market.ticker} is still open` : 'scanner: not a live candidate' });
  if (!live || !sig) {
    if (live) logs.push({ role: 'analyst', action: 'skip', reason: `analyst: ${variant.id} does not match these features` });
    return { logs, take: false, skipped: false, allocated: false };
  }
  logs.push({ role: 'analyst', action: 'score', reason: `analyst: ask ${sig.ask} with ${sig.features.secondsLeft}s left` });
  logs.push({ role: 'brain', action: quiet ? 'shadow' : 'allocate', reason: quiet ? 'brain: $0 shadow. Size is not raised.' : 'brain: $2 paper. Size is not raised.' });
  const spread = sig.features.spread;
  let veto = null;
  if (!(sig.ask > 0 && sig.ask < 1)) veto = 'risk: ask is outside 0 to 1';
  else if (spread != null && spread > RISK_MAX_SPREAD) veto = `risk: spread ${spread} is wider than ${RISK_MAX_SPREAD}`;
  else if (onCooldown(settledRows, market.series, market.closeTime)) veto = `risk: ${market.series} cooldown, next ${COOLDOWN_WINDOWS} windows after a loss`;
  else if (feeVeto) veto = feeVeto;
  else if (!room) veto = 'risk: this snapshot is at its bet cap';
  if (veto) {
    logs.push({ role: 'risk', action: 'veto', reason: veto });
    logs.push({ role: 'executor', action: 'skip', reason: 'executor: no fill' });
    return { logs, take: false, skipped: true, allocated: false, skipReason: veto };
  }
  logs.push({ role: 'risk', action: 'pass', reason: 'risk: no veto' });
  logs.push({ role: 'executor', action: quiet ? 'shadow' : 'fill', reason: `executor: paper ${quiet ? 'shadow' : 'fill'} at ask ${sig.ask}, fee included` });
  return { logs, take: true, skipped: false, allocated: !quiet, skipReason: null };
}
