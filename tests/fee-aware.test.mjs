import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { kalshiTakerFee, feePerContract, feeEdgeClears, breakEvenWinRate } from '../engine/kalshi.js';
import { FEE_EDGE_MARGIN, FEE_AWARE_ADDED_AT, LEARN_SIZE, VARIANTS, signal, stepJournal, reviewBrain, defaultBrain, sideWinProb } from '../engine/learn.js';
import { feeBreakEvenTable, feeAskNote } from '../engine/trainer.js';
import { graduates } from '../engine/strategies.js';

const addedDay = FEE_AWARE_ADDED_AT.slice(0, 10);

function rawFee(price, contracts) {
  return 0.07 * contracts * price * (1 - price);
}

function sample(id, day, pnl, n = 20) {
  const family = id.startsWith('scalp') ? 'scalp' : 'late';
  return Array.from({ length: n }, (_, i) => ({
    variant: id,
    family,
    window: day,
    pnl,
    series: 'KXBTC15M',
    ticker: `${id}-${day}-${i}`,
    sizeUsd: 2,
    closeTime: `${day}T12:00:00Z`,
  }));
}

test('the margin and the added day were written down as one cent on 2026-11-20', () => {
  assert.equal(FEE_EDGE_MARGIN, 0.01);
  assert.equal(addedDay, '2026-11-20');
  assert.equal(LEARN_SIZE, 2);
  for (const id of ['late-fee', 'scalp-fee']) {
    const variant = VARIANTS.find((row) => row.id === id);
    assert.equal(variant.role, 'challenger');
    assert.equal(variant.feeAware, true);
    assert.equal(variant.addedAt, FEE_AWARE_ADDED_AT);
  }
  assert.equal(VARIANTS.find((row) => row.id === 'late-fee').minAsk, 0.85);
  assert.equal(VARIANTS.find((row) => row.id === 'scalp-fee').minJump, 0.04);
  assert.equal(VARIANTS.find((row) => row.id === 'scalp-fee').exit, undefined);
});

test('taker fee rounds up near 0 and near 1, and an exact cent stays put', () => {
  const cases = [
    [0.001, 2000],
    [0.01, 1],
    [0.01, 200],
    [0.5, 1],
    [0.5, 4],
    [0.85, 2],
    [0.9, 2],
    [0.99, 2],
    [0.999, 1],
    [0.999, 2],
  ];
  for (const [price, contracts] of cases) {
    const raw = rawFee(price, contracts);
    const fee = kalshiTakerFee(price, contracts);
    assert.equal(fee, Math.ceil((raw - 1e-9) * 100) / 100);
    assert.ok(fee + 1e-9 >= raw);
    assert.ok(fee - raw < 0.01 + 1e-9);
    assert.equal(feePerContract(price, contracts), fee / contracts);
  }
  assert.equal(kalshiTakerFee(0.5, 4), 0.07);
  assert.equal(kalshiTakerFee(0.5, 1), 0.02);
  assert.equal(kalshiTakerFee(0.999, 1), 0.01);
  assert.equal(kalshiTakerFee(0.01, 1), 0.01);
  assert.equal(kalshiTakerFee(0, 1), 0);
  assert.equal(kalshiTakerFee(1, 1), 0);
  assert.equal(kalshiTakerFee(0.5, 0), 0);
  assert.equal(feePerContract(0, 1), null);
  assert.equal(feePerContract(1, 2), null);
  assert.equal(feePerContract(0.5, 0), null);
});

