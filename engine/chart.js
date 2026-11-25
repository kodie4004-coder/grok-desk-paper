// Detailed charts: exact points, time ranges, axes, gaps. Pure SVG strings so
// node tests can check the geometry. Points are never interpolated: a P&L
// series steps (it only changes when a line settles) and a price series
// breaks where the feed has no candle for longer than the gap limit.
export const RANGES = Object.freeze({ '1h': 3600e3, '1d': 86400e3, '1w': 7 * 86400e3, all: Infinity });
export const RANGE_KEYS = Object.freeze(['1h', '1d', '1w', 'all']);

export function inRange(points, range = 'all', now = Date.now()) {
  const span = RANGES[range] ?? Infinity;
  const from = now - span;
  return (points || []).filter((p) => p && Number.isFinite(p.t) && Number.isFinite(p.v) && p.t >= from && p.t <= now + 60e3).sort((a, b) => a.t - b.t);
}

// Split where two neighbours are further apart than maxGapMs.
export function segments(points, maxGapMs = Infinity) {
  const out = [];
  let cur = [];
  for (const p of points || []) {
    if (cur.length && p.t - cur[cur.length - 1].t > maxGapMs) { out.push(cur); cur = []; }
    cur.push(p);
  }
  if (cur.length) out.push(cur);
  return out;
}

// Cumulative after-fee P&L from settled lines [{t, pnl}]. One point per line.
export function cumulative(lines, start = 0) {
  let run = start;
  return [...(lines || [])].filter((l) => Number.isFinite(l.t) && Number.isFinite(l.pnl)).sort((a, b) => a.t - b.t).map((l) => { run += l.pnl; return { t: l.t, v: Math.round(run * 100) / 100, d: l.pnl, n: l.n }; });
}

export function niceTicks(min, max, count = 4) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) { const pad = Math.abs(min) * 0.05 || 1; min -= pad; max += pad; }
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || 10 * mag;
  const out = [];
  const end = Math.ceil(max / step - 1e-9) * step;
  for (let v = Math.floor(min / step + 1e-9) * step; v <= end + 1e-12; v += step) out.push((Math.round(v / step) * step) || 0);
  return out;
}

const pad2 = (n) => String(n).padStart(2, '0');
export function timeLabel(t, spanMs) {
  const d = new Date(t);
  if (spanMs <= 2 * 86400e3) return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return `${d.toLocaleString('en-US', { month: 'short' })} ${d.getDate()}`;
}

export function fmtValue(v, kind) {
  if (!Number.isFinite(v)) return '–';
  if (kind === 'pnl') return (v > 0.004 ? '+' : v < -0.004 ? '−' : '') + '$' + Math.abs(v).toFixed(2);
  const a = Math.abs(v);
  return '$' + (a >= 1000 ? v.toLocaleString('en-US', { maximumFractionDigits: 0 }) : a >= 1 ? v.toFixed(2) : v.toPrecision(4));
}

// The SVG for a detailed chart. data-points carries the exact series for the
// crosshair (time, value) so the tooltip reads the real number.
export function chartSvg({ points = [], kind = 'pnl', gapMs = Infinity, w = 640, h = 220, step = kind === 'pnl', label = '' } = {}) {
  const pts = points.filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v));
  if (pts.length < 2) return `<div class="dchart-empty">${pts.length ? 'Only one point in this range.' : 'No points in this range.'}</div>`;
  const L = 58, R = 12, T = 12, B = 26;
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
  let lo = Math.min(...pts.map((p) => p.v)), hi = Math.max(...pts.map((p) => p.v));
  // Keep $0 on the axis only when it is near the data, so a far-away zero
  // does not flatten the detail.
  if (kind === 'pnl' && Math.min(Math.abs(lo), Math.abs(hi)) <= Math.max(1, hi - lo)) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
  const ticks = niceTicks(lo, hi, 4);
  lo = Math.min(lo, ticks[0] ?? lo); hi = Math.max(hi, ticks[ticks.length - 1] ?? hi);
  const span = hi - lo || 1, tspan = t1 - t0 || 1;
  const x = (t) => L + ((t - t0) / tspan) * (w - L - R);
  const y = (v) => T + (1 - (v - lo) / span) * (h - T - B);
  const f = (n) => n.toFixed(1);
  const segs = segments(pts, gapMs);
  const paths = segs.map((s) => {
    let d = `M${f(x(s[0].t))},${f(y(s[0].v))}`;
    for (let i = 1; i < s.length; i++) d += step ? `H${f(x(s[i].t))}V${f(y(s[i].v))}` : `L${f(x(s[i].t))},${f(y(s[i].v))}`;
    return d;
  });
  const last = pts[pts.length - 1].v;
  const tone = kind === 'pnl' ? (last > 0 ? 'up' : last < 0 ? 'dn' : 'flat') : (last >= pts[0].v ? 'up' : 'dn');
  const yAxis = ticks.map((v) => `<g class="dc-y"><line x1="${L}" x2="${w - R}" y1="${f(y(v))}" y2="${f(y(v))}"></line><text x="${L - 6}" y="${f(y(v) + 3.5)}" text-anchor="end">${fmtValue(v, kind)}</text></g>`).join('');
  const xs = [0, 0.25, 0.5, 0.75, 1].map((k) => t0 + k * tspan);
  const xAxis = xs.map((t, i) => `<text class="dc-x" x="${f(x(t))}" y="${h - 8}" text-anchor="${i === 0 ? 'start' : i === 4 ? 'end' : 'middle'}">${timeLabel(t, tspan)}</text>`).join('');
  const zero = kind === 'pnl' && lo <= 0 && hi >= 0 ? `<line class="dc-zero" x1="${L}" x2="${w - R}" y1="${f(y(0))}" y2="${f(y(0))}"></line>` : '';
  const gaps = segs.slice(1).map((s, i) => { const a = segs[i][segs[i].length - 1].t, b = s[0].t; return `<rect class="dc-gap" x="${f(x(a))}" y="${T}" width="${f(Math.max(1, x(b) - x(a)))}" height="${h - T - B}"><title>No data from ${new Date(a).toLocaleString()} to ${new Date(b).toLocaleString()}</title></rect>`; }).join('');
  const data = JSON.stringify(pts.map((p) => [p.t, p.v]));
  return `<svg class="dchart is-${tone}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="${label ? label + '. ' : ''}${pts.length} points from ${new Date(t0).toLocaleString()} to ${new Date(t1).toLocaleString()}. Last ${fmtValue(last, kind)}." data-kind="${kind}" data-l="${L}" data-r="${R}" data-t="${T}" data-b="${B}" data-lo="${lo}" data-hi="${hi}" data-t0="${t0}" data-t1="${t1}" data-points='${data}'>${yAxis}${xAxis}${zero}${gaps}${paths.map((d) => `<path class="dc-line" d="${d}"></path>`).join('')}<g class="dc-cross" hidden><line class="dc-vx" y1="${T}" y2="${h - B}"></line><circle class="dc-dot" r="4"></circle></g></svg>`;
}

