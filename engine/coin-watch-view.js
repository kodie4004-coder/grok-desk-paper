// Coins to watch card. Pure HTML from data/coin-watch.json. No buy button,
// no wallet: links open the coin elsewhere and Copy puts the mint on the
// clipboard so the owner can trade it himself.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const finite = (x) => typeof x === 'number' && Number.isFinite(x);
const r1 = (x) => Math.round(x * 10) / 10;

export function money(x) {
  if (!finite(x)) return '—';
  if (x >= 1e6) return `$${(x / 1e6).toFixed(1)}M`;
  if (x >= 1e3) return `$${Math.round(x / 1e3)}k`;
  return `$${Math.round(x)}`;
}

export function ageText(min) {
  if (!finite(min)) return '—';
  if (min < 60) return `${Math.max(0, Math.round(min))}m`;
  if (min < 48 * 60) return `${Math.round(min / 60)}h`;
  return `${Math.round(min / 1440)}d`;
}

const pct = (x) => (finite(x) ? `${x > 0 ? '+' : ''}${(x * 100).toFixed(1)}%` : '—');

// Price line from the stored points (minutes from now, price).
export function priceSparkSvg(points, { w = 96, h = 30 } = {}) {
  const pts = (points || []).filter((p) => finite(p?.m) && finite(p?.p) && p.p > 0);
  if (pts.length < 2) return '<span class="cw-spark-none" aria-hidden="true"></span>';
  const ys = pts.map((p) => Math.log(p.p));
  const min = Math.min(...ys), max = Math.max(...ys);
  const span = max - min || 1;
  const x = (i) => r1(1 + (i / (pts.length - 1)) * (w - 2));
  const y = (v) => r1(h - 2 - ((v - min) / span) * (h - 4));
  const line = ys.map((v, i) => `${i ? 'L' : 'M'}${x(i)} ${y(v)}`).join(' ');
  const area = `${line} L${x(ys.length - 1)} ${h} L${x(0)} ${h} Z`;
  const t = pts[pts.length - 1].p > pts[0].p ? 'up' : pts[pts.length - 1].p < pts[0].p ? 'dn' : 'flat';
  return `<svg class="spark cw-spark is-${t}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Price over 24 hours, ${t === 'up' ? 'up' : t === 'dn' ? 'down' : 'flat'}" focusable="false"><path class="spark-area" d="${area}"/><path class="spark-line" d="${line}" vector-effect="non-scaling-stroke"/><circle class="spark-dot" cx="${x(ys.length - 1)}" cy="${y(ys[ys.length - 1])}" r="2.4"/></svg>`;
}

// Pick record as three glanceable tiles: hit rate big, after-fee average
// under it, and a bar for the share of picks that went up. Real counts only.
export function recordHtml(record) {
  const hs = [['m15', '15 min'], ['h1', '1 hour'], ['h4', '4 hours']];
  const any = hs.some(([k]) => (record?.[k]?.n || 0) > 0);
  if (!any) {
    const n = record?.picks || 0;
    return `<div class="cw-rec is-empty"><b>Pick record</b><span>Tracking starts now${n ? ` · ${n} logged, first result in 15m` : ''}</span></div>`;
  }
  const cells = hs.map(([k, label]) => {
    const r = record[k] || {};
    if (!r.n) return `<li class="cw-tile is-wait"><small>${label}</small><b>—</b><em>waiting</em></li>`;
    const t = r.avgNet > 0 ? 'is-up' : r.avgNet < 0 ? 'is-dn' : '';
    const rate = Math.round((r.hits / r.n) * 100);
    return `<li class="cw-tile ${t}" style="--p:${rate}%"><small>${label}</small><b>${pct(r.avgNet)}</b><em>${r.hits}/${r.n} up</em><i class="cw-bar" aria-hidden="true"></i></li>`;
  }).join('');
  return `<div class="cw-rec"><div class="cw-rec-head"><b>Pick record</b><span>avg after fees + slippage</span></div><ul>${cells}</ul></div>`;
}

function logo(p) {
  const initials = esc(String(p.symbol || '?').replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase() || '?');
  const hue = [...String(p.ca || '')].reduce((s, ch) => s + ch.charCodeAt(0), 0) % 360;
  if (!p.imageUrl) return `<span class="logo fallback" style="--h:${hue}" aria-hidden="true">${initials}</span>`;
  return `<img class="logo" alt="" loading="lazy" data-initials="${initials}" data-h="${hue}" src="${esc(p.imageUrl)}">`;
}

const shortCa = (ca) => (ca.length > 12 ? `${ca.slice(0, 4)}…${ca.slice(-4)}` : ca);
const toneOf = (score) => (score >= 70 ? 'hot' : score >= 45 ? 'warm' : 'cool');
const scoreRing = (score, cls = '') => `<span class="cw-score is-${toneOf(score)} ${cls}" style="--s:${Math.max(0, Math.min(100, score))}" aria-label="Score ${score} of 100"><b>${score}</b></span>`;
const outLinks = (p, cls) => {
  const link = (href, icon, label) => `<a class="${cls}" href="${esc(href)}" target="_blank" rel="noopener" aria-label="Open in ${label}"><img src="${icon}" alt="" width="16" height="16"><span>${label}</span></a>`;
  return link(`https://pump.fun/coin/${encodeURIComponent(p.ca)}`, 'icons/pump.svg', 'Pump.fun') + link(`https://fomo.family/tokens/solana/${encodeURIComponent(p.ca)}`, 'icons/fomo.svg', 'FOMO') + link(p.dexUrl || `https://dexscreener.com/solana/${encodeURIComponent(p.ca)}`, 'icons/dex.svg', 'Dex');
};

