// Coins to watch, run inside the meme snapshot. Read-only public data:
// DexScreener pairs, GeckoTerminal trending pools, and RugCheck reports.
// No wallet, no key, no order. The phone push uses NTFY_TOPIC only when the
// step has it, and the topic is never logged or written.
import fs from 'node:fs';
import { bestPair, pricesFromDex, scoreCoin } from '../engine/meme.js';
import { RUG_URL } from '../engine/early.js';
import { ntfyTopic, DESK_URL } from '../engine/alerts.js';
import {
  CW_NOTE, CW_SAFETY_TTL_MS, CW_SCAN, formatWatchPush, logPicks, markPicks, pendingMints, pickRecord,
  planWatchPush, rankWatch, readRugReport, watchSafety,
} from '../engine/coin-watch.js';

const PATH = 'data/coin-watch.json';
const BOARD_ONLY = new Set(['top 10 holders', 'dev wallet share', 'mint authority', 'freeze authority']);

export function readWatchDoc(path = PATH) {
  try { return JSON.parse(fs.readFileSync(path, 'utf8')); } catch { return null; }
}

// Board coins that clear every check RugCheck does not replace.
export function boardReady(coin) {
  return !!coin?.ca && (coin.reasons || []).length > 0 && (coin.reasons || []).every((r) => BOARD_ONLY.has(r.name) || r.ok === true);
}

async function json(fetchImpl, url) {
  const res = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function updateCoinWatch({ coins = [], meta = new Map(), trending = [], now = Date.now(), fetchImpl = fetch, env = {}, path = PATH } = {}) {
  const prev = readWatchDoc(path) || {};
  const cache = prev.rugCache && typeof prev.rugCache === 'object' ? prev.rugCache : {};
  const pairs = new Map();
  const base = new Map();
  for (const coin of coins) {
    if (!boardReady(coin)) continue;
    const pair = meta.get(coin.ca)?.pair;
    if (pair) { pairs.set(coin.ca, pair); base.set(coin.ca, coin); }
  }
  // Trending pools widen the pool. They run the same board checks.
  const extra = (trending || []).map((row) => row.ca).filter((ca) => ca && !base.has(ca) && !meta.has(ca)).slice(0, 20);
  if (extra.length) {
    try {
      const book = await json(fetchImpl, 'https://api.dexscreener.com/latest/dex/tokens/' + extra.join(','));
      for (const ca of extra) {
        const pair = bestPair(book?.pairs || [], ca);
        if (!pair) continue;
        const scored = scoreCoin(pair, null, now);
        const coin = { ca, symbol: pair.baseToken?.symbol || '?', name: pair.baseToken?.name || 'Unknown', imageUrl: pair.info?.imageUrl || null, ...scored };
        if (boardReady(coin)) { pairs.set(ca, pair); base.set(ca, coin); }
      }
    } catch (e) { console.log('watch trending pairs', e.message); }
  }
  const order = [...base.values()].sort((a, b) => (Number(pairs.get(b.ca)?.volume?.h1) || 0) - (Number(pairs.get(a.ca)?.volume?.h1) || 0)).slice(0, CW_SCAN);
  const nextCache = {};
  let rugCalls = 0;
  const cands = [];
  for (const coin of order) {
    const hit = cache[coin.ca];
    let rug = hit && now - Date.parse(hit.at || '') < CW_SAFETY_TTL_MS ? hit.rug : undefined;
    if (rug === undefined) {
      try {
        rug = readRugReport(await json(fetchImpl, `${RUG_URL}/${encodeURIComponent(coin.ca)}/report`));
        rugCalls += 1;
      } catch (e) {
        rug = null;
        console.log('watch rug', coin.symbol, e.message);
      }
      if (rug) nextCache[coin.ca] = { at: new Date(now).toISOString(), rug };
    } else nextCache[coin.ca] = hit;
    cands.push({ coin, pair: pairs.get(coin.ca), rug });
  }
  const top = rankWatch(cands, now);
  const blocked = cands.filter((c) => !watchSafety(c.coin, c.rug).ok).length;
  const logged = logPicks(prev.log || [], top, now);
  const priceMap = {};
  for (const [ca, pair] of pairs) { const px = Number(pair?.priceUsd); if (px > 0) priceMap[ca] = px; }
  for (const [ca, m] of meta) { const px = Number(m?.pair?.priceUsd); if (px > 0 && !priceMap[ca]) priceMap[ca] = px; }
  const need = pendingMints(logged.log, now).filter((ca) => !priceMap[ca]);
  for (let i = 0; i < need.length; i += 30) {
    const slice = need.slice(i, i + 30);
    try {
      Object.assign(priceMap, pricesFromDex(await json(fetchImpl, 'https://api.dexscreener.com/latest/dex/tokens/' + slice.join(',')), slice));
    } catch (e) { console.log('watch marks', e.message); }
  }
  const marked = markPicks(logged.log, priceMap, now);
  let push = prev.push && typeof prev.push === 'object' ? prev.push : { sent: [] };
  const topic = ntfyTopic(env);
  const queued = planWatchPush(top, logged.added, push, now);
  let delivered = 0;
  if (topic && queued.length) {
    for (const pick of queued) {
      const msg = formatWatchPush(pick, DESK_URL);
      try {
        const res = await fetchImpl(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
          method: 'POST',
          headers: { Title: msg.title, Tags: msg.tags, Click: msg.click, Actions: msg.actions, 'Content-Type': 'text/plain; charset=utf-8' },
          body: msg.body,
        });
        if (res?.ok) {
          delivered += 1;
          push = { sent: [...(push.sent || []), { ca: pick.ca, symbol: pick.symbol, at: new Date(now).toISOString(), score: pick.score }].slice(-200) };
        }
      } catch { console.log('watch push request failed'); }
    }
  }
  const pushed = topic ? String(delivered) : 'off';
  const doc = {
    paper: true,
    liveExecution: false,
    updatedAt: new Date(now).toISOString(),
    note: CW_NOTE,
    pushOn: !!topic,
    scanned: cands.length,
    blocked,
    picks: top,
    record: pickRecord(marked.log),
    log: marked.log,
    push,
    rugCache: nextCache,
  };
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(path, JSON.stringify(doc, null, 2) + '\n');
  console.log('coin watch', `scanned=${cands.length}`, `safe=${top.length}`, `blocked=${blocked}`, `new=${logged.added.length}`, `marked=${marked.marked}`, `rug=${rugCalls}`, `push=${pushed}`);
  return doc;
}
