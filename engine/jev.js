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
export const JEV_PROMPT = 'context-v2';
export const X_PROFILE_URL = 'https://syndication.twitter.com/srv/timeline-profile/screen-name/';
export const RUG_REPORT_URL = 'https://api.rugcheck.xyz/v1/tokens';

const VERDICTS = new Set(['pass', 'flag', 'unknown']);

export const JEV_QUESTIONS = {
  x_account: {
    type: 'noul',
    instructions: 'Using the linked X account and the public profile facts when they are present (followers, account age, bio), is that account plausibly legitimate and the real project behind this coin?',
    criteria: {
      true: 'A linked X account is present and the profile facts, when supplied, fit this project.',
      false: 'No X account is linked, or the link or the profile facts do not plausibly belong to this project.',
    },
  },
  copycat: {
    type: 'noul',
    instructions: 'Using the name, ticker, description, and the similar coins listed from our boards, is this coin a copycat or an impersonation of an existing ticker or narrative?',
    criteria: {
      true: 'The name, ticker, description, or a listed similar coin shows a copy or an impersonation.',
      false: 'Nothing in the name, ticker, description, or the listed similar coins shows a copy or an impersonation.',
    },
  },
  rug: {
    type: 'noul',
    instructions: 'Using the RugCheck summary (mint authority, freeze authority, top-holder percent, LP status) and the description, does this coin show an obvious rug red flag?',
    criteria: {
      true: 'The RugCheck summary or the description has an obvious rug red flag, such as a live mint, a live freeze, an unlocked LP, a concentrated holder, a guaranteed return, or a demand to hurry.',
      false: 'The RugCheck summary and the description have no obvious rug red flag.',
    },
  },
  verdict: {
    type: 'choice',
    instructions: 'Choose one paper-safety verdict from the DexScreener description and links, the X profile facts, the RugCheck summary, the age, the liquidity, and the similar tickers. The choice includes a confidence from 0 to 1. Ignore price.',
    criteria: {
      pass: 'The linked X account is plausibly the real project, the coin is not a copycat or impersonation, and neither the description nor the RugCheck summary shows an obvious rug red flag.',
      flag: 'The linked X account is not plausibly the real project, or the coin is a copycat or impersonation, or the description or the RugCheck summary shows an obvious rug red flag.',
      unknown: 'The supplied DexScreener text, X profile, RugCheck summary, age, liquidity, and similar tickers still do not say enough.',
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
    confidence: verdict.confidence,
    reason: `${verdict.choice}: X ${fmt(x)}, copycat ${fmt(copycat)}, rug ${fmt(rug)}`,
  };
}

export function jevStamp(jev) {
  if (!jev || !VERDICTS.has(jev.verdict)) return null;
  const stamp = { verdict: jev.verdict, reason: clip(jev.reason, 160) };
  if (unit(jev.confidence)) stamp.confidence = jev.confidence;
  return stamp;
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

export function xHandleFromUrls(urls) {
  for (const url of urls || []) {
    const match = String(url || '').match(/(?:https?:\/\/)?(?:www\.)?(?:x\.com|twitter\.com)\/([A-Za-z0-9_]{1,15})(?:\/|$|\?|#)/i);
    if (!match) continue;
    if (/^(intent|share|home|search|i|hashtag)$/i.test(match[1])) continue;
    return match[1];
  }
  return '';
}

export function parseXProfile(html, handle, now = Date.now()) {
  const text = String(html || '');
  const match = text.match(/"created_at":"([^"]+)","default_profile":(?:true|false),"default_profile_image":(?:true|false),"description":"((?:\\.|[^"\\])*)"[\s\S]{0,1200}?"followers_count":(\d+)/);
  if (!match) return null;
  const created = Date.parse(match[1]);
  const followers = Number(match[3]);
  if (!Number.isFinite(created) || !Number.isFinite(followers) || created > now) return null;
  const bio = match[2].replace(/\\n/g, ' ').replace(/\\"/g, '"').replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))).replace(/\s+/g, ' ').trim().slice(0, 240);
  return {
    handle: handle || '',
    followers,
    createdAt: new Date(created).toISOString(),
    ageDays: Math.max(0, Math.floor((now - created) / 86400000)),
    bio,
    source: 'syndication.twitter.com',
  };
}

export function xProfileUrl(handle) {
  return `${X_PROFILE_URL}${encodeURIComponent(handle)}`;
}

export async function readXProfile(handle, fetchImpl, timeoutMs = 5000, now = Date.now()) {
  if (!handle || typeof fetchImpl !== 'function') return null;
  const url = xProfileUrl(handle);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchImpl(url, {
        headers: { accept: 'text/html,application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 429 || res.status === 503) {
        if (attempt === 0) {
          await new Promise((resolve) => setTimeout(resolve, 400));
          continue;
        }
        return null;
      }
      if (!res.ok) return null;
      const html = await res.text();
      return parseXProfile(html, handle, now);
    } catch {
      if (attempt === 1) return null;
    }
  }
  return null;
}

function authorityBit(body, key) {
  const token = body?.token;
  const has = !!body && (Object.prototype.hasOwnProperty.call(body, key) || (token && Object.prototype.hasOwnProperty.call(token, key)));
  if (!has) return null;
  const raw = body[key] !== undefined ? body[key] : token?.[key];
  if (raw == null || raw === '') return 'no';
  if (typeof raw === 'string') return 'yes';
  return null;
}

export function rugFacts(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const mint = authorityBit(body, 'mintAuthority');
  const freeze = authorityBit(body, 'freezeAuthority');
  const holders = Array.isArray(body.topHolders) ? body.topHolders : [];
  const pcts = holders.slice(0, 10).map((row) => Number(row?.pct)).filter((n) => Number.isFinite(n) && n >= 0);
  const topHolderPct = pcts.length ? Math.round(pcts.reduce((sum, n) => sum + n, 0) * 10) / 10 : null;
  let lpLockedPct = Number(body.lpLockedPct);
  if (!Number.isFinite(lpLockedPct)) {
    const locked = (Array.isArray(body.markets) ? body.markets : []).map((row) => Number(row?.lp?.lpLockedPct)).filter((n) => Number.isFinite(n));
    lpLockedPct = locked.length ? Math.max(...locked) : null;
  }
  if (lpLockedPct != null) lpLockedPct = Math.round(lpLockedPct * 10) / 10;
  let lpStatus = 'unknown';
  if (lpLockedPct != null && lpLockedPct >= 90) lpStatus = 'locked';
  else if (lpLockedPct != null && lpLockedPct < 50) lpStatus = 'unlocked';
  else if (lpLockedPct != null) lpStatus = 'partial';
  if (mint == null && freeze == null && topHolderPct == null && lpLockedPct == null) return null;
  return {
    mint,
    freeze,
    topHolderPct,
    topN: pcts.length || null,
    lpLockedPct,
    lpStatus,
  };
}

export function rugReportUrl(ca) {
  return `${RUG_REPORT_URL}/${encodeURIComponent(ca)}/report`;
}

async function readJson(url, fetchImpl, timeoutMs) {
  const res = await fetchImpl(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) return null;
  return res.json();
}

export async function readRugFacts(ca, fetchImpl, timeoutMs = 5000) {
  if (!ca || typeof fetchImpl !== 'function') return null;
  try {
    return rugFacts(await readJson(rugReportUrl(ca), fetchImpl, timeoutMs));
  } catch {
    return null;
  }
}

function normName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function similarCoins(coin, boards, limit = 6) {
  const symbol = normName(coin?.symbol);
  const name = normName(coin?.name);
  const generic = new Set(['coin', 'token', 'solana', 'pump', 'inu']);
  const tokens = new Set(name.split(' ').filter((part) => part.length >= 4 && !generic.has(part)));
  const out = [];
  const seen = new Set();
  for (const row of boards || []) {
    if (!row || (coin?.ca && row.ca === coin.ca)) continue;
    const sym = normName(row.symbol);
    const nm = normName(row.name);
    if (sym === '?' || nm === 'unknown') continue;
    const symHit = symbol.length >= 2 && symbol !== '?' && sym === symbol;
    const nameHit = !!name && nm === name;
    const tokenHit = [...tokens].some((part) => nm.includes(part) || sym === part);
    if (!symHit && !nameHit && !tokenHit) continue;
    const key = `${sym}|${nm}`;
    if (!sym && !nm || seen.has(key)) continue;
    seen.add(key);
    out.push({ name: clip(row.name, 60), symbol: clip(row.symbol, 24) });
    if (out.length >= limit) break;
  }
  return out;
}

export async function prepareJevState(coin, opts = {}) {
  const fetchImpl = opts.fetchImpl;
  const base = describeCoin({ coin, pair: opts.pair, profile: opts.profile });
  const handle = xHandleFromUrls([...base.socials.map((row) => row.url), ...base.websites]);
  const timeoutMs = opts.timeoutMs ?? 5000;
  const now = opts.nowMs ?? Date.now();
  let xProfile = null;
  let rug = null;
  if (typeof fetchImpl === 'function') {
    const jobs = [];
    jobs.push(handle ? readXProfile(handle, fetchImpl, timeoutMs, now) : Promise.resolve(null));
    jobs.push(coin?.ca ? readRugFacts(coin.ca, fetchImpl, timeoutMs) : Promise.resolve(null));
    try {
      const [profile, facts] = await Promise.all(jobs);
      xProfile = profile;
      rug = facts;
    } catch {
      xProfile = null;
      rug = null;
    }
  }
  const ageMin = numUnit(coin?.ageMin ?? coin?.features?.ageMin);
  const liq = numUnit(coin?.liq ?? coin?.features?.liq);
  return {
    ...base,
    ageMin: ageMin == null ? null : Math.round(ageMin * 10) / 10,
    liquidityUsd: liq == null ? null : Math.round(liq),
    xProfile,
    rug,
    similar: similarCoins(coin, opts.boards || []),
  };
}

function numUnit(value) {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function reusableStamp(row) {
  const stamp = jevStamp(row);
  if (!stamp) return null;
  if (stamp.verdict === 'unknown' && row?.prompt !== JEV_PROMPT) return null;
  return stamp;
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
    const cached = reusableStamp(cache.get(ca));
    if (cached) { out.push({ ...coin, jev: cached }); continue; }
    if (!coin.pass) { out.push(coin); continue; }
    if (!key) { skipped += 1; out.push(coin); continue; }
    if (asked >= cap || Date.now() >= deadline) { capped += 1; out.push(coin); continue; }
    const build = opts.prepare || opts.describe;
    let state = jevState(coin);
    try {
      if (typeof build === 'function') state = await build(coin);
    } catch {
      state = jevState(coin);
    }
    const result = await askJev(state, { key, fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs, env: opts.env });
    asked += 1;
    http += result.attempts || 0;
    const stamp = result.ok ? jevStamp(result) : null;
    if (stamp) {
      cache.set(ca, {
        ...stamp,
        model: result.model || JEV_MODEL,
        askedAt: opts.now || new Date().toISOString(),
        prompt: JEV_PROMPT,
      });
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
      prompt: typeof row.prompt === 'string' ? row.prompt : null,
    });
  }
  return map;
}

export function cacheDoc(map) {
  const verdicts = {};
  for (const [ca, row] of map || []) {
    const stamp = jevStamp(row);
    if (!stamp) continue;
    verdicts[ca] = { ...stamp, model: row.model || JEV_MODEL, askedAt: row.askedAt || null, prompt: row.prompt || null };
  }
  return { paper: true, model: JEV_MODEL, verdicts };
}

// The 20-call run cap stays. This is the extra stop for a UTC day, shared by
// the snapshot and the fast scan. A batch id is written once, so a rebase
// that sees both copies does not count the same asks twice.
export const JEV_DAILY_CAP = 100;

export function jevCallsOnDay(doc, day) {
  let n = 0;
  for (const row of doc?.batches || []) {
    if (row?.day === day && Number(row.n) > 0) n += Number(row.n);
  }
  return n;
}

export function jevDailyRemaining(doc, day, cap = JEV_DAILY_CAP) {
  return Math.max(0, cap - jevCallsOnDay(doc, day));
}

export function jevRunCap(doc, day, runCap = JEV_CALL_CAP, dailyCap = JEV_DAILY_CAP) {
  return Math.min(Math.max(0, runCap), jevDailyRemaining(doc, day, dailyCap));
}

export function noteJevCalls(doc, day, n, id, at) {
  const batches = Array.isArray(doc?.batches) ? doc.batches.filter((row) => row && typeof row.id === 'string' && row.day) : [];
  const add = Number(n);
  if (add > 0 && typeof id === 'string' && id && !batches.some((row) => row.id === id)) {
    batches.push({ id, day, n: add, at: typeof at === 'string' ? at : null });
  }
  const today = Date.parse(`${day}T00:00:00Z`);
  const cutoff = Number.isFinite(today) ? today - 3 * 86400000 : 0;
  const kept = batches.filter((row) => {
    const t = Date.parse(`${row.day}T00:00:00Z`);
    return Number.isFinite(t) && t >= cutoff;
  });
  return { paper: true, liveExecution: false, batches: kept };
}

export function mergeJevCalls(a, b) {
  const by = new Map();
  for (const row of [...(a?.batches || []), ...(b?.batches || [])]) {
    if (!row?.id || !row.day || !(Number(row.n) > 0)) continue;
    if (!by.has(row.id)) by.set(row.id, { id: String(row.id), day: String(row.day), n: Number(row.n), at: row.at || null });
  }
  const batches = [...by.values()].sort((x, y) => String(x.at || '').localeCompare(String(y.at || '')) || x.id.localeCompare(y.id));
  return { paper: true, liveExecution: false, batches };
}

export function mergeJevCacheDocs(a, b) {
  const verdicts = { ...(a?.verdicts && typeof a.verdicts === 'object' ? a.verdicts : {}) };
  for (const [ca, row] of Object.entries(b?.verdicts && typeof b.verdicts === 'object' ? b.verdicts : {})) {
    const prev = verdicts[ca];
    if (!prev) {
      verdicts[ca] = row;
      continue;
    }
    const prevAt = Date.parse(prev.askedAt || '') || 0;
    const nextAt = Date.parse(row?.askedAt || '') || 0;
    if (nextAt >= prevAt) verdicts[ca] = row;
  }
  return { ...(a || {}), ...(b || {}), paper: true, model: b?.model || a?.model || JEV_MODEL, verdicts };
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
    unknownRate: asked.length ? asked.filter((row) => row.jev.verdict === 'unknown').length / asked.length : null,
    pass: asked.filter((row) => row.jev.verdict === 'pass').length,
    note: 'Shadow only. A flag is left out of this mean and stays in the baseline. Unknown is not a veto. Weight is 1 only when the existing edge gate clears on this book. This bot does not place or block a trade.',
  };
}
