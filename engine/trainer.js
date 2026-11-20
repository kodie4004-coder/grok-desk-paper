// 15-minute paper practice. Local calls only. No wallet, no orders, no size change.
// The readiness bar is graduates() from the bot rules: 3 windows, 20+ calls,
// positive mean, 90% lower bound above 0. Clearing it does not turn anything on.

import { kalshiTakerFee, normalizeMarket, quoteAge } from './kalshi.js';
import { arenaIdeas, SPOT } from './arena.js';
import { clusterBootstrap } from './eval.js';
import { graduates } from './strategies.js';
import { levelOf } from './game.js';

export const TRAINER_STAKE = 2;
export const TRAINER_XP_CALL = 8;
export const TRAINER_XP_SETTLE = 4;
export const READY_WINDOWS = 3;
export const READY_CALLS = 20;

export function emptyTrainer() {
  return { open: [], closed: [], xp: 0, paper: true, stakeUsd: TRAINER_STAKE };
}

export function yesProbability(side, confidence) {
  const c = Number(confidence);
  if (!Number.isInteger(c) || c < 51 || c > 99) return null;
  if (side !== 'yes' && side !== 'no') return null;
  return side === 'yes' ? c / 100 : (100 - c) / 100;
}

export function marketYesProb(market) {
  const bid = Number(market?.yesBid);
  const ask = Number(market?.yesAsk);
  if (bid > 0 && bid < 1 && ask > 0 && ask < 1 && bid <= ask) return (bid + ask) / 2;
  if (ask > 0 && ask < 1) return ask;
  if (bid > 0 && bid < 1) return bid;
  return null;
}

export function brierScore(probYes, result) {
  if (!(probYes >= 0 && probYes <= 1)) return null;
  if (result !== 'yes' && result !== 'no') return null;
  const raw = (probYes - (result === 'yes' ? 1 : 0)) ** 2;
  return Math.round(raw * 1e8) / 1e8;
}

export function trainerDeal(ask) {
  const price = Number(ask);
  if (!(price > 0 && price < 1)) return null;
  const contracts = Math.floor(TRAINER_STAKE / price);
  if (contracts < 1) return null;
  const fee = kalshiTakerFee(price, contracts);
  return { contracts, fee, cost: contracts * price, sizeUsd: TRAINER_STAKE, ask: price };
}

function fmtPx(n) {
  if (!(typeof n === 'number' && Number.isFinite(n))) return null;
  return Math.abs(n) >= 100 ? n.toFixed(2) : n.toFixed(4);
}

