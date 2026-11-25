// "Call it": the trainer on the front of the Desk. Up or down on the current
// 15-minute window, scored on settle, with a daily streak. Paper practice at
// a fixed $2; streaks and XP reward correct calls, never size.
import { preTradeCheck } from './ticket.js';
import { STREAK_BADGES, TRAINER_STAKE } from './trainer.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const usd = (x, sign) => (!Number.isFinite(x) ? '–' : (sign && x > 0.004 ? '+' : x < -0.004 ? '−' : '') + '$' + Math.abs(x).toFixed(2));
const cents = (p) => (Number(p) > 0 && Number(p) < 1 ? Math.round(p * 100) + '¢' : '–');
export const CALL_CONF = Object.freeze([55, 65, 75, 85]);

export function pickCallMarket(markets, now = Date.now(), series = 'KXBTC15M') {
  const open = (markets || []).filter((m) => m && !m.result && Date.parse(m.closeTime) > now + 20e3);
  const mine = open.filter((m) => String(m.series || m.ticker).startsWith(series));
  return (mine.length ? mine : open).sort((a, b) => Date.parse(a.closeTime) - Date.parse(b.closeTime))[0] || null;
}

export function callItHtml({ market = null, book = null, streak = null, side = '', conf = 65, now = Date.now(), stale = false, last = null } = {}) {
  const st = streak || { days: 0, hits: 0, bestHits: 0, todayCalls: 0, todayRight: 0, todaySettled: 0, badges: [] };
  const chips = `<div class="ci-streak"><span class="ci-chip is-days" title="Days in a row with a call"><b>${st.days}</b><small>day streak</small></span><span class="ci-chip is-hits" title="Correct calls in a row"><b>${st.hits}</b><small>right in a row</small></span><span class="ci-chip"><b>${st.todayRight}/${st.todaySettled}</b><small>today</small></span></div>`;
  const badges = st.badges.length ? `<p class="ci-badges">${STREAK_BADGES.filter((b) => st.badges.includes(b.id)).map((b) => `<span class="ci-badge">${esc(b.label)}</span>`).join('')}</p>` : '';
  const head = `<div class="ci-head"><h2 class="ci-t">Call it <small>15-min · paper $${TRAINER_STAKE}</small></h2>${chips}</div>`;
  const lastHtml = last ? `<p class="ci-last is-${last.won ? 'up' : 'dn'}">Last call: ${last.side === 'yes' ? 'Up' : 'Down'} ${last.won ? '✓ right' : '✗ wrong'} · ${usd(last.pnl, true)} after fees</p>` : '';
  if (!market || stale) {
    return `<section class="callit" aria-label="Call it">${head}<p class="note">${stale ? 'The snapshot is older than 15 minutes, so there is no live window to call.' : 'No 15-minute window is open in this snapshot yet.'}</p>${lastHtml}${badges}<button type="button" class="btn" data-tabjump="train">Open the trainer</button></section>`;
  }
  const close = Date.parse(market.closeTime);
  const mine = (book?.open || []).find((c) => c.ticker === market.ticker);
  const left = Math.max(0, Math.round((close - now) / 1000));
  const clock = `<span class="ci-clock live-clock" data-close="${esc(market.closeTime)}">${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}</span>`;
  const name = String(market.series || market.ticker).replace(/^KX|15M$/g, '');
  const strike = Number(market.floorStrike) > 0 ? ` · start $${Number(market.floorStrike).toLocaleString('en-US', { maximumFractionDigits: 2 })}` : '';
  if (mine) {
    return `<section class="callit is-called" aria-label="Call it">${head}<div class="ci-mkt"><b>${esc(name)} up in 15 min?</b>${clock}</div><p class="ci-mine">You called <b class="is-${mine.side === 'yes' ? 'up' : 'dn'}">${mine.side === 'yes' ? 'Up ↑' : 'Down ↓'}</b> at ${mine.confidence}% · ${mine.contracts} contracts · fee ${usd(mine.fee)}. Scored when the window settles.</p>${lastHtml}${badges}<div class="ci-act"><button type="button" class="btn" data-market-sheet="${esc(market.ticker)}">Window &amp; ticket</button><button type="button" class="btn" data-tabjump="train">Trainer</button></div></section>`;
  }
  const t = side ? preTradeCheck({ ask: side === 'yes' ? market.yesAsk : market.noAsk, bid: side === 'yes' ? market.yesBid : market.noBid, side, stake: TRAINER_STAKE, pWin: conf / 100 }) : null;
  const btn = (s, label, arrow, ask) => `<button type="button" class="ci-side is-${s === 'yes' ? 'up' : 'dn'}${side === s ? ' on' : ''}" data-ci-side="${s}" aria-pressed="${side === s}"><span class="ci-arrow" aria-hidden="true">${arrow}</span><b>${label}</b><small>${cents(ask)}</small></button>`;
  const confRow = `<div class="ci-conf" role="group" aria-label="How sure">${CALL_CONF.map((c) => `<button type="button" data-ci-conf="${c}" class="${conf === c ? 'on' : ''}" aria-pressed="${conf === c}">${c}%</button>`).join('')}</div>`;
  const mini = t && t.contracts ? `<p class="ci-ticket">${t.contracts} contracts · fee <b class="fee-mint">${usd(t.fee)}</b> · break-even <b class="fee-gold">${(t.breakEven * 100).toFixed(1)}%</b> · EV at ${conf}% <b class="is-${t.evYou > 0 ? 'up' : 'dn'}">${usd(t.evYou, true)}</b></p>` : '<p class="ci-ticket note">Pick Up or Down. The fee and break-even show here before you lock it in.</p>';
  return `<section class="callit" aria-label="Call it">${head}<div class="ci-mkt"><b>${esc(name)} up in 15 min?</b>${clock}<small>${esc(strike.slice(3))}</small></div>
    <div class="ci-sides">${btn('yes', 'Up', '↑', market.yesAsk)}${btn('no', 'Down', '↓', market.noAsk)}</div>
    ${confRow}${mini}
    <div class="ci-act"><button type="button" class="btn pri" data-ci-go="${esc(market.ticker)}"${side ? '' : ' disabled'}>Lock in my call</button><button type="button" class="btn" data-market-sheet="${esc(market.ticker)}">Window &amp; ticket</button></div>
    ${lastHtml}${badges}<p class="ci-foot">Scored on settle after the real taker fee. Streaks reward being right; the size is always $${TRAINER_STAKE}.</p></section>`;
}
