// Early-entry scan. Paper only: no wallet, no key, no order.
// One pass is the same discovery and checks as the snapshot's early sleeve.
// The loop waits about 60 seconds and stops after 5 hours 50 minutes.
// The topic secret is read from the environment and is never printed.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { bestPair, lookupMints } from '../engine/meme.js';
import { cacheDoc, cacheFromDoc, jevCallsOnDay, jevKey, jevRunCap, noteJevCalls, prepareJevState, reviewCandidates } from '../engine/jev.js';
import { EARLY_SCAN, EARLY_SOURCES, candidatesFromSources, decideCandidate, needsChain, nextLog, readRug, rollEarlyLog, withPair } from '../engine/early.js';
import { ntfyTopic, sendPhoneAlerts } from '../engine/alerts.js';
import { createLimiter, limitedFetch, medianNumber } from '../engine/scan-limit.js';

export const FAST_INTERVAL_MS = 60 * 1000;
export const FAST_BUDGET_MS = (5 * 60 + 50) * 60 * 1000;
export const FAST_COMMIT_MS = 5 * 60 * 1000;

export function loopDecision({
  startedAt,
  now,
  lastCommitAt,
  intervalMs = FAST_INTERVAL_MS,
  budgetMs = FAST_BUDGET_MS,
  commitMs = FAST_COMMIT_MS,
}) {
  const elapsed = now - startedAt;
  if (elapsed >= budgetMs) return { done: true, commit: true, waitMs: 0 };
  const due = lastCommitAt == null || now - lastCommitAt >= commitMs;
  return { done: false, commit: due, waitMs: intervalMs };
}

export async function runFastLoop(opts) {
  const startedAt = opts.startedAt ?? opts.now();
  let lastCommitAt = opts.lastCommitAt ?? null;
  let scans = 0;
  let commits = 0;
  for (let guard = 0; guard < 4000; guard++) {
    const now = opts.now();
    const decision = loopDecision({
      startedAt,
      now,
      lastCommitAt,
      intervalMs: opts.intervalMs,
      budgetMs: opts.budgetMs,
      commitMs: opts.commitMs,
    });
    if (decision.done) {
      if (decision.commit && opts.commit) {
        await opts.commit(now);
        commits += 1;
      }
      return { scans, commits, elapsed: now - startedAt };
    }
    try {
      if (opts.scan) await opts.scan(now);
    } catch (e) {
      console.log('fast scan pass failed', safeError(e));
    }
    scans += 1;
    if (decision.commit && opts.commit) {
      await opts.commit(now);
      lastCommitAt = now;
      commits += 1;
    }
    const spent = Math.max(0, opts.now() - now);
    const wait = Math.max(0, decision.waitMs - spent);
    if (wait) await opts.sleep(wait);
    else if (!(decision.waitMs > 0)) throw new Error('fast scan interval is missing');
  }
  throw new Error('fast scan did not finish');
}

export function safeError(e) {
  const text = String(e?.message || 'error').replace(/https?:\/\/\S*ntfy\.sh\S*/gi, 'ntfy');
  if (/NTFY_TOPIC/.test(text)) return 'request failed';
  return text.slice(0, 180);
}

export function sightDoc(firstSight, at, loops = 0) {
  const rows = Object.entries(firstSight || {});
  if (rows.length > 2000) {
    rows.sort((a, b) => String(a[1]?.at || '').localeCompare(String(b[1]?.at || '')));
    for (const [ca] of rows.slice(0, rows.length - 2000)) delete firstSight[ca];
  }
  const ages = Object.values(firstSight || {}).map((row) => row.ageMin);
  return {
    paper: true,
    liveExecution: false,
    updatedAt: at || null,
    loops,
    intervalMs: FAST_INTERVAL_MS,
    firstSight: firstSight || {},
    seen: Object.keys(firstSight || {}).length,
    medianAgeMin: medianNumber(ages),
    medianUnder30Min: medianNumber(ages.filter((n) => n < 30)),
  };
}

export function noteFirstSight(state, rows, at) {
  const firstSight = { ...(state?.firstSight || {}) };
  for (const row of rows || []) {
    if (!row?.ca || firstSight[row.ca]) continue;
    if (!Number.isFinite(row.ageMin) || row.ageMin < 0) continue;
    const sources = row.sources || (row.source ? [row.source] : []);
    firstSight[row.ca] = {
      at,
      ageMin: Math.round(row.ageMin * 10) / 10,
      symbol: row.symbol || '?',
      source: sources[0] || null,
    };
  }
  return sightDoc(firstSight, at, state?.loops || 0);
}

export function mergeSightDocs(a, b) {
  const firstSight = { ...(a?.firstSight || {}) };
  for (const [ca, row] of Object.entries(b?.firstSight || {})) {
    if (!row || !Number.isFinite(row.ageMin)) continue;
    const prev = firstSight[ca];
    if (!prev || (row.at && (!prev.at || String(row.at) < String(prev.at)))) firstSight[ca] = { ...row };
  }
  const at = [a?.updatedAt, b?.updatedAt].filter(Boolean).sort().pop() || null;
  return sightDoc(firstSight, at, Math.max(Number(a?.loops) || 0, Number(b?.loops) || 0));
}

