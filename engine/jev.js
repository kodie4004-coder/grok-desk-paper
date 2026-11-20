// Jev shadow check. Paper only. This module cannot sign, connect a wallet,
// or send an order. A verdict never opens or blocks a trade.
// The request shape is TypeSafe System One: POST /v1/systemone, model id
// jev-1.14.0 (the current target of the jev-latest alias). One request asks
// the three fuzzy questions and a choice verdict. Weight moves only when
// graduates() clears. A missing API key is a no-op.

import { clusterBootstrap } from './eval.js';
import { graduates } from './strategies.js';

export const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
export const JEV_MODEL = 'jev-1.14.0';
export const JEV_CALL_CAP = 20;
export const JEV_TIMEOUT_MS = 8000;
export const JEV_RUN_BUDGET_MS = 35000;
export const JEV_ID = 'jev-check';

const VERDICTS = new Set(['pass', 'flag', 'unknown']);

export const JEV_QUESTIONS = {
  x_account: {
    type: 'noul',
    instructions: 'Is the linked X account plausibly legitimate and the real project behind this coin?',
    criteria: {
      true: 'A linked X account is present and it plausibly belongs to this project.',
      false: 'No X account is linked, or the link does not plausibly belong to this project.',
    },
  },
  copycat: {
    type: 'noul',
    instructions: 'Is this coin a copycat or an impersonation of an existing ticker or narrative?',
    criteria: {
      true: 'The name, ticker, or description copies or impersonates an existing coin, brand, or narrative.',
      false: 'Nothing in the name, ticker, or description shows a copy or an impersonation.',
    },
  },
  rug: {
    type: 'noul',
    instructions: 'Does the description show an obvious rug red flag?',
    criteria: {
      true: 'The description has an obvious rug red flag, such as a guaranteed return, a hidden mint, or a demand to hurry.',
      false: 'The description has no obvious rug red flag.',
    },
  },
  verdict: {
    type: 'choice',
    instructions: 'From the name, ticker, description, and linked accounts only, choose one paper-safety verdict. Ignore price.',
    criteria: {
      pass: 'The linked X account is plausibly the real project, the coin is not a copycat or impersonation, and the description has no obvious rug red flag.',
      flag: 'The linked X account is not plausibly the real project, or the coin is a copycat or impersonation, or the description has an obvious rug red flag.',
      unknown: 'The text does not say enough to judge the X account, a copycat, or a rug.',
    },
  },
};

export function jevKey(env) {
  const source = env || (typeof process === 'undefined' ? undefined : process.env);
  const key = source?.TYPESAFE_API_KEY;
  if (typeof key !== 'string') return '';
  return key.trim();
}

function clip(value, max) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function httpUrl(value) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return '';
  return value.slice(0, 200);
}

export function jevState(coin) {
  const socials = [];
  const seen = new Set();
  for (const row of coin?.socials || []) {
    const url = httpUrl(row?.url);
    if (!url || seen.has(url.toLowerCase())) continue;
    seen.add(url.toLowerCase());
    socials.push({ type: clip(row?.type || 'link', 40), url });
    if (socials.length >= 8) break;
  }
  const websites = [];
  for (const row of coin?.websites || []) {
    const url = httpUrl(typeof row === 'string' ? row : row?.url);
    if (!url || websites.includes(url)) continue;
    websites.push(url);
    if (websites.length >= 8) break;
  }
  return {
    name: clip(coin?.name, 120),
    symbol: clip(coin?.symbol, 32),
    description: clip(coin?.description, 2000),
    websites,
    socials,
  };
}

