// K1, frozen in EVAL_PROTOCOL.md section v5. Paper quotes only. No orders.
// Taker fee: Kalshi schedule effective 7 July 2026,
// fees = round up(0.07 × C × P × (1 − P)).
// https://kalshi.com/docs/kalshi-fee-schedule.pdf
// Rounded up to the next $0.01 because this paper account is not a direct member.
// https://docs.kalshi.com/getting_started/fee_rounding

export const KALSHI_SERIES = [
  'KXBTC15M', 'KXETH15M', 'KXSOL15M', 'KXXRP15M', 'KXDOGE15M', 'KXBNB15M', 'KXHYPE15M', 'KXZEC15M', 'KXNEAR15M',
  'KXGOLD15M', 'KXSILVER15M', 'KXPLATINUM15M', 'KXPALLADIUM15M', 'KXCOPPER15M', 'KXWTI15M', 'KXBRENT15M', 'KXNATGAS15M',
  'KXEURUSD15M', 'KXGBPUSD15M', 'KXUSDJPY15M', 'KXUSDCAD15M', 'KXAUDUSD15M', 'KXCRYPTOLEAD15M',
];

export const K1 = Object.freeze({
  minAsk: 0.85,
  budgetUsd: 5,
  windowLoSec: 180,
  windowHiSec: 300,
  targetSec: 240,
  freshMs: 120000,
});

// The board is stale once the snapshot is older than 15 minutes.
export const KALSHI_STALE_MS = 15 * 60 * 1000;

// A series such as KXCRYPTOLEAD15M settles several markets in one window.
// The last few settled rows are not enough. Any open paper line whose
// close has passed and whose ticker is not already yes/no on the board
// still needs a direct lookup.
export function tickersNeedingResult(entries, markets, now) {
  const resolved = new Set();
  for (const market of markets || []) {
    if (market && (market.result === 'yes' || market.result === 'no') && market.ticker) resolved.add(market.ticker);
  }
  const out = [];
  const seen = new Set();
  for (const entry of entries || []) {
    const ticker = entry?.ticker;
    if (!ticker || resolved.has(ticker) || seen.has(ticker)) continue;
    const close = Date.parse(entry.closeTime || '');
    if (!Number.isFinite(close) || now < close) continue;
    seen.add(ticker);
    out.push(ticker);
  }
  return out;
}

export function quoteAge(fetchedAt, now) {
  const t = Date.parse(fetchedAt || '');
  if (!Number.isFinite(t)) return { ms: null, stale: true, label: 'unknown age' };
  const ms = now - t;
  const stale = !(ms >= 0 && ms <= KALSHI_STALE_MS);
  const abs = Math.abs(ms);
  const minutes = Math.floor(abs / 60000);
  const hours = Math.floor(minutes / 60);
  const label = hours >= 1 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
  return { ms, stale, label };
}

export function kalshiTakerFee(price, contracts) {
  if (!(price > 0 && price < 1) || !(contracts >= 1)) return 0;
  const raw = 0.07 * contracts * price * (1 - price);
  return Math.ceil((raw - 1e-9) * 100) / 100;
}

// Fee per contract after the same cent round-up. Null when the quote is not a price.
export function feePerContract(price, contracts) {
  const p = Number(price);
  const c = Number(contracts);
  if (!(p > 0 && p < 1) || !(c >= 1)) return null;
  return kalshiTakerFee(p, c) / c;
}

// Strict: estimated win probability minus the ask must clear the per-contract fee plus margin.
// 1e-9 ignores binary dust. It is not a second margin.
export function feeEdgeClears(prob, ask, contracts, margin) {
  if (!(margin >= 0) || !(prob >= 0 && prob <= 1)) return false;
  const per = feePerContract(ask, contracts);
  if (per == null) return false;
  return prob - ask - per - margin > 1e-9;
}

// Break-even win rate on the fixed $2 paper chip. The chip size is not an argument.
export function breakEvenWinRate(ask) {
  const price = Number(ask);
  if (!(price > 0 && price < 1)) return null;
  const contracts = Math.floor(2 / price);
  if (contracts < 1) return null;
  const fee = kalshiTakerFee(price, contracts);
  const per = fee / contracts;
  return { ask: price, contracts, fee, feePerContract: per, breakEven: price + per, sizeUsd: 2 };
}

