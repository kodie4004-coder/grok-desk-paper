// User alert rules, checked in the browser while the app is open. Paper
// signals only: an alert never places, sizes or blocks anything. Delivered to
// an in-app inbox and, where the browser allows it, a system notification.
// Background push (phone asleep, app closed) is not here: it needs the runner
// to read committed rules and a workflow edit that wires NTFY_TOPIC. See
// docs/ALERTS.md.
export const ALERT_TYPES = Object.freeze({
  price: 'Price level',
  closing: 'Window closing soon',
  botflip: 'Bot flip',
  pick: 'New coin pick',
  recap: 'Daily recap',
});
export const ALERT_CAP_PER_HOUR = 12;
export const INBOX_MAX = 100;

const num = (x) => (x === null || x === undefined || x === '' ? NaN : Number(x));
const okId = (s) => typeof s === 'string' && /^[A-Za-z0-9:_.-]{1,64}$/.test(s);

// Validate one rule from storage or a form. Unknown or broken rules drop.
export function cleanRule(r) {
  if (!r || typeof r !== 'object' || !ALERT_TYPES[r.type]) return null;
  const id = okId(r.id) ? r.id : `${r.type}-${Math.random().toString(36).slice(2, 8)}`;
  const base = { id, type: r.type, on: r.on !== false, notify: r.notify !== false };
  if (r.type === 'price') {
    const level = num(r.level);
    if (!(level > 0)) return null;
    const target = r.target === 'BTC' || r.target === 'ETH' || r.target === 'SOL' || (typeof r.target === 'string' && /^coin:[A-Za-z0-9]{20,64}$/.test(r.target)) ? r.target : null;
    if (!target) return null;
    return { ...base, target, op: r.op === 'below' ? 'below' : 'above', level, label: typeof r.label === 'string' ? r.label.slice(0, 24) : '' };
  }
  if (r.type === 'closing') {
    const secs = Math.round(num(r.secs));
    return { ...base, series: okId(r.series) ? r.series : 'KXBTC15M', secs: Number.isFinite(secs) ? Math.min(600, Math.max(30, secs)) : 120 };
  }
  if (r.type === 'botflip') return { ...base, bot: okId(r.bot) ? r.bot : 'any' };
  if (r.type === 'pick') { const m = Math.round(num(r.minScore)); return { ...base, minScore: Number.isFinite(m) ? Math.min(100, Math.max(0, m)) : 60 }; }
  if (r.type === 'recap') { const h = Math.round(num(r.hour)); return { ...base, hour: Number.isFinite(h) ? Math.min(23, Math.max(0, h)) : 21 }; }
  return null;
}
export function cleanRules(list) {
  const out = [];
  const seen = new Set();
  for (const r of Array.isArray(list) ? list : []) { const c = cleanRule(r); if (c && !seen.has(c.id)) { seen.add(c.id); out.push(c); } }
  return out.slice(0, 40);
}

export const DEFAULT_RULES = Object.freeze([
  { id: 'closing-btc', type: 'closing', series: 'KXBTC15M', secs: 120, on: false, notify: true },
  { id: 'recap', type: 'recap', hour: 21, on: false, notify: true },
  { id: 'pick-60', type: 'pick', minScore: 60, on: false, notify: true },
  { id: 'flip-any', type: 'botflip', bot: 'any', on: false, notify: true },
]);

export function ruleText(r) {
  if (r.type === 'price') return `${r.label || (r.target.startsWith('coin:') ? 'Coin' : r.target)} ${r.op} $${Number(r.level).toLocaleString('en-US', { maximumFractionDigits: 8 })}`;
  if (r.type === 'closing') return `${r.series.replace(/^KX|15M$/g, '')} window, ${r.secs >= 60 ? Math.round(r.secs / 60) + ' min' : r.secs + ' s'} before it locks`;
  if (r.type === 'botflip') return `${r.bot === 'any' ? 'Any bot' : r.bot} flips to rising or fading`;
  if (r.type === 'pick') return `New coin pick scoring ${r.minScore}+`;
  if (r.type === 'recap') return `Daily recap at ${((r.hour + 11) % 12) + 1}${r.hour < 12 ? 'am' : 'pm'}`;
  return r.type;
}

export function emptyMemory() {
  return { px: {}, windows: {}, flags: {}, picks: null, recapDay: null, sent: [] };
}

