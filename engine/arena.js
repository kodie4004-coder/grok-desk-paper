// Live paper arena. Fixed $2. Not the edge book. Rules match EVAL_PROTOCOL.md section v6.
import { kalshiTakerFee, coinFlipSide, normalizeMarket } from './kalshi.js';
import { addXp, noteDay, dayKey } from './game.js';
import { cryptoPnl } from './scalp.js';

export const ARENA_SIZE = 2;
export const ARENA_DAY_LOSS = 20;

export const SPOT = {
  KXBTC15M: 'BTC', KXETH15M: 'ETH', KXSOL15M: 'SOL', KXXRP15M: 'XRP', KXDOGE15M: 'DOGE',
  KXBNB15M: 'BNB', KXHYPE15M: 'HYPE', KXZEC15M: 'ZEC', KXNEAR15M: 'NEAR',
};

export function arenaFee(price) {
  const contracts = Math.floor(ARENA_SIZE / price);
  if (contracts < 1 || !(price > 0 && price < 1)) return null;
  return { contracts, fee: kalshiTakerFee(price, contracts), sizeUsd: ARENA_SIZE };
}

export function settleContract(entry, exitPx, contracts, maker) {
  const fees = (maker ? 0 : kalshiTakerFee(entry, contracts)) + (exitPx === 0 || exitPx === 1 ? 0 : kalshiTakerFee(exitPx, contracts));
  return { pnl: contracts * exitPx - contracts * entry - fees, fees };
}

function leftSec(market, now) {
  return (Date.parse(market.closeTime) - now) / 1000;
}

function plans(market, now, spots, prev) {
  const out = [];
  const left = leftSec(market, now);
  const yes = Number(market.yesAsk), no = Number(market.noAsk);
  const bid = Number(market.yesBid);
  if (left >= 180 && left <= 300 && yes >= 0.85 && yes < 1) out.push({ rule: 'late', side: 'yes', ask: yes, reason: 'late favorite, YES ask ≥ 0.85' });
  else if (left >= 180 && left <= 300 && no >= 0.85 && no < 1) out.push({ rule: 'late', side: 'no', ask: no, reason: 'late favorite, NO ask ≥ 0.85' });
  const base = SPOT[market.series];
  const spot = base && spots?.[base];
  if (left >= 120 && left <= 600 && spot?.px > 0 && market.floorStrike > 0 && yes > 0 && yes < 1 && no > 0 && no < 1) {
    const up = spot.px > market.floorStrike * 1.0005;
    const down = spot.px < market.floorStrike * 0.9995;
    if (up) out.push({ rule: 'mom', side: 'yes', ask: yes, reason: `momentum vs target, ${spot.source} estimate above strike` });
    else if (down) out.push({ rule: 'mom', side: 'no', ask: no, reason: `momentum vs target, ${spot.source} estimate below strike` });
  }
  if (left >= 360 && left <= 720 && yes > 0.15 && yes < 0.4) out.push({ rule: 'revert', side: 'yes', ask: yes, reason: 'mean revert, YES ask is cheap vs 0.50' });
  else if (left >= 360 && left <= 720 && yes > 0.6 && yes < 0.85) out.push({ rule: 'revert', side: 'no', ask: no, reason: 'mean revert, YES ask is rich vs 0.50' });
  if (left >= 600 && left <= 840 && yes > 0 && yes < 1 && no > 0 && no < 1) {
    const side = coinFlipSide(market.ticker + market.closeTime);
    out.push({ rule: 'flip', side, ask: side === 'yes' ? yes : no, reason: 'coin-flip control, fixed before the result' });
  }
  const old = prev?.[market.ticker];
  if (old && left > 120 && yes - old.yesAsk >= 0.04 && yes - bid <= 0.03 && yes > 0 && yes < 1) {
    out.push({ rule: 'scalp', side: 'yes', ask: yes, reason: 'intra-window scalp, ask jumped 4c and the spread is tight' });
  }
  return out;
}

function pushLog(state, now, row) {
  state.arenaLog ||= [];
  state.arenaLog.push({ t: now, ...row });
  if (state.arenaLog.length > 80) state.arenaLog.splice(0, state.arenaLog.length - 80);
}

function realizedToday(state, now) {
  const day = dayKey(now);
  return (state.arenaClosed || []).concat(state.picksClosed || []).filter((t) => dayKey(t.closedAt || 0) === day).reduce((a, t) => a + (t.pnl || 0), 0);
}

