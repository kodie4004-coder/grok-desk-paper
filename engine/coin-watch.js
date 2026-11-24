// Coins to watch. Ideas for the owner to check by hand, not trades.
// This module cannot sign, connect a wallet, or send an order. It ranks coins
// that already passed the desk's meme filters plus a RugCheck report, logs each
// new top pick with the price when it was picked, and marks it later at fixed
// horizons. The score weights below were written before any pick was logged.
// They are not fit on the pick log, and nothing here touches a weight, a gate,
// the holdout, or the $2 paper size.
import { MEME_RULES, MEME_SIZE, memePnl } from './meme.js';
import { EARLY_RULES, earlySlip } from './early.js';

export const CW_TOP = 5;
export const CW_SCAN = 12;
export const CW_HORIZONS = Object.freeze([
  { key: 'm15', label: '15m', ms: 15 * 60 * 1000 },
  { key: 'h1', label: '1h', ms: 60 * 60 * 1000 },
  { key: 'h4', label: '4h', ms: 4 * 60 * 60 * 1000 },
]);
export const CW_LATE_MS = 30 * 60 * 1000;
export const CW_REPICK_MS = 24 * 60 * 60 * 1000;
export const CW_SAFETY_TTL_MS = 20 * 60 * 1000;
export const CW_BAD_PRINT_X = 100;
export const CW_LOG_CAP = 3000;
export const CW_PUSH_MIN = 85;
export const CW_PUSH_PER_DAY = 4;
export const CW_RULES = Object.freeze({
  maxTop10: MEME_RULES.maxTop10,
  lpLockedMin: EARLY_RULES.lpLockedMin,
  maxCreatorShare: 0.05,
});
export const CW_NOTE = 'Ideas, not advice. The coin practice bots are still losing after fees.';