// Nearest point to an x position in chart units, for the crosshair.
export function nearestPoint(points, xUnits, { l, r, w, t0, t1 }) {
  if (!points?.length) return null;
  const t = t0 + ((xUnits - l) / Math.max(1, w - l - r)) * (t1 - t0);
  let best = 0;
  for (let i = 1; i < points.length; i++) if (Math.abs(points[i][0] - t) < Math.abs(points[best][0] - t)) best = i;
  return { i: best, t: points[best][0], v: points[best][1] };
}

// Card shell used on every chart screen: title, Detailed switch, range seg,
// expand button, the chart (or a light spark when Detailed is off).
export function chartCardHtml({ id, title, sub = '', detailed = false, range = '1d', ranges = RANGE_KEYS, body = '', state = 'ready', fresh = '' } = {}) {
  const seg = detailed ? `<div class="seg dc-range" role="group" aria-label="Time range">${ranges.map((k) => `<button type="button" data-range="${k}" data-chart="${id}" class="${range === k ? 'on' : ''}" aria-pressed="${range === k}">${k === 'all' ? 'All' : k}</button>`).join('')}</div>` : '';
  const inner = state === 'loading' ? '<div class="skel-line dc-skel"></div>' : body;
  return `<section class="dcard${detailed ? ' is-detailed' : ''}" data-chart-card="${id}"><div class="dcard-head"><div><b>${title}</b>${sub ? `<small>${sub}</small>` : ''}</div>${fresh}<label class="dc-toggle"><input type="checkbox" data-detailed="${id}" ${detailed ? 'checked' : ''}><span>Detailed</span></label>${detailed ? `<button type="button" class="dc-max" data-expand="${id}" aria-label="Expand chart">⤢</button>` : ''}</div>${seg}<div class="dc-body">${inner}<div class="dc-tip" hidden></div></div></section>`;
}

// Freshness chip: live, recent, or stale, from an ISO time.
export function freshness(at, now = Date.now(), { liveMs = 90e3, staleMs = 15 * 60e3 } = {}) {
  const t = Date.parse(at || '');
  if (!Number.isFinite(t)) return { state: 'none', age: null, text: 'no timestamp' };
  const age = Math.max(0, now - t);
  const s = Math.round(age / 1000);
  const ago = s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  if (age <= liveMs) return { state: 'live', age, text: `Live · ${ago} ago` };
  if (age <= staleMs) return { state: 'recent', age, text: `Updated ${ago} ago` };
  return { state: 'stale', age, text: `Stale · ${ago} old` };
}
export function freshHtml(at, opts = {}, src = '') {
  const f = freshness(at, opts.now, opts);
  return `<span class="fresh is-${f.state}" data-fresh="${at || ''}" data-live="${opts.liveMs ?? 90e3}" data-stale="${opts.staleMs ?? 900e3}"${src ? ` title="${src}"` : ''}><i aria-hidden="true"></i><span>${f.text}</span></span>`;
}
