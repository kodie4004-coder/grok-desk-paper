// Bets: one list of paper bets across the Kalshi and coin books, plus the
// buy-in controls. Paper only. Nothing here can place an order, and nothing
// here feeds strategy logic, weights, or gates.
//
// The runner records every line at its fixed $2 paper size. A different
// buy-in is a re-scale of those recorded lines:
//   Kalshi: contracts = floor(buy-in / ask), fee = round up(0.07 × C × P × (1 − P))
//           on each taker leg, payout = exit price or 1/0 at settle.
//   Coins:  P&L and fees scale with the stake (1.25% each way plus the same
//           modeled slippage per dollar). Bigger real size would slip more.
import { kalshiTakerFee } from './kalshi.js';
import { memePnl, MEME_SLIP } from './meme.js';
import { isQuoteError } from './quote-guard.js';
import { RISK_LIMITS, RECORDED_STAKE, clampStake, cleanLossCap, cleanMaxOpen, riskCheck } from './risk.js';

export { RECORDED_STAKE };
export const BUYIN_MIN = RISK_LIMITS.minStake;
export const BUYIN_MAX = RISK_LIMITS.maxStake;
export const MAX_OPEN_CAP = RISK_LIMITS.maxOpenCap;
export const LOSS_CAP_MAX = RISK_LIMITS.lossCapMax;

export const BET_DEFAULTS = Object.freeze({
  schema: 1,
  paper: true,
  liveExecution: false,
  defaultBuyIn: 2,
  buyIn: {},
  coinBuyIn: {},
  paused: [],
  dailyLossCap: null,
  maxOpen: null,
  killSwitch: false,
});

const round2 = (x) => Math.round(x * 100) / 100;
const num = (x) => (x === null || x === undefined || x === '' ? NaN : Number(x));

export function clampBuyIn(x, fallback = BET_DEFAULTS.defaultBuyIn) {
  return clampStake(x, fallback);
}

function cleanMap(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (!/^[A-Za-z0-9:_.-]{1,64}$/.test(k)) continue;
    const n = num(v);
    if (Number.isFinite(n)) out[k] = clampBuyIn(n);
  }
  return out;
}

// Validate anything that came from localStorage, a file, or the network.
// paper and liveExecution are forced; they are not settings.
export function normalizeBetSettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    schema: 1,
    paper: true,
    liveExecution: false,
    defaultBuyIn: clampBuyIn(r.defaultBuyIn),
    buyIn: cleanMap(r.buyIn),
    coinBuyIn: cleanMap(r.coinBuyIn),
    paused: [...new Set((Array.isArray(r.paused) ? r.paused : []).filter((x) => typeof x === 'string' && /^[A-Za-z0-9:_.-]{1,64}$/.test(x)))].sort(),
    dailyLossCap: cleanLossCap(r.dailyLossCap),
    maxOpen: cleanMaxOpen(r.maxOpen),
    killSwitch: r.killSwitch === true,
  };
}

export function buyInFor(settings, bot) {
  const s = settings || BET_DEFAULTS;
  return s.buyIn?.[bot] ?? s.defaultBuyIn ?? BET_DEFAULTS.defaultBuyIn;
}
export function coinBuyInFor(settings, ca) {
  const s = settings || BET_DEFAULTS;
  return s.coinBuyIn?.[ca] ?? s.defaultBuyIn ?? BET_DEFAULTS.defaultBuyIn;
}
// Stake for one line. A coin line uses its coin's practice buy-in, then its
// bot's buy-in, then the default; a Kalshi line its bot's, then the default.
export function lineStake(settings, bot, ca) {
  const s = settings || BET_DEFAULTS;
  if (ca && s.coinBuyIn && s.coinBuyIn[ca] != null) return s.coinBuyIn[ca];
  return s.buyIn?.[bot] ?? s.defaultBuyIn ?? BET_DEFAULTS.defaultBuyIn;
}
export function isPaused(settings, bot) {
  return !!settings?.paused?.includes(bot);
}

