// Early-entry shadow. Paper only. This module cannot sign, connect a wallet,
// or send an order. It does not change the meme safety bars, graduates(),
// or the $2 size. A row from here is shadow with weight 0 until graduates()
// says otherwise, and even then it is not allocated.

import { clusterBootstrap } from './eval.js';
import { MEME_RULES, MEME_SIZE, MEME_SLIP, memePnl, memeTargetClearsFees, poolMint } from './meme.js';
import { graduates } from './strategies.js';

export const EARLY_ID = 'early-entry';
export const EARLY_SCAN = 8;
export const RUG_URL = 'https://api.rugcheck.xyz/v1/tokens';

// Frozen before any early-entry shadow trade. Not fit on the age audit.
export const EARLY_RULES = {
  minLiq: 1000,
  maxAgeMin: 30,
  maxTop10: 0.40,
  chaseMultiple: 3,
  lpLockedMin: 90,
  lpUnlockedMax: 50,
  maxOpen: 4,
  quotes: ['SOL', 'WSOL', 'USDC', 'USDT'],
};

export const EARLY_SOURCES = [
  { id: 'dex-boosts', url: 'https://api.dexscreener.com/token-boosts/latest/v1' },
  { id: 'dex-profiles', url: 'https://api.dexscreener.com/token-profiles/latest/v1' },
  { id: 'dex-pairs', url: 'https://api.dexscreener.com/latest/dex/pairs/solana' },
  { id: 'gecko-new', url: 'https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=1' },
  { id: 'pump-latest', url: 'https://frontend-api-v3.pump.fun/coins/latest?limit=30&offset=0&includeNsfw=false' },
];

export const DETECTION_NOTE = 'Discovery runs on the Kalshi snapshot chain, not on a faster cron. GitHub cron cannot fire more often than every 5 minutes, and the 5-minute meme kick has been dropped before. A new coin waits for the next chain pass.';