export function mergeEarlyBoards(a, b) {
  const ta = Date.parse(a?.fetchedAt || '') || 0;
  const tb = Date.parse(b?.fetchedAt || '') || 0;
  const pick = tb >= ta ? (b || a) : (a || b);
  return pick || { paper: true, liveExecution: false, coins: [] };
}

function attachJev(decisions, review, { key, cap }) {
  const byCa = new Map((review?.coins || []).map((row) => [row.ca, row]));
  return decisions.map((row) => {
    if (row.action !== 'enter') return row;
    const found = byCa.get(row.ca);
    if (found?.jev) return { ...row, jev: found.jev };
    if (!key || cap <= 0) return row;
    return { ...row, jevPending: true };
  });
}

export async function scanEarly(opts) {
  const log = opts.log || ((line) => console.log(line));
  const limited = limitedFetch(opts.fetchImpl, opts.limiter, opts.sleep);
  const now = opts.now;
  const at = new Date(now).toISOString();
  const sources = [];
  for (const source of EARLY_SOURCES) {
    try {
      const res = await limited(source.url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
      const text = await res.text();
      let body = null;
      try { body = JSON.parse(text); } catch { body = null; }
      sources.push({ id: source.id, ok: !!(res.ok && body != null), status: res.status, body: res.ok ? body : null });
    } catch (e) {
      sources.push({ id: source.id, ok: false, status: 0, body: null, error: safeError(e) });
    }
  }
  let rows = candidatesFromSources(sources, now);
  let sight = noteFirstSight(opts.sight, rows, at);
  const meta = new Map();
  const needPair = rows.filter((row) => row.liq == null || row.ageMin == null || !(row.priceUsd > 0)).slice(0, 30);
  if (needPair.length) {
    try {
      const res = await limited('https://api.dexscreener.com/latest/dex/tokens/' + needPair.map((row) => row.ca).join(','), {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
      const book = res.ok ? await res.json() : { pairs: [] };
      for (const row of needPair) meta.set(row.ca, { pair: bestPair(book?.pairs || [], row.ca) });
    } catch (e) {
      log(`early pairs ${safeError(e)}`);
    }
  }
  rows = rows.map((row) => withPair(row, meta.get(row.ca)?.pair, now));
  sight = noteFirstSight(sight, rows, at);
  const wanted = rows.filter((row) => needsChain(row)).sort((a, b) => a.ageMin - b.ageMin).slice(0, EARLY_SCAN);
  const wantedSet = new Set(wanted.map((row) => row.ca));
  let safety = new Map();
  if (wanted.length) {
    try {
      safety = await lookupMints(wanted.map((row) => row.ca), meta, { budgetMs: 20000, fetchImpl: limited });
    } catch (e) {
      log(`early rpc ${safeError(e)}`);
    }
  }
  const rugs = new Map();
  for (const row of wanted) {
    try {
      rugs.set(row.ca, await readRug(row.ca, limited));
    } catch (e) {
      rugs.set(row.ca, { known: false, locked: null, pct: null, error: safeError(e) });
    }
  }
  let decisions = rows.map((row) => {
    const checked = wantedSet.has(row.ca);
    return decideCandidate(row, {
      checkedSafety: checked,
      safety: safety.get(row.ca),
      checkedLp: checked,
      lp: rugs.get(row.ca),
    });
  });
  const callDoc = opts.callDoc || { paper: true, liveExecution: false, batches: [] };
  const day = at.slice(0, 10);
  const runCap = jevRunCap(callDoc, day);
  const cache = opts.cache instanceof Map ? opts.cache : new Map();
  const key = jevKey(opts.env);
  let asked = 0;
  let reviewedOk = false;
  try {
    const enters = decisions.filter((row) => row.action === 'enter').map((row) => ({ ...row, pass: true }));
    const review = await reviewCandidates(enters, {
      cache,
      cap: runCap,
      key,
      fetchImpl: limited,
      now: at,
      budgetMs: opts.budgetMs ?? 20000,
      prepare: (coin) => prepareJevState(coin, {
        pair: meta.get(coin.ca)?.pair || null,
        boards: rows.map((item) => ({ ca: item.ca, name: item.name, symbol: item.symbol })),
        fetchImpl: limited,
        nowMs: now,
      }),
    });
    asked = review.asked;
    reviewedOk = true;
    decisions = attachJev(decisions, review, { key, cap: runCap });
    log(`jev asked=${review.asked} http=${review.http} skipped=${review.skipped} capped=${review.capped} daily=${jevCallsOnDay(callDoc, day) + review.asked}`);
  } catch (e) {
    log(`jev skipped ${safeError(e)}`);
  }
  if (!reviewedOk) decisions = decisions.map((row) => (row.action === 'enter' ? { ...row, jevPending: true } : row));
  const nextCalls = asked > 0
    ? noteJevCalls(callDoc, day, asked, opts.callId || `${at}#fast`, at)
    : callDoc;
  const alerts = await sendPhoneAlerts(decisions, {
    env: opts.env,
    state: opts.alertState,
    now,
    fetchImpl: opts.fetchImpl,
  });
  if (!ntfyTopic(opts.env)) {
    if (opts.notice && !opts.notice.missingTopic) {
      opts.notice.missingTopic = true;
      log('phone alerts off, topic secret is missing');
    }
  } else if (alerts.delivered) {
    for (const ca of alerts.sent) {
      const row = decisions.find((item) => item.ca === ca);
      log(`phone alert ${row?.symbol || '?'} ${ca}`);
    }
  }
  const tally = { enter: 0, pass: 0, kill: 0 };
  for (const row of decisions) if (tally[row.action] != null) tally[row.action] += 1;
  log(`early ${JSON.stringify(tally)} medianAgeMin=${sight.medianAgeMin ?? 'none'} medianUnder30Min=${sight.medianUnder30Min ?? 'none'} seen=${sight.seen}`);
  return {
    sources,
    decisions,
    sight,
    cache,
    callDoc: nextCalls,
    alertState: alerts.state,
    sent: alerts.sent,
    asked,
  };
}

function dataDir() {
  return process.env.FAST_SCAN_DATA || 'data';
}

function readJson(name, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir(), name), 'utf8')); }
  catch { return fallback; }
}