// The file the runner reads. Same shape, stamped, sorted keys for clean diffs.
export function settingsFileText(settings, at = new Date().toISOString()) {
  const s = normalizeBetSettings(settings);
  const sortObj = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
  return JSON.stringify({ ...s, buyIn: sortObj(s.buyIn), coinBuyIn: sortObj(s.coinBuyIn), exportedAt: at, note: 'Paper only. The runner keeps recording $2 lines; buy-ins re-scale the view. killSwitch, paused, maxOpen and dailyLossCap only stop new paper lines. Trading mode is always paper.' }, null, 2) + '\n';
}

export function settingsDiff(a, b) {
  const x = normalizeBetSettings(a);
  const y = normalizeBetSettings(b);
  const out = [];
  if (x.defaultBuyIn !== y.defaultBuyIn) out.push('defaultBuyIn');
  if (JSON.stringify(x.buyIn) !== JSON.stringify(y.buyIn)) out.push('buyIn');
  if (JSON.stringify(x.coinBuyIn) !== JSON.stringify(y.coinBuyIn)) out.push('coinBuyIn');
  if (JSON.stringify(x.paused) !== JSON.stringify(y.paused)) out.push('paused');
  if (x.dailyLossCap !== y.dailyLossCap) out.push('dailyLossCap');
  if (x.maxOpen !== y.maxOpen) out.push('maxOpen');
  if (x.killSwitch !== y.killSwitch) out.push('killSwitch');
  return out;
}

// ---- rows -------------------------------------------------------------

const ms = (t) => { const v = Date.parse(t || ''); return Number.isFinite(v) ? v : null; };

export function kalshiBet(row) {
  if (!row || row.skipped === true) return null;
  const settled = Number.isFinite(row.pnl) && !!row.settledAt;
  return {
    id: row.id,
    bot: row.variant || row.strategy || row.family || 'bot',
    family: row.family || null,
    book: 'kalshi',
    market: row.series || row.market || '',
    ticker: row.ticker || '',
    title: row.title || row.ticker || '',
    side: row.side || '',
    entry: Number(row.ask),
    contracts: Number(row.contracts) || 0,
    stake: Number(row.sizeUsd) || RECORDED_STAKE,
    fees: settled ? Number(row.fees ?? row.fee) || 0 : Number(row.fee) || 0,
    pnl: settled ? Number(row.pnl) : null,
    exitPx: Number.isFinite(row.exitPx) ? row.exitPx : null,
    maker: !!row.maker,
    openedAt: row.openedAt || null,
    closeAt: row.closeTime || null,
    settledAt: settled ? row.settledAt : null,
    result: row.result || null,
    won: settled ? !!row.won : null,
    counted: !!row.allocated,
    role: row.role || null,
  };
}

export function coinBet(row) {
  if (!row || row.skipped === true) return null;
  const settled = Number.isFinite(row.pnl) && !!row.settledAt;
  return {
    id: row.id,
    bot: row.variant || 'meme',
    family: row.family || 'meme',
    book: 'coin',
    market: row.symbol ? '$' + row.symbol : (row.ca || '').slice(0, 6),
    ca: row.ca || null,
    ticker: row.ca || '',
    title: row.name || row.symbol || '',
    side: 'buy',
    entry: Number(row.entry),
    contracts: null,
    stake: Number(row.sizeUsd) || RECORDED_STAKE,
    fees: settled ? Number(row.fees) || 0 : 0,
    pnl: settled ? Number(row.pnl) : null,
    exitPx: Number.isFinite(row.exitPx) ? row.exitPx : null,
    exit: row.exit || null,
    slip: Number.isFinite(row.slip) ? row.slip : null,
    openedAt: row.openedAt || null,
    closeAt: null,
    settledAt: settled ? row.settledAt : null,
    result: row.exit || null,
    won: settled ? row.pnl > 0 : null,
    counted: !!row.allocated,
    role: row.allocated ? 'champion' : 'shadow',
  };
}