export function reviewArena(state, board, now, spots, book) {
  state.arenaOpen ||= [];
  state.arenaClosed ||= [];
  state.arenaSeen ||= {};
  state.picksOpen ||= [];
  state.picksClosed ||= [];
  state.game ||= { xp: 0, days: {} };
  const notes = [];
  const markets = (board?.markets || []).map(normalizeMarket);
  for (const m of markets) {
    if (m.result !== 'yes' && m.result !== 'no') continue;
    for (const list of ['arenaOpen', 'picksOpen']) {
      const open = (state[list] || []).filter((p) => p.ticker === m.ticker);
      for (const bet of open) {
        const won = m.result === bet.side;
        const exitPx = won ? 1 : 0;
        const deal = settleContract(bet.ask, exitPx, bet.contracts, bet.maker);
        state[list] = state[list].filter((p) => p !== bet);
        const closed = list === 'arenaOpen' ? 'arenaClosed' : 'picksClosed';
        state[closed].push({ ...bet, won, result: m.result, pnl: deal.pnl, fees: deal.fees, closedAt: now, sizeUsd: ARENA_SIZE });
        addXp(state.game, 'settle');
        noteDay(state.game, now);
        const row = { action: 'settle', rule: bet.rule, title: bet.title || m.ticker, won, pnl: deal.pnl, fees: deal.fees, reason: `${won ? 'PAPER win' : 'PAPER loss'} · result ${m.result} · fee $${deal.fees.toFixed(2)}` };
        notes.push(row);
        pushLog(state, now, row);
      }
    }
  }
  if (realizedToday(state, now) <= -ARENA_DAY_LOSS) {
    if (state.arenaPausedDay !== dayKey(now)) {
      state.arenaPausedDay = dayKey(now);
      addXp(state.game, 'pause');
      pushLog(state, now, { action: 'skip', rule: 'pause', title: 'Arena', reason: 'Paused for the day. Paper drawdown hit $20. Size stays $2.' });
    }
    state.arenaQuotes = Object.fromEntries(markets.filter((m) => !m.result).map((m) => [m.ticker, { yesAsk: Number(m.yesAsk) }]));
    return notes;
  }
  const prev = state.arenaQuotes || {};
  for (const m of markets) {
    if (m.result === 'yes' || m.result === 'no') continue;
    for (const idea of plans(m, now, spots, prev)) {
      const key = idea.rule + ':' + m.ticker;
      if (state.arenaSeen[key]) continue;
      const deal = arenaFee(idea.ask);
      if (!deal) continue;
      state.arenaSeen[key] = true;
      state.arenaOpen.push({
        ticker: m.ticker, title: m.title, series: m.series, rule: idea.rule, side: idea.side,
        ask: idea.ask, contracts: deal.contracts, fee: deal.fee, sizeUsd: ARENA_SIZE, openedAt: now,
      });
      addXp(state.game, 'place');
      noteDay(state.game, now);
      const row = { action: 'take', rule: idea.rule, title: m.title || m.ticker, reason: `${idea.reason} · $${ARENA_SIZE} · fee $${deal.fee.toFixed(2)}` };
      notes.push(row);
      pushLog(state, now, row);
    }
    const qKey = 'maker:' + m.ticker;
    const quote = state.makerQuote?.[m.ticker];
    const bid = Number(m.yesBid), ask = Number(m.yesAsk);
    if (quote && !state.arenaSeen[qKey] && ask > 0 && ask <= quote.bid) {
      const deal = arenaFee(quote.bid);
      if (deal) {
        state.arenaSeen[qKey] = true;
        state.arenaOpen.push({
          ticker: m.ticker, title: m.title, series: m.series, rule: 'maker', side: 'yes',
          ask: quote.bid, contracts: deal.contracts, fee: 0, sizeUsd: ARENA_SIZE, openedAt: now, maker: true,
        });
        addXp(state.game, 'place');
        noteDay(state.game, now);
        pushLog(state, now, { action: 'take', rule: 'maker', title: m.title || m.ticker, reason: `maker bid filled because the ask traded through ${quote.bid.toFixed(2)} · PAPER` });
      }
    }
    state.makerQuote ||= {};
    if (bid > 0.02 && ask < 0.98 && ask > bid) state.makerQuote[m.ticker] = { bid: +(bid).toFixed(2), ask: +(ask).toFixed(2) };
  }
  state.arenaQuotes = Object.fromEntries(markets.filter((m) => !m.result).map((m) => [m.ticker, { yesAsk: Number(m.yesAsk) }]));
  if (book?.bid > 0 && book.ask > book.bid && book.bidSz + book.askSz > 0) {
    const imb = book.bidSz / (book.bidSz + book.askSz);
    const spread = book.ask / book.bid - 1;
    const open = (state.arenaOpen || []).find((p) => p.rule === 'imbalance');
    if (open && now - open.openedAt >= 60000) {
      const deal = cryptoPnl(open.ask, (book.bid + book.ask) / 2, ARENA_SIZE);
      if (!deal) return notes;
      state.arenaOpen = state.arenaOpen.filter((p) => p !== open);
      state.arenaClosed.push({ ...open, won: deal.pnl > 0, pnl: deal.pnl, fees: deal.fees, closedAt: now, estimate: true });
      addXp(state.game, 'settle');
      pushLog(state, now, { action: 'settle', rule: 'imbalance', title: 'BTC book', reason: `PAPER ${deal.pnl >= 0 ? 'win' : 'loss'} · Coinbase L2 estimate · fee $${deal.fees.toFixed(2)}` });
    } else if (!open && imb >= 0.65 && spread <= 0.0005 && state.arenaPausedDay !== dayKey(now)) {
      state.arenaOpen.push({ ticker: 'BOOK-BTC', title: 'BTC book imbalance', rule: 'imbalance', side: 'yes', ask: book.ask, contracts: 0, fee: 0, sizeUsd: ARENA_SIZE, openedAt: now, estimate: true });
      addXp(state.game, 'place');
      noteDay(state.game, now);
      pushLog(state, now, { action: 'take', rule: 'imbalance', title: 'BTC book', reason: `bid size is ${(imb * 100).toFixed(0)}% of the top 20 · Coinbase L2 estimate · $${ARENA_SIZE}` });
    }
  }
  return notes;
}