export function contractCount(ask) {
  if (!(ask > 0 && ask < 1)) return 0;
  return Math.floor(K1.budgetUsd / ask);
}

export function settlePnl(ask, won) {
  const contracts = contractCount(ask);
  if (contracts < 1) return null;
  const fee = kalshiTakerFee(ask, contracts);
  const cost = contracts * ask;
  const payout = won ? contracts : 0;
  return { contracts, fee, cost, pnl: payout - cost - fee, perDollar: (payout - cost - fee) / cost };
}

export function favoriteSide(yesAsk, noAsk) {
  const yes = Number(yesAsk);
  const no = Number(noAsk);
  if (!(yes > 0 && yes < 1) || !(no > 0 && no < 1)) return null;
  const yesFav = yes >= K1.minAsk;
  const noFav = no >= K1.minAsk;
  if (yesFav === noFav) return null;
  return yesFav ? { side: 'yes', ask: yes } : { side: 'no', ask: no };
}

export function noAskFromBid(yesBid) {
  const bid = Number(yesBid);
  if (!(bid >= 0 && bid <= 1)) return null;
  return +(1 - bid).toFixed(4);
}

export function candleInWindow(candles, closeMs) {
  const target = closeMs - K1.targetSec * 1000;
  const lo = closeMs - K1.windowHiSec * 1000;
  const hi = closeMs - K1.windowLoSec * 1000;
  let best = null;
  let bestDist = Infinity;
  for (const c of candles || []) {
    const t = (c.end_period_ts || 0) * 1000;
    if (t < lo || t > hi) continue;
    const dist = Math.abs(t - target);
    if (dist < bestDist) { best = c; bestDist = dist; }
  }
  return best;
}

export function asksFromCandle(candle) {
  if (!candle) return null;
  const yesAsk = Number(candle.yes_ask?.close_dollars);
  const yesBid = Number(candle.yes_bid?.close_dollars);
  const noAsk = noAskFromBid(yesBid);
  if (!(yesAsk > 0 && yesAsk < 1) || !(noAsk > 0 && noAsk < 1)) return null;
  return { yesAsk, noAsk };
}

export function coinFlipSide(ticker) {
  let sum = 0;
  const s = String(ticker || '');
  for (let i = 0; i < s.length; i++) sum += s.charCodeAt(i);
  return sum % 2 === 0 ? 'yes' : 'no';
}

export function normalizeMarket(m) {
  if (m.yesAsk != null && m.closeTime) return m;
  return {
    ticker: m.ticker,
    series: String(m.ticker || '').split('-')[0],
    title: m.title || m.ticker,
    floorStrike: m.floor_strike ?? m.floorStrike ?? null,
    yesBid: Number(m.yes_bid_dollars ?? m.yesBid),
    yesAsk: Number(m.yes_ask_dollars ?? m.yesAsk),
    noBid: Number(m.no_bid_dollars ?? m.noBid),
    noAsk: Number(m.no_ask_dollars ?? m.noAsk),
    closeTime: m.close_time || m.closeTime,
    volume: Number(m.volume_fp ?? m.volume),
    result: m.result || '',
    status: m.status || '',
  };
}