// Re-scale one recorded line to a different paper buy-in. Exact for Kalshi
// (same fee rule the runner uses); linear for coins.
export function rescale(bet, stake) {
  const s = clampBuyIn(stake);
  if (!bet) return null;
  if (bet.book === 'kalshi') {
    const p = bet.entry;
    if (!(p > 0 && p < 1)) return { stake: s, contracts: 0, fees: 0, pnl: null, tooSmall: true };
    const c = Math.floor((s + 1e-9) / p);
    if (c < 1) return { stake: s, contracts: 0, fees: 0, pnl: null, tooSmall: true };
    const entryFee = bet.maker ? 0 : kalshiTakerFee(p, c);
    if (bet.pnl == null) return { stake: s, contracts: c, fees: round2(entryFee), pnl: null, cost: round2(c * p) };
    const payout = bet.exitPx != null ? bet.exitPx : bet.won ? 1 : 0;
    const exitFee = bet.exitPx != null && bet.exitPx > 0 && bet.exitPx < 1 ? kalshiTakerFee(bet.exitPx, c) : 0;
    const fees = entryFee + exitFee;
    return { stake: s, contracts: c, fees: round2(fees), pnl: c * payout - c * p - fees, cost: round2(c * p) };
  }
  const k = s / (bet.stake || RECORDED_STAKE);
  return { stake: s, contracts: null, fees: round2((bet.fees || 0) * k), pnl: bet.pnl == null ? null : bet.pnl * k, cost: s };
}

// Mark an open bet against the latest quote. Kalshi: sell at the bid now,
// both taker fees in. Coins: sell at the last price, fees and slippage in.
export function markOpen(bet, { board, prices } = {}, stake = bet?.stake) {
  if (!bet || bet.pnl != null) return null;
  if (bet.book === 'kalshi') {
    const m = (board?.markets || []).find((x) => x.ticker === bet.ticker);
    if (!m) return null;
    const bid = bet.side === 'yes' ? Number(m.yesBid) : Number(m.noBid);
    if (!Number.isFinite(bid)) return null;
    const sc = rescale(bet, stake);
    if (!sc || sc.tooSmall) return null;
    const c = sc.contracts;
    const fees = (bet.maker ? 0 : kalshiTakerFee(bet.entry, c)) + (bid > 0 && bid < 1 ? kalshiTakerFee(bid, c) : 0);
    return { mark: bid, pnl: c * bid - c * bet.entry - fees, fees: round2(fees) };
  }
  const px = Number(prices?.[bet.ca]);
  if (!(px > 0) || !(bet.entry > 0)) return null;
  const r = memePnl(bet.entry, px, bet.slip ?? MEME_SLIP, clampBuyIn(stake));
  return r ? { mark: px, pnl: r.pnl, fees: round2(r.fees) } : null;
}

// ---- runner doc ---------------------------------------------------------

export const HIST_COLS = Object.freeze({
  kalshi: ['openedSec', 'settledSec', 'ask', 'contracts', 'won', 'exitPx', 'maker', 'counted'],
  coin: ['openedSec', 'settledSec', 'stake', 'pnl', 'fees', 'counted'],
});

function sec(t) { const v = ms(t); return v == null ? 0 : Math.round(v / 1000); }

export function histRow(bet) {
  if (bet.book === 'kalshi') return [sec(bet.openedAt), sec(bet.settledAt), bet.entry, bet.contracts, bet.won ? 1 : 0, bet.exitPx, bet.maker ? 1 : 0, bet.counted ? 1 : 0];
  return [sec(bet.openedAt), sec(bet.settledAt), bet.stake, Math.round(bet.pnl * 1e4) / 1e4, Math.round(bet.fees * 1e4) / 1e4, bet.counted ? 1 : 0];
}

