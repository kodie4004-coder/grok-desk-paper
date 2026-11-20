import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { stepMeme } from '../engine/meme.js';
import { challengerRows, upgradeLines } from '../engine/upgrades.js';
import {
  JEV_CALL_CAP, JEV_MODEL, JEV_PROMPT, JEV_URL, askJev, cacheDoc, cacheFromDoc, describeCoin, jevShadow, jevState,
  parseVerdict, parseXProfile, prepareJevState, readXProfile, reviewCandidates, rugFacts, similarCoins, xHandleFromUrls, xProfileUrl,
} from '../engine/jev.js';

const now = Date.parse('2026-11-20T12:00:00Z');
const root = new URL('..', import.meta.url);

function answer(choice, nouls = {}) {
  const x = nouls.x ?? 0.8;
  const copycat = nouls.copycat ?? 0.1;
  const rug = nouls.rug ?? 0.1;
  return {
    model: JEV_MODEL,
    answers: {
      x_account: { type: 'noul', noul: x },
      copycat: { type: 'noul', noul: copycat },
      rug: { type: 'noul', noul: rug },
      verdict: {
        type: 'choice',
        choice,
        confidence: 0.7,
        probabilities: { pass: 0.7, flag: 0.2, unknown: 0.1 },
      },
    },
    usage: { input_tokens: 12, output_tokens: 2 },
  };
}

function jsonResponse(body, status = 200) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text };
}

function coin(ca, jev) {
  return { ca, symbol: 'T', name: 'Test', priceUsd: 1, pass: true, ...(jev ? { jev } : {}) };
}

test('a pass and a flag parse, and a high yes-probability does not override the choice', async () => {
  let header = '';
  let sent = null;
  const pass = await askJev(jevState({ name: 'Test', symbol: 'T', description: 'a coin', priceUsd: 4 }), {
    key: 'test-key',
    fetchImpl: async (url, init) => {
      header = init.headers.authorization;
      sent = JSON.parse(init.body);
      assert.equal(url, JEV_URL);
      return jsonResponse(answer('pass', { copycat: 0.99 }));
    },
  });
  assert.equal(header, 'Bearer test-key');
  assert.equal(sent.model, JEV_MODEL);
  assert.equal(sent.questions.x_account.type, 'noul');
  assert.match(sent.questions.x_account.instructions, /X account/);
  assert.match(sent.questions.copycat.instructions, /copycat/i);
  assert.match(sent.questions.rug.instructions, /rug/i);
  assert.deepEqual(Object.keys(sent.questions.verdict.criteria).sort(), ['flag', 'pass', 'unknown']);
  assert.equal(sent.state.priceUsd, undefined);
  assert.equal(pass.ok, true);
  assert.equal(pass.verdict, 'pass');
  assert.equal(pass.attempts, 1);
  assert.match(pass.reason, /^pass: X 0\.80, copycat 0\.99, rug 0\.10$/);
  const flag = await askJev({}, {
    key: 'test-key',
    fetchImpl: async () => jsonResponse(answer('flag', { x: 0.2, copycat: 0.91, rug: 0.4 })),
  });
  assert.equal(flag.verdict, 'flag');
  assert.match(flag.reason, /^flag:/);
  assert.equal(parseVerdict(answer('pass', { copycat: 0.99 })).verdict, 'pass');
});

test('malformed JSON and a bad choice are unknown and are not retried', async () => {
  let bad = 0;
  const malformed = await askJev({}, {
    key: 'test-key',
    fetchImpl: async () => { bad += 1; return jsonResponse('{'); },
  });
  assert.equal(bad, 1);
  assert.equal(malformed.ok, false);
  assert.equal(malformed.verdict, 'unknown');
  assert.equal(malformed.malformed, true);
  assert.equal(malformed.skipped, false);
  let shaped = 0;
  const wrong = await askJev({}, {
    key: 'test-key',
    fetchImpl: async () => {
      shaped += 1;
      return jsonResponse(answer('maybe'));
    },
  });
  assert.equal(shaped, 1);
  assert.equal(wrong.verdict, 'unknown');
  assert.equal(wrong.malformed, true);
  assert.equal(parseVerdict(null), null);
  assert.equal(parseVerdict({ answers: { verdict: { type: 'choice', choice: ' flag ', confidence: 0.5, probabilities: {} } } }), null);
});

