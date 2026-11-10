// Free public market data (no keys): GeckoTerminal, DexScreener, Jupiter lite price API.
// All three send CORS headers, so the browser calls them directly. Read-only: nothing here can trade.

const GT = 'https://api.geckoterminal.com/api/v2/networks/solana';
const DS = 'https://api.dexscreener.com';
const JUP = 'https://lite-api.jup.ag/price/v3';
const num = (x) => (x === null || x === undefined || x === '' ? null : Number.isFinite(+x) ? +x : null);

function normPool(p) {
  const a = p.attributes, rel = p.relationships || {};
  const tx = a.transactions || {}, pc = a.price_change_percentage || {}, vol = a.volume_usd || {};
  const t = (w) => (tx[w] ? { b: tx[w].buys, s: tx[w].sells, buyers: tx[w].buyers, sellers: tx[w].sellers } : null);
  const name = a.name || '';
  return {
    pool: a.address,
    token: rel.base_token?.data?.id?.split('_').slice(1).join('_') || null,
    symbol: name.split(' / ')[0] || '?',
    name,
    dex: rel.dex?.data?.id || null,
    createdAt: a.pool_created_at ? Date.parse(a.pool_created_at) : null,
    priceUsd: num(a.base_token_price_usd),
    liq: num(a.reserve_in_usd),
    fdv: num(a.fdv_usd),
    pc: { m5: num(pc.m5), h1: num(pc.h1), h6: num(pc.h6), h24: num(pc.h24) },
    tx: { m5: t('m5'), h1: t('h1') },
    vol: { m5: num(vol.m5), h1: num(vol.h1), h24: num(vol.h24) },
  };
}