// Check every rule against the current data. Returns new events and the next
// memory. Fires on a crossing or a first sighting, never on every check.
//   ctx.prices   { BTC: 61000, 'coin:<ca>': 0.0012 }
//   ctx.markets  Kalshi board markets (closeTime, series, ticker)
//   ctx.decay    recent-form rows (id, flag)
//   ctx.picks    coin picks (ca, symbol, score)
//   ctx.recap    { day, net, n } recorded $2 after-fee totals for today
//   ctx.localDay / ctx.localHour   the user's clock
export function evaluateAlerts(rules, ctx = {}, memory = emptyMemory(), now = Date.now()) {
  const mem = { ...emptyMemory(), ...memory, px: { ...(memory?.px || {}) }, windows: { ...(memory?.windows || {}) }, flags: { ...(memory?.flags || {}) } };
  const events = [];
  const fire = (rule, key, title, body) => events.push({ id: `${rule.id}:${key}`, rule: rule.id, type: rule.type, at: now, title, body, notify: rule.notify, read: false });
  for (const r of cleanRules(rules)) {
    if (!r.on) continue;
    if (r.type === 'price') {
      const px = Number(ctx.prices?.[r.target]);
      if (!(px > 0)) continue;
      const side = px >= r.level ? 'above' : 'below';
      const prev = mem.px[r.id];
      mem.px[r.id] = side;
      if (prev && prev !== side && side === r.op) fire(r, `${Math.floor(now / 60e3)}`, `${ruleText(r)}`, `Now $${px.toLocaleString('en-US', { maximumFractionDigits: 8 })}. Price alert, not a signal.`);
    } else if (r.type === 'closing') {
      const m = (ctx.markets || []).filter((x) => x && String(x.series || x.ticker || '').startsWith(r.series) && !x.result && Date.parse(x.closeTime) > now).sort((a, b) => Date.parse(a.closeTime) - Date.parse(b.closeTime))[0];
      if (!m) continue;
      const left = (Date.parse(m.closeTime) - now) / 1000;
      const key = `${r.id}|${m.ticker}`;
      if (left <= r.secs && !mem.windows[key]) { mem.windows[key] = now; fire(r, m.ticker, `${r.series.replace(/^KX|15M$/g, '')} locks in ${Math.max(1, Math.round(left / 60))} min`, `${String(m.title || m.ticker).replace(/[?.!]+$/, '')}? Call it on the Desk before it locks. Paper practice.`); }
    } else if (r.type === 'botflip') {
      for (const d of ctx.decay || []) {
        if (!d?.id || (r.bot !== 'any' && d.id !== r.bot)) continue;
        const key = `${r.id}|${d.id}`;
        const prev = mem.flags[key];
        const cur = d.flag || 'flat';
        mem.flags[key] = cur;
        if (prev !== undefined && prev !== cur && cur !== 'flat') fire(r, `${d.id}:${cur}:${Math.floor(now / 3600e3)}`, `${d.id} is ${cur === 'improving' ? 'rising' : 'fading'}`, `Last ${d.recentN || 100} paper bets vs the ones before, after fees. Unproven; the edge gate decides.`);
      }
    } else if (r.type === 'pick') {
      const list = (ctx.picks || []).filter((p) => p?.ca);
      if (!list.length) continue;
      const seen = new Set(mem.picks || []);
      const first = mem.picks == null;
      for (const p of list) {
        if (!seen.has(p.ca) && !first && Number(p.score) >= r.minScore) fire(r, p.ca, `New coin pick: $${p.symbol || p.ca.slice(0, 4)}`, `Watch score ${p.score}/100. A paper idea, not advice. You buy coins yourself.`);
        seen.add(p.ca);
      }
      mem.picks = [...seen].slice(-300);
    } else if (r.type === 'recap') {
      const day = ctx.localDay;
      if (!day || mem.recapDay === day || !Number.isFinite(ctx.localHour) || ctx.localHour < r.hour || !ctx.recap) continue;
      mem.recapDay = day;
      const n = ctx.recap.net;
      fire(r, day, `Today: ${n >= 0 ? '+' : '−'}$${Math.abs(n).toFixed(2)} after fees`, `${ctx.recap.n.toLocaleString('en-US')} paper lines at the recorded $2 size. Paper only.`);
    }
  }
  // Rate limit across all rules.
  const hourAgo = now - 3600e3;
  const sent = (mem.sent || []).filter((t) => t > hourAgo);
  const room = Math.max(0, ALERT_CAP_PER_HOUR - sent.length);
  const kept = events.slice(0, room);
  mem.sent = [...sent, ...kept.map(() => now)];
  return { events: kept, dropped: events.length - kept.length, memory: mem };
}

export function addToInbox(inbox, events) {
  const have = new Set((inbox || []).map((e) => e.id));
  return [...(events || []).filter((e) => !have.has(e.id)), ...(inbox || [])].slice(0, INBOX_MAX);
}
export const unreadCount = (inbox) => (inbox || []).filter((e) => !e.read).length;
