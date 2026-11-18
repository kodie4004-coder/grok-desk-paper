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

export function kalshiTakerFee(price, contracts) {
  if (!(price > 0 && price < 1) || !(contracts >= 1)) return 0;
  const raw = 0.07 * contracts * price * (1 - price);
  return Math.ceil((raw - 1e-9) * 100) / 100;
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
