// Cheap-late guard pills for the Bots tab. Same pill and tap-to-open compare as
// the coin-watch challenger. Every number comes from lessons.json guardReport().
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const finite = (x) => typeof x === 'number' && Number.isFinite(x);
const usd = (x) => (finite(x) ? `${x > 0 ? '+' : x < 0 ? '−' : ''}$${Math.abs(x).toFixed(2)}` : '—');
const tone = (x) => (finite(x) ? (x > 0 ? 'is-up' : x < 0 ? 'is-dn' : '') : '');
const dayText = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : ''; };

const ruleText = (r) => (r && finite(r.maxAsk) && finite(r.minLeft) && finite(r.maxLeft) ? ` · skips ask &lt; ${r.maxAsk.toFixed(2)}, ${r.minLeft / 60}–${r.maxLeft / 60} min` : '');

export function guardPillHtml(row, need, since) {
  if (!row?.id) return '';
  const n = finite(row.n) ? row.n : 0;
  const tr = (name, cnt, mean, cls) => `<tr class="${cls}"><th scope="row">${esc(name)}</th><td>${finite(cnt) ? cnt : 0}</td><td class="${tone(mean)}">${usd(mean)}</td></tr>`;
  return `<details class="cw-ch" data-fold="guard-${esc(row.id)}"><summary class="cw-ch-pill"><i aria-hidden="true"></i>Challenger · ${n}/${need} <small>${esc(row.id)}</small></summary>
<table class="cw-ch-cmp"><thead><tr><th scope="col"></th><th scope="col">n</th><th scope="col">After fees</th></tr></thead><tbody>${tr(row.parent + (row.parentBenched ? ' · benched' : ''), row.parentN, row.parentMean, 'is-champ')}${tr(row.id, row.n, row.mean, 'is-chall')}</tbody></table>
<p class="cw-ch-k">Since ${esc(dayText(since))}${ruleText(row.rule)} · holdout decides</p></details>`;
}

export function guardChallengersHtml(guard) {
  const pairs = (guard?.pairs || []).filter((p) => p && p.id);
  if (!pairs.length || !guard.experimentSince) return '';
  const need = finite(guard.need) ? guard.need : 20;
  const pills = pairs.map((p) => guardPillHtml({ ...p, rule: guard.rule }, need, guard.experimentSince)).join('');
  return `<section class="guard-ch" aria-label="Cheap-late guard challengers">${pills}</section>`;
}
