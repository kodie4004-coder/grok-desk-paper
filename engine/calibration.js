// Model vs market: a calibration audit for challengers that write a model
// probability (pEst) on each paper line. Paper only. Read-only: this does not
// move any weight, size, or edge gate. Numbers come from the journal rows.
//
// For each bot: settled paper rows on or after the bot's addedAt, with a
// finite pEst, a finite ask, a yes/no result, and a finite after-fee pnl.
// Brier(model) = mean((pEst - won)^2). Brier(market) = mean((ask - won)^2),
// where the ask paid is the price Kalshi put on the side the bot bought.
// Lower is better. A model that is less accurate than the ask it pays has no
// edge to sell, whatever its own edge estimate says.

export const CALIBRATION_SMALL_N = 30;
export const CALIBRATION_SMALL_WINDOWS = 10;

function finite(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

export function calibrationRows(rows, id, addedAt) {
  const since = Date.parse(addedAt || '');
  return (rows || []).filter((row) => {
    if (!row || row.variant !== id) return false;
    if (row.paper === false || row.skipped === true) return false;
    if (typeof row.won !== 'boolean' || !finite(row.pnl)) return false;
    if (!finite(row.pEst) || row.pEst < 0 || row.pEst > 1) return false;
    if (!finite(row.ask) || !(row.ask > 0 && row.ask < 1)) return false;
    if (!row.settledAt) return false;
    if (Number.isFinite(since)) {
      const opened = Date.parse(row.openedAt || '');
      if (!Number.isFinite(opened) || opened < since) return false;
    }
    return true;
  });
}

const r3 = (n) => Math.round(n * 1000) / 1000;
const r2 = (n) => Math.round(n * 100) / 100;

function usd(n) {
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

export function calibrationLine(stat) {
  const { id, n, wins, sumAsk, sumPEst, brierModel, brierMarket, mean, small } = stat;
  const bm = brierModel.toFixed(3);
  const bk = brierMarket.toFixed(3);
  let verdict;
  if (bm === bk) verdict = `${id}'s prices were about as accurate as Kalshi's own (Brier ${bm} vs ${bk})`;
  else if (brierModel < brierMarket) verdict = `${id}'s prices were more accurate than Kalshi's own (Brier ${bm} vs ${bk})`;
  else verdict = `${id}'s prices were less accurate than Kalshi's own (Brier ${bm} vs ${bk})`;
  const expect = `It expected ${sumPEst.toFixed(1)} wins, Kalshi's asks implied ${sumAsk.toFixed(1)}, and it won ${wins} of ${n}`;
  const money = `Mean ${usd(mean)} per $2 line after fees`;
  return `${verdict}. ${expect}. ${money}.${small ? ' Small sample.' : ''} Lower Brier is better.`;
}

// addedAt: { [variantId]: ISO time }. Bots without an addedAt use every row.
export function modelCalibration(rows, addedAt = {}) {
  const ids = [...new Set((rows || []).filter((row) => row && finite(row.pEst) && row.variant).map((row) => row.variant))].sort();
  const out = [];
  for (const id of ids) {
    const mine = calibrationRows(rows, id, addedAt[id]);
    if (!mine.length) continue;
    const n = mine.length;
    const wins = mine.filter((row) => row.won).length;
    const sumAsk = mine.reduce((s, row) => s + row.ask, 0);
    const sumPEst = mine.reduce((s, row) => s + row.pEst, 0);
    const brierModel = mine.reduce((s, row) => s + (row.pEst - (row.won ? 1 : 0)) ** 2, 0) / n;
    const brierMarket = mine.reduce((s, row) => s + (row.ask - (row.won ? 1 : 0)) ** 2, 0) / n;
    const net = mine.reduce((s, row) => s + row.pnl, 0);
    const windows = new Set(mine.map((row) => row.closeTime || row.ticker)).size;
    const stat = {
      id,
      addedAt: addedAt[id] || null,
      n,
      windows,
      wins,
      sumAsk: r2(sumAsk),
      sumPEst: r2(sumPEst),
      brierModel: r3(brierModel),
      brierMarket: r3(brierMarket),
      beatsMarket: brierModel < brierMarket,
      net: r2(net),
      mean: r2(net / n),
      small: n < CALIBRATION_SMALL_N || windows < CALIBRATION_SMALL_WINDOWS,
    };
    stat.text = calibrationLine({ ...stat, sumAsk, sumPEst, mean: net / n });
    out.push(stat);
  }
  return out;
}

// Pick the fresher Model vs market audit. lessons.json is rebuilt once a day;
// today.json is rebuilt on every snapshot. Read-only: nothing here moves a
// weight, a size, or the edge gate.
export function freshCalibration(lessons, today) {
  const nightly = Array.isArray(lessons?.calibration) ? lessons.calibration : null;
  const live = Array.isArray(today?.calibration) ? today.calibration : null;
  const nightlyAt = Date.parse(lessons?.generatedAt || '');
  const liveAt = Date.parse(today?.calibrationAt || '');
  if (live && (!nightly || !Number.isFinite(nightlyAt) || (Number.isFinite(liveAt) && liveAt >= nightlyAt))) {
    return { rows: live, at: Number.isFinite(liveAt) ? today.calibrationAt : null, source: 'snapshot' };
  }
  if (nightly) return { rows: nightly, at: Number.isFinite(nightlyAt) ? lessons.generatedAt : null, source: 'nightly' };
  return { rows: null, at: null, source: null };
}
