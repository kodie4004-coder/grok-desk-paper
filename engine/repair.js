// Repair mode. The loss cap stays where it is. A losing sleeve goes to shadow
// at the same small size. Shadow P&L is not written into the live balance.
// Nothing here raises size, resets the bank, or loosens the edge gate.

export const REPAIR_MIN_N = 20;
export const REPAIR_SIZE_USD = 2;
export const CHASE_COOLDOWN_MS = 60 * 60 * 1000;
export const BENCH_MIN_N = 20;

const usd = (x) => {
  if (x == null || !Number.isFinite(x)) return '—';
  const n = Math.round(x * 100) / 100;
  const sign = n > 0 ? '+' : n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toFixed(2)}`;
};

const pct = (x) => (x == null || !Number.isFinite(x) ? '—' : `${x > 0 ? '+' : ''}${x.toFixed(1)}%`);

export function isEarlyBook(variant) {
  const name = String(variant || '');
  return name === 'early-entry' || name === 'early-track' || name.startsWith('early-exit');
}

function earlyBook(variant) {
  return isEarlyBook(variant);
}

export function sleeveBenched(rows) {
  const list = rows || [];
  const live = list.filter((row) => row && row.pnl != null && row.allocated !== false);
  const shadows = list.filter((row) => row && row.pnl != null && row.allocated === false && !earlyBook(row.variant));
  const n = live.length;
  const mean = n ? live.reduce((sum, row) => sum + row.pnl, 0) / n : null;
  const shadowMean = shadows.length ? shadows.reduce((sum, row) => sum + row.pnl, 0) / shadows.length : null;
  const repairPass = shadows.length >= REPAIR_MIN_N && shadowMean > 0;
  const losing = n >= BENCH_MIN_N && !(mean > 0);
  // A sleeve already logging shadow trades stays there until the repair gate
  // passes. Dropping those rows out of the count must not turn allocation back on.
  // Early-entry shadows are a different book and do not bench this sleeve.
  const held = shadows.length > 0 && !repairPass;
  return { benched: losing || held, n, mean, held };
}

export function chaseBlocked(rows, ca, nowMs, coolMs = CHASE_COOLDOWN_MS) {
  if (!ca || !Number.isFinite(nowMs)) return false;
  return (rows || []).some((row) => {
    if (row.ca !== ca || row.exit !== 'stop' || !row.settledAt) return false;
    const t = Date.parse(row.settledAt);
    if (!Number.isFinite(t)) return false;
    const gap = nowMs - t;
    return gap >= 0 && gap < coolMs;
  });
}

// Shadow rows only. Pass does not change the loss cap or the size.
export function repairGate(rows) {
  const list = (rows || []).filter((row) => row && row.pnl != null);
  const n = list.length;
  const mean = n ? list.reduce((sum, row) => sum + row.pnl, 0) / n : null;
  const wins = list.filter((row) => row.pnl > 0).length;
  return {
    pass: n >= REPAIR_MIN_N && mean > 0,
    n,
    need: REPAIR_MIN_N,
    mean,
    wins,
    sizeUsd: REPAIR_SIZE_USD,
  };
}

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export function tradeWindow(rows) {
  const list = rows || [];
  const n = list.length;
  const wins = list.filter((row) => row.pnl > 0).length;
  const pnl = list.reduce((sum, row) => sum + (row.pnl || 0), 0);
  const fees = list.reduce((sum, row) => sum + (row.fees || row.fee || 0), 0);
  const exits = {};
  for (const row of list) {
    const key = row.exit || row.exitReason || 'other';
    const bucket = exits[key] || (exits[key] = { n: 0, wins: 0, pnl: 0, fees: 0, holds: [], moves: [] });
    bucket.n += 1;
    if (row.pnl > 0) bucket.wins += 1;
    bucket.pnl += row.pnl || 0;
    bucket.fees += row.fees || row.fee || 0;
    const hold = (Date.parse(row.settledAt || row.closedAt) - Date.parse(row.openedAt)) / 60000;
    if (Number.isFinite(hold)) bucket.holds.push(hold);
    if (row.entry > 0 && row.exitPx > 0) bucket.moves.push((row.exitPx / row.entry - 1) * 100);
  }
  for (const bucket of Object.values(exits)) {
    bucket.medianHoldMin = median(bucket.holds);
    bucket.medianMovePct = median(bucket.moves);
    delete bucket.holds;
    delete bucket.moves;
  }
  const stops = list.filter((row) => row.exit === 'stop' && row.entry > 0 && row.exitPx > 0).map((row) => ({
    symbol: row.symbol,
    movePct: (row.exitPx / row.entry - 1) * 100,
    holdMin: (Date.parse(row.settledAt) - Date.parse(row.openedAt)) / 60000,
    pnl: row.pnl,
  }));
  let chaseN = 0;
  let chasePnl = 0;
  let feeKilled = 0;
  let feeKilledPnl = 0;
  for (let i = 0; i < list.length; i++) {
    const row = list[i];
    const prev = list.slice(0, i).reverse().find((item) => item.ca === row.ca && item.exit === 'stop');
    if (prev) {
      const gap = (Date.parse(row.openedAt) - Date.parse(prev.settledAt)) / 60000;
      if (gap >= 0 && gap < CHASE_COOLDOWN_MS / 60000) {
        chaseN += 1;
        chasePnl += row.pnl || 0;
      }
    }
    if (row.entry > 0 && row.exitPx > 0 && row.sizeUsd > 0) {
      const gross = row.sizeUsd * (row.exitPx / row.entry - 1);
      if (gross > 0 && row.pnl <= 0) {
        feeKilled += 1;
        feeKilledPnl += row.pnl || 0;
      }
    }
  }
  return {
    n,
    wins,
    losses: n - wins,
    winRate: n ? wins / n : 0,
    pnl,
    fees,
    mean: n ? pnl / n : null,
    exits,
    stops,
    chase: { n: chaseN, pnl: chasePnl },
    feeKilled: { n: feeKilled, pnl: feeKilledPnl },
  };
}

function keptByCooldown(rows) {
  const kept = [];
  for (const row of rows) {
    const prior = rows.filter((item) => Date.parse(item.settledAt || item.closedAt) <= Date.parse(row.openedAt));
    if (chaseBlocked(prior, row.ca, Date.parse(row.openedAt))) continue;
    kept.push(row);
  }
  return kept;
}

function latestIncident(sorted) {
  if (sorted.length < 34) return { rows: sorted.slice(), index: 0, exact: false };
  for (let i = sorted.length - 34; i >= 0; i--) {
    const slice = sorted.slice(i, i + 34);
    const wins = slice.filter((row) => row.pnl > 0).length;
    if (wins === 7) return { rows: slice, index: i, exact: true };
  }
  return { rows: sorted.slice(-34), index: Math.max(0, sorted.length - 34), exact: false };
}

export function diagnoseMeme(rows) {
  // Early-entry and its exit shadows are a different book. They do not fill
  // the safety sleeve's repair bar or the incident window.
  const sorted = [...(rows || [])].filter((row) => row && row.pnl != null && !isEarlyBook(row.variant)).sort((a, b) => Date.parse(a.openedAt) - Date.parse(b.openedAt));
  const incidentPick = latestIncident(sorted);
  const incidentRows = incidentPick.rows;
  const trainRows = sorted.slice(0, incidentPick.index);
  const laterRows = sorted.slice(incidentPick.index + incidentRows.length);
  const incident = tradeWindow(incidentRows);
  const train = tradeWindow(trainRows);
  const later = tradeWindow(laterRows);
  const after = {
    train: tradeWindow(keptByCooldown(trainRows)),
    holdout: tradeWindow(keptByCooldown(incidentRows)),
    later: tradeWindow(keptByCooldown(laterRows)),
  };
  const bench = sleeveBenched(trainRows);
  const shadows = sorted.filter((row) => row.allocated === false);
  const repair = repairGate(shadows);
  const timer = incident.exits['time-stop'] || { n: 0, wins: 0, pnl: 0, fees: 0, medianMovePct: null };
  const stop = incident.exits.stop || { n: 0, wins: 0, pnl: 0 };
  const stopMoves = incident.stops.map((item) => pct(item.movePct)).join(', ');
  const findings = [
    `${timer.n > incident.n / 2 ? 'Most of these exits are the 30-minute timer.' : 'The 30-minute timer is not the majority of these exits.'} ${timer.n} of ${incident.n} closed that way, net ${usd(timer.pnl)} after ${usd(timer.fees).replace('+', '')} of fees. The median price change on those exits was ${pct(timer.medianMovePct)}. ${incident.feeKilled.n} trades were up before fees and down after them.`,
    `Stops are not the tight ones. ${stop.n} trades hit the -15% stop and all of them lost, net ${usd(stop.pnl)}. The fills were ${stopMoves || 'none'}. The price moved past the stop between checks.`,
    `Entries chase the same coin after a stop. ${incident.chase.n} re-entries inside an hour netted ${usd(incident.chase.pnl)}. The window is ${incident.wins} wins and ${incident.losses} losses, mean ${usd(incident.mean)} on a $${REPAIR_SIZE_USD} bet. That sleeve is benched to shadow until ${REPAIR_MIN_N} shadow trades average above zero. Size stays $${REPAIR_SIZE_USD}.`,
  ];
  return {
    paper: true,
    exactIncident: incidentPick.exact,
    incident,
    train,
    later,
    before: { train, holdout: incident, later },
    after,
    bench,
    repair,
    benched: sleeveBenched(sorted).benched,
    findings,
    note: `The ${incident.n} trades in this window net ${usd(incident.pnl)} after fees on $${REPAIR_SIZE_USD} paper bets. Win rate ${incident.n ? Math.round(incident.winRate * 100) : 0}%.`,
  };
}