const num = (x) => {
  const n = typeof x === 'string' ? Number(x) : x;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
// Board checks the watch list replaces with RugCheck. Top 10 is replaced by the
// RugCheck holder list because the public RPC answers that lookup with 429.
const REPLACED = new Set(['top 10 holders', 'dev wallet share', 'mint authority', 'freeze authority']);

// RugCheck /v1/tokens/{mint}/report. Pool vaults and lockers are left out of the
// holder share. A missing field stays null, and null fails the safety check.
export function readRugReport(body) {
  if (!body || typeof body !== 'object' || !body.mint) return null;
  const skip = new Set();
  for (const [addr, row] of Object.entries(body.knownAccounts || {})) {
    if (row?.type === 'AMM' || row?.type === 'LOCKER') skip.add(addr);
  }
  let mainLp = null;
  let mainUsd = -1;
  for (const m of body.markets || []) {
    if (m?.pubkey) skip.add(m.pubkey);
    for (const side of [m?.liquidityAAccount, m?.liquidityBAccount]) if (side?.owner) skip.add(side.owner);
    const usd = (num(m?.lp?.baseUSD) || 0) + (num(m?.lp?.quoteUSD) || 0);
    if (usd > mainUsd) { mainUsd = usd; mainLp = num(m?.lp?.lpLockedPct); }
  }
  const holders = Array.isArray(body.topHolders) ? body.topHolders : null;
  let top10 = null;
  let insiders = 0;
  if (holders) {
    const kept = holders.filter((h) => h && !skip.has(h.owner) && !skip.has(h.address)).slice(0, 10);
    top10 = kept.reduce((sum, h) => sum + (num(h.pct) || 0), 0) / 100;
    insiders = kept.filter((h) => h.insider === true).length;
  }
  const supply = num(body.token?.supply);
  const creatorBal = num(body.creatorBalance);
  const creatorShare = supply > 0 && creatorBal != null ? creatorBal / supply : null;
  const risks = Array.isArray(body.risks) ? body.risks : [];
  return {
    mint: body.mintAuthority == null ? 'no' : 'yes',
    freeze: body.freezeAuthority == null ? 'no' : 'yes',
    top10,
    lpPct: mainLp,
    creatorShare,
    insiders,
    holders: num(body.totalHolders),
    rugged: body.rugged === true,
    danger: risks.filter((r) => r?.level === 'danger').map((r) => String(r.name || 'risk')),
    warn: risks.filter((r) => r?.level === 'warn').map((r) => String(r.name || 'risk')),
  };
}

// Every check must pass. A failed or missing lookup is a fail, never a pass.
export function watchSafety(coin, rug) {
  const fails = [];
  const flags = [];
  for (const r of coin?.reasons || []) {
    if (REPLACED.has(r.name)) continue;
    if (r.ok !== true) fails.push(`${r.name}: ${r.detail}`);
  }
  if (!coin?.reasons?.length) fails.push('no board checks');
  if (coin?.jev?.verdict === 'flag') fails.push('jev flag');
  if (!rug) {
    fails.push('rug report missing');
    return { ok: false, fails, flags };
  }
  if (rug.rugged) fails.push('rugged');
  if (rug.mint !== 'no') fails.push('mint authority');
  if (rug.freeze !== 'no') fails.push('freeze authority');
  if (rug.top10 == null || rug.top10 > CW_RULES.maxTop10) fails.push(`top 10 holders ${rug.top10 == null ? 'missing' : Math.round(rug.top10 * 100) + '%'}`);
  if (rug.lpPct == null || rug.lpPct < CW_RULES.lpLockedMin) fails.push(`lp locked ${rug.lpPct == null ? 'missing' : Math.round(rug.lpPct) + '%'}`);
  if (rug.creatorShare != null && rug.creatorShare > CW_RULES.maxCreatorShare) fails.push(`dev holds ${Math.round(rug.creatorShare * 100)}%`);
  for (const d of rug.danger || []) fails.push(`danger: ${d}`);
  if (rug.top10 != null) flags.push({ k: 'top10', label: `Top10 ${Math.round(rug.top10 * 100)}%`, warn: rug.top10 > 0.25 });
  flags.push({ k: 'lp', label: `LP ${Math.round(rug.lpPct ?? 0)}% locked`, warn: false });
  if (rug.creatorShare != null) flags.push({ k: 'dev', label: `Dev ${(rug.creatorShare * 100).toFixed(rug.creatorShare > 0 && rug.creatorShare < 0.01 ? 1 : 0)}%`, warn: rug.creatorShare > 0.02 });
  if (rug.insiders > 0) flags.push({ k: 'insider', label: `${rug.insiders} insider${rug.insiders === 1 ? '' : 's'} in top10`, warn: true });
  for (const w of (rug.warn || []).slice(0, 2)) flags.push({ k: 'warn', label: w, warn: true });
  return { ok: fails.length === 0, fails, flags };
}

// 0-100. Volume surge 30, 1h volume 20, depth 20, trend 15, buy share 15.
// A pool younger than a day spreads its 24h volume over its real age.
export function scoreWatch(pair, now = Date.now()) {
  const volH1 = num(pair?.volume?.h1);
  const volH24 = num(pair?.volume?.h24);
  const liq = num(pair?.liquidity?.usd);
  const h1 = num(pair?.priceChange?.h1);
  const buys = num(pair?.txns?.h1?.buys);
  const sells = num(pair?.txns?.h1?.sells);
  const created = num(pair?.pairCreatedAt);
  const hours = created ? clamp((now - created) / 3600000, 1, 24) : 24;
  const surge = volH1 != null && volH24 > 0 ? volH1 / (volH24 / hours) : null;
  const buyShare = buys != null && sells != null && buys + sells >= 10 ? buys / (buys + sells) : null;
  const parts = {
    surge: surge == null ? 0 : clamp(15 * Math.log2(Math.max(surge, 1)), 0, 30),
    vol: volH1 > 0 ? clamp(10 * (Math.log10(volH1) - 4), 0, 20) : 0,
    depth: liq > 0 ? clamp(20 * (Math.log10(liq / 20000) / Math.log10(25)), 0, 20) : 0,
    trend: h1 == null || h1 <= 0 ? 0 : h1 <= 30 ? h1 / 2 : h1 <= 150 ? 15 : clamp(15 - (h1 - 150) / 20, 0, 15),
    buys: buyShare == null ? 0 : clamp((buyShare - 0.5) * 75, 0, 15),
  };
  const score = Math.round(clamp(Object.values(parts).reduce((a, b) => a + b, 0), 0, 100));
  return { score, parts, surge, buyShare, volH1, liq, h1 };
}

const usd = (x) => (x >= 1e6 ? `$${(x / 1e6).toFixed(1)}M` : x >= 1e3 ? `$${Math.round(x / 1e3)}k` : `$${Math.round(x)}`);

export function watchReason(scored, safety) {
  const bits = [];
  if (scored.surge != null && scored.surge >= 1.5) bits.push(`volume ${scored.surge >= 10 ? Math.round(scored.surge) : scored.surge.toFixed(1)}x normal hour`);
  else if (scored.volH1 > 0) bits.push(`${usd(scored.volH1)} traded in 1h`);
  if (scored.h1 != null && scored.h1 > 0) bits.push(`up ${Math.round(scored.h1)}% in 1h`);
  else if (scored.buyShare != null && scored.buyShare >= 0.55) bits.push(`${Math.round(scored.buyShare * 100)}% buys`);
  const lp = (safety?.flags || []).find((f) => f.k === 'lp');
  if (lp) bits.push(lp.label);
  return bits.slice(0, 3).join(', ');
}

// Five real points from DexScreener's own % changes: -24h, -6h, -1h, -5m, now.
export function sparkFromPair(pair) {
  const px = num(pair?.priceUsd);
  if (!(px > 0)) return [];
  const pc = pair?.priceChange || {};
  const out = [];
  for (const [mins, key] of [[1440, 'h24'], [360, 'h6'], [60, 'h1'], [5, 'm5']]) {
    const ch = num(pc[key]);
    if (ch == null || ch <= -100) continue;
    out.push({ m: -mins, p: px / (1 + ch / 100) });
  }
  out.push({ m: 0, p: px });
  return out;
}

// cands: [{ coin, pair, rug }]. Only safe coins are returned.
export function rankWatch(cands, now, top = CW_TOP) {
  const rows = [];
  for (const c of cands || []) {
    const ca = c?.coin?.ca;
    const price = num(c?.pair?.priceUsd);
    if (!ca || !(price > 0)) continue;
    const safety = watchSafety(c.coin, c.rug);
    if (!safety.ok) continue;
    const scored = scoreWatch(c.pair, now);
    const created = num(c.pair?.pairCreatedAt);
    rows.push({
      ca,
      symbol: c.coin.symbol || c.pair?.baseToken?.symbol || '?',
      name: c.coin.name || c.pair?.baseToken?.name || 'Unknown',
      imageUrl: c.coin.imageUrl || c.pair?.info?.imageUrl || null,
      dexUrl: c.pair?.url || `https://dexscreener.com/solana/${ca}`,
      priceUsd: price,
      score: scored.score,
      parts: Object.fromEntries(Object.entries(scored.parts).map(([k, v]) => [k, Math.round(v * 10) / 10])),
      liq: scored.liq,
      volH1: scored.volH1,
      h1: scored.h1,
      ageMin: created ? Math.round((now - created) / 60000) : (num(c.coin.ageMin) == null ? null : Math.round(c.coin.ageMin)),
      holders: c.rug?.holders ?? null,
      flags: safety.flags,
      reason: watchReason(scored, safety),
      spark: sparkFromPair(c.pair),
    });
  }
  rows.sort((a, b) => b.score - a.score || (b.volH1 || 0) - (a.volH1 || 0) || a.ca.localeCompare(b.ca));
  return rows.slice(0, top);
}

// A coin is logged again only after a full day off the log.
export function logPicks(log, top, now) {
  const rows = Array.isArray(log) ? [...log] : [];
  const last = new Map();
  for (const row of rows) {
    const t = Date.parse(row.pickedAt || '');
    if (row?.ca && Number.isFinite(t)) last.set(row.ca, Math.max(last.get(row.ca) || 0, t));
  }
  const added = [];
  const iso = new Date(now).toISOString();
  for (const pick of top || []) {
    const prev = last.get(pick.ca);
    if (prev != null && now - prev < CW_REPICK_MS) continue;
    if (!(pick.priceUsd > 0)) continue;
    const slip = earlySlip(pick.liq);
    const row = {
      id: `${iso}#${pick.ca}`,
      ca: pick.ca,
      symbol: pick.symbol,
      pickedAt: iso,
      price: pick.priceUsd,
      score: pick.score,
      liq: pick.liq ?? null,
      slip: slip == null ? null : Math.round(slip * 10000) / 10000,
      marks: {},
    };
    rows.push(row);
    added.push(row);
    last.set(pick.ca, now);
  }
  const kept = rows.length > CW_LOG_CAP ? rows.slice(rows.length - CW_LOG_CAP) : rows;
  return { log: kept, added };
}

export function pendingMints(log, now) {
  const out = new Set();
  for (const row of log || []) {
    const t = Date.parse(row.pickedAt || '');
    if (!Number.isFinite(t)) continue;
    for (const h of CW_HORIZONS) {
      if (row.marks?.[h.key]) continue;
      if (now >= t + h.ms) out.add(row.ca);
    }
  }
  return [...out];
}

// Net is a hypothetical $2 round trip: the meme fee each side and the slip
// stored at pick time. A print 100x over the pick price is a bad feed and is
// skipped. A mark that cannot be priced inside 30 minutes is recorded missed.
export function markPicks(log, prices, now) {
  let marked = 0;
  const rows = (log || []).map((row) => {
    const t = Date.parse(row.pickedAt || '');
    if (!Number.isFinite(t) || !(row.price > 0)) return row;
    let marks = row.marks || {};
    for (const h of CW_HORIZONS) {
      if (marks[h.key] || now < t + h.ms) continue;
      const px = num(prices?.[row.ca]);
      const good = px > 0 && px <= row.price * CW_BAD_PRINT_X;
      if (good) {
        const fill = memePnl(row.price, px, row.slip ?? undefined, MEME_SIZE);
        marks = { ...marks, [h.key]: { at: new Date(now).toISOString(), price: px, ret: Math.round((px / row.price - 1) * 10000) / 10000, net: fill ? Math.round((fill.pnl / MEME_SIZE) * 10000) / 10000 : null } };
        marked += 1;
      } else if (now > t + h.ms + CW_LATE_MS) {
        marks = { ...marks, [h.key]: { at: new Date(now).toISOString(), missed: true } };
        marked += 1;
      }
    }
    return marks === row.marks ? row : { ...row, marks };
  });
  return { log: rows, marked };
}

export function pickRecord(log) {
  const out = { picks: (log || []).length };
  for (const h of CW_HORIZONS) {
    let n = 0; let hits = 0; let sum = 0; let missed = 0;
    for (const row of log || []) {
      const m = row.marks?.[h.key];
      if (!m) continue;
      if (m.missed || m.net == null) { missed += 1; continue; }
      n += 1;
      sum += m.net;
      if (m.net > 0) hits += 1;
    }
    out[h.key] = { n, hits, hitRate: n ? Math.round((hits / n) * 1000) / 1000 : null, avgNet: n ? Math.round((sum / n) * 10000) / 10000 : null, missed };
  }
  return out;
}

export function planWatchPush(top, added, state, now) {
  const sent = Array.isArray(state?.sent) ? state.sent : [];
  const lastDay = sent.filter((row) => now - Date.parse(row.at || '') < CW_REPICK_MS);
  const recent = new Set(lastDay.map((row) => row.ca));
  const fresh = new Set((added || []).map((row) => row.ca));
  let room = Math.max(0, CW_PUSH_PER_DAY - lastDay.length);
  const queued = [];
  for (const pick of top || []) {
    if (room <= 0) break;
    if (pick.score < CW_PUSH_MIN || !fresh.has(pick.ca) || recent.has(pick.ca)) continue;
    queued.push(pick);
    room -= 1;
  }
  return queued;
}

export function formatWatchPush(pick, deskUrl) {
  const symbol = String(pick?.symbol || '?').replace(/[\r\n]/g, ' ').trim().slice(0, 32) || '?';
  return {
    title: `${symbol} coin to watch · ${pick.score}/100`,
    tags: 'eyes',
    click: `https://pump.fun/coin/${encodeURIComponent(pick.ca)}`,
    actions: [
      `view, Pump.fun, https://pump.fun/coin/${encodeURIComponent(pick.ca)}`,
      `view, FOMO, https://fomo.family/tokens/solana/${encodeURIComponent(pick.ca)}`,
      `view, Desk, ${deskUrl}`,
    ].join('; '),
    body: [pick.reason || '', CW_NOTE, pick.ca].filter(Boolean).join('\n'),
  };
}
