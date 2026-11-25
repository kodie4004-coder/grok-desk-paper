// Sim at your buy-ins. Display only, paper money.
//
// The runner records every line at $2. data/lines.json is a compact copy of
// every settled line (Kalshi and coins, bad coin quotes set aside) so the app
// can re-scale all of them, not just the newest few: every total, chart and
// bot number then follows the chosen buy-in. Kalshi is exact (whole contracts,
// the same round-up fee on each taker leg); coins scale with the stake.
// Nothing here feeds strategy logic, weights, gates or the runner's size.
import { kalshiTakerFee } from './kalshi.js';
import { isQuoteError } from './quote-guard.js';
import { RECORDED_STAKE, kalshiBet, coinBet, normalizeBetSettings, clampBuyIn, lineStake } from './bets.js';
export { lineStake };

export const LINES_SCHEMA = 1;
const r4 = (x) => Math.round(x * 1e4) / 1e4;
const r2 = (x) => Math.round(x * 100) / 100;
const msOf = (t) => { const v = Date.parse(t || ''); return Number.isFinite(v) ? v : null; };

// True when any buy-in differs from the recorded $2.
export function isSim(settings) {
  const s = normalizeBetSettings(settings);
  return s.defaultBuyIn !== RECORDED_STAKE || Object.values(s.buyIn).some((v) => v !== RECORDED_STAKE) || Object.values(s.coinBuyIn).some((v) => v !== RECORDED_STAKE);
}
const fmtStake = (v) => '$' + (Number.isInteger(v) ? String(v) : v.toFixed(2));
export function simLabel(settings) {
  const s = normalizeBetSettings(settings);
  if (!isSim(s)) return null;
  const extra = new Set([...Object.values(s.buyIn), ...Object.values(s.coinBuyIn)].filter((v) => v !== s.defaultBuyIn));
  return `Sim @ ${fmtStake(s.defaultBuyIn)}${extra.size ? ' + per-bot' : ''}`;
}

// One Kalshi line at C contracts. payout is the exit price, or 1/0 at settle.
export function kalshiLine(entry, payout, maker, c) {
  if (!(entry > 0 && entry < 1) || !(c >= 1)) return null;
  const fees = (maker ? 0 : kalshiTakerFee(entry, c)) + (payout > 0 && payout < 1 ? kalshiTakerFee(payout, c) : 0);
  return { pnl: c * payout - c * entry - fees, fees, cost: c * entry };
}
const recordedC = (entry) => Math.floor((RECORDED_STAKE + 1e-9) / entry);

// ---- file (runner side) -----------------------------------------------

export function linesFile({ kalshiRows = [], memeRows = [], now = Date.now() } = {}) {
  const lines = [];
  for (const r of kalshiRows) { const b = kalshiBet(r); if (b && b.pnl != null) lines.push(b); }
  for (const r of memeRows) { if (isQuoteError(r)) continue; const b = coinBet(r); if (b && b.pnl != null) lines.push(b); }
  lines.sort((a, b) => (msOf(a.settledAt) ?? 0) - (msOf(b.settledAt) ?? 0));
  const bots = [];
  const botIdx = new Map();
  const cas = [];
  const caIdx = new Map();
  const idx = (map, list, key, mk) => { if (!map.has(key)) { map.set(key, list.length); list.push(mk()); } return map.get(key); };
  const k = { b: [], t: [], o: [], a: [], x: [], f: [], c: {} };
  const m = { b: [], t: [], o: [], ca: [], s: [], p: [], e: [], f: [] };
  let base = null;
  let lastK = null;
  let lastM = null;
  for (const b of lines) {
    const st = Math.round((msOf(b.settledAt) ?? 0) / 1000);
    const op = msOf(b.openedAt) != null ? Math.max(0, st - Math.round(msOf(b.openedAt) / 1000)) : 0;
    if (base == null) { base = st; lastK = st; lastM = st; }
    const bi = idx(botIdx, bots, b.bot, () => ({ id: b.bot, book: b.book, family: b.family || null }));
    if (b.book === 'kalshi') {
      const payout = b.exitPx != null ? b.exitPx : b.won ? 1 : 0;
      const i = k.b.length;
      k.b.push(bi); k.t.push(st - lastK); k.o.push(op); k.a.push(r4(b.entry)); k.x.push(r4(payout));
      k.f.push((b.maker ? 1 : 0) | (b.counted ? 2 : 0));
      if (b.contracts !== recordedC(b.entry)) k.c[i] = b.contracts;
      lastK = st;
    } else {
      m.b.push(bi); m.t.push(st - lastM); m.o.push(op);
      m.ca.push(b.ca ? idx(caIdx, cas, b.ca, () => b.ca) : -1);
      m.s.push(r4(b.stake || RECORDED_STAKE)); m.p.push(r4(b.pnl)); m.e.push(r4(b.fees || 0)); m.f.push(b.counted ? 2 : 0);
      lastM = st;
    }
  }
  return { schema: LINES_SCHEMA, paper: true, liveExecution: false, generatedAt: new Date(now).toISOString(), recordedStake: RECORDED_STAKE, n: lines.length, base: base ?? 0, bots, cas, kalshi: k, coin: m };
}