const num = (x) => {
  const n = typeof x === 'string' ? Number(x) : x;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

function check(name, action, detail) {
  return { name, action, detail };
}

// One-way constant-product impact is size / (liquidity/2). The flat 1% cushion
// still applies when the pool is deeper than that. The 0.9 cap only stops a
// zero sell price. It is not a claim about the pool.
export function earlySlip(liq) {
  if (!(liq > 0)) return null;
  const impact = (2 * MEME_SIZE) / liq;
  return Math.min(0.9, Math.max(MEME_SLIP, impact));
}

export function earlyClears(liq, tp = MEME_RULES.tp) {
  const slip = earlySlip(liq);
  if (slip == null || !memeTargetClearsFees(tp)) return false;
  const up = memePnl(1, tp, slip);
  const flat = memePnl(1, 1, slip);
  return !!(up && flat && up.pnl > 0 && up.pnl + 1e-9 >= -flat.pnl);
}

export function launchMultiple(row) {
  if (Number.isFinite(row?.launchMultiple) && row.launchMultiple > 0) return row.launchMultiple;
  if (row?.ageMin != null && row.ageMin >= 0 && row.ageMin <= 60 && Number.isFinite(row.h1)) return 1 + row.h1 / 100;
  return null;
}

export function readLp(summary) {
  const pct = num(summary?.lpLockedPct);
  if (pct == null) return { known: false, locked: null, pct: null };
  if (pct >= EARLY_RULES.lpLockedMin) return { known: true, locked: true, pct };
  if (pct < EARLY_RULES.lpUnlockedMax) return { known: true, locked: false, pct };
  return { known: false, locked: null, pct };
}

export function rugUrl(ca) {
  return `${RUG_URL}/${encodeURIComponent(ca)}/report/summary`;
}

function dexMints(body) {
  const rows = Array.isArray(body) ? body : [];
  const out = [];
  for (const row of rows) {
    if (row?.chainId !== 'solana' || !row.tokenAddress) continue;
    out.push({
      ca: row.tokenAddress,
      symbol: '?',
      name: row.description ? String(row.description).slice(0, 80) : 'Unknown',
      source: 'dex',
    });
  }
  return out;
}

export function fromGeckoPools(doc, now) {
  const out = [];
  for (const pool of doc?.data || []) {
    const ca = poolMint(pool);
    if (!ca) continue;
    const attr = pool.attributes || {};
    const created = Date.parse(attr.pool_created_at || '');
    const ageMin = Number.isFinite(created) ? (now - created) / 60000 : null;
    const parts = String(attr.name || '').split('/').map((part) => part.trim());
    const quote = String(parts[1] || '').toUpperCase();
    out.push({
      ca,
      symbol: parts[0] || '?',
      name: parts[0] || 'Unknown',
      priceUsd: num(attr.base_token_price_usd),
      liq: num(attr.reserve_in_usd),
      ageMin,
      h1: num(attr.price_change_percentage?.h1),
      quote,
      dexUrl: `https://dexscreener.com/solana/${ca}`,
      source: 'gecko-new',
    });
  }
  return out;
}

export function fromPump(body, now) {
  const rows = Array.isArray(body) ? body : (Array.isArray(body?.coins) ? body.coins : []);
  const out = [];
  for (const row of rows) {
    const ca = row?.mint || row?.tokenAddress || null;
    if (!ca) continue;
    const raw = num(row.created_timestamp);
    const created = raw == null ? null : (raw > 1e12 ? raw : raw * 1000);
    const multiple = num(row.launchMultiple);
    out.push({
      ca,
      symbol: row.symbol || '?',
      name: row.name || 'Unknown',
      ageMin: created == null ? null : (now - created) / 60000,
      quote: 'SOL',
      launchMultiple: multiple,
      dexUrl: `https://dexscreener.com/solana/${ca}`,
      source: 'pump-latest',
    });
  }
  return out;
}

export function candidatesFromSources(loaded, now) {
  const lists = [];
  for (const source of loaded || []) {
    if (!source?.ok || source.body == null) continue;
    if (source.id === 'gecko-new') lists.push(fromGeckoPools(source.body, now));
    else if (source.id === 'pump-latest') lists.push(fromPump(source.body, now));
    else if (source.id === 'dex-boosts' || source.id === 'dex-profiles' || source.id === 'dex-pairs') lists.push(dexMints(source.body));
  }
  return mergeCandidates(lists);
}

export function mergeCandidates(lists) {
  const map = new Map();
  for (const row of lists.flat()) {
    if (!row?.ca) continue;
    const prev = map.get(row.ca) || { ca: row.ca, sources: [] };
    const sources = [...new Set([...(prev.sources || []), row.source].filter(Boolean))];
    const next = { ...prev, sources };
    for (const key of ['symbol', 'name', 'priceUsd', 'liq', 'ageMin', 'h1', 'quote', 'dexUrl', 'imageUrl', 'launchMultiple']) {
      if ((next[key] == null || next[key] === '' || next[key] === '?') && row[key] != null && row[key] !== '' && row[key] !== '?') next[key] = row[key];
    }
    if (!next.symbol) next.symbol = row.symbol || '?';
    if (!next.name) next.name = row.name || 'Unknown';
    map.set(row.ca, next);
  }
  return [...map.values()];
}

export function withPair(row, pair, now) {
  if (!pair) return row;
  const created = num(pair.pairCreatedAt);
  const ageMin = row.ageMin ?? (created ? (now - created) / 60000 : null);
  return {
    ...row,
    symbol: row.symbol && row.symbol !== '?' ? row.symbol : (pair.baseToken?.symbol || row.symbol || '?'),
    name: row.name && row.name !== 'Unknown' ? row.name : (pair.baseToken?.name || row.name || 'Unknown'),
    priceUsd: row.priceUsd ?? num(pair.priceUsd),
    liq: row.liq ?? num(pair.liquidity?.usd),
    ageMin,
    h1: row.h1 ?? num(pair.priceChange?.h1),
    quote: row.quote || String(pair.quoteToken?.symbol || '').toUpperCase(),
    dexUrl: pair.url || row.dexUrl || (row.ca ? `https://dexscreener.com/solana/${row.ca}` : null),
    imageUrl: row.imageUrl || pair.info?.imageUrl || null,
  };
}

// Hard kills are recorded together. A chase is a pass only when nothing hard failed.
// Safety and LP are kills only after that lookup was actually attempted.
export function decideCandidate(row, ctx = {}) {
  const kills = [];
  const notes = [];
  const liq = num(row?.liq);
  const age = num(row?.ageMin);
  const quote = String(row?.quote || '').toUpperCase();
  const safety = ctx.safety;
  if (ctx.checkedSafety) {
    const mint = safety?.mint ?? null;
    const freeze = safety?.freeze ?? null;
    const top10 = num(safety?.top10);
    if (mint !== 'no') kills.push(check('mint authority', 'kill', mint == null ? (safety?.mintDetail || 'missing') : 'not revoked'));
    else notes.push(check('mint authority', 'ok', 'revoked'));
    if (freeze !== 'no') kills.push(check('freeze authority', 'kill', freeze == null ? (safety?.freezeDetail || 'missing') : 'not revoked'));
    else notes.push(check('freeze authority', 'ok', 'revoked'));
    if (top10 == null || top10 > EARLY_RULES.maxTop10) {
      kills.push(check('top 10 holders', 'kill', top10 == null ? (safety?.top10Detail || 'missing') : `${(top10 * 100).toFixed(1)}%`));
    } else notes.push(check('top 10 holders', 'ok', `${(top10 * 100).toFixed(1)}%`));
  }
  if (ctx.checkedLp) {
    const lp = ctx.lp || {};
    if (lp.known && lp.locked === false) kills.push(check('lp', 'kill', `locked ${Number(lp.pct).toFixed(1)}%, not burned or locked`));
    else if (lp.known && lp.locked === true) notes.push(check('lp', 'ok', `locked ${Number(lp.pct).toFixed(1)}%`));
    else notes.push(check('lp', 'unknown', lp.error || 'not known, does not kill'));
  }
  if (!(liq >= EARLY_RULES.minLiq)) kills.push(check('liquidity', 'kill', liq == null ? 'missing' : `$${Math.round(liq)}`));
  else notes.push(check('liquidity', 'ok', `$${Math.round(liq)}`));
  if (!(liq > 0) || !earlyClears(liq)) {
    const slip = earlySlip(liq);
    kills.push(check('expectancy', 'kill', slip == null ? 'no liquidity to model a $2 fill' : `$${MEME_SIZE} slip ${(slip * 100).toFixed(1)}% does not clear the take-profit`));
  } else notes.push(check('expectancy', 'ok', `slip ${(earlySlip(liq) * 100).toFixed(1)}%`));
  if (!EARLY_RULES.quotes.includes(quote)) kills.push(check('quote', 'kill', quote || 'missing'));
  else notes.push(check('quote', 'ok', quote));
  if (!(row?.priceUsd > 0)) kills.push(check('price', 'kill', 'missing'));
  let soft = null;
  if (age == null) kills.push(check('age', 'kill', 'missing'));
  else if (age < 0) kills.push(check('age', 'kill', 'clock'));
  else if (age >= EARLY_RULES.maxAgeMin) soft = `not early, ${Math.round(age)} min`;
  else notes.push(check('age', 'ok', `${Math.round(age)} min`));
  const multiple = launchMultiple(row);
  if (multiple != null && multiple >= EARLY_RULES.chaseMultiple) {
    soft = `already ${multiple.toFixed(1)}x from the early print, chase not entry`;
  }
  const base = {
    ca: row?.ca,
    symbol: row?.symbol || '?',
    name: row?.name || 'Unknown',
    priceUsd: row?.priceUsd ?? null,
    liq,
    ageMin: age,
    quote,
    dexUrl: row?.dexUrl || (row?.ca ? `https://dexscreener.com/solana/${row.ca}` : null),
    imageUrl: row?.imageUrl || null,
    h1: row?.h1 ?? null,
    sources: row?.sources || [],
    checks: [...kills, ...notes],
  };
  if (kills.length) {
    return { ...base, action: 'kill', reason: kills.map((item) => `${item.name}: ${item.detail}`).join('; ') };
  }
  if (soft) return { ...base, action: 'pass', reason: soft };
  if (!ctx.checkedSafety || !ctx.checkedLp) {
    return { ...base, action: 'pass', reason: 'safety lookup did not finish' };
  }
  return { ...base, action: 'enter', reason: 'early shadow $2', slip: earlySlip(liq) };
}

export function needsChain(row) {
  const age = num(row?.ageMin);
  const liq = num(row?.liq);
  const quote = String(row?.quote || '').toUpperCase();
  if (!(age >= 0) || age >= EARLY_RULES.maxAgeMin) return false;
  if (!(liq >= EARLY_RULES.minLiq) || !earlyClears(liq)) return false;
  if (!EARLY_RULES.quotes.includes(quote) || !(row?.priceUsd > 0)) return false;
  return true;
}

export async function loadSources(fetchImpl, preloaded = {}) {
  const out = [];
  for (const source of EARLY_SOURCES) {
    if (Object.prototype.hasOwnProperty.call(preloaded, source.id)) {
      const body = preloaded[source.id];
      out.push({ id: source.id, ok: body != null, status: body == null ? 0 : 200, body });
      continue;
    }
    try {
      const res = await fetchImpl(source.url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
      const text = await res.text();
      let body = null;
      try { body = JSON.parse(text); } catch { body = null; }
      out.push({ id: source.id, ok: !!(res.ok && body != null), status: res.status, body: res.ok ? body : null });
    } catch (e) {
      const error = e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timeout' : 'request failed';
      out.push({ id: source.id, ok: false, status: 0, body: null, error });
    }
  }
  return out;
}

export async function readRug(ca, fetchImpl) {
  try {
    const res = await fetchImpl(rugUrl(ca), {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { known: false, locked: null, pct: null, error: `HTTP ${res.status}` };
    const body = await res.json();
    return { ...readLp(body), error: null };
  } catch {
    return { known: false, locked: null, pct: null, error: 'request failed' };
  }
}

export function openEarly({ decisions, open = [], now }) {
  const have = new Set((open || []).map((pos) => pos?.ca).filter(Boolean));
  let n = (open || []).filter((pos) => pos?.variant === EARLY_ID && pos.pnl == null && !pos.exit).length;
  const added = [];
  for (const row of decisions || []) {
    if (row?.action !== 'enter' || !row.ca || have.has(row.ca)) continue;
    if (n >= EARLY_RULES.maxOpen) break;
    if (!(row.priceUsd > 0) || !Number.isFinite(row.slip)) continue;
    if (row.slip <= 0 || row.sizeUsd && row.sizeUsd !== MEME_SIZE) continue;
    added.push({
      id: `${EARLY_ID}:${row.ca}`,
      ca: row.ca,
      symbol: row.symbol,
      name: row.name,
      entry: row.priceUsd,
      sizeUsd: MEME_SIZE,
      openedAt: new Date(now).toISOString(),
      variant: EARLY_ID,
      family: 'meme',
      allocated: false,
      shadow: true,
      paper: true,
      open: true,
      liq: row.liq,
      slip: row.slip,
      ageMin: row.ageMin,
      reason: row.reason,
      ...(row.jev ? { jev: row.jev } : {}),
    });
    have.add(row.ca);
    n += 1;
  }
  return added;
}

export function nextLog(prevRows, decisions, at) {
  const last = new Map();
  for (const row of prevRows || []) if (row?.ca) last.set(row.ca, row);
  const out = [];
  for (const row of decisions || []) {
    if (!row?.ca || !row.action) continue;
    const prev = last.get(row.ca);
    if (prev && prev.action === row.action && prev.reason === row.reason) continue;
    out.push({
      at,
      ca: row.ca,
      symbol: row.symbol || '?',
      action: row.action,
      reason: row.reason,
      ageMin: row.ageMin ?? null,
      liq: row.liq ?? null,
      paper: true,
    });
  }
  return out;
}

function meanOf(rows) {
  if (!rows.length) return null;
  return rows.reduce((sum, row) => sum + row.pnl, 0) / rows.length;
}

function medianOf(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function dayWindows(rows) {
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

export function earlyShadow(rows) {
  const early = (rows || []).filter((row) => row && row.variant === EARLY_ID && row.pnl != null);
  const base = (rows || []).filter((row) => row && row.pnl != null && row.variant !== EARLY_ID);
  const weight = graduates(dayWindows(early)) ? 1 : 0;
  return {
    id: EARLY_ID,
    name: 'Early entry',
    status: 'shadow',
    role: 'challenger',
    weight,
    paper: true,
    allocated: false,
    liveExecution: false,
    sizeUsd: MEME_SIZE,
    n: early.length,
    mean: meanOf(early),
    baselineMean: meanOf(base),
    medianAgeMin: medianOf(early.map((row) => row.ageMin).filter((value) => Number.isFinite(value))),
    note: 'Shadow only. Weight is 1 only when graduates() clears on this book. The meme safety sleeve is not changed. Size stays $2. This does not place a live order.',
  };
}
