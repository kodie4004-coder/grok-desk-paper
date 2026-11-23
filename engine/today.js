// Today's Home header numbers. Reads settled paper rows only. Does not change
// weights, the edge gate, fees, or live_execution.
import { isQuoteError, quoteErrorCount } from './quote-guard.js';
import { isEarlyBook, repairGate, sleeveBenched, REPAIR_MIN_N, REPAIR_SIZE_USD } from './repair.js';

export const STALE_MS = 20 * 60 * 1000;
export const OLD_MS = 60 * 60 * 1000;

const round2 = (x) => Math.round(x * 100) / 100;

export function dayKey(value) {
  const t = typeof value === 'number' ? value : Date.parse(value || '');
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

export function ageLabel(ageMs) {
  if (!Number.isFinite(ageMs) || ageMs < 0) return 'no update time';
  const sec = Math.floor(ageMs / 1000);
  if (sec < 60) return 'updated just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `updated ${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) {
    const rem = min % 60;
    const hours = hr === 1 ? '1 hr' : `${hr} hr`;
    return rem ? `updated ${hours} ${rem} min ago` : `updated ${hours} ago`;
  }
  const days = Math.floor(hr / 24);
  return days === 1 ? 'updated 1 day ago' : `updated ${days} days ago`;
}

export function feedAge(fetchedAt, now) {
  const t = typeof fetchedAt === 'number' ? fetchedAt : Date.parse(fetchedAt || '');
  if (!Number.isFinite(t)) {
    return { at: null, ageMs: null, stale: true, tone: 'old', label: 'no update time' };
  }
  const ageMs = Math.max(0, (Number.isFinite(now) ? now : Date.now()) - t);
  const stale = ageMs >= STALE_MS;
  const tone = ageMs >= OLD_MS ? 'old' : stale ? 'stale' : 'fresh';
  return { at: new Date(t).toISOString(), ageMs, stale, tone, label: ageLabel(ageMs) };
}

function settledOn(row, day) {
  if (!row || row.pnl == null || !Number.isFinite(row.pnl)) return false;
  if (isQuoteError(row)) return false;
  return String(row.settledAt || row.window || row.closedAt || '').slice(0, 10) === day;
}

// PR #27 book split: allocated safety (and other allocated paper) vs the
// shadow and early log. Early-entry rows never count as allocated.
export function isAllocatedRow(row) {
  return !!(row && row.allocated !== false && !isEarlyBook(row.variant));
}

export function isShadowRow(row) {
  return !!(row && (row.allocated === false || isEarlyBook(row.variant)));
}

function bookStats(rows) {
  const list = rows || [];
  const pnl = list.reduce((sum, row) => sum + row.pnl, 0);
  const fees = list.reduce((sum, row) => sum + (row.fees || row.fee || 0), 0);
  return { n: list.length, pnl: round2(pnl), fees: round2(fees) };
}

export function todayBooks(rows, day) {
  const list = (rows || []).filter((row) => settledOn(row, day));
  return {
    day,
    allocated: bookStats(list.filter(isAllocatedRow)),
    shadow: bookStats(list.filter(isShadowRow)),
  };
}

// Safety-sleeve shadows only. Early-entry and early-exit are a different book.
export function repairProgress(memeRows) {
  const rows = memeRows || [];
  const shadows = rows.filter((row) => row && row.pnl != null && row.allocated === false && !isEarlyBook(row.variant));
  const gate = repairGate(shadows);
  const bench = sleeveBenched(rows);
  const quarantined = quoteErrorCount(rows.filter((row) => row && row.pnl != null && !isEarlyBook(row.variant)));
  return { ...gate, benched: bench.benched, sizeUsd: REPAIR_SIZE_USD, need: REPAIR_MIN_N, quarantined };
}

export function todayDoc({ kalshiRows = [], memeRows = [], kalshiFetchedAt = null, memeFetchedAt = null, now } = {}) {
  const t = Number.isFinite(now) ? now : Date.now();
  const day = dayKey(t);
  const books = todayBooks([].concat(kalshiRows || [], memeRows || []), day);
  const repair = repairProgress(memeRows);
  return {
    paper: true,
    liveExecution: false,
    day,
    generatedAt: new Date(t).toISOString(),
    kalshiFetchedAt: kalshiFetchedAt || null,
    memeFetchedAt: memeFetchedAt || null,
    allocated: books.allocated,
    shadow: books.shadow,
    repair,
    feeds: {
      kalshi: feedAge(kalshiFetchedAt, t),
      meme: feedAge(memeFetchedAt, t),
    },
  };
}
