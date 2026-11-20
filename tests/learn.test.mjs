import test from 'node:test';
import assert from 'node:assert/strict';
import { stepJournal, reviewBrain, featureLessons, gateProgress, settleRow, LEARN_SIZE, defaultBrain, riskShadow, signal, VARIANTS, SNAPSHOT_ALLOC_CAP, SNAPSHOT_LINE_CAP, repairPracticeGate } from '../engine/learn.js';
import { graduates } from '../engine/strategies.js';

const now = Date.parse('2026-11-20T12:00:00Z');

function market(over) {
  return { ticker: 'KXBTC15M-T', series: 'KXBTC15M', title: 'BTC', yesAsk: 0.9, noAsk: 0.12, yesBid: 0.88, noBid: 0.1, closeTime: '2026-11-20T12:05:00Z', floorStrike: 100, result: '', ...over };
}

function row(variant, window, pnl, extra = {}) {
  return { variant, family: variant.split('-')[0] === 'late' ? 'late' : variant, window, pnl, series: 'KXBTC15M', ticker: variant + window + pnl, sizeUsd: 2, closeTime: window + 'T12:00:00Z', ...extra };
}

test('a settled paper trade stays $2 and keeps the taker fee', () => {
  const entry = { id: 'late:T', side: 'yes', ask: 0.9, contracts: 2, sizeUsd: 2, closeTime: '2026-11-19T00:00:00Z' };
  const won = settleRow(entry, 'yes', now);
  assert.equal(won.sizeUsd, LEARN_SIZE);
  assert.ok(won.fees > 0);
  assert.ok(won.pnl < 2 * 0.1);
  const lost = settleRow(entry, 'no', now);
  assert.equal(lost.sizeUsd, 2);
  assert.ok(lost.pnl < 0);
  assert.throws(() => settleRow({ ...entry, sizeUsd: 4 }, 'yes', now), /fixed at \$2/);
});

test('the journal records entry features and does not double-count a ticker', () => {
  const first = stepJournal({ markets: [market()], open: [], quotes: {}, brain: defaultBrain(), existingIds: [], now: Date.parse('2026-11-20T12:02:00Z') });
  const late = first.open.find((r) => r.variant === 'late');
  assert.ok(late);
  assert.equal(late.sizeUsd, 2);
  assert.equal(late.price, 0.9);
  assert.ok(late.secondsLeft > 0);
  assert.equal(late.momentum, null);
  const again = stepJournal({ markets: [market({ result: 'no' })], open: first.open, quotes: first.quotes, brain: defaultBrain(), existingIds: [], now });
  assert.equal(again.settled.filter((r) => r.variant === 'late').length, 1);
  assert.equal(again.settled.find((r) => r.variant === 'late').won, false);
  const third = stepJournal({ markets: [market({ result: 'no' })], open: [], quotes: {}, brain: defaultBrain(), existingIds: again.settled.map((r) => r.id), now });
  assert.equal(third.settled.length, 0);
});

test('a challenger that only wins the holdout wait, and a judged holdout is not reused', () => {
  const train = Array.from({ length: 20 }, (_, i) => row('late', '2026-11-17', -0.05, { family: 'late' }));
  const holdChamp = Array.from({ length: 20 }, (_, i) => row('late', '2026-11-18', -0.02, { family: 'late' }));
  const holdChallenger = Array.from({ length: 20 }, (_, i) => row('late-tight', '2026-11-18', 0.04, { family: 'late' }));
  const brain = reviewBrain(defaultBrain(), [...train, ...holdChamp, ...holdChallenger], now, { iters: 40 });
  assert.equal(brain.champions.late, 'late-tight');
  assert.ok(brain.judged.includes('2026-11-18'));
  const again = reviewBrain(brain, [...train, ...holdChamp, ...holdChallenger], now, { iters: 40 });
  assert.equal(again.champions.late, 'late-tight');
  assert.match(again.decisions[0], /already judged/);
});

