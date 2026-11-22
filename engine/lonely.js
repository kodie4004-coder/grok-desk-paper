// Moon Dev "lonely fill" filter on the coin books. Paper only.
// A coin entry counts as lonely when no other coin book entry opened in the
// five minutes before it. The filter does not change meme-safety or early-entry
// sizing. It writes a $0-risk shadow journal row that copies the parent's fill
// when the parent settles, so it is not a second $2 line.
// Rules were written down before this book was scored.

export const LONELY_ID = 'lonely-entry';
export const LONELY_ADDED_AT = '2026-11-22T08:45:00.000Z';
export const LONELY_GAP_MS = 5 * 60 * 1000;
export const LONELY_SOURCES = Object.freeze(['meme-safety', 'early-entry']);

export function isEntryRow(row) {
  return !!row && LONELY_SOURCES.includes(row.variant) && row.skipped !== true && row.openedAt;
}

export function isLonely(at, rows, gap = LONELY_GAP_MS) {
  const t = typeof at === 'number' ? at : Date.parse(at || '');
  if (!Number.isFinite(t)) return false;
  for (const row of rows || []) {
    if (!isEntryRow(row)) continue;
    const opened = Date.parse(row.openedAt);
    if (!Number.isFinite(opened)) continue;
    if (opened < t && t - opened < gap) return false;
  }
  return true;
}

export function stampLonely(pos, rows, now) {
  const at = Date.parse(pos?.openedAt || '') || now;
  return { ...pos, lonelyEligible: isLonely(at, rows) };
}

export function lonelyFrom(row) {
  if (!row?.lonelyEligible || !Number.isFinite(row.pnl) || row.skipped === true) return null;
  if (row.variant === LONELY_ID) return null;
  return {
    ...row,
    id: `${LONELY_ID}:${row.id || row.ca}`,
    variant: LONELY_ID,
    family: 'meme',
    allocated: false,
    shadow: true,
    sourceVariant: row.variant,
    paper: true,
    open: false,
  };
}

export function emitLonely(rows, known = new Set()) {
  const out = [];
  const have = new Set(known);
  for (const row of rows || []) {
    const shadow = lonelyFrom(row);
    if (!shadow || have.has(shadow.id)) continue;
    out.push(shadow);
    have.add(shadow.id);
  }
  return out;
}

// Historical scoring book: settled meme-safety and early-entry rows that would
// have passed the filter, in openedAt order. The crowding clock is every earlier
// source entry, including ones the filter itself drops.
export function lonelyBook(rows) {
  const sorted = [...(rows || [])].filter(isEntryRow)
    .sort((a, b) => String(a.openedAt).localeCompare(String(b.openedAt)) || String(a.id || '').localeCompare(String(b.id || '')));
  const out = [];
  for (let i = 0; i < sorted.length; i += 1) {
    const row = sorted[i];
    if (!Number.isFinite(row.pnl)) continue;
    const at = Date.parse(row.openedAt);
    if (!isLonely(at, sorted.slice(0, i))) continue;
    const shadow = lonelyFrom({ ...row, lonelyEligible: true });
    if (shadow) out.push(shadow);
  }
  return out;
}
