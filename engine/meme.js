// Solana meme signals. Thresholds are frozen in EVAL_PROTOCOL.md before any live pass.
// Paper only. This module cannot sign, connect a wallet, or send an order.

import { graduates } from './strategies.js';

export const MEME_SIZE = 2;
export const MEME_FEE = 0.0125;
export const MEME_SLIP = 0.01;
export const MEME_RULES = {
  minLiq: 20000,
  minVolH24: 5000,
  minAgeMin: 30,
  maxAgeDays: 14,
  maxTop10: 0.40,
  maxFdvToLiq: 50,
  maxH1: 400,
  minH1: -80,
  quotes: ['SOL', 'WSOL', 'USDC', 'USDT'],
  stop: 0.85,
  tp: 1.25,
  holdMs: 30 * 60 * 1000,
};

const num = (x) => {
  const n = typeof x === 'string' ? Number(x) : x;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

export function memePnl(entry, exit) {
  if (!(entry > 0) || !(exit > 0)) return null;
  const buy = entry * (1 + MEME_SLIP);
  const sell = exit * (1 - MEME_SLIP);
  const qty = MEME_SIZE / buy;
  const proceeds = qty * sell;
  const fees = MEME_SIZE * MEME_FEE + proceeds * MEME_FEE;
  return { pnl: proceeds - MEME_SIZE - fees, fees, sizeUsd: MEME_SIZE };
}

function check(name, ok, detail) {
  return { name, ok, detail };
}

export function scoreCoin(pair, info, now) {
  const reasons = [];
  const liq = num(pair?.liquidity?.usd);
  const vol = num(pair?.volume?.h24);
  const h1 = num(pair?.priceChange?.h1);
  const created = num(pair?.pairCreatedAt);
  const ageMin = created ? (now - created) / 60000 : null;
  const quote = String(pair?.quoteToken?.symbol || '').toUpperCase();
  const fdv = num(pair?.fdv);
  const ratio = liq > 0 && fdv > 0 ? fdv / liq : null;
  const holders = info?.holders?.distribution_percentage?.top_10;
  const top10 = holders == null ? null : num(holders) / (num(holders) > 1 ? 100 : 1);
  const mint = info?.mint_authority ?? null;
  const freeze = info?.freeze_authority ?? null;
  reasons.push(check('liquidity', liq != null && liq >= MEME_RULES.minLiq, liq == null ? 'missing' : `$${Math.round(liq).toLocaleString('en-US')}`));
  reasons.push(check('volume', vol != null && vol >= MEME_RULES.minVolH24, vol == null ? 'missing' : `$${Math.round(vol).toLocaleString('en-US')} / 24h`));
  reasons.push(check('age', ageMin != null && ageMin >= MEME_RULES.minAgeMin && ageMin <= MEME_RULES.maxAgeDays * 24 * 60, ageMin == null ? 'missing' : `${Math.round(ageMin)} min`));
  reasons.push(check('quote', MEME_RULES.quotes.includes(quote), quote || 'missing'));
  reasons.push(check('fdv / liquidity', ratio == null || ratio <= MEME_RULES.maxFdvToLiq, ratio == null ? 'missing, not blocking' : ratio.toFixed(1)));
  reasons.push(check('1h move', h1 == null || (h1 <= MEME_RULES.maxH1 && h1 >= MEME_RULES.minH1), h1 == null ? 'missing' : `${h1}%`));
  reasons.push(check('top 10 holders', top10 != null && top10 <= MEME_RULES.maxTop10, top10 == null ? 'missing' : `${Math.round(top10 * 100)}%`));
  reasons.push(check('mint authority', mint === 'no', mint == null ? 'missing' : String(mint)));
  reasons.push(check('freeze authority', freeze === 'no', freeze == null ? 'missing' : String(freeze)));
  reasons.push(check('dev wallet share', null, 'not in the free token info'));
  const blocking = reasons.filter((r) => r.name !== 'dev wallet share' && r.name !== 'fdv / liquidity' && r.ok !== true);
  return {
    pass: blocking.length === 0,
    reasons,
    features: { liq, vol, h1, ageMin, top10, mint, freeze, ratio, quote },
  };
}

export function tokenMint(pair) {
  const mint = pair?.baseToken?.address || null;
  if (!mint || mint === pair?.pairAddress) return null;
  return mint;
}

export function bestPair(pairs, token) {
  const rows = (pairs || []).filter((p) => p?.chainId === 'solana' && tokenMint(p) === token);
  return rows.sort((a, b) => (num(b?.liquidity?.usd) || 0) - (num(a?.liquidity?.usd) || 0))[0] || null;
}

export function stepMeme({ coins, open = [], now }) {
  const settled = [];
  const still = [];
  const byCa = new Map((coins || []).map((c) => [c.ca, c]));
  for (const pos of open) {
    const live = byCa.get(pos.ca);
    const px = num(live?.priceUsd);
    const age = now - Date.parse(pos.openedAt);
    let exit = null;
    let why = null;
    if (px > 0 && px <= pos.entry * MEME_RULES.stop) { exit = px; why = 'stop'; }
    else if (px > 0 && px >= pos.entry * MEME_RULES.tp) { exit = px; why = 'take-profit'; }
    else if (age >= MEME_RULES.holdMs && px > 0) { exit = px; why = 'time-stop'; }
    if (exit) {
      const deal = memePnl(pos.entry, exit);
      if (deal && deal.sizeUsd === MEME_SIZE) settled.push({ ...pos, ...deal, exit: why, exitPx: exit, settledAt: new Date(now).toISOString(), won: deal.pnl > 0, paper: true });
    } else still.push(pos);
  }
  const known = new Set(still.map((p) => p.ca).concat(settled.map((p) => p.ca)));
  for (const coin of coins || []) {
    if (!coin.pass || known.has(coin.ca) || !(coin.priceUsd > 0)) continue;
    if (still.length >= 8) break;
    still.push({
      id: `meme:${coin.ca}`,
      ca: coin.ca,
      symbol: coin.symbol,
      name: coin.name,
      entry: coin.priceUsd,
      sizeUsd: MEME_SIZE,
      openedAt: new Date(now).toISOString(),
      variant: 'meme-safety',
      family: 'meme',
      allocated: true,
      paper: true,
      open: true,
    });
    known.add(coin.ca);
  }
  return { settled, open: still.filter((p) => p.pnl == null) };
}

export function memeGate(rows) {
  const groups = new Map();
  for (const row of rows || []) {
    const key = (row.settledAt || '').slice(0, 10);
    if (!key || row.pnl == null) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const windows = [...groups.entries()].map(([key, list]) => ({
    key,
    seen: false,
    n: list.length,
    mean: list.reduce((sum, row) => sum + row.pnl, 0) / list.length,
    lo: null,
  }));
  return { windows, graduated: graduates(windows), n: (rows || []).filter((row) => row.pnl != null).length };
}
