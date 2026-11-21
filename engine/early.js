// Early-entry shadow. Paper only. This module cannot sign, connect a wallet,
// or send an order. It does not change the meme safety bars, graduates(),
// or the $2 size. A row from here is shadow with weight 0 until graduates()
// says otherwise, and even then it is not allocated.

import { clusterBootstrap } from './eval.js';
import { MEME_RULES, MEME_SIZE, MEME_SLIP, memePnl, memeTargetClearsFees, poolMint } from './meme.js';
import { graduates } from './strategies.js';
import { isFocusBenched } from './focus-plan.js';

export const EARLY_ID = 'early-entry';
export const EARLY_TRACK = 'early-track';
export const EARLY_EXIT_FAST = 'early-exit-fast';
export const EARLY_EXIT_HALF = 'early-exit-half';
export const EARLY_EXIT_TRAIL = 'early-exit-trail';
export const EARLY_SCAN = 8;
export const RUG_URL = 'https://api.rugcheck.xyz/v1/tokens';

// Registered before any early-exit shadow result. Not fit on the journal or a holdout.
// The fast book uses the same 15% stop and 25% take-profit, and a 10 minute time stop.
// Half is sold only at a print at least 12% above entry when that half clears fees
// at the stored slip. The other half then trails 15% off its own peak.
// The peak trail sells the full $2 at 15% off the high the 4s watcher has seen.
// 15% is the existing stop distance, moved from the entry to the peak.
export const EARLY_EXITS = Object.freeze({
  fastHoldMs: 10 * 60 * 1000,
  halfTake: 1.12,
  trailGap: 0.15,
});

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

export const DETECTION_NOTE = 'Discovery loops about every 60 seconds inside one Actions job for 5 hours 50 minutes. A new job starts every 6 hours, and the Kalshi chain starts one when none is running. The checks are unchanged. A phone push is not a trade.';

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
  // Focus bench (static or rolling): no new early-entry lines. Open ones still settle.
  if (isFocusBenched(EARLY_ID)) return [];
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

// Pass and kill lines are an audit, not the score. Every enter stays.
// Older pass/kill lines collapse to the latest per mint, and the dropped
// reason counts stay in the summary so the histogram is not thrown away.
export const EARLY_LOG_CAP = 600;

function reasonKey(row) {
  return `${row.action || '?'} :: ${row.reason || ''}`;
}

function rowKey(row) {
  return JSON.stringify([row.ca, row.action, row.reason, row.at]);
}

export function rollEarlyLog(prevRows, extra = [], summary = null) {
  const combined = [...(prevRows || []), ...(extra || [])].filter((row) => row && row.ca);
  const enters = combined.filter((row) => row.action === 'enter');
  const rest = combined.filter((row) => row.action !== 'enter');
  if (rest.length <= EARLY_LOG_CAP) return { rows: combined, summary: summary || null, rewritten: false };
  const latest = new Map();
  for (const row of rest) latest.set(row.ca, row);
  const newest = [...latest.values()].sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')) || String(b.ca).localeCompare(String(a.ca)));
  const keptRest = newest.slice(0, EARLY_LOG_CAP);
  const kept = new Set(keptRest.map(rowKey));
  const dropped = rest.filter((row) => !kept.has(rowKey(row)));
  const counts = { ...(summary?.counts || {}) };
  for (const row of dropped) {
    const key = reasonKey(row);
    counts[key] = (counts[key] || 0) + 1;
  }
  const rows = [...enters, ...keptRest].sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')) || String(a.ca).localeCompare(String(b.ca)));
  return {
    rows,
    rewritten: true,
    summary: {
      paper: true,
      liveExecution: false,
      keptEnters: enters.length,
      keptLatest: keptRest.length,
      dropped: (summary?.dropped || 0) + dropped.length,
      counts,
    },
  };
}

function slipOf(pos) {
  return Number.isFinite(pos?.slip) ? pos.slip : undefined;
}

function closedLeg(row) {
  return !!(row && row.settledAt);
}

function fullDeal(pos, px, now) {
  const deal = memePnl(pos.entry, px, slipOf(pos), MEME_SIZE);
  if (!deal || deal.sizeUsd !== MEME_SIZE) return null;
  return { ...deal, exitPx: px, settledAt: new Date(now).toISOString(), won: deal.pnl > 0 };
}

