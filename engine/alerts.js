// Phone push for an early-entry paper signal. This module cannot sign,
// connect a wallet, or send an order. A missing topic does nothing, so a
// fork and CI pass without the secret. The topic is never written here.

export const ALERT_LINE = 'UNPROVEN paper signal - strategy has not passed the edge gate';
export const ALERTS_PER_HOUR = 10;
export const ALERT_HOUR_MS = 60 * 60 * 1000;
export const DESK_URL = 'https://kodie4004-coder.github.io/grok-desk-paper/';
export const ALERT_MINT_CAP = 3000;

const TOPIC_RE = /^[-_A-Za-z0-9]{1,64}$/;

export function ntfyTopic(env) {
  const topic = env?.NTFY_TOPIC;
  if (typeof topic !== 'string') return '';
  const trimmed = topic.trim();
  return TOPIC_RE.test(trimmed) ? trimmed : '';
}

export function pumpCoinUrl(ca) {
  return `https://pump.fun/coin/${encodeURIComponent(ca)}`;
}

export function fomoCoinUrl(ca) {
  return `https://fomo.family/tokens/solana/${encodeURIComponent(ca)}`;
}

function ageLabel(ageMin) {
  if (!Number.isFinite(ageMin)) return 'age unknown';
  const rounded = Math.round(ageMin * 10) / 10;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${text} min`;
}

function liqLabel(liq) {
  if (!Number.isFinite(liq)) return 'liquidity unknown';
  return `$${Math.round(liq)}`;
}

export function emptyAlertState() {
  return { paper: true, liveExecution: false, sent: [] };
}

export function normalizeAlerts(doc) {
  const sent = [];
  const seen = new Set();
  for (const row of doc?.sent || []) {
    if (!row?.ca || seen.has(row.ca)) continue;
    seen.add(row.ca);
    sent.push({ ca: row.ca, at: typeof row.at === 'string' ? row.at : null, symbol: row.symbol || '?' });
  }
  return { paper: true, liveExecution: false, sent };
}

export function passesPhoneAlert(row) {
  if (!row?.ca || row.action !== 'enter' || row.jevPending) return false;
  if (row.jev?.verdict === 'flag') return false;
  return true;
}

export function formatAlert(row) {
  const symbol = String(row?.symbol || '?').replace(/[\r\n]/g, ' ').trim().slice(0, 32) || '?';
  const verdict = row?.jev?.verdict || 'not asked';
  const click = pumpCoinUrl(row.ca);
  const body = [
    symbol,
    `Age ${ageLabel(row.ageMin)}`,
    `Liquidity ${liqLabel(row.liq)}`,
    `Jev ${verdict}`,
    ALERT_LINE,
    row.ca,
  ].join('\n');
  return {
    title: `${symbol} paper signal`,
    tags: 'warning',
    click,
    actions: [
      `view, Open FOMO, ${fomoCoinUrl(row.ca)}`,
      `view, Open Pump.fun, ${click}`,
      `view, Desk, ${DESK_URL}`,
    ].join('; '),
    body,
  };
}

function recentCount(sent, now) {
  let n = 0;
  for (const row of sent || []) {
    const t = Date.parse(row.at || '');
    if (!Number.isFinite(t)) continue;
    const age = now - t;
    if (age >= 0 && age < ALERT_HOUR_MS) n += 1;
  }
  return n;
}

export function planAlerts(rows, state, now) {
  const doc = normalizeAlerts(state);
  const seen = new Set(doc.sent.map((row) => row.ca));
  let used = recentCount(doc.sent, now);
  const queued = [];
  const skipped = [];
  for (const row of rows || []) {
    if (!passesPhoneAlert(row)) {
      const reason = row?.jev?.verdict === 'flag' ? 'flag' : (row?.jevPending ? 'pending' : 'checks');
      skipped.push({ ca: row?.ca || null, reason });
      continue;
    }
    if (seen.has(row.ca)) {
      skipped.push({ ca: row.ca, reason: 'dedupe' });
      continue;
    }
    if (used >= ALERTS_PER_HOUR) {
      skipped.push({ ca: row.ca, reason: 'cap' });
      continue;
    }
    queued.push(row);
    seen.add(row.ca);
    used += 1;
  }
  return { queued, skipped };
}

export function markSent(state, rows, nowIso) {
  const doc = normalizeAlerts(state);
  const sent = [...doc.sent];
  const seen = new Set(sent.map((row) => row.ca));
  for (const row of rows || []) {
    if (!row?.ca || seen.has(row.ca)) continue;
    sent.push({ ca: row.ca, at: nowIso, symbol: row.symbol || '?' });
    seen.add(row.ca);
  }
  sent.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')) || a.ca.localeCompare(b.ca));
  const kept = sent.length > ALERT_MINT_CAP ? sent.slice(sent.length - ALERT_MINT_CAP) : sent;
  return { paper: true, liveExecution: false, sent: kept };
}

export function mergeAlertDocs(a, b) {
  const by = new Map();
  for (const row of [...(normalizeAlerts(a).sent), ...(normalizeAlerts(b).sent)]) {
    const prev = by.get(row.ca);
    if (!prev || (row.at && (!prev.at || row.at < prev.at))) by.set(row.ca, row);
  }
  const sent = [...by.values()].sort((x, y) => String(x.at || '').localeCompare(String(y.at || '')) || x.ca.localeCompare(y.ca));
  const kept = sent.length > ALERT_MINT_CAP ? sent.slice(sent.length - ALERT_MINT_CAP) : sent;
  return { paper: true, liveExecution: false, sent: kept };
}

export async function sendPhoneAlerts(rows, opts = {}) {
  const topic = opts.topic == null ? ntfyTopic(opts.env) : (TOPIC_RE.test(String(opts.topic || '').trim()) ? String(opts.topic).trim() : '');
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const state = normalizeAlerts(opts.state);
  const ready = (rows || []).filter((row) => passesPhoneAlert(row));
  if (!topic) {
    return {
      sent: [],
      skipped: ready.map((row) => ({ ca: row.ca, reason: 'no topic' })),
      state,
      delivered: 0,
    };
  }
  const plan = planAlerts(rows, state, now);
  const fetchImpl = opts.fetchImpl;
  if (typeof fetchImpl !== 'function') {
    return {
      sent: [],
      skipped: [...plan.skipped, ...plan.queued.map((row) => ({ ca: row.ca, reason: 'no fetch' }))],
      state,
      delivered: 0,
    };
  }
  const delivered = [];
  const failed = [];
  for (let i = 0; i < plan.queued.length; i++) {
    const row = plan.queued[i];
    const msg = formatAlert(row);
    try {
      const res = await fetchImpl(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
        method: 'POST',
        headers: {
          Title: msg.title,
          Tags: msg.tags,
          Click: msg.click,
          Actions: msg.actions,
          'Content-Type': 'text/plain; charset=utf-8',
        },
        body: msg.body,
      });
      if (res?.status === 429) {
        failed.push({ ca: row.ca, reason: 'http' });
        for (const rest of plan.queued.slice(i + 1)) failed.push({ ca: rest.ca, reason: 'http' });
        break;
      }
      if (!res?.ok) {
        failed.push({ ca: row.ca, reason: 'http' });
        continue;
      }
      delivered.push(row);
    } catch {
      failed.push({ ca: row.ca, reason: 'request failed' });
    }
  }
  return {
    sent: delivered.map((row) => row.ca),
    skipped: [...plan.skipped, ...failed],
    state: markSent(state, delivered, new Date(now).toISOString()),
    delivered: delivered.length,
  };
}
