// Replays replay/tape.json through the engine in Node and prints the recap.
// Must match the recorded session's own recap (proves replay = same engine, same data).
import fs from 'node:fs';
import { createReplaySource } from '../engine/data.js';
import { tick, endSession } from '../engine/engine.js';
const file = process.argv[2] || 'replay/tape.json.gz';
const raw = fs.readFileSync(file);
const tape = JSON.parse((file.endsWith('.gz') ? (await import('node:zlib')).gunzipSync(raw) : raw).toString('utf8'));
const st = JSON.parse(JSON.stringify(tape.meta.initialState));
const src = createReplaySource(tape);
for (const t of tape.ticks) await tick(st, src, t.t);
console.log(JSON.stringify(endSession(st, tape.ticks.at(-1).t)));