test('a timeout is retried once and a missing key does not call', async () => {
  let tries = 0;
  const timed = await askJev({}, {
    key: 'test-key',
    fetchImpl: async () => {
      tries += 1;
      const err = new Error('timed out');
      err.name = 'TimeoutError';
      throw err;
    },
  });
  assert.equal(tries, 2);
  assert.equal(timed.ok, false);
  assert.equal(timed.verdict, 'unknown');
  assert.equal(timed.timeout, true);
  assert.equal(timed.reason, 'timeout');
  let called = false;
  const missing = await askJev({}, {
    key: '',
    env: { TYPESAFE_API_KEY: 'should-not-be-read' },
    fetchImpl: async () => { called = true; return jsonResponse(answer('pass')); },
  });
  assert.equal(called, false);
  assert.equal(missing.skipped, true);
  assert.equal(missing.verdict, 'unknown');
  assert.equal(missing.attempts, 0);
  const quiet = await reviewCandidates([coin('CA')], {
    key: '',
    fetchImpl: async () => { called = true; return jsonResponse(answer('pass')); },
  });
  assert.equal(called, false);
  assert.equal(quiet.asked, 0);
  assert.equal(quiet.skipped, 1);
  assert.equal(quiet.coins[0].jev, undefined);
});

test('one coin is asked once, a later pass uses the cache, and the run stops at 20', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonResponse(answer(calls % 2 ? 'pass' : 'flag'));
  };
  const cache = new Map();
  const first = await reviewCandidates([coin('CA'), coin('CA')], { cache, key: 'test-key', fetchImpl, now: '2026-11-20T00:00:00Z' });
  assert.equal(calls, 1);
  assert.equal(first.coins[0].jev.verdict, 'pass');
  assert.equal(first.coins[1].jev.verdict, 'pass');
  const again = await reviewCandidates([coin('CA')], { cache, key: 'test-key', fetchImpl });
  assert.equal(calls, 1);
  assert.equal(again.asked, 0);
  const many = Array.from({ length: JEV_CALL_CAP + 1 }, (_, i) => coin('M' + i));
  const capped = await reviewCandidates(many, { cache: new Map(), key: 'test-key', fetchImpl });
  assert.equal(capped.asked, JEV_CALL_CAP);
  assert.equal(capped.capped, 1);
  assert.equal(capped.coins[JEV_CALL_CAP].jev, undefined);
  assert.equal(calls, 1 + JEV_CALL_CAP);
  const stored = cacheDoc(cache);
  assert.equal(stored.model, JEV_MODEL);
  assert.equal(stored.verdicts.CA.verdict, 'pass');
  assert.equal(JSON.stringify(stored).includes('test-key'), false);
  const skippedFail = await reviewCandidates([{ ca: 'NO', pass: false }], { cache: new Map(), key: 'test-key', fetchImpl });
  assert.equal(skippedFail.asked, 0);
  assert.equal(calls, 1 + JEV_CALL_CAP);
  const budget = await reviewCandidates([coin('LATE')], { cache: new Map(), key: 'test-key', fetchImpl, budgetMs: 0 });
  assert.equal(budget.asked, 0);
  assert.equal(budget.capped, 1);
});

test('a Jev flag is recorded on the paper trade and does not block it', () => {
  const flag = { verdict: 'flag', reason: 'flag: X 0.10, copycat 0.90, rug 0.40' };
  const opened = stepMeme({ coins: [coin('CA', flag)], open: [], history: [], now });
  assert.equal(opened.open.length, 1);
  assert.equal(opened.open[0].sizeUsd, 2);
  assert.equal(opened.open[0].allocated, true);
  assert.equal(opened.open[0].shadow, false);
  assert.equal(opened.open[0].variant, 'meme-safety');
  assert.deepEqual(opened.open[0].jev, flag);
  const closed = stepMeme({ coins: [{ ca: 'CA', priceUsd: 0.8, pass: true }], open: opened.open, now: now + 60000 });
  assert.equal(closed.settled.length, 1);
  assert.equal(closed.settled[0].jev.verdict, 'flag');
  assert.equal(closed.settled[0].sizeUsd, 2);
  const stats = jevShadow(closed.settled);
  assert.equal(stats.n, 1);
  assert.equal(stats.flagged, 1);
  assert.equal(stats.vetoN, 0);
  assert.equal(stats.mean, null);
  assert.ok(stats.baselineMean < 0);
  assert.equal(stats.weight, 0);
  assert.equal(stats.status, 'shadow');
  assert.equal(stats.blocksEntries, false);
});

