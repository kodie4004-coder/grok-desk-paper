import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  VARIANTS, signal, stepJournal, defaultBrain, reviewBrain, cheapLateSkip, guardReport, lessonsDocument, lessonsMarkdown,
  GUARD_ADDED_AT, GUARD_MAX_ASK, GUARD_MIN_LEFT, GUARD_MAX_LEFT, HOLD_MIN, LEARN_SIZE,
} from '../engine/learn.js';
import { REPAIR_MIN_N } from '../engine/repair.js';
import { guardChallengersHtml } from '../engine/guard-view.js';

const guards = VARIANTS.filter((v) => v.guard === 'cheap-late');
const byId = (id) => VARIANTS.find((v) => v.id === id);
const MIN = 60;

test('three guard shadows copy their parent rules and stay pinned at weight 0', () => {
  assert.deepEqual(guards.map((v) => [v.id, v.parent]), [['scalp-guard', 'scalp'], ['fair-guard', 'fair-spot'], ['maker-guard', 'rest-maker']]);
  for (const g of guards) {
    const parent = byId(g.parent);
    assert.equal(g.role, 'challenger');
    assert.equal(g.pinZero, true);
    assert.equal(g.addedAt, GUARD_ADDED_AT);
    for (const key of ['family', 'kind', 'minJump', 'maxSpread', 'minLeft', 'maxLeft', 'feeMargin', 'exit']) assert.deepEqual(g[key], parent[key], `${g.id} ${key}`);
  }
  assert.equal(GUARD_MAX_ASK, 0.60);
  assert.equal(GUARD_MIN_LEFT, 120);
  assert.equal(GUARD_MAX_LEFT, 600);
  assert.equal(LEARN_SIZE, 2);
  assert.equal(REPAIR_MIN_N, 20);
  // Champion rules are unchanged.
  assert.deepEqual(defaultBrain().champions, { late: 'late', mom: 'mom', revert: 'revert', scalp: 'scalp', flip: 'flip' });
  assert.equal(byId('scalp').guard, undefined);
  assert.equal(byId('fair-spot').guard, undefined);
  assert.equal(byId('rest-maker').guard, undefined);
});

test('guard skip rule: ask 0.59 with 3 min left skipped, 0.61 taken, 0.40 with 12 min left taken', () => {
  assert.equal(cheapLateSkip(0.59, 3 * MIN), true);
  assert.equal(cheapLateSkip(0.61, 3 * MIN), false);
  assert.equal(cheapLateSkip(0.40, 12 * MIN), false);
  assert.equal(cheapLateSkip(0.40, 1 * MIN), false, 'under 2 minutes is outside the lesson');
  assert.equal(cheapLateSkip(0.59, 10 * MIN), true);
  assert.equal(cheapLateSkip(0.60, 3 * MIN), false);
  assert.equal(cheapLateSkip(null, 3 * MIN), false);
});

test('scalp-guard fires exactly when scalp fires, minus cheap-late asks', () => {
  const now = Date.parse('2026-11-27T12:00:00Z');
  const scalp = byId('scalp');
  const guard = byId('scalp-guard');
  const mk = (ask, leftSec) => ({ ticker: 'KXBTC15M-X', series: 'KXBTC15M', yesAsk: ask, yesBid: ask - 0.01, noAsk: 1 - ask + 0.01, closeTime: new Date(now + leftSec * 1000).toISOString() });
  const ctx = (ask) => ({ prev: { yesAsk: ask - 0.05, samples: [] } });
  assert.ok(signal(scalp, mk(0.59, 3 * MIN), now, ctx(0.59)));
  assert.equal(signal(guard, mk(0.59, 3 * MIN), now, ctx(0.59)), null);
  assert.ok(signal(guard, mk(0.61, 3 * MIN), now, ctx(0.61)));
  assert.ok(signal(guard, mk(0.40, 12 * MIN), now, ctx(0.40)));
  // The maker guard uses the resting price, same as the lesson's bucket.
  const maker = byId('maker-guard');
  const m = { ticker: 'KXBTC15M-M', series: 'KXBTC15M', yesAsk: 0.62, yesBid: 0.58, noAsk: 0.42, closeTime: new Date(now + 3 * MIN * 1000).toISOString() };
  assert.ok(signal(byId('rest-maker'), m, now, {}));
  assert.equal(signal(maker, m, now, {}), null);
  assert.ok(signal(maker, { ...m, yesAsk: 0.66, yesBid: 0.62 }, now, {}));
});