export function fromHist(book, bot, arr) {
  if (book === 'kalshi') {
    const [o, s, ask, contracts, won, exitPx, maker, counted] = arr;
    const fee = (maker ? 0 : kalshiTakerFee(ask, contracts)) + (exitPx != null && exitPx > 0 && exitPx < 1 ? kalshiTakerFee(exitPx, contracts) : 0);
    const payout = exitPx != null ? exitPx : won ? 1 : 0;
    return { book, bot, entry: ask, contracts, won: !!won, exitPx, maker: !!maker, counted: !!counted, stake: RECORDED_STAKE, fees: fee, pnl: contracts * payout - contracts * ask - fee, openedAt: new Date(o * 1000).toISOString(), settledAt: new Date(s * 1000).toISOString() };
  }
  const [o, s, stake, pnl, fees, counted] = arr;
  return { book, bot, stake, pnl, fees, won: pnl > 0, counted: !!counted, openedAt: new Date(o * 1000).toISOString(), settledAt: new Date(s * 1000).toISOString() };
}

const dayOf = (t) => String(t || '').slice(0, 10);

// Compact summary for data/bets.json. Totals use every settled line;
// recent and hist keep the newest lines per bot so the file stays small.
export function betsDoc({ kalshiRows = [], kalshiOpen = [], memeRows = [], memeOpen = [], now = Date.now(), recentPerBot = 12, histPerBot = 200 } = {}) {
  const today = new Date(now).toISOString().slice(0, 10);
  const settled = [];
  for (const r of kalshiRows) { const b = kalshiBet(r); if (b && b.pnl != null) settled.push(b); }
  let quoteErrors = 0;
  for (const r of memeRows) { if (isQuoteError(r)) { quoteErrors += 1; continue; } const b = coinBet(r); if (b && b.pnl != null) settled.push(b); }
  const open = [];
  for (const r of kalshiOpen) { const b = kalshiBet(r); if (b && b.pnl == null) open.push(b); }
  for (const r of memeOpen) { const b = coinBet(r); if (b && b.pnl == null) open.push(b); }
  settled.sort((a, b) => String(a.settledAt).localeCompare(String(b.settledAt)));
  const bots = {};
  const by = new Map();
  for (const b of settled) {
    const t = bots[b.bot] || (bots[b.bot] = { id: b.bot, book: b.book, family: b.family, n: 0, wins: 0, net: 0, fees: 0, todayN: 0, todayNet: 0, countedN: 0, countedNet: 0, open: 0, lastAt: null });
    t.n += 1; t.wins += b.won ? 1 : 0; t.net += b.pnl; t.fees += b.fees;
    if (b.counted) { t.countedN += 1; t.countedNet += b.pnl; }
    if (dayOf(b.settledAt) === today) { t.todayN += 1; t.todayNet += b.pnl; }
    t.lastAt = b.settledAt;
    if (!by.has(b.bot)) by.set(b.bot, []);
    by.get(b.bot).push(b);
  }
  for (const b of open) {
    const t = bots[b.bot] || (bots[b.bot] = { id: b.bot, book: b.book, family: b.family, n: 0, wins: 0, net: 0, fees: 0, todayN: 0, todayNet: 0, countedN: 0, countedNet: 0, open: 0, lastAt: null });
    t.open += 1;
  }
  // Hourly after-fee totals per bot and overall: exact sums of settled lines,
  // one entry per hour that had a settle. Used for the 1w and all-time charts.
  const hourly = {};
  const addHour = (key, b) => {
    const h = Math.floor((ms(b.settledAt) ?? 0) / 3600e3) * 3600;
    const m = hourly[key] || (hourly[key] = new Map());
    const cell = m.get(h) || [h, 0, 0, 0, 0];
    cell[1] += b.pnl; cell[2] += 1;
    if (b.counted) { cell[3] += b.pnl; cell[4] += 1; }
    m.set(h, cell);
  };
  for (const b of settled) { addHour(b.bot, b); addHour('_all', b); }
  const hourlyOut = Object.fromEntries(Object.entries(hourly).map(([k, m]) => [k, [...m.values()].sort((a, b) => a[0] - b[0]).map(([h, net, n, cNet, cN]) => [h, Math.round(net * 1e4) / 1e4, n, Math.round(cNet * 1e4) / 1e4, cN])]));
  for (const t of Object.values(bots)) { t.net = round2(t.net); t.fees = round2(t.fees); t.todayNet = round2(t.todayNet); t.countedNet = round2(t.countedNet); }
  const recent = [];
  const hist = {};
  for (const [bot, rows] of by) {
    recent.push(...rows.slice(-recentPerBot));
    const tail = rows.slice(-histPerBot);
    hist[bot] = { book: tail[0].book, rows: tail.map(histRow) };
  }
  recent.sort((a, b) => String(b.settledAt).localeCompare(String(a.settledAt)));
  const slim = (b) => {
    const o = { ...b };
    for (const k of Object.keys(o)) if (o[k] === null || o[k] === undefined) delete o[k];
    if (Number.isFinite(o.pnl)) o.pnl = Math.round(o.pnl * 1e4) / 1e4;
    return o;
  };
  const all = Object.values(bots);
  return {
    schema: 1,
    paper: true,
    liveExecution: false,
    generatedAt: new Date(now).toISOString(),
    day: today,
    recordedStake: RECORDED_STAKE,
    quoteErrorsSetAside: quoteErrors,
    totals: {
      n: settled.length,
      net: round2(all.reduce((a, t) => a + t.net, 0)),
      fees: round2(all.reduce((a, t) => a + t.fees, 0)),
      todayN: all.reduce((a, t) => a + t.todayN, 0),
      todayNet: round2(all.reduce((a, t) => a + t.todayNet, 0)),
      countedN: all.reduce((a, t) => a + t.countedN, 0),
      countedNet: round2(all.reduce((a, t) => a + t.countedNet, 0)),
      open: open.length,
      exposure: round2(open.reduce((a, b) => a + (b.book === 'kalshi' ? b.contracts * b.entry + b.fees : b.stake), 0)),
    },
    bots: Object.fromEntries(Object.keys(bots).sort().map((k) => [k, bots[k]])),
    open: open.map(slim),
    recent: recent.map(slim),
    histCols: HIST_COLS,
    hist,
    hourlyCols: ['hourSec', 'net', 'n', 'countedNet', 'countedN'],
    hourly: hourlyOut,
  };
}

