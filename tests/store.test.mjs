import test from 'node:test';
import assert from 'node:assert/strict';
import { migrate, exportHistory, importHistory, historyCsv, SCHEMA } from '../engine/store.js';

test('schema 1 state gains an arena book without dropping the coin book', () => {
  const st = migrate({ schema: 1, closed: [{ pnl: 1 }], cash: 500 });
  assert.equal(st.schema, SCHEMA);
  assert.deepEqual(st.closed, [{ pnl: 1 }]);
  assert.deepEqual(st.arenaClosed, []);
  assert.equal(st.game.xp, 0);
});

test('export and import round-trip paper history and reject a real-looking file', () => {
  const doc = exportHistory({ arenaClosed: [{ rule: 'mom', title: 'BTC', side: 'yes', sizeUsd: 2, pnl: -0.1, fees: 0.02, closedAt: 1 }], picksClosed: [], closed: [], game: { xp: 5, days: {} } });
  assert.equal(doc.paper, true);
  const csv = historyCsv(doc.arenaClosed.map((r) => ({ book: 'arena', ...r })));
  assert.match(csv, /mom/);
  const next = importHistory({}, doc);
  assert.equal(next.arenaClosed[0].sizeUsd, 2);
  assert.throws(() => importHistory({}, { paper: false }), /paper export/);
});
