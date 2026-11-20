// Research upgrades. Paper only. These rules were written down before the shadow
// numbers. They do not change graduates(), the $2 size, or live_execution.
// Maker fee on a 15-minute crypto resting order is zero.
// Taker fee remains round_up(0.07 × C × P × (1 − P)).
// Settlement fair value uses a 60-second average, not one tick.
// The noise scale is the 0.05% already frozen for mom-strict. It is not fit here.

import { kalshiTakerFee } from './kalshi.js';

export const LEARN_SIZE = 2;
export const SETTLEMENT_SCALE = 0.0005;
export const CRYPTO_15M = new Set([
  'KXBTC15M', 'KXETH15M', 'KXSOL15M', 'KXXRP15M', 'KXDOGE15M', 'KXBNB15M', 'KXHYPE15M', 'KXZEC15M', 'KXNEAR15M',
]);
const SPOT = {
  KXBTC15M: 'BTC', KXETH15M: 'ETH', KXSOL15M: 'SOL', KXXRP15M: 'XRP', KXDOGE15M: 'DOGE',
  KXBNB15M: 'BNB', KXHYPE15M: 'HYPE', KXZEC15M: 'ZEC', KXNEAR15M: 'NEAR',
};

function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

export function normalCdf(z) {
  if (!Number.isFinite(z)) return null;
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-0.5 * z * z);
  const tail = d * (((((1.330274429 * t - 1.821255978) * t) + 1.781477937) * t - 0.356563782) * t + 0.319381530) * t;
  const upper = 1 - tail;
  return z >= 0 ? upper : 1 - upper;
}

// Expected settlement level. Before the last minute, that is the trailing
// 60-second average. Inside the last minute, the part already printed is locked
// and the rest stays at that average. A single last tick is not the input.
export function settlementProb({ strike, avg60, secondsLeft, prints = null, now = null, closeMs = null }) {
  if (!(strike > 0) || !(avg60 > 0) || !Number.isFinite(secondsLeft)) return null;
  let expected = avg60;
  if (secondsLeft < 60 && secondsLeft >= 0) {
    const elapsed = 60 - secondsLeft;
    let lockedAvg = avg60;
    if (Array.isArray(prints) && Number.isFinite(now) && Number.isFinite(closeMs)) {
      const start = closeMs - 60000;
      const locked = prints.filter((row) => row.t >= start && row.t <= now && row.px > 0);
      if (locked.length) lockedAvg = locked.reduce((sum, row) => sum + row.px, 0) / locked.length;
    }
    expected = (lockedAvg * elapsed + avg60 * secondsLeft) / 60;
  }
  const noiseMin = secondsLeft > 60 ? 1 : Math.max(secondsLeft, 0) / 60;
  if (noiseMin === 0) return expected >= strike ? 1 : 0;
  const sigma = SETTLEMENT_SCALE * Math.sqrt(noiseMin);
  const z = ((expected - strike) / strike) / sigma;
  return normalCdf(z);
}

function feePerContract(price) {
  if (!(price > 0 && price < 1)) return null;
  return 0.07 * price * (1 - price);
}

export function settlePick(market, spots, secondsLeft) {
  const base = SPOT[market?.series];
  const spot = base ? spots?.[base] : null;
  const strike = Number(market?.floorStrike);
  const avg60 = Number(spot?.avg60);
  const fair = settlementProb({
    strike,
    avg60,
    secondsLeft,
    prints: spot?.prints || null,
    now: spot?.now,
    closeMs: Date.parse(market?.closeTime || ''),
  });
  if (fair == null) return null;
  const yes = Number(market.yesAsk);
  const no = Number(market.noAsk);
  const yesFee = feePerContract(yes);
  const noFee = feePerContract(no);
  if (yesFee != null && fair - yes > yesFee) return { side: 'yes', ask: yes, fair };
  if (noFee != null && (1 - fair) - no > noFee) return { side: 'no', ask: no, fair };
  return null;
}

export function makerPick(market) {
  if (!CRYPTO_15M.has(market?.series)) return null;
  const yes = Number(market.yesAsk);
  const bid = Number(market.yesBid);
  if (!(bid > 0.02 && bid < 0.98) || !(yes > bid && yes < 1)) return null;
  const spread = yes - bid;
  if (spread < 0.01 || spread > 0.10) return null;
  return { side: 'yes', ask: +bid.toFixed(4), limit: +bid.toFixed(4), maker: true };
}

// A later trade or ask at or through the resting price. The bid reprinting is not a fill.
export function quoteCrossed(limit, market) {
  const price = Number(limit);
  if (!(price > 0 && price < 1) || !market) return false;
  const trade = num(market.lastTrade ?? market.tradePrice);
  const askLow = num(market.yesAskLow);
  const ask = num(market.yesAsk);
  if (trade > 0 && trade <= price) return true;
  if (askLow > 0 && askLow <= price) return true;
  if (ask > 0 && ask <= price) return true;
  return false;
}

function dealAt(price, won, maker) {
  if (!(price > 0 && price < 1)) return null;
  const contracts = Math.floor(LEARN_SIZE / price);
  if (contracts < 1) return null;
  const fees = maker ? 0 : kalshiTakerFee(price, contracts);
  return { contracts, fees, pnl: (won ? contracts : 0) - contracts * price - fees };
}