// ---- what-if ----------------------------------------------------------

// Replay recorded lines at the chosen buy-ins and limits. The stake per bot
// is fixed; a loss never raises the next stake. Limits only skip lines.
export function simulate(bets, settings) {
  const s = normalizeBetSettings(settings);
  const rows = [...(bets || [])].filter((b) => b && b.pnl != null).sort((a, b) => (ms(a.openedAt) ?? 0) - (ms(b.openedAt) ?? 0));
  const out = [];
  const active = []; // settledAt ms of lines still open in the sim
  const realized = []; // [settledMs, day, pnl]
  const skipped = { kill: 0, paused: 0, cap: 0, maxOpen: 0, tooSmall: 0 };
  const WHY = { 'kill switch': 'kill', paused: 'paused', 'daily loss cap': 'cap', 'max open': 'maxOpen', size: 'tooSmall' };
  let net = 0, fees = 0, wins = 0, n = 0, recorded = 0, staked = 0;
  for (const b of rows) {
    const t = ms(b.openedAt) ?? 0;
    const day = dayOf(b.openedAt);
    recorded += b.pnl;
    for (let i = active.length - 1; i >= 0; i--) if (active[i] <= t) active.splice(i, 1);
    const dayPnl = s.dailyLossCap != null ? realized.reduce((a, [st, d, p]) => (d === day && st <= t ? a + p : a), 0) : 0;
    const stake = lineStake(s, b.bot, b.book === 'coin' ? b.ca : null);
    // Same limits module as the runner guard and the ticket.
    const risk = riskCheck({ settings: s, bot: b.bot, stake, counted: true, dayPnl, openCounted: active.length });
    let skip = risk.ok ? null : WHY[risk.why];
    const sc = skip ? null : rescale(b, stake);
    if (!skip && (!sc || sc.tooSmall)) skip = 'tooSmall';
    if (skip) { skipped[skip] += 1; out.push({ ...b, sim: { skip } }); continue; }
    const st = ms(b.settledAt) ?? t;
    active.push(st);
    realized.push([st, dayOf(b.settledAt) || day, sc.pnl]);
    n += 1; net += sc.pnl; fees += sc.fees; wins += sc.pnl > 0 ? 1 : 0; staked += sc.cost ?? stake;
    out.push({ ...b, sim: sc });
  }
  return { rows: out, n, wins, net: round2(net), fees: round2(fees), staked: round2(staked), recorded: round2(recorded), skipped };
}

