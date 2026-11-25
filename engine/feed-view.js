// Arena feed detail sheet and share-card models. Pure: browser and tests.
// PAPER ONLY. Display only; numbers come straight from the log row or the
// data files. Share cards always carry a paper label and never a profit claim
// beyond the real after-fee number shown in the app.
import { usd, FAMILY, familyOf } from './home-view.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const finite = (n) => typeof n === 'number' && Number.isFinite(n);

export function feedSheetHtml(d) {
  if (!d) return '';
  const fam = FAMILY[String(d.rule || '').split('-')[0]];
  const when = finite(d.t) ? new Date(d.t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  const bits = String(d.reason || '').split(' · ').filter(Boolean).map((b) => `<li>${esc(b)}</li>`).join('');
  const money = d.action === 'settle' && finite(d.pnl)
    ? `<div class="sh-big"><b class="is-${d.pnl > 0 ? 'up' : d.pnl < 0 ? 'dn' : 'flat'}">${usd(d.pnl)}</b><span>paper result after fees${finite(d.fees) ? ` · fees $${d.fees.toFixed(2)}` : ''}</span></div>`
    : '';
  return `<div class="sh-feed" style="--ac:${fam?.color || '#8b97a6'}">
<header class="sh-head"><span class="agent-ic sh-ic" aria-hidden="true">${fam?.icon || '•'}</span><span class="sh-id"><h2 id="sheetTitle">${esc(String(d.action || '').toUpperCase())} · ${esc(d.rule)}</h2><small>${esc(fam?.name || 'Arena bot')}${when ? ` · ${esc(when)}` : ''}</small></span></header>
${money}
<p class="sh-why">${esc(d.title || d.rule)}</p>
${bits ? `<h3 class="sh-sec">Why</h3><ul class="sh-chips">${bits}</ul>` : ''}
<p class="sh-note">Paper only. $2 practice size, never raised after a loss. Estimates are Coinbase or OKX spots, not Kalshi prints.</p>
</div>`;
}

export const SHARE_URL = 'kodie4004-coder.github.io/grok-desk-paper';

// What a share card shows. Real fields only; null when there is nothing real.
export function shareModel(kind, x) {
  if (!x) return null;
  if (kind === 'bot') {
    if (!finite(x.net)) return null;
    const fam = FAMILY[familyOf(x)] || { color: '#3dff9a', name: 'Bot' };
    return {
      kind, accent: fam.color, title: x.id, kicker: fam.name,
      big: usd(x.net), bigTone: x.net > 0 ? 'up' : x.net < 0 ? 'dn' : 'flat', bigLabel: 'all-time, after fees',
      lines: [`${Number(x.n || 0).toLocaleString('en-US')} paper bets at $2 · ${usd(x.mean)} per bet`],
      spark: (x.spark || []).filter(finite), sparkCum: true, sparkLabel: x.recentN ? `last ${x.recentN} bets, running total` : '',
      badge: 'PAPER TRADING · NOT REAL MONEY',
    };
  }
  if (kind === 'pick') {
    if (!x.ca || !finite(x.score)) return null;
    return {
      kind, accent: '#ffe066', title: `${x.name} · $${x.symbol}`, kicker: 'Coin to watch',
      big: `${x.score}/100`, bigTone: 'flat', bigLabel: 'watch score',
      lines: [x.reason || '', (x.flags || []).map((f) => f.label).join(' · ')].filter(Boolean),
      spark: (x.spark || []).map((p) => p?.p).filter((p) => finite(p) && p > 0), sparkCum: false, sparkLabel: 'price, last 24h',
      badge: 'PAPER IDEA · NOT ADVICE',
    };
  }
  return null;
}
