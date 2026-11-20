import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JEV_CALL_CAP, JEV_DAILY_CAP, jevCallsOnDay, jevRunCap, mergeJevCalls, noteJevCalls } from '../engine/jev.js';
import { HOST_GAP_MS, createLimiter, limitedFetch } from '../engine/scan-limit.js';
import {
  FAST_BUDGET_MS, FAST_COMMIT_MS, FAST_INTERVAL_MS, loopDecision, runFastLoop, scanEarly,
} from '../runner/fast-scan.mjs';

test('the loop waits 60s, commits about every 5 min, and stops at 5h50m', async () => {
  assert.equal(FAST_INTERVAL_MS, 60 * 1000);
  assert.equal(FAST_COMMIT_MS, 5 * 60 * 1000);
  assert.equal(FAST_BUDGET_MS, (5 * 60 + 50) * 60 * 1000);
  const opened = loopDecision({ startedAt: 0, now: 0, lastCommitAt: null });
  assert.equal(opened.done, false);
  assert.equal(opened.commit, true);
  assert.equal(opened.waitMs, FAST_INTERVAL_MS);
  const early = loopDecision({ startedAt: 0, now: FAST_INTERVAL_MS, lastCommitAt: 0 });
  assert.equal(early.commit, false);
  const fifth = loopDecision({ startedAt: 0, now: FAST_COMMIT_MS, lastCommitAt: 0 });
  assert.equal(fifth.commit, true);
  assert.equal(loopDecision({ startedAt: 0, now: FAST_BUDGET_MS, lastCommitAt: 0 }).done, true);
  let now = 0;
  const commits = [];
  const sleeps = [];
  const result = await runFastLoop({
    startedAt: 0,
    now: () => now,
    sleep: async (ms) => { sleeps.push(ms); now += ms; },
    scan: async () => {},
    commit: async (t) => { commits.push(t); },
  });
  assert.equal(result.scans, 350);
  assert.equal(result.elapsed, FAST_BUDGET_MS);
  assert.equal(sleeps.length, 350);
  assert.equal(sleeps.every((ms) => ms === FAST_INTERVAL_MS), true);
  assert.equal(commits[0], 0);
  assert.equal(commits[1], FAST_COMMIT_MS);
  assert.equal(commits.at(-1), FAST_BUDGET_MS);
  for (let i = 1; i < commits.length; i++) assert.ok(commits[i] - commits[i - 1] >= FAST_COMMIT_MS);
});

test('DexScreener and GeckoTerminal keep their gaps, and a 429 backs off', async () => {
  assert.equal(HOST_GAP_MS['api.geckoterminal.com'], 7000);
  assert.equal(HOST_GAP_MS['api.dexscreener.com'], 1100);
  assert.equal(HOST_GAP_MS['api.rugcheck.xyz'], 1200);
  let now = 0;
  const sleeps = [];
  const sleep = async (ms) => { sleeps.push(ms); now += ms; };
  const limiter = createLimiter({ clock: () => now, sleep });
  await limiter.wait('https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=1');
  await limiter.wait('https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=1');
  assert.equal(sleeps[0], 7000);
  let dexNow = 0;
  const dexSleeps = [];
  const dexLimiter = createLimiter({
    clock: () => dexNow,
    sleep: async (ms) => { dexSleeps.push(ms); dexNow += ms; },
  });
  await dexLimiter.wait('https://api.dexscreener.com/token-boosts/latest/v1');
  await dexLimiter.wait('https://api.dexscreener.com/token-profiles/latest/v1');
  assert.deepEqual(dexSleeps, [1100]);
  let hits = 0;
  const fetchImpl = async (url) => {
    hits += 1;
    if (String(url).includes('pump.fun')) return { ok: false, status: 403, headers: { get: () => null }, text: async () => '<html>' };
    if (hits === 1) return { ok: false, status: 429, headers: { get: (name) => (name === 'retry-after' ? '2' : null) }, text: async () => '' };
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => '{"ok":true}', json: async () => ({ ok: true }) };
  };
  const limited = limitedFetch(fetchImpl, limiter, sleep);
  const ok = await limited('https://api.rugcheck.xyz/v1/tokens/MINT/report/summary');
  assert.equal(ok.ok, true);
  assert.equal(hits, 2);
  assert.ok(sleeps.includes(2000));
  const before = hits;
  const blocked = await limited('https://frontend-api-v3.pump.fun/coins/latest');
  assert.equal(blocked.status, 403);
  assert.equal(hits, before + 1);
});