// ---- table helpers ----------------------------------------------------

export function betStatus(bet) {
  if (bet.pnl == null) return 'open';
  return bet.pnl > 0 ? 'won' : 'lost';
}

export function filterBets(rows, { bot = 'all', market = 'all', status = 'all', book = 'all', counted = 'all', q = '' } = {}) {
  const needle = String(q || '').trim().toLowerCase();
  return (rows || []).filter((b) => {
    if (bot !== 'all' && b.bot !== bot) return false;
    if (market !== 'all' && b.market !== market) return false;
    if (book !== 'all' && b.book !== book) return false;
    if (counted === 'counted' && !b.counted) return false;
    if (counted === 'practice' && b.counted) return false;
    const stt = betStatus(b);
    if (status === 'open' && stt !== 'open') return false;
    if (status === 'settled' && stt === 'open') return false;
    if (status === 'won' && stt !== 'won') return false;
    if (status === 'lost' && stt !== 'lost') return false;
    if (needle && !`${b.bot} ${b.market} ${b.title} ${b.ticker}`.toLowerCase().includes(needle)) return false;
    return true;
  });
}

const SORT_KEY = {
  time: (b) => ms(b.settledAt || b.openedAt) ?? 0,
  bot: (b) => b.bot,
  market: (b) => b.market,
  entry: (b) => b.entry,
  stake: (b) => b.view?.stake ?? b.stake,
  fees: (b) => b.view?.fees ?? b.fees,
  pnl: (b) => b.view?.pnl ?? b.pnl ?? -Infinity,
  settle: (b) => ms(b.closeAt) ?? Infinity,
};
export function sortBets(rows, key = 'time', dir = 'desc') {
  const f = SORT_KEY[key] || SORT_KEY.time;
  const sign = dir === 'asc' ? 1 : -1;
  return [...(rows || [])].sort((a, b) => {
    const x = f(a), y = f(b);
    if (typeof x === 'string' || typeof y === 'string') return sign * String(x).localeCompare(String(y));
    return sign * ((x > y) - (x < y));
  });
}

