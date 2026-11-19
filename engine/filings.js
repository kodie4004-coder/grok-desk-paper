// 13F copy rules from EVAL_PROTOCOL.md section v6. Entry is the filing date, not the quarter.

const SUFFIX = /\b(INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|LTD|LIMITED|PLC|SA|AG|NV|LP|LLC)\b/g;

export function normName(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(SUFFIX, ' ').replace(/\s+/g, ' ').trim();
}

export function matchTicker(issuer, tickers) {
  const key = normName(issuer);
  if (!key) return null;
  const hits = tickers.filter((t) => normName(t.title) === key);
  if (hits.length !== 1) return null;
  return hits[0].ticker;
}

export function stockPnl(entry, exit, sizeUsd = 100) {
  if (!(entry > 0) || !(exit > 0)) return null;
  const bps = 0.0005;
  const buy = entry * (1 + bps);
  const sell = exit * (1 - bps);
  const qty = sizeUsd / buy;
  const pnl = qty * sell - sizeUsd;
  const gross = sizeUsd * (exit / entry - 1);
  return { pnl, fees: gross - pnl };
}

export function filingLagOk(reportDate, filingDate) {
  const r = Date.parse(reportDate);
  const f = Date.parse(filingDate);
  return Number.isFinite(r) && Number.isFinite(f) && f > r;
}
