// Round 4: responsive breakpoints, keyboard shortcuts, charts, freshness.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { layoutFor, gridColumns, sheetMode, shortcutFor, NAV_TABS, BREAKPOINTS } from '../engine/layout.js';
import { segments, inRange, chartSvg, freshness, niceTicks, nearestPoint, cumulative } from '../engine/chart.js';

test('breakpoints: phone under 900, desktop from 900, wide from 1360', () => {
  assert.equal(BREAKPOINTS.desktop, 900);
  assert.equal(layoutFor(390), 'phone');
  assert.equal(layoutFor(899), 'phone');
  assert.equal(layoutFor(900), 'desktop');
  assert.equal(layoutFor(1280), 'desktop');
  assert.equal(layoutFor(1440), 'wide');
  assert.equal(layoutFor(1920), 'wide');
  assert.deepEqual([390, 1280, 1920].map(gridColumns), [1, 2, 3]);
  assert.equal(sheetMode(390), 'sheet');
  assert.equal(sheetMode(1280), 'drawer');
});

test('CSS switches to the sidebar at the same 900px breakpoint', () => {
  const css = fs.readFileSync('styles.css', 'utf8');
  assert.match(css, /@media \(min-width:900px\)\{[\s\S]*?\.tabs\{top:0;bottom:0;left:0/);
  assert.match(css, /@media \(min-width:1360px\)/);
  const html = fs.readFileSync('index.html', 'utf8');
  assert.deepEqual([...html.matchAll(/data-tab="([a-z]+)"/g)].map((m) => m[1]), NAV_TABS);
});

test('shortcuts: 1-5 tabs, / search, Esc close, ignored while typing or with modifiers', () => {
  assert.deepEqual(shortcutFor({ key: '2' }), { type: 'tab', tab: 'bets' });
  assert.deepEqual(shortcutFor({ key: '5' }), { type: 'tab', tab: 'more' });
  assert.deepEqual(shortcutFor({ key: '/' }), { type: 'search' });
  assert.deepEqual(shortcutFor({ key: 'Escape', targetTag: 'INPUT' }), { type: 'close' });
  assert.equal(shortcutFor({ key: '2', targetTag: 'INPUT' }), null);
  assert.equal(shortcutFor({ key: '1', metaKey: true }), null);
  assert.equal(shortcutFor({ key: '9' }), null);
});

test('charts: gaps split the line, nothing is interpolated', () => {
  const t = Date.parse('2026-11-25T12:00:00Z');
  const pts = [0, 1, 2, 10, 11].map((m, i) => ({ t: t + m * 60e3, v: 1 + i }));
  const segs = segments(pts, 3 * 60e3);
  assert.equal(segs.length, 2);
  const svg = chartSvg({ points: pts, kind: 'price', gapMs: 3 * 60e3 });
  assert.equal((svg.match(/class="dc-line"/g) || []).length, 2);
  assert.equal((svg.match(/class="dc-gap"/g) || []).length, 1);
  const lineVerts = (svg.match(/d="([^"]+)"/g) || []).join('').match(/[ML]/g).length;
  assert.equal(lineVerts, pts.length); // one vertex per real point
  assert.equal(JSON.parse(svg.match(/data-points='([^']+)'/)[1]).length, pts.length);
  assert.match(chartSvg({ points: pts.slice(0, 1) }), /Only one point/);
  assert.equal(inRange(pts, '1h', t + 11 * 60e3).length, 5);
  assert.equal(inRange(pts, '1h', t + 65 * 60e3).length, 2);
});

test('charts: P&L steps, ticks cover the range, crosshair finds the nearest real point', () => {
  const c = cumulative([{ t: 2, pnl: 1 }, { t: 1, pnl: -2 }]);
  assert.deepEqual(c.map((p) => p.v), [-2, -1]);
  const ticks = niceTicks(-3.2, 7.9);
  assert.ok(ticks[0] <= -3.2 && ticks[ticks.length - 1] >= 7.9);
  const hit = nearestPoint([[0, 1], [100, 2], [200, 3]], 380, { l: 0, r: 0, w: 400, t0: 0, t1: 200 });
  assert.equal(hit.v, 3);
});

test('freshness: live, recent, stale', () => {
  const now = Date.parse('2026-11-25T12:00:00Z');
  assert.equal(freshness('2026-11-25T11:59:30Z', now).state, 'live');
  assert.equal(freshness('2026-11-25T11:55:00Z', now).state, 'recent');
  assert.equal(freshness('2026-11-25T11:00:00Z', now).state, 'stale');
  assert.equal(freshness(null, now).state, 'none');
});