test('the veto mean drops flags only, and weight stays 0 until the existing gate clears', () => {
  const rows = [
    { ca: 'A', pnl: 1, settledAt: '2026-11-01T00:00:00Z', jev: { verdict: 'pass', reason: 'pass' } },
    { ca: 'B', pnl: -1, settledAt: '2026-11-01T01:00:00Z', jev: { verdict: 'flag', reason: 'flag' } },
    { ca: 'C', pnl: 0.5, settledAt: '2026-11-01T02:00:00Z', jev: { verdict: 'unknown', reason: 'unknown' } },
    { ca: 'D', pnl: 9, settledAt: '2026-11-01T03:00:00Z' },
  ];
  const stats = jevShadow(rows);
  assert.equal(stats.id, 'jev-check');
  assert.equal(stats.n, 3);
  assert.ok(Math.abs(stats.baselineMean - ((1 - 1 + 0.5) / 3)) < 1e-12);
  assert.ok(Math.abs(stats.mean - ((1 + 0.5) / 2)) < 1e-12);
  assert.equal(stats.weight, 0);
  assert.equal(stats.liveExecution, false);
  const thin = Array.from({ length: 19 }, (_, i) => ({
    ca: 'T' + i, pnl: 0.2, settledAt: '2026-11-01T00:00:00Z', jev: { verdict: 'pass', reason: 'pass' },
  }));
  assert.equal(jevShadow(thin).weight, 0);
  const days = ['2026-11-01', '2026-11-02', '2026-11-03'];
  const cleared = days.flatMap((day, d) => Array.from({ length: 20 }, (_, i) => ({
    ca: `D${d}-${i}`, pnl: 0.2, settledAt: `${day}T00:00:00Z`, jev: { verdict: 'pass', reason: 'pass' },
  })));
  const won = jevShadow(cleared);
  assert.equal(won.weight, 1);
  assert.equal(won.status, 'shadow');
  assert.equal(won.blocksEntries, false);
  assert.equal(won.n, 60);
  const state = describeCoin({
    coin: { name: 'Example', symbol: 'EX', priceUsd: 2 },
    pair: { priceUsd: '9', info: { socials: [{ type: 'twitter', url: 'https://x.com/example' }], websites: [{ url: 'https://example.com' }] } },
    profile: { description: 'A small project', links: [{ type: 'twitter', url: 'https://x.com/example' }] },
  });
  assert.equal(state.socials.length, 1);
  assert.deepEqual(state.websites, ['https://example.com']);
  assert.equal(JSON.stringify(state).includes('price'), false);
  const empty = jevShadow([]);
  assert.equal(empty.status, 'shadow');
  assert.equal(empty.weight, 0);
  assert.equal(empty.liveExecution, false);
  assert.equal(empty.n, 0);
  assert.match(empty.note, /Weight is 1 only when the existing edge gate clears/);
  const lines = upgradeLines({ maker: { measured: false }, settlement: { n: 0 }, jev: empty });
  assert.match(lines.join(' '), /Jev check is a shadow challenger/);
  assert.match(lines.join(' '), /Weight is 0/);
  const saved = JSON.parse(readFileSync(fileURLToPath(new URL('data/research-upgrades.json', root)), 'utf8'));
  assert.equal(saved.liveExecution, false);
  assert.equal(saved.jev.id, 'jev-check');
  assert.equal(saved.jev.status, 'shadow');
  assert.equal(saved.jev.weight, 0);
  assert.equal(saved.jev.liveExecution, false);
  assert.equal(saved.jev.blocksEntries, false);
  assert.match(saved.jev.note, /Weight is 1 only when the existing edge gate clears/);
  const cards = challengerRows(saved);
  assert.equal(cards.find((row) => row.id === 'jev-check').status, 'shadow');
  assert.equal(cards.find((row) => row.id === 'jev-check').weight, 0);
  assert.equal(cards.find((row) => row.id === 'rest-maker').status, 'shadow');
  assert.equal(cards.find((row) => row.id === 'mom-settle').status, 'shadow');
});