export function describeCoin({ coin, pair, profile } = {}) {
  const socials = [];
  const websites = [];
  const addSocial = (type, url) => socials.push({ type, url });
  const addSite = (url) => websites.push(url);
  for (const row of pair?.info?.socials || []) addSocial(row?.type, row?.url);
  for (const row of profile?.links || []) {
    const kind = String(row?.type || row?.label || '');
    if (/website/i.test(kind)) addSite(row?.url);
    else addSocial(kind, row?.url);
  }
  for (const row of pair?.info?.websites || []) addSite(row?.url || row);
  const description = [profile?.description, pair?.info?.description].find((text) => typeof text === 'string' && text.trim()) || '';
  return jevState({
    name: coin?.name,
    symbol: coin?.symbol,
    description,
    socials,
    websites,
  });
}

function unit(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function noulAnswer(answer) {
  if (!answer || answer.type !== 'noul' || !unit(answer.noul)) return null;
  return answer.noul;
}

export function parseVerdict(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const answers = body.answers;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return null;
  const x = noulAnswer(answers.x_account);
  const copycat = noulAnswer(answers.copycat);
  const rug = noulAnswer(answers.rug);
  const verdict = answers.verdict;
  if (x == null || copycat == null || rug == null) return null;
  if (!verdict || verdict.type !== 'choice' || !VERDICTS.has(verdict.choice)) return null;
  if (!unit(verdict.confidence) || !verdict.probabilities || typeof verdict.probabilities !== 'object' || Array.isArray(verdict.probabilities)) return null;
  const fmt = (n) => n.toFixed(2);
  return {
    verdict: verdict.choice,
    reason: `${verdict.choice}: X ${fmt(x)}, copycat ${fmt(copycat)}, rug ${fmt(rug)}`,
  };
}

export function jevStamp(jev) {
  if (!jev || !VERDICTS.has(jev.verdict)) return null;
  return { verdict: jev.verdict, reason: clip(jev.reason, 160) };
}

function failure(reason, attempts, extra = {}) {
  return { ok: false, skipped: false, verdict: 'unknown', reason, attempts, ...extra };
}

async function once(key, state, fetchImpl, timeoutMs) {
  const res = await fetchImpl(JEV_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ model: JEV_MODEL, state, questions: JEV_QUESTIONS }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    err.retry = res.status === 429 || res.status >= 500;
    throw err;
  }
  let body;
  try { body = JSON.parse(text); }
  catch {
    const err = new Error('malformed JSON');
    err.malformed = true;
    throw err;
  }
  const parsed = parseVerdict(body);
  if (!parsed) {
    const err = new Error('malformed JSON');
    err.malformed = true;
    throw err;
  }
  return { ...parsed, model: typeof body.model === 'string' && body.model ? body.model : JEV_MODEL };
}

export async function askJev(state, opts = {}) {
  const key = opts.key == null ? jevKey(opts.env) : String(opts.key || '').trim();
  if (!key) return { ok: false, skipped: true, verdict: 'unknown', reason: 'no key', attempts: 0 };
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? JEV_TIMEOUT_MS;
  let last = failure('request failed', 1);
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const parsed = await once(key, state, fetchImpl, timeoutMs);
      return { ok: true, skipped: false, attempts: attempt, ...parsed };
    } catch (e) {
      const timed = e?.name === 'TimeoutError' || e?.name === 'AbortError';
      const malformed = !!e?.malformed;
      const reason = malformed ? 'malformed JSON' : timed ? 'timeout' : (e?.status ? `HTTP ${e.status}` : 'request failed');
      last = failure(reason, attempt, { malformed, timeout: timed });
      const retry = attempt === 1 && !malformed && (timed || e?.retry || !e?.status);
      if (!retry) return last;
    }
  }
  return last;
}

