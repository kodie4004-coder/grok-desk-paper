// Hourly Solana trending-leader rotation. Paper only.
// Hold the #1 GeckoTerminal Solana trending pool when its 1-hour volume is at
// least $1,000,000. Evaluate rotation only after a 60-minute hold. A 15% stop
// is the only intra-hour exit. Size is $2. Rules were written down before any
// forward row. A backtest cannot graduate this book. Historical trending lists
// are not in the tape, so the backtester reports recorded rows only.

import { isFocusBenched } from './focus-plan.js';

// Same $2 size, 1% slip and 1.25% fee as engine/meme.js. Copied so this file
// does not import meme.js (meme watch needs TREND_ID from here).
const MEME_SIZE = 2;
const MEME_FEE = 0.0125;
const MEME_SLIP = 0.01;

function memePnl(entry, exit) {
  if (!(entry > 0) || !(exit > 0)) return null;
  const buy = entry * (1 + MEME_SLIP);
  const sell = exit * (1 - MEME_SLIP);
  const qty = MEME_SIZE / buy;
  const proceeds = qty * sell;
  const fees = MEME_SIZE * MEME_FEE + proceeds * MEME_FEE;
  return { pnl: proceeds - MEME_SIZE - fees, fees, sizeUsd: MEME_SIZE };
}

export const TREND_ID = 'trend-rotate';
export const TREND_ADDED_AT = '2026-11-22T08:45:00.000Z';
export const TREND_MIN_VOL_H1 = 1_000_000;
export const TREND_HOLD_MS = 60 * 60 * 1000;
export const TREND_STOP = 0.85;
export const TREND_QUOTES = Object.freeze(['SOL', 'WSOL', 'USDC', 'USDT']);
export const TREND_URL = 'https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?duration=1h&include=base_token,quote_token';

const num = (x) => {
  const n = typeof x === 'string' ? Number(x) : x;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

function tokenOf(included, id) {
  const row = (included || []).find((item) => item?.id === id);
  const attr = row?.attributes || {};
  return {
    ca: attr.address || (typeof id === 'string' && id.includes('_') ? id.slice(id.indexOf('_') + 1) : null),
    symbol: attr.symbol || null,
    name: attr.name || null,
  };
}

// Rank 1 is the first pool on the trending list. Volume is the 1-hour USD
// figure GeckoTerminal reports. Exotic quotes are skipped, not reranked: if
// #1 is not SOL/WSOL/USDC/USDT or is under $1M, the desk stays in cash.
export function parseTrending(doc) {
  const included = doc?.included || [];
  const out = [];
  for (const row of doc?.data || []) {
    const attr = row?.attributes || {};
    const baseId = row?.relationships?.base_token?.data?.id;
    const quoteId = row?.relationships?.quote_token?.data?.id;
    const base = tokenOf(included, baseId);
    const quote = tokenOf(included, quoteId);
    const volH1 = num(attr.volume_usd?.h1);
    const px = num(attr.base_token_price_usd);
    out.push({
      rank: out.length + 1,
      pool: attr.address || null,
      ca: base.ca,
      symbol: base.symbol || (attr.name || '').split(' / ')[0] || null,
      name: base.name,
      quote: quote.symbol,
      volH1,
      priceUsd: px,
    });
  }
  return out;
}

export function trendLeader(rows) {
  const first = (rows || [])[0];
  if (!first?.ca || !(first.priceUsd > 0)) return null;
  const quote = String(first.quote || '').toUpperCase();
  if (!TREND_QUOTES.includes(quote)) return null;
  if (!(first.volH1 >= TREND_MIN_VOL_H1)) return null;
  if (first.rank !== 1) return null;
  return first;
}

export function trendExit(pos, px, now, leader) {
  if (!pos || pos.variant !== TREND_ID || !(pos.entry > 0)) return null;
  const age = now - Date.parse(pos.openedAt || '');
  let why = null;
  if (px > 0 && px <= pos.entry * TREND_STOP) why = 'stop';
  else if (Number.isFinite(age) && age >= TREND_HOLD_MS) {
    if (!leader || leader.ca !== pos.ca) why = 'rotate';
  }
  if (!why || !(px > 0)) return null;
  const deal = memePnl(pos.entry, px);
  if (!deal || deal.sizeUsd !== MEME_SIZE) return null;
  return {
    ...pos,
    ...deal,
    exit: why,
    exitPx: px,
    settledAt: new Date(now).toISOString(),
    won: deal.pnl > 0,
    paper: true,
    open: false,
  };
}

function lastTrendExit(rows) {
  let last = null;
  for (const row of rows || []) {
    if (row?.variant !== TREND_ID || !row.settledAt) continue;
    if (!last || String(row.settledAt) > String(last.settledAt)) last = row;
  }
  return last;
}

// After a 15% stop, stay in cash until the 60-minute clock runs. A rotate
// may open the new leader in the same step.
function canEnter(history, settled, now) {
  if ((settled || []).some((row) => row.variant === TREND_ID && row.exit === 'stop')) return false;
  const last = lastTrendExit([...(history || []), ...(settled || [])]);
  if (!last) return true;
  if (last.exit === 'stop' && now - Date.parse(last.settledAt) < TREND_HOLD_MS) return false;
  return true;
}

export function stepTrend({ trending = [], open = [], history = [], now, prices = {} }) {
  if (isFocusBenched(TREND_ID)) {
    return { settled: [], open: (open || []).filter((p) => p?.variant === TREND_ID && p.pnl == null) };
  }
  const knownIds = new Set((history || []).map((row) => row?.id).filter(Boolean));
  const leader = trendLeader(trending);
  const settled = [];
  const still = [];
  const others = [];
  for (const pos of open || []) {
    if (pos?.variant !== TREND_ID) { others.push(pos); continue; }
    if (pos.pnl != null) continue;
    const live = trending.find((row) => row.ca === pos.ca);
    const px = num(prices?.[pos.ca]) || num(live?.priceUsd) || (leader?.ca === pos.ca ? num(leader.priceUsd) : null);
    const hit = trendExit(pos, px, now, leader);
    if (hit && !knownIds.has(hit.id)) {
      settled.push(hit);
      knownIds.add(hit.id);
    } else still.push(pos);
  }
  if (!still.length && leader && !isFocusBenched(TREND_ID) && canEnter(history, settled, now)) {
    const id = `${TREND_ID}:${leader.ca}:${new Date(now).toISOString()}`;
    if (!knownIds.has(id) && !others.some((p) => p?.ca === leader.ca && p.pnl == null)) {
      still.push({
        id,
        ca: leader.ca,
        symbol: leader.symbol,
        name: leader.name,
        entry: leader.priceUsd,
        sizeUsd: MEME_SIZE,
        openedAt: new Date(now).toISOString(),
        variant: TREND_ID,
        family: 'meme',
        allocated: false,
        shadow: true,
        paper: true,
        open: true,
        volH1: leader.volH1,
        rank: 1,
      });
    }
  }
  return { settled, open: others.concat(still) };
}