export function placePick(state, market, side, now) {
  state.picksOpen ||= [];
  state.picksClosed ||= [];
  state.game ||= { xp: 0, days: {} };
  const m = normalizeMarket(market);
  if (state.arenaPausedDay === dayKey(now)) return { ok: false, reason: 'Arena is paused for the day. Chip stays $2.' };
  if ((state.picksOpen || []).some((p) => p.ticker === m.ticker)) return { ok: false, reason: 'Already picked this market.' };
  const ask = side === 'yes' ? Number(m.yesAsk) : Number(m.noAsk);
  const deal = arenaFee(ask);
  if (!deal) return { ok: false, reason: 'No ask inside 0 and 1.' };
  state.picksOpen.push({
    ticker: m.ticker, title: m.title, series: m.series, rule: 'pick', side, ask,
    contracts: deal.contracts, fee: deal.fee, sizeUsd: ARENA_SIZE, openedAt: now,
  });
  addXp(state.game, 'pick');
  noteDay(state.game, now);
  pushLog(state, now, { action: 'take', rule: 'pick', title: m.title || m.ticker, reason: `your PAPER chip $${ARENA_SIZE} on ${side.toUpperCase()} · fee $${deal.fee.toFixed(2)}` });
  return { ok: true, fee: deal.fee };
}

export async function loadSpots(fetchImpl = globalThis.fetch) {
  const bases = [...new Set(Object.values(SPOT))];
  const out = {};
  await Promise.all(bases.map(async (base) => {
    try {
      const res = await fetchImpl(`https://api.coinbase.com/v2/prices/${base}-USD/spot`, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error('coinbase');
      const body = await res.json();
      const px = Number(body.data?.amount);
      if (px > 0) { out[base] = { px, source: 'Coinbase estimate' }; return; }
    } catch { /* try the backup */ }
    try {
      const res = await fetchImpl(`https://www.okx.com/api/v5/market/ticker?instId=${base}-USDT`, { headers: { accept: 'application/json' } });
      if (!res.ok) return;
      const body = await res.json();
      const px = Number(body.data?.[0]?.last);
      if (px > 0) out[base] = { px, source: 'OKX estimate' };
    } catch { /* no estimate */ }
  }));
  return out;
}

export async function loadBook(fetchImpl = globalThis.fetch) {
  try {
    const res = await fetchImpl('https://api.exchange.coinbase.com/products/BTC-USD/book?level=2', { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error('book');
    const body = await res.json();
    const bidSz = (body.bids || []).slice(0, 20).reduce((a, r) => a + Number(r[1] || 0), 0);
    const askSz = (body.asks || []).slice(0, 20).reduce((a, r) => a + Number(r[1] || 0), 0);
    const bid = Number(body.bids?.[0]?.[0]);
    const ask = Number(body.asks?.[0]?.[0]);
    return { bid, ask, bidSz, askSz, source: 'Coinbase L2 estimate' };
  } catch {
    return null;
  }
}
