// Headless paper runner: same engine as the app, runs on any machine with Node 18+.
// Usage: node runner/headless.mjs --minutes 45 --out runner/state.json --tape replay/tape.json
// PAPER ONLY. No wallet, key or order code exists in this project.
import fs from 'node:fs';
import { DEFAULT_SETTINGS } from '../engine/core.js';
import { createLiveSource, createRecorder } from '../engine/data.js';
import { newState, startSession, tick, mark, endSession, serialize, recap } from '../engine/engine.js';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const minutes = +arg('minutes', 30), out = arg('out', 'runner/state.json'), tapePath = arg('tape', '');
const settings = { ...DEFAULT_SETTINGS, ...(arg('settings') ? JSON.parse(fs.readFileSync(arg('settings'), 'utf8')) : {}) };
const live = createLiveSource();
const src = tapePath ? createRecorder(live) : live;
const state = newState(settings, Date.now());
if (fs.existsSync(out)) {
  try {
    const prev = JSON.parse(fs.readFileSync(out, 'utf8'));
    const book = prev.edgeBook?.length ? prev.edgeBook : (prev.closed || []);
    state.edgeBook = book.slice(-500);
  } catch { /* a fresh file is fine */ }
}
startSession(state, Date.now());
const initial = JSON.parse(serialize(state));
const end = Date.now() + minutes * 60000;
const emit = (e) => console.log(new Date().toISOString(), e.type.toUpperCase(), e.text);
const save = () => {
  fs.writeFileSync(out, serialize(state));
  if (tapePath) fs.writeFileSync(tapePath, JSON.stringify({ ...src.tape, meta: { ...src.tape.meta, settings, initialState: initial, minutes } }));
};
while (Date.now() < end) {
  const t0 = Date.now();
  await tick(state, src, t0, emit);
  const r = recap(state, Date.now());
  console.log(new Date().toISOString(), `tick ${state.tick} · open ${state.open.length} · closed ${r.trades} · equity $${r.equity} · judged ${state.counts.judged} · followed ${state.followed.length} · errors ${state.errors}`);
  save();
  const tickDeadline = t0 + settings.tickSec * 1000;
  while (Date.now() < tickDeadline && Date.now() < end) {
    const slice = Math.min(settings.markSec > 0 ? settings.markSec * 1000 : tickDeadline - Date.now(), tickDeadline - Date.now(), end - Date.now());
    if (slice > 0) await new Promise((res) => setTimeout(res, slice));
    if (Date.now() + 25 >= tickDeadline || Date.now() >= end) break;
    if (settings.markSec > 0 && state.open.length) {
      await mark(state, src, Date.now(), emit);
      save();
    }
  }
}
console.log('RECAP', JSON.stringify(endSession(state, Date.now())));
save();