// Compact list row (Phantom / Coinbase style). Tap the row for the sheet;
// Copy and the three app links stay one tap away on the row itself.
export function pickHtml(p, rank) {
  const ca = esc(p.ca);
  const warn = (p.flags || []).some((f) => f.warn);
  return `<li class="cw-pick${warn ? ' has-warn' : ''}" style="--i:${rank - 1}">
<button type="button" class="cw-top" data-open-pick="${ca}" aria-label="${esc(p.name)} details">${logo(p)}<span class="cw-id"><b>${esc(p.name)}</b><small>#${rank} · $${esc(p.symbol)}${warn ? ' · <span class="cw-warn">check flags</span>' : ''}</small></span>${priceSparkSvg(p.spark, { w: 72, h: 28 })}${scoreRing(p.score)}</button>
<p class="cw-why">${esc(p.reason)}</p>
<div class="cw-act"><button type="button" class="cw-copy" data-copy="${ca}" aria-label="Copy contract address ${esc(shortCa(p.ca))}">${esc(shortCa(p.ca))}</button>${outLinks(p, 'cw-ico')}</div>
</li>`;
}

// What made the score. Weights from scoreWatch() in coin-watch.js.
export const SCORE_PARTS = [['surge', 'Volume surge', 30], ['vol', '1h volume', 20], ['depth', 'Liquidity depth', 20], ['trend', '1h trend', 15], ['buys', 'Buy share', 15]];

export function pickSheetHtml(p, rank) {
  if (!p) return '';
  const ca = esc(p.ca);
  const flags = (p.flags || []).map((f) => `<span class="cw-flag${f.warn ? ' is-warn' : ''}">${esc(f.label)}</span>`).join('');
  const stat = (k, v) => `<div class="sh-stat"><small>${k}</small><b>${v}</b></div>`;
  const h1 = finite(p.h1) ? `<span class="${p.h1 > 0 ? 'is-up' : p.h1 < 0 ? 'is-dn' : ''}">${p.h1 > 0 ? '+' : ''}${p.h1.toFixed(1)}%</span>` : '—';
  const parts = p.parts ? SCORE_PARTS.map(([k, label, max]) => {
    const v = finite(p.parts[k]) ? Math.max(0, Math.min(max, p.parts[k])) : 0;
    return `<li><span>${label}</span><i style="--w:${Math.round((v / max) * 100)}%" aria-hidden="true"></i><b>${Math.round(v)}/${max}</b></li>`;
  }).join('') : '';
  return `<header class="sh-head">${logo(p)}<span class="sh-id"><h2 id="sheetTitle">${esc(p.name)}</h2><small>#${rank} pick · $${esc(p.symbol)}</small></span>${scoreRing(p.score, 'is-big')}</header>
<div class="sh-chart">${priceSparkSvg(p.spark, { w: 320, h: 110 })}<span class="sh-chart-k">Price, last 24h · 1h ${h1}</span></div>
<p class="sh-why">${esc(p.reason)}</p>
<div class="sh-stats">${stat('Liquidity', money(p.liq))}${stat('1h volume', money(p.volH1))}${stat('Age', ageText(p.ageMin))}${stat('Holders', finite(p.holders) ? p.holders.toLocaleString('en-US') : '—')}</div>
<div class="cw-flags">${flags}</div>
${parts ? `<h3 class="sh-sec">Why this score</h3><ul class="sh-parts">${parts}</ul>` : ''}
<div class="sh-ca"><span class="sh-ca-full">${ca}</span><button type="button" class="btn pri" data-copy="${ca}">Copy</button></div>
<div class="sh-links">${outLinks(p, 'cw-link')}</div>
<p class="sh-note">Idea, not advice. You buy it yourself in Pump.fun or FOMO. Paper only.</p>`;
}

export function coinWatchHtml(doc, now = Date.now()) {
  const note = '<p class="cw-note">Ideas, not advice. The coin practice bots are still losing after fees.</p>';
  if (!doc) {
    return `<section class="cw" aria-label="Coins to watch"><div class="sec-row"><h2 class="sec">Coins to watch</h2></div>${recordHtml(null)}<p class="cw-empty">The first scan has not run yet.</p>${note}</section>`;
  }
  const at = Date.parse(doc.updatedAt || '');
  const ago = Number.isFinite(at) ? `${Math.max(0, Math.round((now - at) / 60000))}m ago` : '';
  const picks = (doc.picks || []).filter((p) => p?.ca);
  const body = picks.length
    ? `<ol class="cw-list">${picks.map((p, i) => pickHtml(p, i + 1)).join('')}</ol>`
    : `<p class="cw-empty">Nothing safe right now. ${doc.scanned || 0} checked${doc.blocked ? `, ${doc.blocked} blocked by safety` : ''}.</p>`;
  return `<section class="cw" aria-label="Coins to watch"><div class="sec-row"><h2 class="sec">Coins to watch</h2><span class="sec-note">${esc(ago)}${doc.pushOn ? ' · push on' : ''}</span></div>${recordHtml(doc.record)}${body}${note}</section>`;
}