export async function reviewCandidates(coins, opts = {}) {
  const cache = opts.cache instanceof Map ? opts.cache : new Map();
  const cap = Number.isFinite(opts.cap) ? opts.cap : JEV_CALL_CAP;
  const budgetMs = Number.isFinite(opts.budgetMs) ? opts.budgetMs : JEV_RUN_BUDGET_MS;
  const deadline = Date.now() + Math.max(0, budgetMs);
  const key = opts.key == null ? jevKey(opts.env) : String(opts.key || '').trim();
  let asked = 0;
  let http = 0;
  let skipped = 0;
  let capped = 0;
  const out = [];
  for (const coin of coins || []) {
    const ca = coin?.ca;
    if (!ca) { out.push(coin); continue; }
    const cached = jevStamp(cache.get(ca));
    if (cached) { out.push({ ...coin, jev: cached }); continue; }
    if (!coin.pass) { out.push(coin); continue; }
    if (!key) { skipped += 1; out.push(coin); continue; }
    if (asked >= cap || Date.now() >= deadline) { capped += 1; out.push(coin); continue; }
    const state = typeof opts.describe === 'function' ? opts.describe(coin) : jevState(coin);
    const result = await askJev(state, { key, fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs, env: opts.env });
    asked += 1;
    http += result.attempts || 0;
    const stamp = result.ok ? jevStamp(result) : null;
    if (stamp) {
      cache.set(ca, { ...stamp, model: result.model || JEV_MODEL, askedAt: opts.now || new Date().toISOString() });
      out.push({ ...coin, jev: stamp });
    } else out.push(coin);
  }
  return { coins: out, cache, asked, http, skipped, capped };
}

export function cacheFromDoc(doc) {
  const map = new Map();
  const verdicts = doc?.verdicts;
  if (!verdicts || typeof verdicts !== 'object' || Array.isArray(verdicts)) return map;
  for (const [ca, row] of Object.entries(verdicts)) {
    const stamp = jevStamp(row);
    if (!ca || !stamp) continue;
    map.set(ca, {
      ...stamp,
      model: typeof row.model === 'string' ? row.model : JEV_MODEL,
      askedAt: typeof row.askedAt === 'string' ? row.askedAt : null,
    });
  }
  return map;
}

export function cacheDoc(map) {
  const verdicts = {};
  for (const [ca, row] of map || []) {
    const stamp = jevStamp(row);
    if (!stamp) continue;
    verdicts[ca] = { ...stamp, model: row.model || JEV_MODEL, askedAt: row.askedAt || null };
  }
  return { paper: true, model: JEV_MODEL, verdicts };
}

function meanOf(rows) {
  if (!rows.length) return null;
  return rows.reduce((sum, row) => sum + row.pnl, 0) / rows.length;
}

function vetoWindows(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = String(row.settledAt || '').slice(0, 10);
    if (!key || row.pnl == null) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, list]) => {
    const boot = clusterBootstrap(list.map((row) => ({ pnl: row.pnl, pool: row.ca || '?' })), { iters: 200, seed: 7, qLo: 0.05, qHi: 0.95 });
    return { key, seen: false, n: list.length, mean: boot.mean, lo: boot.lo, hi: boot.hi };
  });
}

// Baseline is every settled paper trade that has a verdict. The veto book
// drops flags and keeps unknowns. graduates() is the only way weight leaves 0.
export function jevShadow(rows) {
  const asked = (rows || []).filter((row) => row && row.pnl != null && jevStamp(row.jev));
  const kept = asked.filter((row) => row.jev.verdict !== 'flag');
  const windows = vetoWindows(kept);
  const weight = graduates(windows) ? 1 : 0;
  return {
    id: JEV_ID,
    name: 'Jev check',
    status: 'shadow',
    role: 'challenger',
    weight,
    paper: true,
    blocksEntries: false,
    liveExecution: false,
    n: asked.length,
    baselineMean: meanOf(asked),
    mean: meanOf(kept),
    vetoN: kept.length,
    flagged: asked.filter((row) => row.jev.verdict === 'flag').length,
    unknown: asked.filter((row) => row.jev.verdict === 'unknown').length,
    pass: asked.filter((row) => row.jev.verdict === 'pass').length,
    note: 'Shadow only. A flag is left out of this mean and stays in the baseline. Unknown is not a veto. Weight is 1 only when the existing edge gate clears on this book. This bot does not place or block a trade.',
  };
}
