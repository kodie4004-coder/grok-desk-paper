// "While you were away" recap and the Today strip. Pure: browser and tests.
// PAPER ONLY. Display only: every number is a difference between two real
// snapshots of data files the runner already writes (alloc-curve.json,
// today.json, coin-watch.json). Nothing here moves a gate, a weight or a size.
import { usd, tone } from './home-view.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const finite = (n) => typeof n === 'number' && Number.isFinite(n);
export const AWAY_MIN_MS = 20 * 60 * 1000;

// Snapshot of what the owner saw on this visit.
export function seenSnapshot({ curve, today, coinWatch, now = Date.now() } = {}) {
  if (!curve || !finite(curve.net)) return null;
  const bots = {};
  for (const s of today?.decay || []) if (s?.id && finite(s.net)) bots[s.id] = s.net;
  return { at: now, net: curve.net, n: curve.n || 0, bots, picks: (coinWatch?.picks || []).map((p) => p?.ca).filter(Boolean) };
}

export function awayText(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hr`;
  return `${Math.round(h / 24)} days`;
}

// What changed between the last visit and now. null when there is nothing to say.
export function awaySummary(prev, cur) {
  if (!prev || !cur || !finite(prev.at) || !finite(cur.at) || cur.at - prev.at < AWAY_MIN_MS) return null;
  const pnl = finite(prev.net) && finite(cur.net) ? Math.round((cur.net - prev.net) * 100) / 100 : null;
  const bets = Math.max(0, (cur.n || 0) - (prev.n || 0));
  let mover = null;
  for (const [id, net] of Object.entries(cur.bots || {})) {
    const was = prev.bots?.[id];
    if (!finite(was) || !finite(net)) continue;
    const d = Math.round((net - was) * 100) / 100;
    if (d !== 0 && (!mover || Math.abs(d) > Math.abs(mover.delta))) mover = { id, delta: d };
  }
  const seen = new Set(prev.picks || []);
  const newPicks = (cur.picks || []).filter((ca) => !seen.has(ca)).length;
  if (!bets && !mover && !newPicks && !pnl) return null;
  return { away: awayText(cur.at - prev.at), pnl, bets, mover, newPicks };
}

export function awayHtml(sum) {
  if (!sum) return '';
  const items = [
    sum.pnl != null ? `<li><small>Desk P&amp;L</small><b class="is-${tone(sum.pnl)}">${usd(sum.pnl)}</b></li>` : '',
    `<li><small>New bets</small><b>${sum.bets.toLocaleString('en-US')}</b></li>`,
    sum.mover ? `<li><small>Biggest mover</small><b class="is-${tone(sum.mover.delta)}">${esc(sum.mover.id)} ${usd(sum.mover.delta)}</b></li>` : '',
    sum.newPicks ? `<li><small>New coin picks</small><b>${sum.newPicks}</b></li>` : '',
  ].join('');
  return `<section class="away" aria-label="While you were away"><div class="away-head"><b>While you were away</b><span>${esc(sum.away)} · paper, after fees</span><button type="button" class="away-x" data-away-close aria-label="Dismiss">✕</button></div><ul>${items}</ul></section>`;
}

// Glanceable strip under the hero. closeAt drives a live countdown in the app.
export function todayStripHtml({ today, coinWatch, closeAt, now = Date.now() } = {}) {
  const tiles = [];
  const lead = (today?.decay || []).filter((x) => x?.id && x.recentN && finite(x.recentNet)).sort((a, b) => b.recentNet - a.recentNet)[0];
  if (lead) tiles.push(`<li role="button" tabindex="0" data-tabjump="brain"><small>Hot bot</small><b class="is-${tone(lead.recentNet)}">${usd(lead.recentNet)}</b><em>${esc(lead.id)} · last ${lead.recentN}</em></li>`);
  const picks = (coinWatch?.picks || []).filter((p) => p?.ca);
  if (coinWatch) tiles.push(`<li role="button" tabindex="0" data-tabjump="coins"><small>Coins to watch</small><b>${picks.length}</b><em>${picks.length ? `top score ${Math.max(...picks.map((p) => p.score || 0))}` : 'none safe'}</em></li>`);
  const close = Date.parse(closeAt || '');
  if (Number.isFinite(close)) tiles.push(`<li role="button" tabindex="0" data-tabjump="arena"><small>Next close</small><b class="live-clock" data-close="${new Date(close).toISOString()}">${clockText(close, now)}</b><em>15-min window</em></li>`);
  if (!tiles.length) return '';
  return `<section class="tstrip" aria-label="Today"><ul>${tiles.join('')}</ul></section>`;
}

export function clockText(closeMs, now = Date.now()) {
  const s = Math.max(0, Math.round((closeMs - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
