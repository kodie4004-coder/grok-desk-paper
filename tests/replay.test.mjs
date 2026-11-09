import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createReplaySource } from '../engine/data.js';
import { tick, endSession } from '../engine/engine.js';

test('recorded tape still replays to the same paper recap', async () => {
  const tape = JSON.parse(gunzipSync(fs.readFileSync('replay/tape.json.gz')).toString('utf8'));
  const st = JSON.parse(JSON.stringify(tape.meta.initialState));
  const src = createReplaySource(tape);
  for (const tk of tape.ticks) await tick(st, src, tk.t);
  const rc = endSession(st, tape.ticks.at(-1).t);
  assert.equal(rc.net, 1.76);
  assert.equal(rc.trades, 7);
  assert.equal(rc.wins, 3);
  assert.equal(rc.equity, 501.78);
  assert.equal(rc.fees, 1.78);
});