function moneySigned(n) {
  if (!Number.isFinite(n)) return '—';
  const sign = n > 0 ? '+' : n < 0 ? '−' : '';
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

export function lessonText(row) {
  const bits = ['Paper practice. This is not advice.'];
  if (Number.isFinite(row.secondsLeft)) {
    const m = Math.floor(row.secondsLeft / 60);
    const s = row.secondsLeft % 60;
    bits.push(`You called with ${m}m ${String(s).padStart(2, '0')}s left.`);
    if (row.secondsLeft < 60) bits.push('Under a minute was left. The price had little time to move, and the taker fee still applied. The next call stays $2.');
  } else bits.push('Time left at the call was not stored.');
  if (row.floorStrike > 0 && row.spotPx > 0) {
    const rel = row.spotPx > row.floorStrike ? 'above' : row.spotPx < row.floorStrike ? 'below' : 'exactly on';
    bits.push(`${row.spotSource || 'The spot estimate'} showed ${fmtPx(row.spotPx)}, ${rel} the strike ${fmtPx(row.floorStrike)}.`);
  } else if (row.floorStrike > 0) {
    bits.push(`The strike in the snapshot was ${fmtPx(row.floorStrike)}. This phone had no spot estimate, so the card does not say where price was.`);
  } else {
    bits.push('The snapshot had no strike, so this card does not compare price to a strike.');
  }
  if (row.spotPx > 0 && row.settleSpotPx > 0) {
    const delta = row.settleSpotPx - row.spotPx;
    const dir = delta > 0 ? 'up' : delta < 0 ? 'down' : 'unchanged';
    bits.push(`By the settle check, the spot estimate was ${fmtPx(row.settleSpotPx)} (${dir} from ${fmtPx(row.spotPx)}).`);
    if (row.floorStrike > 0) {
      const crossed = (row.spotPx - row.floorStrike) * (row.settleSpotPx - row.floorStrike) < 0;
      if (crossed) bits.push('That estimate crossed the strike between the two checks.');
      else {
        const still = row.settleSpotPx > row.floorStrike ? 'above' : row.settleSpotPx < row.floorStrike ? 'below' : 'on';
        bits.push(`It was still ${still} the strike at that check.`);
      }
    }
  } else if (row.spotPx > 0) {
    bits.push('No second spot estimate was available at settle, so momentum is not stated.');
  }
  if (row.result === 'yes' || row.result === 'no') {
    bits.push(`The snapshot result was ${row.result}. You called ${row.side} and ${row.won ? 'matched it' : 'did not match it'}.`);
  }
  if (row.marketYes == null) bits.push('The quote did not have a usable YES price, so there is no market-implied probability.');
  else bits.push(`The market's YES price in the quote was ${Number(row.marketYes).toFixed(2)}.`);
  if (row.bots?.length) {
    const names = row.bots.map((b) => `${b.rule} leaned ${b.side} (${b.reason})`).join('; ');
    bits.push(`With the same quote, the paper bots that had a setup were: ${names}.`);
  } else bits.push('With the same quote, none of the paper bot setups fired.');
  if (Number.isFinite(row.pnl)) {
    const askTxt = Number.isFinite(Number(row.ask)) ? Number(row.ask).toFixed(2) : '—';
    bits.push(`Paper P&L after the taker fee is ${moneySigned(row.pnl)} on ${row.contracts || 0} contracts at ${askTxt}, fee $${Number(row.fees || 0).toFixed(2)}. The next call is still $${TRAINER_STAKE}.`);
  }
  return bits.join(' ');
}

function spotFor(market, spots) {
  const series = market.series || String(market.ticker || '').split('-')[0];
  const base = SPOT[series];
  if (!base || !(spots?.[base]?.px > 0)) return null;
  return spots[base];
}

export function placeTrainerCall(book, rawMarket, side, confidence, now, ctx = {}) {
  const market = normalizeMarket(rawMarket || {});
  const yesProb = yesProbability(side, confidence);
  if (yesProb == null) return { ok: false, reason: 'Confidence is a whole number from 51 to 99 for the side you picked. Under 50 means the other side.' };
  const close = Date.parse(market.closeTime || '');
  if (!(close > now)) return { ok: false, reason: 'That window has locked.' };
  if (market.result === 'yes' || market.result === 'no') return { ok: false, reason: 'That market already settled.' };
  const age = quoteAge(ctx.fetchedAt, now);
  if (age.stale) return { ok: false, reason: 'The snapshot is older than 15 minutes, so this is not a live window.' };
  book.open ||= [];
  book.closed ||= [];
  if (book.open.some((c) => c.ticker === market.ticker)) return { ok: false, reason: 'You already called this window.' };
  const ask = side === 'yes' ? Number(market.yesAsk) : Number(market.noAsk);
  const deal = trainerDeal(ask);
  if (!deal) return { ok: false, reason: 'No ask between 0 and 1, so there is no paper fill.' };
  const spot = spotFor(market, ctx.spots);
  const ideas = arenaIdeas(market, now, ctx.spots || {}, ctx.prev || {}).map((idea) => ({
    rule: idea.rule,
    side: idea.side,
    reason: idea.reason,
  }));
  const call = {
    id: `${market.ticker}:${now}`,
    ticker: market.ticker,
    title: market.title || market.ticker,
    series: market.series || String(market.ticker || '').split('-')[0],
    side,
    confidence: Number(confidence),
    yesProb,
    marketYes: marketYesProb(market),
    yesAsk: Number(market.yesAsk),
    yesBid: Number(market.yesBid),
    floorStrike: market.floorStrike > 0 ? Number(market.floorStrike) : null,
    spotPx: spot ? spot.px : null,
    spotSource: spot ? spot.source : null,
    secondsLeft: Math.round((close - now) / 1000),
    closeTime: market.closeTime,
    calledAt: now,
    bots: ideas,
    paper: true,
    ...deal,
  };
  book.open.push(call);
  book.xp = (book.xp || 0) + TRAINER_XP_CALL;
  book.stakeUsd = TRAINER_STAKE;
  book.paper = true;
  const level = levelOf(book.xp);
  return { ok: true, call, level, levelUp: level > levelOf(book.xp - TRAINER_XP_CALL) };
}

export function settleTrainer(book, board, now, spots) {
  book.open ||= [];
  book.closed ||= [];
  book.xp ||= 0;
  const before = levelOf(book.xp);
  const byTicker = new Map((board?.markets || []).map((raw) => {
    const m = normalizeMarket(raw);
    return [m.ticker, m];
  }));
  const settled = [];
  book.open = book.open.filter((call) => {
    const m = byTicker.get(call.ticker);
    if (!m || (m.result !== 'yes' && m.result !== 'no')) return true;
    const won = m.result === call.side;
    const payout = won ? call.contracts : 0;
    const pnl = payout - call.cost - call.fee;
    const spot = spotFor(m, spots);
    const row = {
      ...call,
      won,
      result: m.result,
      pnl,
      fees: call.fee,
      settledAt: now,
      settleSpotPx: spot ? spot.px : null,
      settleSpotSource: spot ? spot.source : null,
      brier: brierScore(call.yesProb, m.result),
      marketBrier: brierScore(call.marketYes, m.result),
    };
    row.lesson = lessonText(row);
    book.closed.push(row);
    settled.push(row);
    return false;
  });
  if (book.closed.length > 500) book.closed.splice(0, book.closed.length - 500);
  if (settled.length) book.xp += TRAINER_XP_SETTLE * settled.length;
  book.stakeUsd = TRAINER_STAKE;
  const level = levelOf(book.xp);
  return { settled, level, levelUp: level > before };
}

export function hitStreak(closed) {
  const rows = [...(closed || [])].filter((r) => r.won != null).sort((a, b) => (b.settledAt || 0) - (a.settledAt || 0));
  let n = 0;
  for (const row of rows) {
    if (!row.won) break;
    n += 1;
  }
  return n;
}

export function calibrationBuckets(rows) {
  const cuts = [51, 60, 70, 80, 90, 100];
  return cuts.slice(0, -1).map((lo, i) => {
    const hi = cuts[i + 1];
    const mine = (rows || []).filter((r) => r.confidence >= lo && r.confidence < hi && r.won != null);
    const hits = mine.filter((r) => r.won).length;
    const top = hi - 1;
    return {
      lo,
      hi: top,
      n: mine.length,
      hits,
      rate: mine.length ? hits / mine.length : null,
      expected: (lo + top) / 2 / 100,
    };
  });
}

function dayOf(row) {
  const raw = row.closeTime || row.calledAt;
  if (typeof raw === 'number') return new Date(raw).toISOString().slice(0, 10);
  const text = String(raw || '');
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const t = Date.parse(text);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
}

export function trainerWindows(closed) {
  const groups = new Map();
  for (const row of closed || []) {
    if (!Number.isFinite(row.pnl)) continue;
    const key = dayOf(row);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, rows]) => {
    const boot = clusterBootstrap(rows.map((r) => ({ pnl: r.pnl, pool: r.series || r.ticker || '?' })), { iters: 200, seed: 7 });
    return { key, seen: false, n: rows.length, mean: boot.mean, lo: boot.lo, hi: boot.hi };
  });
}

