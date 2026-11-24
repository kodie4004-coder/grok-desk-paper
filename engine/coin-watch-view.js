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

export function recordHtml(record) {
  const hs = [['m15', '15m'], ['h1', '1h'], ['h4', '4h']];
  const any = hs.some(([k]) => (record?.[k]?.n || 0) > 0);
  if (!any) {
    const n = record?.picks || 0;
    return `<div class="cw-rec is-empty"><b>Past picks</b><span>Tracking starts now${n ? ` · ${n} logged, first result in 15m` : ''}</span></div>`;
  }
  const cells = hs.map(([k, label]) => {
    const r = record[k] || {};
    if (!r.n) return `<li><small>${label}</small><b>—</b><em>waiting</em></li>`;
    const tone = r.avgNet > 0 ? 'is-up' : r.avgNet < 0 ? 'is-dn' : '';
    return `<li><small>${label}</small><b>${r.hits}/${r.n} up</b><em class="${tone}">${pct(r.avgNet)}</em></li>`;
  }).join('');
  return `<div class="cw-rec"><b>Past picks</b><ul>${cells}</ul><span>after fees + slippage</span></div>`;
}

function logo(p) {
  const initials = esc(String(p.symbol || '?').replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase() || '?');
  const hue = [...String(p.ca || '')].reduce((s, ch) => s + ch.charCodeAt(0), 0) % 360;
  if (!p.imageUrl) return `<span class="logo fallback" style="--h:${hue}" aria-hidden="true">${initials}</span>`;
  return `<img class="logo" alt="" loading="lazy" data-initials="${initials}" data-h="${hue}" src="${esc(p.imageUrl)}">`;
}

export function pickHtml(p, rank) {
  const ca = esc(p.ca);
  const short = p.ca.length > 12 ? `${p.ca.slice(0, 4)}…${p.ca.slice(-4)}` : p.ca;
  const tone = p.score >= 70 ? 'hot' : p.score >= 45 ? 'warm' : 'cool';
  const flags = (p.flags || []).map((f) => `<span class="cw-flag${f.warn ? ' is-warn' : ''}">${esc(f.label)}</span>`).join('');
  const link = (href, icon, label) => `<a class="cw-link" href="${esc(href)}" target="_blank" rel="noopener"><img src="${icon}" alt="" width="16" height="16">${label}</a>`;
  return `<li class="cw-pick">
<div class="cw-top">${logo(p)}<span class="cw-id"><b>${esc(p.name)}</b><small>#${rank} · $${esc(p.symbol)}</small></span>${priceSparkSvg(p.spark)}<span class="cw-score is-${tone}" style="--s:${Math.max(0, Math.min(100, p.score))}" aria-label="Score ${p.score} of 100"><b>${p.score}</b></span></div>
<p class="cw-why">${esc(p.reason)}</p>
<div class="cw-stats"><span><small>Liq</small>${money(p.liq)}</span><span><small>1h vol</small>${money(p.volH1)}</span><span><small>Age</small>${ageText(p.ageMin)}</span>${finite(p.holders) ? `<span><small>Holders</small>${p.holders >= 1000 ? `${r1(p.holders / 1000)}k` : p.holders}</span>` : ''}</div>
<div class="cw-flags">${flags}</div>
<div class="cw-act"><button type="button" class="ca-chip" data-expand-ca aria-expanded="false" aria-label="Contract address, tap to expand"><span class="ca-short">${esc(short)}</span><span class="ca-full">${ca}</span></button><button type="button" class="btn pri" data-copy="${ca}">Copy</button></div>
<div class="cw-links">${link(`https://pump.fun/coin/${encodeURIComponent(p.ca)}`, 'icons/pump.svg', 'Pump.fun')}${link(`https://fomo.family/tokens/solana/${encodeURIComponent(p.ca)}`, 'icons/fomo.svg', 'FOMO')}${link(p.dexUrl || `https://dexscreener.com/solana/${encodeURIComponent(p.ca)}`, 'icons/dex.svg', 'Dex')}</div>
</li>`;
}

export function coinWatchHtml(doc, now = Date.now()) {
  const note = '<p class="cw-note">Ideas, not advice. The coin practice bots are still losing after fees.</p>';
  if (!doc) {
    return `<section class="cw" aria-label="Coins to watch"><div class="sec-row"><h2 class="sec">Coins to watch</h2></div><div class="cw-card">${recordHtml(null)}${note}<p class="cw-empty">The first scan has not run yet.</p></div></section>`;
  }
  const at = Date.parse(doc.updatedAt || '');
  const ago = Number.isFinite(at) ? `${Math.max(0, Math.round((now - at) / 60000))}m ago` : '';
  const picks = (doc.picks || []).filter((p) => p?.ca);
  const body = picks.length
    ? `<ol class="cw-list">${picks.map((p, i) => pickHtml(p, i + 1)).join('')}</ol>`
    : `<p class="cw-empty">Nothing safe right now. ${doc.scanned || 0} checked${doc.blocked ? `, ${doc.blocked} blocked by safety` : ''}.</p>`;
  return `<section class="cw" aria-label="Coins to watch"><div class="sec-row"><h2 class="sec">Coins to watch</h2><span class="sec-note">${esc(ago)}${doc.pushOn ? ' · push on' : ''}</span></div><div class="cw-card">${recordHtml(doc.record)}${note}${body}</div></section>`;
}