// One attempt per market, on the minute closest to five minutes before the close,
// inside the two to ten minute window. Fill only if a later candle trades through the bid.
export function replayResting(market) {
  const close = Number(market?.close);
  const rows = [...(market?.candles || [])].sort((a, b) => a.end_period_ts - b.end_period_ts);
  const target = close - 300000;
  const lo = close - 600000;
  const hi = close - 120000;
  let best = -1;
  let dist = Infinity;
  for (let i = 0; i < rows.length; i++) {
    const t = rows[i].end_period_ts * 1000;
    if (t < lo || t > hi) continue;
    const gap = Math.abs(t - target);
    if (gap < dist) { dist = gap; best = i; }
  }
  const empty = { filled: false, maker: null, taker: null, attempt: false };
  if (best < 0) return empty;
  const bid = num(rows[best].yes_bid?.close_dollars);
  const ask = num(rows[best].yes_ask?.close_dollars);
  if (!(bid > 0 && bid < 1) || !(ask > bid && ask < 1)) return empty;
  let filled = false;
  for (let k = best + 1; k < rows.length; k++) {
    const low = num(rows[k].price?.low_dollars);
    const askLow = num(rows[k].yes_ask?.low_dollars);
    const askClose = num(rows[k].yes_ask?.close_dollars);
    if ((low > 0 && low <= bid) || (askLow > 0 && askLow <= bid) || (askClose > 0 && askClose <= bid)) {
      filled = true;
      break;
    }
  }
  if (market.result !== 'yes' && market.result !== 'no') return { filled, maker: null, taker: null, attempt: false };
  const won = market.result === 'yes';
  return {
    filled,
    attempt: true,
    limit: bid,
    ask,
    maker: filled ? dealAt(bid, won, true) : null,
    taker: dealAt(ask, won, false),
  };
}

export function restingExpectancy(rows) {
  const attempts = (rows || []).filter((row) => row?.attempt && row.taker);
  const filled = attempts.filter((row) => row.filled && row.maker);
  const mean = (list, key) => (list.length ? list.reduce((sum, row) => sum + row[key].pnl, 0) / list.length : null);
  return {
    measured: attempts.length > 0,
    attempts: attempts.length,
    filled: filled.length,
    unfilled: attempts.length - filled.length,
    makerMean: mean(filled, 'maker'),
    takerMean: mean(attempts, 'taker'),
    takerMeanOnFilled: mean(filled, 'taker'),
  };
}

function pctDown(x) {
  if (x == null || !Number.isFinite(x)) return null;
  return (Math.round(Math.abs(x) * 1000) / 10).toFixed(1);
}

function money(x) {
  if (x == null || !Number.isFinite(x)) return '—';
  const sign = x > 0 ? '+' : x < 0 ? '−' : '';
  return `${sign}$${Math.abs(x).toFixed(2)}`;
}

export function upgradeLines(report) {
  const before = report?.meme?.before;
  const after = report?.meme?.after;
  const lines = ['New research upgrades'];
  if (before?.n) {
    let line = `Faster coin stops. On ${before.n} paper stops checked only when a snapshot landed, the average fill was ${pctDown(before.meanRealized)}% down`;
    if (before.medianRealized != null) line += ` and the typical fill was ${pctDown(before.medianRealized)}% down`;
    line += `. The rule is 15% down, so the average was ${pctDown(before.meanGap)} percentage points worse.`;
    if (!after?.n) line += ' The fast checker has no fast fill yet.';
    else line += ` After the fast checker, ${after.n} stops averaged ${pctDown(after.meanRealized)}% down, ${pctDown(after.meanGap)} percentage points versus the rule.`;
    lines.push(line);
  } else lines.push('Faster coin stops. No snapshot stop has been measured yet. The fast checker has no fast fill yet.');
  const maker = report?.maker;
  if (maker?.measured && maker.attempts) {
    const skipped = maker.unfilled === 1 ? '1 was not a trade' : `${maker.unfilled} were not a trade`;
    lines.push(`Resting Kalshi orders are a challenger. A resting order pays no fee. A taker pays 0.07 × contracts × price × (1 − price). On ${maker.attempts} shadow attempts, ${maker.filled} filled because a later trade or quote crossed the bid, and ${skipped}. Filled maker orders averaged ${money(maker.makerMean)} after fees. The taker on every attempt averaged ${money(maker.takerMean)}. On the same filled attempts the taker averaged ${money(maker.takerMeanOnFilled)}. The maker fill is the bid with no fee, held to the same result. It still has to clear the holdout gate.`);
  } else {
    lines.push('Resting Kalshi orders are a challenger. A resting order pays no fee. It becomes a trade only if a later quote crosses its price. If it never crosses, it is not a trade. The shadow comparison is not in this file yet.');
  }
  const n = report?.settlement?.n || 0;
  lines.push(`Settlement prices are a challenger. Kalshi pays the 60-second average against the average from before the open, not one Coinbase tick. This bot uses that average from public trades. It has ${n} settled paper trades, so it has not earned a larger share. Live execution stays off.`);
  return lines;
}
