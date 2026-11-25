// Fee-first ticket and the pre-trade check behind it. One function sizes a
// line, prices the fee, and runs the shared limits, for the ticket on every
// bet and market sheet and for the trainer's practice calls. Paper only: the
// check returns numbers and a yes/no; nothing here can place an order.
import { kalshiTakerFee } from './kalshi.js';
import { riskCheck, RECORDED_STAKE, RISK_WORDS } from './risk.js';
import { tradingMode } from './mode.js';
import { MEME_FEE, MEME_SLIP } from './meme.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const usd = (x, sign) => (!Number.isFinite(x) ? '–' : (sign && x > 0.004 ? '+' : x < -0.004 ? '−' : '') + '$' + Math.abs(x).toFixed(2));
const cents = (p) => (!Number.isFinite(p) ? '–' : (Math.round(p * 1000) / 10).toFixed(p * 100 % 1 ? 1 : 0) + '¢');
const tone = (x) => (x > 0.004 ? 'up' : x < -0.004 ? 'dn' : 'flat');

// Kalshi: buy `side` at `ask` for `stake` paper dollars.
//   contracts  floor(stake / ask)
//   fee        round up(0.07 × C × P × (1 − P)), taker; makers pay 0
//   breakEven  the win rate (and price) this needs after the fee: ask + fee / C
//   maxWin     C × $1 − cost − fee (settles your way)
//   maxLoss    −(cost + fee) (settles against you)
//   ev(p)      p × C − cost − fee, after the entry fee, held to settle
export function preTradeCheck({ ask, bid = null, side = 'yes', stake = RECORDED_STAKE, settings = null, bot = null, counted = false, dayPnl = 0, openCounted = 0, pWin = null, maker = false } = {}) {
  const price = Number(ask);
  const base = { paper: true, mode: tradingMode(), book: 'kalshi', side, stake: Number(stake) };
  if (!(price > 0 && price < 1)) return { ...base, ok: false, why: 'no ask', contracts: 0 };
  const c = Math.floor((Number(stake) + 1e-9) / price);
  const risk = riskCheck({ settings, bot, stake, counted, dayPnl, openCounted });
  if (c < 1) return { ...base, ask: price, ok: false, why: 'too small', contracts: 0, risk };
  const fee = maker ? 0 : kalshiTakerFee(price, c);
  const cost = c * price;
  const b = Number(bid);
  const hasBid = b > 0 && b < 1 && b <= price;
  const pMarket = hasBid ? (b + price) / 2 : price;
  const ev = (p) => (Number.isFinite(p) ? p * c - cost - fee : null);
  const exitNow = hasBid ? c * b - cost - fee - kalshiTakerFee(b, c) : null;
  return {
    ...base, ok: risk.ok, why: risk.ok ? null : risk.why, risk,
    ask: price, bid: hasBid ? b : null, contracts: c, fee, cost, outlay: cost + fee,
    feePerContract: fee / c, breakEven: price + fee / c,
    maxWin: c - cost - fee, maxLoss: -(cost + fee),
    pMarket, evMarket: ev(pMarket), pWin: Number.isFinite(Number(pWin)) && pWin !== null ? Number(pWin) : null,
    evYou: pWin == null ? null : ev(Number(pWin)), exitNow,
  };
}

// Coins: buy at `entry` for `stake`. 1.25% fee each way plus modeled slippage
// on both legs. Break-even is the price move that pays both fees and slips.
export function preTradeCoin({ entry, stake = RECORDED_STAKE, slip = MEME_SLIP, settings = null, bot = null, counted = false, dayPnl = 0, openCounted = 0 } = {}) {
  const px = Number(entry);
  const base = { paper: true, mode: tradingMode(), book: 'coin', stake: Number(stake) };
  const risk = riskCheck({ settings, bot, stake, counted, dayPnl, openCounted });
  if (!(px > 0)) return { ...base, ok: false, why: 'no price', risk };
  const f = MEME_FEE;
  const sl = Math.min(0.9, Math.max(0, Number(slip) || 0));
  const move = ((1 + f) / (1 - f)) * ((1 + sl) / (1 - sl)) - 1;
  return { ...base, ok: risk.ok, why: risk.ok ? null : risk.why, risk, entry: px, feeIn: stake * f, breakEvenMove: move, breakEvenPx: px * (1 + move), maxLoss: -stake * (1 + f), maxWin: null, slip: sl };
}

export function ticketHtml(t, { title = 'Ticket', note = '', simLabel = null } = {}) {
  if (!t) return '';
  const head = `<div class="tk-head"><b>${esc(title)}</b>${simLabel ? `<i class="simb">${esc(simLabel)}</i>` : ''}<span class="tk-mode" title="Paper ticket. Live trading is disabled in this build.">PAPER · LIVE OFF</span></div>`;
  if (t.book === 'coin') {
    if (!t.entry) return `<section class="ticket">${head}<p class="note">No price yet, so no ticket.</p></section>`;
    return `<section class="ticket" aria-label="${esc(title)}">${head}<div class="tk-grid">
      <div class="tk-cell"><small>Buy-in</small><b>${usd(t.stake)}</b></div>
      <div class="tk-cell"><small>Fee in</small><b class="fee-mint">${usd(t.feeIn)}</b></div>
      <div class="tk-cell tk-key"><small>Break-even move</small><b class="fee-gold">+${(t.breakEvenMove * 100).toFixed(1)}%</b></div>
      <div class="tk-cell"><small>Max loss</small><b class="is-dn">${usd(t.maxLoss, true)}</b></div>
    </div><p class="tk-foot">1.25% each way plus ${(t.slip * 100).toFixed(1)}% modeled slippage per leg. ${riskLine(t)}${esc(note)}</p></section>`;
  }
  if (!t.contracts) return `<section class="ticket">${head}<p class="note">${t.why === 'too small' ? `${usd(t.stake)} buys no contract at ${cents(t.ask)}.` : 'No ask in the quote, so no ticket.'}</p></section>`;
  const ev = t.evYou != null ? t.evYou : t.evMarket;
  return `<section class="ticket" aria-label="${esc(title)}">${head}<div class="tk-grid">
    <div class="tk-cell"><small>Contracts</small><b>${t.contracts}</b><em>@ ${cents(t.ask)}</em></div>
    <div class="tk-cell"><small>Taker fee</small><b class="fee-mint">${usd(t.fee)}</b><em>${(t.feePerContract * 100).toFixed(2)}¢ each</em></div>
    <div class="tk-cell tk-key"><small>Break-even</small><b class="fee-gold">${(t.breakEven * 100).toFixed(1)}%</b><em>win rate needed</em></div>
    <div class="tk-cell"><small>Max win</small><b class="is-up">${usd(t.maxWin, true)}</b></div>
    <div class="tk-cell"><small>Max loss</small><b class="is-dn">${usd(t.maxLoss, true)}</b></div>
    <div class="tk-cell"><small>EV after fees</small><b class="is-${tone(ev)}">${usd(ev, true)}</b><em>${t.evYou != null ? `at your ${Math.round(t.pWin * 100)}%` : `at the market's ${Math.round(t.pMarket * 100)}%`}</em></div>
  </div><p class="tk-foot">${t.exitNow != null ? `Sell now at the bid: ${usd(t.exitNow, true)} after both fees. ` : ''}Fee = round up(0.07 × C × P × (1 − P)). ${riskLine(t)}${esc(note)}</p></section>`;
}

function riskLine(t) {
  if (!t.risk || t.risk.ok) return '';
  return `<b class="tk-risk">${esc(RISK_WORDS[t.risk.why] || t.risk.why)}.</b> `;
}