test('train losses bench a bot and do not raise its paper size', () => {
  const train = Array.from({ length: 20 }, () => row('late-loose', '2026-11-17', -0.08, { family: 'late', sizeUsd: 2 }));
  const hold = [row('late', '2026-11-18', -0.01, { family: 'late' })];
  const brain = reviewBrain(defaultBrain(), [...train, ...hold], now, { iters: 40 });
  assert.ok(brain.benched.includes('late-loose'));
  assert.equal(brain.weights['late-loose'], 0);
  const next = stepJournal({
    markets: [market()],
    open: [],
    quotes: {},
    brain,
    existingIds: [],
    now: Date.parse('2026-11-20T12:02:00Z'),
  });
  const loose = next.open.filter((r) => r.variant === 'late-loose');
  assert.ok(loose.every((r) => r.allocated === false && r.sizeUsd === 2));
  assert.ok(next.open.some((r) => r.variant === 'late' && r.allocated));
});

test('a good train and a bad holdout does not replace the champion', () => {
  const train = Array.from({ length: 20 }, () => row('late-early', '2026-11-17', 0.05, { family: 'late' }));
  const holdChamp = Array.from({ length: 20 }, () => row('late', '2026-11-18', 0.03, { family: 'late' }));
  const holdBad = Array.from({ length: 20 }, () => row('late-early', '2026-11-18', -0.04, { family: 'late' }));
  const brain = reviewBrain(defaultBrain(), [...train, ...holdChamp, ...holdBad], now, { iters: 40 });
  assert.equal(brain.champions.late, 'late');
});