test('Jev stays at 20 a run and stops at 100 a UTC day', () => {
  assert.equal(JEV_DAILY_CAP, 100);
  assert.equal(JEV_CALL_CAP, 20);
  const day = '2026-11-20';
  let doc = noteJevCalls({ batches: [] }, day, 20, 'run-a', `${day}T00:00:00Z`);
  assert.equal(jevRunCap(doc, day), 20);
  doc = noteJevCalls(doc, day, 79, 'run-b', `${day}T01:00:00Z`);
  assert.equal(jevCallsOnDay(doc, day), 99);
  assert.equal(jevRunCap(doc, day), 1);
  doc = noteJevCalls(doc, day, 1, 'run-c', `${day}T02:00:00Z`);
  assert.equal(jevRunCap(doc, day), 0);
  const doubled = noteJevCalls(doc, day, 50, 'run-c', `${day}T02:00:00Z`);
  assert.equal(jevCallsOnDay(doubled, day), 100);
  const merged = mergeJevCalls(doc, noteJevCalls({ batches: [] }, day, 5, 'run-d', `${day}T03:00:00Z`));
  assert.equal(jevCallsOnDay(merged, day), 105);
  assert.equal(jevCallsOnDay(noteJevCalls(doc, '2026-11-17', 9, 'old', '2026-11-17T00:00:00Z'), day), 100);
  const snap = readFileSync(new URL('../runner/snapshot-meme.mjs', import.meta.url), 'utf8');
  assert.match(snap, /jevRunCap/);
  assert.match(snap, /JEV_CALL_CAP - reviewed\.asked/);
});

test('one mocked pass records age and does not print the topic', async () => {
  const now = Date.parse('2026-11-20T12:00:00Z');
  const topic = 'deskTopic1';
  const logs = [];
  let ntfy = 0;
  const gecko = {
    data: [{
      relationships: { base_token: { data: { id: 'solana_MINTGECKO' } } },
      attributes: { name: 'NEW / SOL', pool_created_at: new Date(now - 4 * 60000).toISOString() },
    }],
  };
  const fetchImpl = async (url) => {
    if (String(url).includes('ntfy.sh')) ntfy += 1;
    const body = String(url).includes('geckoterminal') ? gecko : (String(url).includes('/tokens/') ? { pairs: [] } : []);
    const text = JSON.stringify(body);
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => text, json: async () => body };
  };
  let clock = 0;
  const sleep = async (ms) => { clock += ms; };
  const limiter = createLimiter({ clock: () => clock, sleep });
  const result = await scanEarly({
    fetchImpl,
    now,
    limiter,
    sleep,
    env: { NTFY_TOPIC: topic },
    sight: { paper: true, firstSight: {}, loops: 0 },
    alertState: { sent: [] },
    log: (line) => logs.push(line),
    notice: {},
  });
  assert.equal(ntfy, 0);
  assert.equal(logs.join('\n').includes(topic), false);
  assert.equal(result.sight.firstSight.MINTGECKO.ageMin, 4);
  assert.equal(result.sight.medianAgeMin, 4);
  assert.equal(result.sent.length, 0);
  const quiet = [];
  await scanEarly({
    fetchImpl,
    now,
    limiter: createLimiter({ clock: () => 0, sleep: async () => {} }),
    sleep: async () => {},
    env: {},
    sight: { firstSight: {} },
    log: (line) => quiet.push(line),
    notice: {},
  });
  assert.match(quiet.join('\n'), /topic secret is missing/);
});

test('the workflow is one long run, every 6 hours, and the chain can start it', () => {
  const yml = readFileSync(new URL('../.github/workflows/fast-scan.yml', import.meta.url), 'utf8');
  const chain = readFileSync(new URL('../.github/workflows/kalshi-15m.yml', import.meta.url), 'utf8');
  const push = readFileSync(new URL('../runner/push-snapshot.sh', import.meta.url), 'utf8');
  const queue = readFileSync(new URL('../runner/queue-fast-scan.sh', import.meta.url), 'utf8');
  const scan = readFileSync(new URL('../runner/fast-scan.mjs', import.meta.url), 'utf8');
  assert.match(yml, /workflow_dispatch:/);
  assert.match(yml, /cron: '11 \*\/6 \* \* \*'/);
  assert.match(yml, /group: early-fast-scan/);
  assert.match(yml, /cancel-in-progress: false/);
  assert.match(yml, /timeout-minutes: 360/);
  assert.match(yml, /NTFY_TOPIC: \$\{\{ secrets\.NTFY_TOPIC \}\}/);
  assert.match(yml, /TYPESAFE_API_KEY: \$\{\{ secrets\.TYPESAFE_API_KEY \}\}/);
  assert.doesNotMatch(yml, /echo[^\n]*NTFY/);
  assert.match(chain, /bash runner\/queue-fast-scan\.sh/);
  assert.match(queue, /fast-scan\.yml/);
  assert.match(queue, /queue-next\.mjs/);
  assert.match(push, /git rebase origin\/main/);
  assert.match(push, /SNAP_MODE/);
  assert.match(push, /merge-scan\.mjs/);
  assert.match(scan, /delete env\.NTFY_TOPIC/);
  assert.doesNotMatch(scan, /console\.log\([^)]*NTFY_TOPIC/);
  assert.doesNotMatch(scan, /privateKey|secretKey|signTransaction/);
});