// ---- decode and sim (app side) ------------------------------------------

export function decodeLines(file) {
  if (!file || file.schema !== LINES_SCHEMA) return [];
  const out = [];
  const bots = file.bots || [];
  const k = file.kalshi || {};
  let t = file.base || 0;
  for (let i = 0; i < (k.b || []).length; i++) {
    t += k.t[i];
    const bot = bots[k.b[i]] || { id: 'bot', book: 'kalshi' };
    const entry = k.a[i];
    const payout = k.x[i];
    const maker = !!(k.f[i] & 1);
    const c = k.c?.[i] ?? recordedC(entry);
    const rec = kalshiLine(entry, payout, maker, c);
    out.push({ book: 'kalshi', bot: bot.id, family: bot.family, entry, payout, maker, counted: !!(k.f[i] & 2), contracts: c, stake: RECORDED_STAKE, pnl: rec ? rec.pnl : 0, fees: rec ? rec.fees : 0, t: t * 1000, open: (t - (k.o?.[i] || 0)) * 1000 });
  }
  const m = file.coin || {};
  t = file.base || 0;
  for (let i = 0; i < (m.b || []).length; i++) {
    t += m.t[i];
    const bot = bots[m.b[i]] || { id: 'meme', book: 'coin' };
    out.push({ book: 'coin', bot: bot.id, family: bot.family, ca: m.ca[i] >= 0 ? file.cas[m.ca[i]] : null, stake: m.s[i], pnl: m.p[i], fees: m.e[i], counted: !!(m.f[i] & 2), t: t * 1000, open: (t - (m.o?.[i] || 0)) * 1000 });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

// One decoded line at a buy-in. tooSmall when the buy-in buys no contract.
export function simLine(line, stake) {
  const s = clampBuyIn(stake);
  if (line.book === 'kalshi') {
    const c = Math.floor((s + 1e-9) / line.entry);
    const r = kalshiLine(line.entry, line.payout, line.maker, c);
    return r ? { pnl: r.pnl, fees: r.fees, cost: r.cost, contracts: c } : { pnl: 0, fees: 0, cost: 0, contracts: 0, tooSmall: true };
  }
  const k = s / (line.stake || RECORDED_STAKE);
  return { pnl: line.pnl * k, fees: line.fees * k, cost: s };
}

// Every settled line at the chosen buy-ins, rolled up the same way as
// data/bets.json: totals, per-bot, hourly cells, newest lines per bot.
// Each figure also carries the recorded $2 value for the same lines.
export function simBook(lines, settings, { now = Date.now(), histPerBot = 150 } = {}) {
  const s = normalizeBetSettings(settings);
  const today = new Date(now).toISOString().slice(0, 10);
  const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
  const bots = {};
  const hourly = {};
  const hist = {};
  const tot = { n: 0, net: 0, fees: 0, todayN: 0, todayNet: 0, countedN: 0, countedNet: 0, countedTodayNet: 0, staked: 0, tooSmall: 0, rec: { net: 0, fees: 0, todayNet: 0, countedNet: 0, countedTodayNet: 0 } };
  const cell = (key, h) => { const mp = hourly[key] || (hourly[key] = new Map()); let c = mp.get(h); if (!c) { c = [h, 0, 0, 0, 0]; mp.set(h, c); } return c; };
  for (const l of lines || []) {
    const stake = lineStake(s, l.bot, l.ca);
    const sc = simLine(l, stake);
    const b = bots[l.bot] || (bots[l.bot] = { id: l.bot, book: l.book, family: l.family || null, stake, n: 0, wins: 0, net: 0, fees: 0, todayN: 0, todayNet: 0, countedN: 0, countedNet: 0, tooSmall: 0, rec: { net: 0, todayNet: 0, countedNet: 0 } });
    const isToday = dayOf(l.t) === today;
    if (sc.tooSmall) { b.tooSmall += 1; tot.tooSmall += 1; }
    b.n += 1; b.net += sc.pnl; b.fees += sc.fees; b.wins += sc.pnl > 0 ? 1 : 0; b.rec.net += l.pnl;
    tot.n += 1; tot.net += sc.pnl; tot.fees += sc.fees; tot.staked += sc.cost; tot.rec.net += l.pnl; tot.rec.fees += l.fees;
    if (isToday) { b.todayN += 1; b.todayNet += sc.pnl; b.rec.todayNet += l.pnl; tot.todayN += 1; tot.todayNet += sc.pnl; tot.rec.todayNet += l.pnl; }
    if (l.counted) {
      b.countedN += 1; b.countedNet += sc.pnl; b.rec.countedNet += l.pnl;
      tot.countedN += 1; tot.countedNet += sc.pnl; tot.rec.countedNet += l.pnl;
      if (isToday) { tot.countedTodayNet += sc.pnl; tot.rec.countedTodayNet += l.pnl; }
    }
    const h = Math.floor(l.t / 3600e3) * 3600;
    for (const key of [l.bot, '_all']) { const c = cell(key, h); c[1] += sc.pnl; c[2] += 1; if (l.counted) { c[3] += sc.pnl; c[4] += 1; } }
    const hh = hist[l.bot] || (hist[l.bot] = { book: l.book, rows: [] });
    hh.rows.push(l.book === 'kalshi'
      ? [Math.round(l.open / 1000), Math.round(l.t / 1000), l.entry, sc.contracts || 0, l.payout >= 1 ? 1 : 0, l.payout > 0 && l.payout < 1 ? l.payout : null, l.maker ? 1 : 0, l.counted ? 1 : 0]
      : [Math.round(l.open / 1000), Math.round(l.t / 1000), stake, r4(sc.pnl), r4(sc.fees), l.counted ? 1 : 0]);
  }
  for (const h of Object.values(hist)) if (h.rows.length > histPerBot) h.rows = h.rows.slice(-histPerBot);
  const fix = (o) => { for (const k of Object.keys(o)) if (typeof o[k] === 'number' && k !== 'n' && !/N$|^wins$|^tooSmall$|^stake$/.test(k)) o[k] = r2(o[k]); };
  for (const b of Object.values(bots)) { fix(b); fix(b.rec); }
  fix(tot); fix(tot.rec);
  const hourlyOut = Object.fromEntries(Object.entries(hourly).map(([k2, mp]) => [k2, [...mp.values()].sort((a, b) => a[0] - b[0]).map(([h, net, n, cNet, cN]) => [h, r4(net), n, r4(cNet), cN])]));
  return { label: simLabel(s), totals: tot, bots, hourly: hourlyOut, hist };
}

// The bets doc as the views read it, with every rolled-up number at the
// chosen buy-ins. Rows (open, recent) stay as recorded; the views re-scale
// those one by one.
export function simDoc(doc, book) {
  if (!doc || !book) return doc;
  const bots = {};
  for (const [id, b] of Object.entries(doc.bots || {})) {
    const s = book.bots[id];
    bots[id] = s ? { ...b, net: s.net, fees: s.fees, wins: s.wins, todayNet: s.todayNet, countedNet: s.countedNet, n: s.n, todayN: s.todayN, countedN: s.countedN, stake: s.stake, rec: s.rec, sim: true } : b;
  }
  const t = book.totals;
  return { ...doc, sim: { label: book.label, rec: t.rec, tooSmall: t.tooSmall }, totals: { ...doc.totals, n: t.n, net: t.net, fees: t.fees, todayN: t.todayN, todayNet: t.todayNet, countedN: t.countedN, countedNet: t.countedNet }, bots, hourly: book.hourly, hist: book.hist };
}

// Bot cards (recent form): the same stats re-scaled line by line. The set of
// lines per bot is the decay row's own (opened at or after recentFrom is the
// recent run); the gate and flags stay on the recorded $2 lines.
export function simDecay(decay, lines, settings) {
  if (!Array.isArray(decay) || !lines?.length) return decay;
  const s = normalizeBetSettings(settings);
  const by = new Map();
  for (const l of lines) { if (!by.has(l.bot)) by.set(l.bot, []); by.get(l.bot).push(l); }
  return decay.map((d) => {
    const ls = by.get(d.id);
    if (!d || !ls?.length) return d;
    const sorted = [...ls].sort((a, b) => a.open - b.open);
    const delta = (l) => simLine(l, lineStake(s, l.bot, l.ca)).pnl - l.pnl;
    const dAll = sorted.reduce((a, l) => a + delta(l), 0);
    const from = msOf(d.recentFrom);
    let recent = from != null ? sorted.filter((l) => l.open >= from - 1000) : sorted.slice(-(d.recentN || 0));
    if (d.recentN && recent.length > d.recentN) recent = recent.slice(-d.recentN);
    const cum = [];
    let run = 0;
    for (const l of recent) { run += delta(l); cum.push(run); }
    const dRecent = run;
    const k = (d.spark || []).length;
    const spark = k && cum.length ? d.spark.map((v, j) => r2(v + cum[Math.min(cum.length - 1, Math.ceil(((j + 1) * cum.length) / k) - 1)])) : d.spark;
    const net = r2((d.net || 0) + dAll);
    const recentNet = r2((d.recentNet || 0) + dRecent);
    const n = d.n || 0;
    return { ...d, net, mean: n ? r2(net / n) : d.mean, recentNet, recentMean: d.recentN ? r2(recentNet / d.recentN) : d.recentMean, beforeMean: d.beforeN ? r2((net - recentNet) / d.beforeN) : d.beforeMean, spark, sim: true, rec: { net: d.net, mean: d.mean, recentNet: d.recentNet } };
  });
}

// Home hero curve: counted (allocated) lines at the chosen buy-ins.
export function simCurve(lines, settings, { points = 80, now = Date.now() } = {}) {
  const s = normalizeBetSettings(settings);
  const counted = (lines || []).filter((l) => l.counted);
  const today = new Date(now).toISOString().slice(0, 10);
  let net = 0, rec = 0, fees = 0, day = 0;
  const cum = [];
  for (const l of counted) {
    const sc = simLine(l, lineStake(s, l.bot, l.ca));
    net += sc.pnl; rec += l.pnl; fees += sc.fees;
    if (new Date(l.t).toISOString().slice(0, 10) === today) day += sc.pnl;
    cum.push(net);
  }
  const k = Math.min(points, cum.length);
  const pts = [0];
  for (let j = 1; j <= k; j++) pts.push(r2(cum[Math.ceil((j * cum.length) / k) - 1]));
  return { n: counted.length, net: r2(net), fees: r2(fees), day: r2(day), points: pts, rec: r2(rec), sim: true };
}