test('the fee filter is strict and a sure win at 0.999 does not clear one contract', () => {
  const price = 0.9;
  const contracts = Math.floor(2 / price);
  const per = feePerContract(price, contracts);
  assert.equal(feeEdgeClears(price + per + FEE_EDGE_MARGIN, price, contracts, FEE_EDGE_MARGIN), false);
  assert.equal(feeEdgeClears(price + per + FEE_EDGE_MARGIN + 1e-6, price, contracts, FEE_EDGE_MARGIN), true);
  assert.equal(feeEdgeClears(price, price, contracts, FEE_EDGE_MARGIN), false);
  assert.equal(feeEdgeClears(null, price, contracts, FEE_EDGE_MARGIN), false);
  assert.equal(feeEdgeClears(0.99, 0, contracts, FEE_EDGE_MARGIN), false);
  assert.equal(feeEdgeClears(0.99, 1, contracts, FEE_EDGE_MARGIN), false);
  assert.equal(feeEdgeClears(1, 0.999, 1, FEE_EDGE_MARGIN), false);
  const cheap = breakEvenWinRate(0.01);
  assert.equal(cheap.contracts, 200);
  assert.equal(cheap.sizeUsd, 2);
  assert.equal(cheap.fee, kalshiTakerFee(0.01, 200));
  assert.ok(Math.abs(cheap.breakEven - (0.01 + cheap.fee / 200)) < 1e-12);
  const wing = breakEvenWinRate(0.999);
  assert.equal(wing.contracts, 2);
  assert.ok(wing.breakEven > 1);
  assert.equal(wing.fee, 0.01);
  assert.equal(breakEvenWinRate(0), null);
  assert.equal(breakEvenWinRate(1), null);
  assert.equal(breakEvenWinRate(1.2), null);
});

test('the quote mid is the proxy, and a normal YES book does not enter', () => {
  assert.equal(sideWinProb({ yesBid: 0.88, yesAsk: 0.9 }, 'yes'), 0.89);
  assert.equal(sideWinProb({ yesBid: 0.1, yesAsk: 0.12 }, 'no'), 0.89);
  assert.equal(sideWinProb({ yesBid: 0.96, yesAsk: 0.9 }, 'yes'), null);
  assert.equal(sideWinProb({ yesBid: 0, yesAsk: 0.9 }, 'yes'), null);
  assert.equal(sideWinProb({ yesBid: 0.9, yesAsk: 1 }, 'yes'), null);
  const now = Date.parse('2026-11-21T12:00:00Z');
  const late = VARIANTS.find((row) => row.id === 'late');
  const lateFee = VARIANTS.find((row) => row.id === 'late-fee');
  const yesBook = {
    ticker: 'KXBTC15M-Y',
    series: 'KXBTC15M',
    yesAsk: 0.9,
    yesBid: 0.88,
    noAsk: 0.12,
    noBid: 0.1,
    closeTime: '2026-11-21T12:04:00Z',
    floorStrike: 100,
    result: '',
  };
  assert.ok(signal(late, yesBook, now));
  assert.equal(signal(lateFee, yesBook, now), null);
  assert.equal(signal(lateFee, { ...yesBook, yesBid: 0.96 }, now), null);
  const noBook = { ...yesBook, yesAsk: 0.12, yesBid: 0.1, noAsk: 0.85, noBid: 0.8 };
  const p = sideWinProb(noBook, 'no');
  const contracts = Math.floor(LEARN_SIZE / noBook.noAsk);
  assert.equal(feeEdgeClears(p, noBook.noAsk, contracts, FEE_EDGE_MARGIN), true);
  const picked = signal(lateFee, noBook, now);
  assert.equal(picked.side, 'no');
  assert.equal(picked.pEst, p);
  assert.equal(picked.features.pEst, p);
  const opened = stepJournal({ markets: [noBook], open: [], quotes: {}, brain: defaultBrain(), existingIds: [], now });
  const row = opened.open.find((item) => item.variant === 'late-fee');
  assert.ok(row);
  assert.equal(row.sizeUsd, 2);
  assert.equal(row.side, 'no');
  assert.equal(row.fee, kalshiTakerFee(row.ask, row.contracts));
  const scalp = VARIANTS.find((item) => item.id === 'scalp');
  const scalpFee = VARIANTS.find((item) => item.id === 'scalp-fee');
  const jump = { ...yesBook, yesAsk: 0.7, yesBid: 0.68, noAsk: 0.32, closeTime: '2026-11-21T12:08:00Z' };
  const ctx = { prev: { yesAsk: 0.65 } };
  assert.equal(signal(scalp, jump, now, ctx).side, 'yes');
  assert.equal(signal(scalpFee, jump, now, ctx), null);
});