test('the key is an env var on the meme step and is not logged', () => {
  const yml = readFileSync(fileURLToPath(new URL('.github/workflows/kalshi-15m.yml', root)), 'utf8');
  const snap = readFileSync(fileURLToPath(new URL('runner/snapshot-meme.mjs', root)), 'utf8');
  const client = readFileSync(fileURLToPath(new URL('engine/jev.js', root)), 'utf8');
  const push = readFileSync(fileURLToPath(new URL('runner/push-snapshot.sh', root)), 'utf8');
  assert.match(yml, /TYPESAFE_API_KEY: \$\{\{ secrets\.TYPESAFE_API_KEY \}\}/);
  assert.equal(yml.split('TYPESAFE_API_KEY').length - 1, 2);
  assert.doesNotMatch(yml, /echo[^\n]*TYPESAFE/);
  assert.match(snap, /delete env\.TYPESAFE_API_KEY/);
  assert.doesNotMatch(snap, /console\.log\([^)]*TYPESAFE_API_KEY/);
  assert.doesNotMatch(client, /console\./);
  assert.match(push, /data\/jev-cache\.json/);
  const app = readFileSync(fileURLToPath(new URL('app.js', root)), 'utf8');
  assert.match(app, /Jev check starts at weight 0/);
  assert.match(app, /live_execution stays off/);
  assert.equal(fs.readFileSync(fileURLToPath(new URL('data/jev-cache.json', root)), 'utf8').includes('Bearer'), false);
});

test('an old unknown is asked once more, and a new unknown is kept', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonResponse(answer(calls === 1 ? 'pass' : 'unknown'));
  };
  const cache = new Map([
    ['OLD', { verdict: 'unknown', reason: 'unknown: X 0.10, copycat 0.10, rug 0.10', prompt: null }],
    ['NEW', { verdict: 'unknown', reason: 'unknown: X 0.10, copycat 0.10, rug 0.10', prompt: JEV_PROMPT }],
    ['HELD', { verdict: 'flag', reason: 'flag: X 0.10, copycat 0.90, rug 0.40', prompt: null }],
  ]);
  const first = await reviewCandidates([coin('OLD'), coin('NEW'), coin('HELD')], {
    cache, key: 'test-key', fetchImpl, now: '2026-11-20T00:00:00Z',
  });
  assert.equal(calls, 1);
  assert.equal(first.asked, 1);
  assert.equal(first.coins[0].jev.verdict, 'pass');
  assert.equal(first.coins[1].jev.verdict, 'unknown');
  assert.equal(first.coins[2].jev.verdict, 'flag');
  assert.equal(cache.get('OLD').prompt, JEV_PROMPT);
  assert.equal(cache.get('OLD').confidence, 0.7);
  const again = await reviewCandidates([coin('OLD')], { cache, key: 'test-key', fetchImpl });
  assert.equal(again.asked, 0);
  assert.equal(calls, 1);
  const stored = cacheFromDoc(cacheDoc(cache));
  assert.equal(stored.get('OLD').prompt, JEV_PROMPT);
  assert.equal(stored.get('NEW').verdict, 'unknown');
  const many = Array.from({ length: JEV_CALL_CAP + 1 }, (_, i) => coin('U' + i));
  const old = new Map(many.map((row) => [row.ca, { verdict: 'unknown', reason: 'unknown', prompt: null }]));
  const capped = await reviewCandidates(many, { cache: old, key: 'test-key', fetchImpl });
  assert.equal(capped.asked, JEV_CALL_CAP);
  assert.equal(capped.capped, 1);
});