test('one bot shadow does not stop the others, and one snapshot cannot flood', () => {
  const settledRows = [{ variant: 'late-loose', allocated: true, settledAt: '2026-11-20T01:00:00Z', window: '2026-11-20', pnl: -6, sizeUsd: 2 }];
  const markets = Array.from({ length: 12 }, (_, i) => market({ ticker: 'KXBTC15M-' + i }));
  const when = Date.parse('2026-11-20T12:02:00Z');
  const next = stepJournal({ markets, open: [], quotes: {}, brain: defaultBrain(), existingIds: [], settledRows, now: when });
  const loose = next.open.filter((r) => r.variant === 'late-loose');
  assert.ok(loose.length > 0);
  assert.ok(loose.every((r) => r.allocated === false && r.sizeUsd === 2));
  const taken = next.open.filter((r) => r.variant === 'late' && r.allocated);
  assert.ok(taken.length > 0 && taken.length <= SNAPSHOT_ALLOC_CAP);
  const capped = next.open.filter((r) => r.role !== 'shadow' && r.role !== 'control');
  assert.ok(capped.length <= SNAPSHOT_LINE_CAP);
  assert.ok(next.open.filter((r) => r.role === 'shadow').every((r) => r.allocated === false));
  const ids = next.open.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('a longshot ask is skipped by the new revert filter, and shadow does not return on the holdout', () => {
  const variant = VARIANTS.find((v) => v.id === 'revert-no-longshot');
  const cheap = { ticker: 'T', series: 'KXBTC15M', yesAsk: 0.25, noAsk: 0.8, yesBid: 0.24, closeTime: new Date(now + 500000).toISOString(), floorStrike: 1, result: '' };
  assert.equal(signal(variant, cheap, now), null);
  assert.ok(signal(variant, { ...cheap, yesAsk: 0.42, yesBid: 0.41 }, now));
  const brain = { ...defaultBrain(), shadow: ['late-loose'], shadowSince: { 'late-loose': '2026-11-18' } };
  const sameDay = Array.from({ length: 8 }, (_, i) => row('late-loose', '2026-11-18', 0.05, { family: 'late', ticker: 'h' + i }));
  assert.ok(riskShadow(brain, sameDay, Date.parse('2026-11-19T12:00:00Z')).shadow.includes('late-loose'));
  const later = Array.from({ length: 8 }, (_, i) => row('late-loose', '2026-11-19', 0.05, { family: 'late', ticker: 'l' + i }));
  const train = Array.from({ length: 8 }, (_, i) => row('late-loose', '2026-11-20', 0.02, { family: 'late', ticker: 't' + i }));
  const freed = riskShadow(brain, [...sameDay, ...later, ...train], Date.parse('2026-11-21T12:00:00Z'));
  assert.ok(freed.shadow.includes('late-loose'));
});

test('a finished day past the $6 loss shadows the next morning, and a cleared day does not come back', () => {
  const loss = [{ variant: 'revert-wide', allocated: true, settledAt: '2026-11-19T22:00:00Z', window: '2026-11-19', pnl: -31.61, sizeUsd: 2, openedAt: '2026-11-19T21:00:00Z' }];
  const next = riskShadow(defaultBrain(), loss, Date.parse('2026-11-20T00:01:00Z'));
  assert.ok(next.shadow.includes('revert-wide'));
  assert.equal(next.shadow.includes('flip'), false);
  const control = [{ variant: 'flip', allocated: true, settledAt: '2026-11-19T22:00:00Z', window: '2026-11-19', pnl: -8.3, sizeUsd: 2 }];
  assert.equal(riskShadow(defaultBrain(), control, Date.parse('2026-11-20T00:01:00Z')).shadow.includes('flip'), false);
  const shadows = Array.from({ length: 30 }, (_, i) => ({
    variant: 'revert-wide', allocated: false, pnl: 0.05, openedAt: `2026-11-20T01:${String(i).padStart(2, '0')}:00Z`, settledAt: `2026-11-20T01:${String(i).padStart(2, '0')}:30Z`,
  }));
  const freed = riskShadow({ ...defaultBrain(), shadow: next.shadow, shadowSince: next.shadowSince }, [...loss, ...shadows], Date.parse('2026-11-21T00:01:00Z'));
  assert.equal(freed.shadow.includes('revert-wide'), false);
  assert.equal(freed.shadowReturned['revert-wide'], '2026-11-20');
});

test('bet-cap skips do not refill a cleared shadow window, and a cleared day is not re-applied', () => {
  const practice = Array.from({ length: 30 }, (_, i) => ({
    variant: 'scalp-stop', allocated: false, skipped: false, pnl: 0.05, role: 'shadow',
    openedAt: `2026-11-20T00:${String(i).padStart(2, '0')}:00Z`,
    settledAt: `2026-11-20T00:${String(i).padStart(2, '0')}:30Z`,
  }));
  const skips = Array.from({ length: 30 }, (_, i) => ({
    variant: 'scalp-stop', allocated: false, skipped: true, pnl: -0.4,
    openedAt: `2026-11-20T02:${String(i).padStart(2, '0')}:00Z`,
    skipReason: 'risk: this snapshot is at its bet cap',
  }));
  const loss = [{ variant: 'scalp-stop', allocated: true, pnl: -8, settledAt: '2026-11-19T22:00:00Z', window: '2026-11-19', openedAt: '2026-11-19T21:00:00Z' }];
  const kept = riskShadow({ ...defaultBrain(), shadow: ['scalp-stop'], shadowSince: { 'scalp-stop': '2026-11-19' } }, [...loss, ...practice, ...skips], Date.parse('2026-11-20T12:00:00Z'));
  assert.equal(kept.shadow.includes('scalp-stop'), false);
  const again = riskShadow({ ...defaultBrain(), shadow: [], shadowSince: {}, shadowReturned: {} }, [...loss, ...practice, ...skips], Date.parse('2026-11-20T12:00:00Z'));
  assert.equal(again.shadow.includes('scalp-stop'), false);
  assert.equal(again.shadowReturned['scalp-stop'], '2026-11-19');
  assert.equal(repairPracticeGate([...practice, ...skips], 'scalp-stop', '2026-11-19').n, 30);
  assert.equal(repairPracticeGate(skips, 'scalp-stop', '2026-11-19').n, 0);
});

test('control and shadow logs do not spend the cap that repair practice needs', () => {
  const now = Date.parse('2026-11-20T12:00:00Z');
  const markets = Array.from({ length: SNAPSHOT_LINE_CAP }, (_, i) => ({
    ticker: `AAA-${String(i).padStart(2, '0')}`,
    series: 'KXBTC15M',
    title: 'BTC',
    yesAsk: 0.5,
    noAsk: 0.5,
    yesBid: 0.48,
    noBid: 0.48,
    closeTime: new Date(now + 700000).toISOString(),
    floorStrike: 100,
    result: '',
  }));
  markets.push({
    ticker: 'ZZY-ALLOC',
    series: 'KXETH15M',
    title: 'ETH',
    yesAsk: 0.9,
    noAsk: 0.12,
    yesBid: 0.88,
    noBid: 0.1,
    closeTime: new Date(now + 240000).toISOString(),
    floorStrike: 100,
    result: '',
  });
  markets.push({
    ticker: 'ZZZ-REPAIR',
    series: 'KXSOL15M',
    title: 'SOL',
    yesAsk: 0.9,
    noAsk: 0.12,
    yesBid: 0.88,
    noBid: 0.1,
    closeTime: new Date(now + 400000).toISOString(),
    floorStrike: 100,
    result: '',
  });
  const brain = { ...defaultBrain(), shadow: ['late-early'], shadowSince: { 'late-early': '2026-11-19' } };
  const next = stepJournal({ markets, open: [], quotes: {}, brain, existingIds: [], settledRows: [], now });
  const flips = next.open.filter((row) => row.variant === 'flip');
  assert.equal(flips.length, SNAPSHOT_LINE_CAP);
  assert.ok(flips.every((row) => row.allocated === false && row.role === 'control' && row.skipped === false));
  const repair = next.open.filter((row) => row.variant === 'late-early' && row.ticker === 'ZZZ-REPAIR');
  assert.equal(repair.length, 1);
  assert.equal(repair[0].skipped, false);
  assert.equal(repair[0].allocated, false);
  assert.equal(repair[0].role, 'shadow');
  assert.equal(repair[0].sizeUsd, 2);
  const allocated = next.open.filter((row) => row.allocated);
  assert.ok(allocated.length > 0 && allocated.length <= SNAPSHOT_ALLOC_CAP);
  assert.ok(allocated.every((row) => row.role !== 'shadow' && row.role !== 'control'));
  assert.equal(next.open.some((row) => row.skipReason === 'risk: this snapshot is at its bet cap'), false);
  const gate = repairPracticeGate([{ ...repair[0], pnl: 0.04, settledAt: '2026-11-20T12:10:00Z' }], 'late-early', '2026-11-19');
  assert.equal(gate.n, 1);
  assert.equal(gate.need, 20);
  assert.equal(gate.pass, false);
  assert.equal(gate.sizeUsd, 2);
});

test('feature lessons wait for 8 trades and the gate still needs three windows', () => {
  const few = Array.from({ length: 7 }, () => ({ family: 'late', price: 0.96, secondsLeft: 60, pnl: -0.1 }));
  assert.equal(featureLessons(few).length, 0);
  const enough = Array.from({ length: 8 }, () => ({ family: 'late', price: 0.96, secondsLeft: 60, pnl: -0.1 }));
  const lesson = featureLessons(enough)[0];
  assert.match(lesson.text, /above 0.95/);
  assert.match(lesson.text, /under 2 minutes/);
  assert.match(lesson.text, /after fees/);
  const oneWindow = Array.from({ length: 20 }, (_, i) => ({ variant: 'late', window: '2026-11-18', pnl: 0.01, series: 'KXBTC15M', ticker: 't' + i, closeTime: '2026-11-18T00:00:00Z' }));
  assert.equal(gateProgress(oneWindow, 30).graduated, false);
  assert.equal(graduates([{ n: 20, mean: 0.1, lo: 0.01, seen: false }, { n: 20, mean: 0.1, lo: 0.01, seen: false }]), false);
});

test('a market that leaves the board is closed without a made-up P&L', () => {
  const entry = {
    id: 'flip:OLD', variant: 'flip', family: 'flip', role: 'control', allocated: true,
    ticker: 'KXCRYPTOLEAD15M-OLD', series: 'KXCRYPTOLEAD15M', side: 'yes', ask: 0.4,
    contracts: 5, sizeUsd: 2, fee: 0.08, openedAt: '2026-11-20T10:00:00.000Z',
    closeTime: '2026-11-20T10:15:00Z', paper: true,
  };
  const soon = stepJournal({ markets: [], open: [entry], quotes: {}, brain: defaultBrain(), now: Date.parse('2026-11-20T12:00:00Z') });
  assert.equal(soon.open.length, 1);
  assert.equal(soon.settled.length, 0);
  const later = stepJournal({ markets: [], open: [entry], quotes: {}, brain: defaultBrain(), now: Date.parse('2026-11-20T18:00:00Z') });
  assert.equal(later.open.length, 0);
  assert.equal(later.settled.length, 1);
  assert.equal(later.settled[0].result, 'missing');
  assert.equal(later.settled[0].pnl, null);
  assert.equal(later.settled[0].skipped, true);
  assert.equal(later.settled[0].sizeUsd, 2);
  assert.equal(later.settled[0].allocated, true);
  const scored = reviewBrain(defaultBrain(), later.settled, Date.parse('2026-11-21T00:00:00Z'));
  assert.equal(scored.paper, true);
});