export async function loadKalshiBoard(fetchImpl = globalThis.fetch) {
  const origin = globalThis.location?.origin || '';
  // A page origin is refused. Skip the probe in the browser so it does not log a CORS error.
  const browserBlocked = origin && origin !== 'https://kalshi.com';
  const probe = 'https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=KXBTC15M&status=open&limit=1';
  try {
    if (browserBlocked) throw new Error('blocked');
    const res = await fetchImpl(probe, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error('blocked');
    const markets = [];
    for (const series of KALSHI_SERIES) {
      for (const status of ['open', 'settled']) {
        const url = `https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=${series}&status=${status}&limit=${status === 'settled' ? 20 : 3}`;
        const body = await (await fetchImpl(url, { headers: { accept: 'application/json' } })).json();
        for (const m of body.markets || []) markets.push(normalizeMarket(m));
      }
    }
    return { fetchedAt: new Date().toISOString(), via: 'kalshi', markets };
  } catch {
    const res = await fetchImpl(`data/kalshi-15m.json?v=${Date.now()}`, { cache: 'no-store' });
    if (!res || !res.ok) return { fetchedAt: null, via: 'unavailable', markets: [], cors: 'blocked' };
    const body = await res.json();
    return { ...body, via: body.via || 'snapshot' };
  }
}

export function reviewKalshi(state, board, now) {
  state.kalshiOpen ||= [];
  state.kalshiClosed ||= [];
  state.kalshiLog ||= [];
  state.kalshiSeen ||= {};
  const fetchedAt = Date.parse(board?.fetchedAt || '');
  const notes = [];
  const push = (row) => {
    notes.push(row);
    state.kalshiLog.push({ t: now, ...row });
    if (state.kalshiLog.length > 80) state.kalshiLog.splice(0, state.kalshiLog.length - 80);
  };
  for (const raw of board?.markets || []) {
    const m = normalizeMarket(raw);
    if (m.result === 'yes' || m.result === 'no') {
      const open = state.kalshiOpen.find((p) => p.ticker === m.ticker);
      if (!open) continue;
      const won = m.result === open.side;
      const deal = settlePnl(open.ask, won);
      state.kalshiOpen = state.kalshiOpen.filter((p) => p !== open);
      state.kalshiClosed.push({ ...open, result: m.result, won, pnl: deal?.pnl ?? 0, fees: deal?.fee ?? open.fee, closedAt: now });
      push({ action: 'settle', rule: 'k1', title: open.title || m.ticker, reason: `${m.result} result · ${won ? 'favorite won' : 'favorite lost'} · fee $${(deal?.fee ?? 0).toFixed(2)}` });
      continue;
    }
    if (state.kalshiSeen[m.ticker] || state.kalshiOpen.some((p) => p.ticker === m.ticker)) continue;
    const decision = liveK1(m, now, fetchedAt);
    const left = (Date.parse(m.closeTime) - now) / 1000;
    if (decision.action === 'take') {
      state.kalshiSeen[m.ticker] = true;
      state.kalshiOpen.push({
        ticker: m.ticker, title: m.title, side: decision.side, ask: decision.ask,
        contracts: decision.contracts, fee: decision.fee, sizeUsd: K1.budgetUsd, openedAt: now, rule: 'k1',
      });
      push({ action: 'take', rule: 'k1', title: m.title || m.ticker, reason: decision.reason });
    } else if (left > 0 && left <= 20 * 60 && !state.kalshiSeen['skip:' + m.ticker]) {
      state.kalshiSeen['skip:' + m.ticker] = true;
      push({ action: 'skip', rule: 'k1', title: m.title || m.ticker, reason: decision.reason });
    }
  }
  return notes;
}

export function liveK1(market, now, fetchedAt) {
  const close = Date.parse(market.closeTime || market.close_time || '');
  if (!close) return { action: 'skip', reason: 'no close time' };
  const age = now - fetchedAt;
  const left = (close - now) / 1000;
  if (!(age >= 0 && age <= K1.freshMs)) return { action: 'skip', reason: `quote is ${Math.round(age / 1000)}s old` };
  if (left < K1.windowLoSec || left > K1.windowHiSec) return { action: 'skip', reason: `${Math.round(left)}s left, outside 3 to 5 minutes` };
  const fav = favoriteSide(market.yesAsk ?? market.yes_ask_dollars, market.noAsk ?? market.no_ask_dollars);
  if (!fav) return { action: 'skip', reason: 'no side is offered at 85c or more' };
  const deal = settlePnl(fav.ask, false);
  if (!deal) return { action: 'skip', reason: 'ask does not buy one contract' };
  return {
    action: 'take',
    side: fav.side,
    ask: fav.ask,
    contracts: deal.contracts,
    fee: deal.fee,
    reason: `buy ${fav.side} at ${fav.ask.toFixed(2)} with ${Math.round(left)}s left · fee $${deal.fee.toFixed(2)}`,
  };
}