function shadowRow(pos, variant, deal, why) {
  return {
    id: `${variant}:${pos.ca}`,
    ca: pos.ca,
    symbol: pos.symbol,
    name: pos.name,
    entry: pos.entry,
    openedAt: pos.openedAt,
    variant,
    family: 'meme',
    allocated: false,
    shadow: true,
    paper: true,
    liq: pos.liq ?? null,
    slip: pos.slip ?? null,
    ageMin: pos.ageMin ?? null,
    parent: pos.variant === EARLY_TRACK ? pos.parent || null : pos.id,
    pnl: deal.pnl,
    fees: deal.fees,
    sizeUsd: MEME_SIZE,
    exit: why,
    exitPx: deal.exitPx,
    settledAt: deal.settledAt,
    won: deal.pnl > 0,
    ...(deal.takePx != null ? { takePx: deal.takePx } : {}),
  };
}

function blankTrack(pos, px) {
  const peak = Math.max(pos?.entry || 0, px || 0);
  return { peak, fast: null, half: null, trail: null };
}

export function earlyTrackDone(track) {
  return !!(closedLeg(track?.fast) && closedLeg(track?.half) && closedLeg(track?.trail));
}

function holdShell(pos) {
  return {
    id: `${EARLY_TRACK}:${pos.ca}`,
    ca: pos.ca,
    symbol: pos.symbol,
    name: pos.name,
    entry: pos.entry,
    sizeUsd: MEME_SIZE,
    openedAt: pos.openedAt,
    variant: EARLY_TRACK,
    family: 'meme',
    allocated: false,
    shadow: true,
    paper: true,
    liq: pos.liq ?? null,
    slip: pos.slip ?? null,
    ageMin: pos.ageMin ?? null,
    parent: pos.id,
    exitTrack: pos.exitTrack,
  };
}

// Same entry, three exit books. A leg journals once, after fees, at $2.
// Weight is not decided here. The baseline position is not closed here.
export function advanceEarlyExits(pos, px, now, opts = {}) {
  if ((pos?.variant !== EARLY_ID && pos?.variant !== EARLY_TRACK) || !(px > 0) || !(pos.entry > 0)) {
    return { pos, rows: [], hold: null };
  }
  const known = opts.known instanceof Set ? opts.known : new Set();
  const parentExiting = !!opts.parentExiting;
  const track = pos.exitTrack
    ? { peak: pos.exitTrack.peak, fast: pos.exitTrack.fast || null, half: pos.exitTrack.half ? { ...pos.exitTrack.half } : null, trail: pos.exitTrack.trail || null }
    : blankTrack(pos, px);
  track.peak = Math.max(track.peak || 0, px, pos.entry);
  const rows = [];
  const age = now - Date.parse(pos.openedAt || '');
  const aged = Number.isFinite(age) && age >= 0;
  const stopPx = pos.entry * MEME_RULES.stop;
  const tpPx = pos.entry * MEME_RULES.tp;
  const emit = (variant, deal, why) => {
    const id = `${variant}:${pos.ca}`;
    // A focus-benched exit still closes its leg so the track can finish, but it
    // writes no new paper row.
    if (!deal || known.has(id) || (isFocusBenched(variant) && opts.emitBenched !== true)) return;
    rows.push(shadowRow(pos, variant, deal, why));
  };
  const seen = (variant) => known.has(`${variant}:${pos.ca}`);

  if (!closedLeg(track.fast)) {
    if (seen(EARLY_EXIT_FAST)) track.fast = { settledAt: 'seen' };
    else {
      let why = null;
      if (px <= stopPx) why = 'stop';
      else if (px >= tpPx) why = 'take-profit';
      else if (aged && age >= EARLY_EXITS.fastHoldMs) why = 'time-stop';
      if (why) {
        const deal = fullDeal(pos, px, now);
        if (deal) {
          track.fast = { ...deal, exit: why };
          emit(EARLY_EXIT_FAST, deal, why);
        }
      }
    }
  }

  if (!closedLeg(track.trail)) {
    if (seen(EARLY_EXIT_TRAIL)) track.trail = { settledAt: 'seen' };
    else {
      const trailPx = track.peak * (1 - EARLY_EXITS.trailGap);
      let why = null;
      if (px <= trailPx) why = 'trail';
      else if (aged && age >= MEME_RULES.holdMs) why = 'time-stop';
      if (why) {
        const deal = fullDeal(pos, px, now);
        if (deal) {
          track.trail = { ...deal, exit: why };
          emit(EARLY_EXIT_TRAIL, deal, why);
        }
      }
    }
  }

  if (!closedLeg(track.half)) {
    if (seen(EARLY_EXIT_HALF)) track.half = { settledAt: 'seen' };
    else if (!track.half?.taken) {
      let why = null;
      if (px <= stopPx) why = 'stop';
      else if (aged && age >= MEME_RULES.holdMs) why = 'time-stop';
      if (why) {
        const deal = fullDeal(pos, px, now);
        if (deal) {
          track.half = { taken: false, ...deal, exit: why };
          emit(EARLY_EXIT_HALF, deal, why);
        }
      } else if (px >= pos.entry * EARLY_EXITS.halfTake) {
        const leg = memePnl(pos.entry, px, slipOf(pos), MEME_SIZE / 2);
        if (leg && leg.pnl > 0) {
          track.half = { taken: true, takePx: px, takePnl: leg.pnl, takeFees: leg.fees, peak: px };
        }
      }
    } else {
      const half = track.half;
      half.peak = Math.max(half.peak || 0, px);
      const trailPx = half.peak * (1 - EARLY_EXITS.trailGap);
      let why = null;
      if (px <= trailPx || (aged && age >= MEME_RULES.holdMs)) why = 'half-trail';
      if (why) {
        const rest = memePnl(pos.entry, px, slipOf(pos), MEME_SIZE / 2);
        if (rest) {
          const deal = {
            pnl: half.takePnl + rest.pnl,
            fees: half.takeFees + rest.fees,
            sizeUsd: MEME_SIZE,
            exitPx: px,
            takePx: half.takePx,
            settledAt: new Date(now).toISOString(),
          };
          deal.won = deal.pnl > 0;
          track.half = { ...half, ...deal, exit: why };
          emit(EARLY_EXIT_HALF, deal, why);
        }
      } else track.half = half;
    }
  }

  const updated = { ...pos, exitTrack: track };
  if (pos.variant === EARLY_TRACK) return { pos: earlyTrackDone(track) ? null : updated, rows, hold: null };
  if (parentExiting && !earlyTrackDone(track)) return { pos: updated, rows, hold: holdShell(updated) };
  return { pos: updated, rows, hold: null };
}