test('the added day cannot promote or bench, and a later day still can', () => {
  const seen = reviewBrain(defaultBrain(), [
    ...sample('late', '2026-11-19', -0.02),
    ...sample('late', addedDay, -0.02),
    ...sample('late-fee', addedDay, 0.2),
    ...sample('late-fee', '2026-11-19', -0.2),
  ], Date.parse('2026-11-21T12:00:00Z'), { iters: 30 });
  assert.equal(seen.champions.late, 'late');
  assert.equal(seen.benched.includes('late-fee'), false);
  assert.match(seen.decisions.join('\n'), /Late favorite, fee-aware was added on 2026-11-20/);
  assert.match(seen.decisions.join('\n'), /cannot promote/);
  assert.equal(seen.addedAt['late-fee'], FEE_AWARE_ADDED_AT);
  assert.equal(seen.addedAt['scalp-fee'], FEE_AWARE_ADDED_AT);
  const later = reviewBrain(defaultBrain(), [
    ...sample('late', '2026-11-21', -0.02),
    ...sample('late', '2026-11-22', -0.02),
    ...sample('late-fee', '2026-11-22', 0.05),
  ], Date.parse('2026-11-23T12:00:00Z'), { iters: 30 });
  assert.equal(later.champions.late, 'late-fee');
  assert.equal(later.champions.scalp, 'scalp');
  const benched = reviewBrain(defaultBrain(), [
    ...sample('scalp-fee', '2026-11-21', -0.1),
    ...sample('scalp', '2026-11-22', -0.01, 1),
  ], Date.parse('2026-11-23T12:00:00Z'), { iters: 20 });
  assert.ok(benched.benched.includes('scalp-fee'));
  assert.equal(benched.weights['scalp-fee'], 0);
  assert.equal(graduates([{ n: 20, mean: 0.1, lo: 0.01, seen: false }, { n: 20, mean: 0.1, lo: 0.01, seen: false }]), false);
  const gate = readFileSync(new URL('../engine/strategies.js', import.meta.url), 'utf8');
  assert.match(gate, /export function graduates\(windows\)/);
  assert.doesNotMatch(gate, /feeAware|FEE_EDGE_MARGIN/);
  const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  assert.match(app, /live_execution[\s\S]*disabled/);
});

test('the break-even table shows only the rates computed for the asks on screen', () => {
  const html = feeBreakEvenTable({
    yesAsk: 0.9,
    noAsk: 0.12,
    captionId: 'fee-cap-test',
    looking: 'yes',
    context: 'This window <script>',
  });
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  const yes = breakEvenWinRate(0.9);
  const no = breakEvenWinRate(0.12);
  const allowed = new Set([(yes.breakEven * 100).toFixed(1), (no.breakEven * 100).toFixed(1)]);
  const shown = [...html.matchAll(/(\d+\.\d)%/g)].map((m) => m[1]);
  assert.ok(shown.length >= 2);
  for (const pct of shown) assert.ok(allowed.has(pct), pct);
  assert.match(html, new RegExp(`\\$${yes.fee.toFixed(2)}`));
  assert.match(html, new RegExp(`\\$${no.fee.toFixed(2)}`));
  assert.match(html, /is-looking/);
  assert.match(html, /aria-labelledby="fee-cap-test"/);
  assert.match(html, /\$2/);
  assert.match(html, /0\.07 × contracts × price × \(1 − price\)/);
  const note = feeAskNote(0.999, 'yes');
  const wing = breakEvenWinRate(0.999);
  assert.match(note, new RegExp(`${(wing.breakEven * 100).toFixed(1)}%`));
  assert.match(note, /above a sure win/);
  assert.match(note, /chip stays \$2/);
  assert.equal(feeAskNote(1, 'yes'), '');
  assert.match(feeBreakEvenTable(null), /no break-even win rate/);
  assert.match(feeBreakEvenTable({ yesAsk: 1, noAsk: 0 }), /No ask between 0 and 1/);
});