function writeJson(name, doc) {
  fs.mkdirSync(dataDir(), { recursive: true });
  const file = path.join(dataDir(), name);
  const next = JSON.stringify(doc, null, 2) + '\n';
  const prev = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (next !== prev) fs.writeFileSync(file, next);
}

function readEarlyLog() {
  const file = path.join(dataDir(), 'early-log.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function writePass(result, at) {
  writeJson('early-board.json', {
    fetchedAt: at,
    paper: true,
    liveExecution: false,
    sources: (result.sources || []).map((source) => ({ id: source.id, ok: !!source.ok, status: source.status ?? null })),
    coins: result.decisions,
  });
  const prev = readEarlyLog();
  const extra = nextLog(prev, result.decisions, at);
  let priorSummary = null;
  try { priorSummary = JSON.parse(fs.readFileSync(path.join(dataDir(), 'early-log-summary.json'), 'utf8')); } catch { priorSummary = null; }
  const rolled = rollEarlyLog(prev, extra, priorSummary);
  if (rolled.rewritten) {
    const body = rolled.rows.map((row) => JSON.stringify(row)).join('\n');
    fs.writeFileSync(path.join(dataDir(), 'early-log.jsonl'), body ? body + '\n' : '');
    if (rolled.summary) writeJson('early-log-summary.json', rolled.summary);
  } else if (extra.length) {
    fs.appendFileSync(path.join(dataDir(), 'early-log.jsonl'), extra.map((row) => JSON.stringify(row)).join('\n') + '\n');
  }
  writeJson('jev-cache.json', cacheDoc(result.cache));
  writeJson('jev-calls.json', result.callDoc);
  writeJson('phone-alerts.json', result.alertState);
  writeJson('fast-scan.json', { ...result.sight, paper: true, liveExecution: false });
}

function pushFast() {
  const env = { ...process.env, SNAP_MODE: 'fast' };
  delete env.NTFY_TOPIC;
  delete env.TYPESAFE_API_KEY;
  try {
    execFileSync('bash', ['runner/push-snapshot.sh'], { stdio: 'inherit', env });
  } catch (e) {
    console.log('fast scan push failed', e.status ?? '');
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const once = process.env.FAST_SCAN_ONCE === '1';
  const publish = !process.env.FAST_SCAN_DATA && process.env.FAST_SCAN_DRY !== '1';
  let cache = new Map();
  try { cache = cacheFromDoc(readJson('jev-cache.json', {})); } catch { cache = new Map(); }
  let calls = readJson('jev-calls.json', { paper: true, liveExecution: false, batches: [] });
  let alerts = readJson('phone-alerts.json', { paper: true, liveExecution: false, sent: [] });
  let sight = readJson('fast-scan.json', { paper: true, liveExecution: false, firstSight: {}, loops: 0 });
  const limiter = createLimiter({ clock: Date.now, sleep });
  const notice = { missingTopic: false };
  const scan = async (now) => {
    const at = new Date(now).toISOString();
    const result = await scanEarly({
      fetchImpl: globalThis.fetch,
      now,
      limiter,
      sleep,
      env: process.env,
      cache,
      callDoc: calls,
      alertState: alerts,
      sight,
      callId: `${at}#fast#${randomBytes(4).toString('hex')}`,
      notice,
    });
    cache = result.cache;
    calls = result.callDoc;
    alerts = result.alertState;
    sight = { ...result.sight, loops: (Number(sight.loops) || 0) + 1 };
    result.sight = sight;
    if (publish || process.env.FAST_SCAN_DATA) writePass(result, at);
  };
  if (once) {
    await scan(Date.now());
    return;
  }
  await runFastLoop({ now: Date.now, sleep, scan, commit: async () => { if (publish) pushFast(); } });
}

const invoked = process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href;
if (invoked) await main();
