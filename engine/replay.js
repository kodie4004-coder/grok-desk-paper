// 15-minute window replay and chart marks. Display only: a settled window's
// price path, played or scrubbed minute by minute, with the bot's entry and
// exit on it. Prices are Coinbase 1-minute candles (public, CORS open), which
// track but are not the index Kalshi settles on. Not a backtest; nothing here
// feeds a gate.
export const WINDOW_MS = 15 * 60e3;
export const COINBASE_PRODUCT = Object.freeze({
  KXBTC15M: 'BTC-USD', KXETH15M: 'ETH-USD', KXSOL15M: 'SOL-USD', KXXRP15M: 'XRP-USD',
  KXDOGE15M: 'DOGE-USD', KXZEC15M: 'ZEC-USD', KXNEAR15M: 'NEAR-USD',
});

const ms = (t) => { const v = typeof t === 'number' ? t : Date.parse(t || ''); return Number.isFinite(v) ? v : null; };

export function seriesOf(x) {
  return String(x?.series || x?.market || x?.ticker || '').split('-')[0];
}
export function productFor(x) {
  return COINBASE_PRODUCT[seriesOf(x)] || null;
}

// The 15-minute window a Kalshi line or market belongs to.
export function windowOf(x) {
  const end = ms(x?.closeAt || x?.closeTime);
  if (end == null) return null;
  return { start: end - WINDOW_MS, end, series: seriesOf(x), product: productFor(x), strike: Number(x?.floorStrike) > 0 ? Number(x.floorStrike) : null };
}

// Coinbase candles [[time, low, high, open, close, volume], ...] (newest first)
// to points. One point per real minute; missing minutes stay missing.
export function candlePoints(rows) {
  return (Array.isArray(rows) ? rows : []).filter((r) => Array.isArray(r) && Number.isFinite(r[0]) && Number.isFinite(r[4]))
    .map((r) => ({ t: r[0] * 1000, v: Number(r[4]), o: Number(r[3]), h: Number(r[2]), l: Number(r[1]) }))
    .sort((a, b) => a.t - b.t);
}

export function coinbaseUrl(product, start, end, gran = 60) {
  return `https://api.exchange.coinbase.com/products/${encodeURIComponent(product)}/candles?granularity=${gran}&start=${new Date(start).toISOString()}&end=${new Date(end).toISOString()}`;
}

// Marks for one Kalshi line on a price path. Entry at openedAt; exit at the
// exit time (or the window close for a held line). The y value is the price
// at that minute (nearest point at or before it).
export function lineMarks(bet, points) {
  const out = [];
  const at = (t) => { let best = null; for (const p of points || []) { if (p.t <= t + 30e3) best = p; else break; } return best ?? points?.[0] ?? null; };
  const o = ms(bet?.openedAt);
  const side = String(bet?.side || '').toUpperCase();
  if (o != null) { const p = at(o); out.push({ t: o, v: p?.v ?? null, kind: 'entry', label: `${side} ${Number.isFinite(bet.entry) ? Math.round(bet.entry * 100) + '¢' : ''}`.trim() }); }
  const s = bet?.exitPx != null ? ms(bet.settledAt) : ms(bet?.closeAt || bet?.closeTime);
  if (s != null && (bet?.pnl != null || bet?.exitPx != null)) {
    const p = at(s);
    const res = bet.pnl == null ? '' : (bet.pnl > 0 ? 'won ' : 'lost ') + (bet.pnl >= 0 ? '+' : '−') + '$' + Math.abs(bet.view?.pnl ?? bet.pnl).toFixed(2);
    out.push({ t: s, v: p?.v ?? null, kind: 'exit', label: bet.exitPx != null ? `exit ${Math.round(bet.exitPx * 100)}¢ ${res}`.trim() : `settle ${res}`.trim(), tone: bet.pnl > 0 ? 'up' : bet.pnl < 0 ? 'dn' : 'flat' });
  }
  return out;
}

// Marks for coin lines on a coin price chart: entry price at open, exit price
// at settle. Only lines for this coin.
export function coinMarks(bets, ca) {
  const out = [];
  for (const b of bets || []) {
    if (b?.ca !== ca) continue;
    const o = ms(b.openedAt);
    if (o != null && b.entry > 0) out.push({ t: o, v: b.entry, kind: 'entry', label: `${b.bot} in` });
    const s = ms(b.settledAt);
    if (s != null && b.exitPx > 0) out.push({ t: s, v: b.exitPx, kind: 'exit', label: `${b.bot} out ${(b.view?.pnl ?? b.pnl) >= 0 ? '+' : '−'}$${Math.abs(b.view?.pnl ?? b.pnl ?? 0).toFixed(2)}`, tone: b.pnl > 0 ? 'up' : 'dn' });
  }
  return out.sort((a, b) => a.t - b.t);
}

// One replay frame: the path up to `at`, the marks already passed, and where
// the price stood against the start (strike). frame 0..1 of the window.
export function replayFrame({ points = [], win, marks = [], frame = 1 } = {}) {
  if (!win) return { points: [], marks: [], at: null };
  const at = win.start + Math.max(0, Math.min(1, frame)) * (win.end - win.start);
  const shown = points.filter((p) => p.t >= win.start - 60e3 && p.t <= at);
  const strike = win.strike ?? points.find((p) => p.t >= win.start - 60e3)?.o ?? null;
  const last = shown[shown.length - 1] || null;
  return {
    at, points: shown, marks: marks.filter((m) => m.t <= at), strike,
    last, vsStrike: last && strike ? last.v - strike : null,
    leaning: last && strike ? (last.v > strike ? 'up' : last.v < strike ? 'down' : 'flat') : null,
    secondsLeft: Math.max(0, Math.round((win.end - at) / 1000)),
  };
}

export const REPLAY_STEPS = 15; // one step per minute