test('the journal logs guards as $2 shadow lines, never allocated', () => {
  const now = Date.parse('2026-11-27T12:00:00Z');
  const market = { ticker: 'KXBTC15M-G', series: 'KXBTC15M', title: 'BTC', yesAsk: 0.70, yesBid: 0.69, noAsk: 0.31, noBid: 0.30, closeTime: new Date(now + 4 * MIN * 1000).toISOString(), result: '' };
  const next = stepJournal({ markets: [market], open: [], quotes: { 'KXBTC15M-G': { yesAsk: 0.64, samples: [0.64] } }, brain: defaultBrain(), existingIds: [], settledRows: [], spots: {}, now });
  const row = next.open.find((r) => r.variant === 'scalp-guard');
  assert.ok(row, 'scalp-guard opened a line');
  assert.equal(row.allocated, false);
  assert.equal(row.sizeUsd, 2);
  assert.equal(row.role, 'shadow');
  for (const g of guards) assert.equal(next.brain.weights[g.id], 0, g.id);
});

const settled = (variant, day, pnl, i) => ({ id: `${variant}:${day}:${i}`, variant, family: byId(variant).family, series: `S${i % 9}`, ticker: `T${i}`, openedAt: `${day}T10:00:00.000Z`, closeTime: `${day}T10:15:00.000Z`, settledAt: `${day}T10:15:00.000Z`, window: day, pnl, allocated: false, price: 0.5, secondsLeft: 200 });

test('forward only: rows on or before the guard day never count, for guard or parent', () => {
  const addedDay = GUARD_ADDED_AT.slice(0, 10);
  const rows = [
    ...Array.from({ length: 30 }, (_, i) => settled('scalp-guard', addedDay, 5, i)),
    ...Array.from({ length: 30 }, (_, i) => settled('scalp', '2026-11-25', -1, i)),
    ...Array.from({ length: 3 }, (_, i) => settled('scalp-guard', '2026-11-27', 0.5, i)),
    ...Array.from({ length: 2 }, (_, i) => settled('scalp', '2026-11-27', -0.25, i)),
    { ...settled('scalp-guard', '2026-11-27', 9, 99), skipped: true },
  ];
  const report = guardReport(rows);
  assert.equal(report.experimentSince, GUARD_ADDED_AT);
  assert.equal(report.need, HOLD_MIN);
  const s = report.pairs.find((p) => p.id === 'scalp-guard');
  assert.equal(s.n, 3);
  assert.equal(s.mean, 0.5);
  assert.equal(s.parentN, 2);
  assert.equal(s.parentMean, -0.25);
  const f = report.pairs.find((p) => p.id === 'fair-guard');
  assert.equal(f.n, 0);
  assert.equal(f.mean, null);
  const doc = lessonsDocument(rows, null, defaultBrain(), Date.parse('2026-11-28T01:00:00Z'));
  assert.deepEqual(doc.guard, report);
  assert.match(lessonsMarkdown(doc), /## Cheap-late guard[\s\S]*scalp-guard vs scalp, forward only: guard n 3, mean \+\$0\.50 after fees; parent n 2, mean −\$0\.25/);
});

test('the added day cannot promote a guard; promotion is still the holdout rule', () => {
  const addedDay = GUARD_ADDED_AT.slice(0, 10);
  const rows = [
    ...Array.from({ length: 25 }, (_, i) => settled('scalp-guard', addedDay, 1, i)),
    ...Array.from({ length: 25 }, (_, i) => settled('scalp', addedDay, -1, i)),
  ];
  const brain = reviewBrain(defaultBrain(), rows, Date.parse('2026-11-27T12:00:00Z'), { iters: 40 });
  assert.equal(brain.holdout, addedDay);
  assert.equal(brain.champions.scalp, 'scalp');
  assert.ok(brain.decisions.some((d) => /Scalp, cheap-late guard was added on 2026-11-26/.test(d)));
  assert.equal(brain.weights['scalp-guard'], 0);
  assert.equal(brain.addedAt['scalp-guard'], GUARD_ADDED_AT);
});

test('the Bots tab pill shows only computed numbers in the challenger component', () => {
  assert.equal(guardChallengersHtml(null), '');
  assert.equal(guardChallengersHtml({ pairs: [] }), '');
  const report = guardReport([settled('fair-guard', '2026-11-27', 0.3, 1)]);
  const html = guardChallengersHtml(report);
  assert.match(html, /class="cw-ch-pill"><i aria-hidden="true"><\/i>Challenger · 1\/20 <small>fair-guard<\/small>/);
  assert.match(html, /Challenger · 0\/20 <small>scalp-guard<\/small>/);
  assert.match(html, /data-fold="guard-maker-guard"/);
  assert.match(html, /<th scope="row">fair-guard<\/th><td>1<\/td><td class="is-up">\+\$0\.30<\/td>/);
  assert.match(html, /rest-maker · benched/);
  const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  assert.match(app, /guardChallengersHtml\(ui\.lessons\?\.guard\)/);
  const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
  assert.match(sw, /'engine\/guard-view\.js'/);
});