export function trainerReady(closed) {
  const windows = trainerWindows(closed);
  const full = windows.filter((w) => w.n >= READY_CALLS);
  const good = full.filter((w) => w.mean > 0 && w.lo != null && w.lo > 0);
  const bad = full.filter((w) => !(w.mean > 0 && w.lo != null && w.lo > 0));
  const ready = graduates(windows);
  let text = `Days with ${READY_CALLS} or more calls: ${full.length}. Days that clear the bar: ${good.length}. You need at least ${READY_WINDOWS}, and every day that reaches ${READY_CALLS} has to clear.`;
  if (bad.length) text += ` ${bad.length} day${bad.length === 1 ? '' : 's'} reached ${READY_CALLS} calls and did not clear, so the bar stays closed.`;
  if (ready) text += ' The paper bar is cleared. That does not turn on a wallet, raise size, or make this advice.';
  else text += ' Not there yet. The chip stays $2.';
  text += ' Paper practice. Not advice.';
  return { windows, ready, full, good, bad, text, need: READY_WINDOWS, per: READY_CALLS };
}

function avg(values) {
  const xs = values.filter((n) => n != null && Number.isFinite(n));
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function trainerStats(book) {
  const closed = book?.closed || [];
  const open = book?.open || [];
  const hits = closed.filter((c) => c.won).length;
  return {
    calls: open.length + closed.length,
    settled: closed.length,
    open: open.length,
    hitRate: closed.length ? hits / closed.length : null,
    hits,
    brier: avg(closed.map((c) => c.brier)),
    marketBrier: avg(closed.map((c) => c.marketBrier)),
    pnl: closed.reduce((a, c) => a + (c.pnl || 0), 0),
    fees: closed.reduce((a, c) => a + (c.fees || 0), 0),
    streak: hitStreak(closed),
    xp: book?.xp || 0,
    level: levelOf(book?.xp || 0),
    buckets: calibrationBuckets(closed),
    ready: trainerReady(closed),
    stakeUsd: TRAINER_STAKE,
  };
}

export function brierVerdict(user, market, n) {
  if (user == null || market == null || !n) return 'No scored calls yet, so there is no Brier comparison.';
  const line = `Average Brier ${user.toFixed(3)} versus the quote ${market.toFixed(3)}.`;
  if (n < READY_CALLS) return `${line} Fewer than ${READY_CALLS} settles, so this does not say you beat the crowd.`;
  if (user < market) return `${line} Lower is better. On this paper sample your calls were closer than the quote. Not advice, and not a promise.`;
  if (user > market) return `${line} Lower is better. On this paper sample the quote was closer. Not advice.`;
  return `${line} The same as the quote on this paper sample. Not advice.`;
}

export function trainerTips() {
  const mid = kalshiTakerFee(0.5, 1);
  const wing = kalshiTakerFee(0.9, 1);
  const cheap = kalshiTakerFee(0.1, 1);
  return [
    {
      title: 'Fee math',
      body: `The Kalshi taker fee is 0.07 × contracts × price × (1 − price), rounded up to the next cent. One contract at 50¢ is $${mid.toFixed(2)}. One contract at 90¢ is $${wing.toFixed(2)}. One contract at 10¢ is $${cheap.toFixed(2)}.`,
    },
    {
      title: 'Why 50¢ costs the most',
      body: 'price × (1 − price) is 0.25 at 50¢ and 0.09 at 90¢ or 10¢. The same contract pays the most fee near 50¢. A favorite or a longshot is cheaper per contract. The fee is still real, and this trainer does not waive it.',
    },
    {
      title: 'Avoiding late chasing',
      body: 'A call in the last minute still pays the taker fee, and the price has little time left to move. The bots only act inside windows that were written down ahead of time. You can record a late call here so you can see that cost. After the window locks, the call is refused. Size stays $2.',
    },
    {
      title: 'Sizing small',
      body: `Every call risks about $${TRAINER_STAKE} of paper: the contracts that budget buys at the ask. A loss does not raise the next call. There is no make-it-back control.`,
    },
  ];
}