export function createLiveSource({ fetchImpl = globalThis.fetch, gtGapMs = 3000 } = {}) {
  let lastGt = 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function get(url, isGt) {
    if (isGt) { const wait = lastGt + gtGapMs - Date.now(); if (wait > 0) await sleep(wait); lastGt = Date.now(); }
    for (let i = 0; i < 3; i++) {
      let res;
      try {
        // 15 s timeout: a hung request must never stall the desk
        res = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
      } catch (e) {
        // In browsers a 429 arrives without CORS headers and surfaces as a network TypeError; back off and retry.
        if (i < 2) { await sleep(6000 * (i + 1)); if (isGt) lastGt = Date.now(); continue; }
        throw e;
      }
      if (res.status === 429) { await sleep(6000 * (i + 1)); if (isGt) lastGt = Date.now(); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url.split('?')[0]}`);
      return res.json();
    }
    throw new Error(`rate limited ${url.split('?')[0]}`);
  }
  return {
    kind: 'live',
    async newPools(page = 1) { return (await get(`${GT}/new_pools?page=${page}`, true)).data.map(normPool); },
    async trendingPools(page = 1, duration = '1h') { return (await get(`${GT}/trending_pools?page=${page}&duration=${duration}`, true)).data.map(normPool); },
    async tokenInfo(token) {
      const a = (await get(`${GT}/tokens/${token}/info`, true)).data.attributes;
      const yn = (v) => (v === 'yes' ? true : v === 'no' ? false : null);
      return {
        holders: num(a.holders?.count),
        holdersUpdated: a.holders?.last_updated ? Date.parse(a.holders.last_updated) : null,
        top10: num(a.holders?.distribution_percentage?.top_10),
        dev: num(a.developer_holding_percentage),
        mintAuthority: yn(a.mint_authority),
        freezeAuthority: yn(a.freeze_authority),
        honeypot: yn(a.is_honeypot),
        social: !!(a.twitter_handle || a.telegram_handle || (a.websites && a.websites.length)),
        gtScore: num(a.gt_score),
      };
    },
    // Trades >= $20 only (skips dust bots). Returns tuples-friendly objects.
    async poolTrades(pool, token) {
      const d = await get(`${GT}/pools/${pool}/trades?trade_volume_in_usd_greater_than=20`, true);
      return d.data.map((x) => {
        const a = x.attributes;
        const buy = a.kind === 'buy';
        return {
          id: a.tx_hash.slice(0, 16) + (buy ? 'b' : 's'),
          t: Date.parse(a.block_timestamp),
          wallet: a.tx_from_address,
          kind: a.kind,
          usd: num(a.volume_in_usd),
          price: num(buy ? a.price_to_in_usd : a.price_from_in_usd),
          token,
          pool,
        };
      });
    },
    // Current USD price per token: DexScreener (deepest pair), Jupiter as fallback.
    // Minute USD candles for research and diagnostics. Read-only. Empty minutes may be omitted by the API.
    async ohlcv(pool, { timeframe = 'minute', aggregate = 1, limit = 1000, before = null } = {}) {
      const q = new URLSearchParams({
        aggregate: String(aggregate),
        limit: String(Math.min(1000, limit)),
        currency: 'usd',
        token: 'base',
      });
      if (before) q.set('before_timestamp', String(before));
      const d = await get(`${GT}/pools/${pool}/ohlcv/${timeframe}?${q}`, true);
      const rows = d?.data?.attributes?.ohlcv_list || [];
      return rows
        .map(([t, o, h, l, c, v]) => ({ t: t * 1000, o: +o, h: +h, l: +l, c: +c, v: +v }))
        .filter((b) => b.t > 0 && b.o > 0 && b.c > 0 && b.h >= b.l)
        .sort((a, b) => a.t - b.t);
    },
    async prices(tokens) {
      const out = {};
      for (let i = 0; i < tokens.length; i += 30) {
        const chunk = tokens.slice(i, i + 30);
        try {
          const pairs = await get(`${DS}/tokens/v1/solana/${chunk.join(',')}`);
          const best = {};
          for (const p of pairs) {
            const k = p.baseToken?.address; const l = p.liquidity?.usd || 0;
            if (k && chunk.includes(k) && num(p.priceUsd) && (!best[k] || l > best[k].l)) best[k] = { l, price: num(p.priceUsd) };
          }
          for (const k in best) out[k] = best[k].price;
        } catch (e) { /* fall through to Jupiter */ }
        const miss = chunk.filter((k) => !out[k]);
        if (miss.length) {
          try {
            const j = await get(`${JUP}?ids=${miss.join(',')}`);
            for (const k of miss) if (j[k]?.usdPrice) out[k] = j[k].usdPrice;
          } catch (e) { /* leave missing */ }
        }
      }
      return out;
    },
  };
}

// Records every call result per tick so a session can be replayed exactly.
export function createRecorder(src) {
  const tape = { meta: { recordedAt: Date.now(), source: 'live public APIs', note: 'REPLAY of a recorded paper session, not live results' }, ticks: [] };
  let cur = null;
  const wrap = (m) => async (...args) => {
    const r = await src[m](...args);
    if (cur) cur.calls.push({ k: m + JSON.stringify(args), r: m === 'poolTrades' ? packTrades(r) : r });
    return r;
  };
  return {
    kind: 'live', tape,
    beginTick(t) { cur = { t, calls: [] }; tape.ticks.push(cur); },
    newPools: wrap('newPools'), trendingPools: wrap('trendingPools'), tokenInfo: wrap('tokenInfo'), poolTrades: wrap('poolTrades'), prices: wrap('prices'),
  };
}

export function createReplaySource(tape) {
  let cur = null;
  const look = (m) => async (...args) => {
    const hit = cur && cur.calls.find((c) => c.k === m + JSON.stringify(args));
    if (!hit) throw new Error('not in recording');
    return m === 'poolTrades' ? unpackTrades(hit.r, args) : JSON.parse(JSON.stringify(hit.r));
  };
  return {
    kind: 'replay', tape,
    beginTick(t) { cur = tape.ticks.find((x) => x.t === t) || null; },
    newPools: look('newPools'), trendingPools: look('trendingPools'), tokenInfo: look('tokenInfo'), poolTrades: look('poolTrades'), prices: look('prices'),
  };
}

// compact trade encoding for tapes: [id, t, wallet, isBuy, usd, price]
function packTrades(tr) { return tr.map((x) => [x.id, x.t, x.wallet, x.kind === 'buy' ? 1 : 0, x.usd, x.price]); }
function unpackTrades(rows, [pool, token]) { return rows.map(([id, t, wallet, b, usd, price]) => ({ id, t, wallet, kind: b ? 'buy' : 'sell', usd, price, token, pool })); }