export function timeToSettle(closeAt, now = Date.now()) {
  const c = ms(closeAt);
  if (c == null) return '—';
  const s = Math.round((c - now) / 1000);
  if (s <= 0) return 'settling';
  if (s < 3600) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

// ---- runner guard -----------------------------------------------------

// Applied by the runner to lines opened in this step only. It can only drop
// a new paper line; it never opens one, never resizes one, and never touches
// gates, weights, or the $2 recorded size.
//   paused       every new line for that bot (counted and practice)
//   maxOpen      new counted lines once that many counted lines are open
//   dailyLossCap new counted lines once today's settled counted P&L
//                (recorded $2 lines, after fees) is at or below -cap
export function guardNewOpens({ prevOpen = [], nextOpen = [], settledToday = [], settings = null, bot = (r) => r.variant } = {}) {
  const s = normalizeBetSettings(settings);
  const before = new Set((prevOpen || []).map((r) => r?.id));
  const dayPnl = (settledToday || []).filter((r) => r?.allocated && Number.isFinite(r.pnl) && r.skipped !== true).reduce((a, r) => a + r.pnl, 0);
  const capHit = s.dailyLossCap != null && dayPnl <= -s.dailyLossCap;
  let countedOpen = (nextOpen || []).filter((r) => before.has(r?.id) && r?.allocated).length;
  const kept = [];
  const dropped = [];
  for (const r of nextOpen || []) {
    if (!r || before.has(r.id)) { kept.push(r); continue; }
    // The runner's size is fixed at $2; the shared limits only drop lines.
    const risk = riskCheck({ settings: s, bot: bot(r), stake: RECORDED_STAKE, counted: !!r.allocated, dayPnl, openCounted: countedOpen });
    const why = risk.ok ? null : risk.why;
    if (why) { dropped.push({ id: r.id, why }); continue; }
    if (r.allocated) countedOpen += 1;
    kept.push(r);
  }
  return { open: kept, dropped, dayPnl: round2(dayPnl), capHit };
}

export function readSettingsText(text) {
  try { return normalizeBetSettings(JSON.parse(text)); } catch { return normalizeBetSettings(null); }
}

// ---- chart series --------------------------------------------------------

// Cumulative all-time after-fee P&L for one bot (or every bot with bot=null)
// over a time range. Per-line points when the kept lines cover the range,
// hourly totals otherwise. The level is anchored to the exact all-time total,
// so the last point equals the recorded net. Nothing is interpolated.
export function pnlSeries(doc, { bot = null, range = 'all', now = Date.now(), counted = 'all', span = null } = {}) {
  const RANGE = { '1h': 3600e3, '1d': 86400e3, '1w': 7 * 86400e3, all: Infinity };
  const from = now - (span ?? RANGE[range] ?? Infinity);
  const ids = bot ? [bot] : Object.keys(doc?.bots || {});
  const pick = (net, n, cNet, cN) => (counted === 'counted' ? [cNet, cN] : counted === 'practice' ? [net - cNet, n - cN] : [net, n]);
  const totalOf = (id) => { const b = doc?.bots?.[id]; if (!b) return 0; return counted === 'counted' ? b.countedNet : counted === 'practice' ? b.net - b.countedNet : b.net; };
  const total = ids.reduce((a, id) => a + (totalOf(id) || 0), 0);
  // Per-line detail if every bot's kept lines reach back past the range start.
  const covers = Number.isFinite(from) && ids.every((id) => {
    const h = doc?.hist?.[id]; const b = doc?.bots?.[id];
    if (!h || !h.rows?.length) return !b || !b.n;
    return h.rows.length >= (b?.n || 0) || h.rows[0][1] * 1000 <= from;
  });
  let lines;
  let res;
  if (covers) {
    res = 'line';
    lines = [];
    for (const id of ids) for (const arr of doc?.hist?.[id]?.rows || []) {
      const b = fromHist(doc.hist[id].book, id, arr);
      if (counted === 'counted' && !b.counted) continue;
      if (counted === 'practice' && b.counted) continue;
      const t = ms(b.settledAt);
      if (t != null && t >= from && t <= now + 60e3) lines.push({ t, pnl: b.pnl, n: 1 });
    }
  } else {
    res = 'hour';
    const src = bot ? doc?.hourly?.[bot] : doc?.hourly?._all;
    lines = (src || []).filter(([h]) => h * 1000 + 3600e3 > from).map(([h, net, n, cNet, cN]) => { const [v, k] = pick(net, n, cNet, cN); return { t: h * 1000 + 3600e3 - 1, pnl: v, n: k }; }).filter((l) => l.n > 0);
  }
  lines.sort((a, b) => a.t - b.t);
  const inside = lines.reduce((a, l) => a + l.pnl, 0);
  let run = total - inside;
  const startT = Number.isFinite(from) ? Math.max(from, (lines[0]?.t ?? now) - 1) : (lines[0]?.t ?? now) - 1;
  const pts = [{ t: startT, v: round2(run), d: 0, n: 0 }];
  for (const l of lines) { run += l.pnl; pts.push({ t: l.t, v: round2(run), d: l.pnl, n: l.n }); }
  if (pts.length && pts[pts.length - 1].t < now - 60e3 && Number.isFinite(from)) pts.push({ t: now, v: round2(run), d: 0, n: 0, hold: true });
  return { points: pts, resolution: res, total: round2(total), lines: lines.length };
}