test('the prompt carries DexScreener, X, RugCheck, age, liquidity, and similar tickers, and not price or the mint', async () => {
  const html = '{"created_at":"Thu Jan 11 05:47:40 +0000 2018","default_profile":false,"default_profile_image":false,"description":"A public bio.","followers_count":1200}';
  const profile = parseXProfile(html, 'example', Date.parse('2026-11-20T00:00:00Z'));
  assert.equal(profile.followers, 1200);
  assert.equal(profile.bio, 'A public bio.');
  assert.equal(profile.source, 'syndication.twitter.com');
  assert.ok(profile.ageDays > 3000);
  assert.equal(parseXProfile('<html>no user</html>', 'example'), null);
  assert.equal(xHandleFromUrls(['https://x.com/example']), 'example');
  assert.equal(xHandleFromUrls(['https://twitter.com/intent/tweet']), '');
  assert.match(xProfileUrl('example'), /^https:\/\/syndication\.twitter\.com\/srv\/timeline-profile\/screen-name\/example$/);
  const rug = rugFacts({
    mintAuthority: null,
    freezeAuthority: 'Freeze111',
    topHolders: [{ pct: 20 }, { pct: 5.5 }],
    markets: [{ lp: { lpLockedPct: 100 } }],
    price: 4,
  });
  assert.equal(rug.mint, 'no');
  assert.equal(rug.freeze, 'yes');
  assert.equal(rug.topHolderPct, 25.5);
  assert.equal(rug.lpStatus, 'locked');
  assert.equal(JSON.stringify(rug).includes('price'), false);
  const similar = similarCoins(
    { ca: 'CA', symbol: 'PEPE', name: 'Pepe Coin' },
    [{ ca: 'CA', symbol: 'PEPE', name: 'Pepe Coin' }, { ca: 'B', symbol: 'PEPE', name: 'Other Pepe' }, { ca: 'C', symbol: 'DOG', name: 'Dog' }],
  );
  assert.deepEqual(similar, [{ name: 'Other Pepe', symbol: 'PEPE' }]);
  let saw = null;
  const state = await prepareJevState({
    ca: 'MINTADDRESS',
    name: 'Example',
    symbol: 'EX',
    ageMin: 12.34,
    liq: 8000.4,
    pass: true,
  }, {
    nowMs: Date.parse('2026-11-20T00:00:00Z'),
    pair: { info: { socials: [{ type: 'twitter', url: 'https://x.com/example' }], websites: [{ url: 'https://example.com' }] } },
    profile: { description: 'A small project' },
    boards: [{ ca: 'B', symbol: 'EX', name: 'Example Two' }],
    fetchImpl: async (url) => {
      saw = url;
      if (String(url).includes('syndication.twitter.com')) return { ok: true, status: 200, text: async () => html };
      if (String(url).includes('/report')) {
        return { ok: true, status: 200, json: async () => ({ mintAuthority: null, freezeAuthority: null, lpLockedPct: 99.2, topHolders: [{ pct: 4 }] }) };
      }
      throw new Error('unexpected ' + url);
    },
  });
  assert.match(saw, /report/);
  assert.equal(state.xProfile.followers, 1200);
  assert.equal(state.rug.mint, 'no');
  assert.equal(state.rug.freeze, 'no');
  assert.equal(state.rug.lpStatus, 'locked');
  assert.equal(state.ageMin, 12.3);
  assert.equal(state.liquidityUsd, 8000);
  assert.deepEqual(state.similar, [{ name: 'Example Two', symbol: 'EX' }]);
  assert.equal(state.description, 'A small project');
  assert.equal(JSON.stringify(state).includes('MINTADDRESS'), false);
  assert.equal(JSON.stringify(state).includes('price'), false);
  let sent = null;
  await askJev(state, {
    key: 'test-key',
    fetchImpl: async (_url, init) => {
      sent = JSON.parse(init.body);
      return jsonResponse(answer('unknown'));
    },
  });
  assert.equal(sent.state.xProfile.followers, 1200);
  assert.equal(sent.state.rug.topHolderPct, 4);
  assert.match(sent.questions.verdict.instructions, /confidence/);
  assert.equal(sent.questions.verdict.type, 'choice');
  let tries = 0;
  const limited = await readXProfile('example', async () => {
    tries += 1;
    if (tries === 1) return { ok: false, status: 429, text: async () => '' };
    return { ok: true, status: 200, text: async () => html };
  }, 5000, Date.parse('2026-11-20T00:00:00Z'));
  assert.equal(tries, 2);
  assert.equal(limited.followers, 1200);
  const quiet = jevShadow([
    { pnl: 1, settledAt: '2026-11-01T00:00:00Z', jev: { verdict: 'pass', reason: 'pass' } },
    { pnl: -1, settledAt: '2026-11-01T01:00:00Z', jev: { verdict: 'unknown', reason: 'unknown' } },
  ]);
  assert.equal(quiet.unknown, 1);
  assert.equal(quiet.unknownRate, 0.5);
});
