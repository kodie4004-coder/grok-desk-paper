// Paper history schema. Version 2 adds the arena book and XP. Nothing here is real money.

export const SCHEMA = 2;

/** @param {object} state */
export function migrate(state) {
  if (!state || typeof state !== 'object') return state;
  const from = state.schema || 1;
  if (from < 2) {
    state.arenaOpen ||= [];
    state.arenaClosed ||= [];
    state.picksOpen ||= [];
    state.picksClosed ||= [];
    state.arenaLog ||= [];
    state.game ||= { xp: 0, days: {} };
    state.schema = 2;
  }
  return state;
}

/** @param {object} state */
export function exportHistory(state) {
  return {
    schema: SCHEMA,
    paper: true,
    exportedAt: new Date().toISOString(),
    note: 'Paper history only. Not real money.',
    arenaClosed: state.arenaClosed || [],
    picksClosed: state.picksClosed || [],
    closed: state.closed || [],
    game: state.game || { xp: 0, days: {} },
  };
}

/** @param {object[]} rows */
export function historyCsv(rows) {
  const header = ['book', 'rule', 'title', 'side', 'sizeUsd', 'pnl', 'fees', 'closedAt'];
  const lines = [header.join(',')];
  for (const row of rows || []) {
    lines.push(header.map((k) => {
      const v = row[k] == null ? '' : String(row[k]);
      return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    }).join(','));
  }
  return lines.join('\n');
}

/** @param {object} state @param {object} doc */
export function importHistory(state, doc) {
  if (!doc || doc.paper !== true || !Array.isArray(doc.arenaClosed) && !Array.isArray(doc.closed)) {
    throw new Error('This file is not a paper export.');
  }
  if (Array.isArray(doc.arenaClosed)) state.arenaClosed = doc.arenaClosed;
  if (Array.isArray(doc.picksClosed)) state.picksClosed = doc.picksClosed;
  if (Array.isArray(doc.closed)) state.closed = doc.closed;
  if (doc.game) state.game = doc.game;
  return migrate(state);
}