export function mergeOpenEntry(preferred, other) {
  if (!other) return preferred;
  if (!preferred) return other;
  const early = preferred.variant === EARLY_ID || preferred.variant === EARLY_TRACK || other.variant === EARLY_ID || other.variant === EARLY_TRACK;
  if (!early) return preferred;
  return { ...other, ...preferred, exitTrack: mergeTrack(preferred.exitTrack, other.exitTrack) };
}

function mergeTrack(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const peak = Math.max(Number(a.peak) || 0, Number(b.peak) || 0) || null;
  return {
    peak,
    fast: earlierLeg(a.fast, b.fast),
    half: earlierLeg(a.half, b.half),
    trail: earlierLeg(a.trail, b.trail),
  };
}

function earlierLeg(a, b) {
  if (closedLeg(a) && closedLeg(b)) return Date.parse(a.settledAt) <= Date.parse(b.settledAt) ? a : b;
  if (closedLeg(a)) return a;
  if (closedLeg(b)) return b;
  if (a?.taken || b?.taken) {
    const base = a?.taken ? a : b;
    const other = base === a ? b : a;
    return {
      ...other,
      ...base,
      peak: Math.max(Number(a?.peak) || 0, Number(b?.peak) || 0) || base.peak || null,
      takePx: base.takePx ?? other?.takePx ?? null,
      takePnl: base.takePnl ?? other?.takePnl ?? null,
      takeFees: base.takeFees ?? other?.takeFees ?? null,
    };
  }
  return a || b || null;
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

const EXIT_BOOKS = [
  { id: EARLY_EXIT_FAST, name: 'Early exit · 10 min' },
  { id: EARLY_EXIT_HALF, name: 'Early exit · half then trail' },
  { id: EARLY_EXIT_TRAIL, name: 'Early exit · peak trail' },
];

// Same early entries, other exits. Weight stays 0. graduates() is not applied.
export function earlyExitReport(rows) {
  const base = (rows || []).filter((row) => row && row.variant === EARLY_ID && row.pnl != null);
  const baselineMean = meanOf(base);
  return EXIT_BOOKS.map((book) => {
    const list = (rows || []).filter((row) => row && row.variant === book.id && row.pnl != null && row.sizeUsd === MEME_SIZE);
    return {
      id: book.id,
      name: book.name,
      status: isFocusBenched(book.id) ? 'benched' : 'shadow',
      role: 'challenger',
      weight: 0,
      paper: true,
      allocated: false,
      liveExecution: false,
      sizeUsd: MEME_SIZE,
      n: list.length,
      mean: meanOf(list),
      baselineMean,
      note: 'Shadow only. Weight stays 0. Same early entries, this exit, after fees. The parameters were registered before this sample. This does not place a live order.',
    };
  });
}
