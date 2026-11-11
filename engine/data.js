// Free public market data (no keys): GeckoTerminal, DexScreener, Jupiter lite price API.
// All three send CORS headers, so the browser calls them directly. Read-only: nothing here can trade.

const GT_ROOT = 'https://api.geckoterminal.com/api/v2';
const GT = `${GT_ROOT}/networks/solana`;
const DS = 'https://api.dexscreener.com';
const JUP = 'https://lite-api.jup.ag/price/v3';
const POLY = 'https://gamma-api.polymarket.com/markets?closed=false&limit=12&order=volumeNum&ascending=false';
const KALSHI = 'https://external-api.kalshi.com/trade-api/v2/markets?limit=8&status=open';
// One GeckoTerminal list per even scan. About 10 calls/minute is the current public doc.
const GT_LISTS = [
  `${GT_ROOT}/networks/trending_pools?page=1`,
  `${GT_ROOT}/networks/new_pools?page=1`,
  `${GT_ROOT}/networks/base/trending_pools?page=1`,
  `${GT_ROOT}/networks/bsc/trending_pools?page=1`,
  `${GT_ROOT}/networks/eth/trending_pools?page=1`,
];
const SCAN_CHAINS = ['solana', 'ethereum', 'base', 'bsc', 'arbitrum'];
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
    chain: rel.network?.data?.id || 'solana',
    createdAt: a.pool_created_at ? Date.parse(a.pool_created_at) : null,
    priceUsd: num(a.base_token_price_usd),
    liq: num(a.reserve_in_usd),
    fdv: num(a.fdv_usd),
    pc: { m5: num(pc.m5), h1: num(pc.h1), h6: num(pc.h6), h24: num(pc.h24) },
    tx: { m5: t('m5'), h1: t('h1') },
    vol: { m5: num(vol.m5), h1: num(vol.h1), h24: num(vol.h24) },
  };
}

export function createLiveSource({ fetchImpl = globalThis.fetch, gtGapMs = 7000 } = {}) {
  let lastGt = 0;
  const cache = new Map();
  async function cached(key, ttl, fn) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.t < ttl) return hit.v;
    const v = await fn();
    cache.set(key, { t: Date.now(), v });
    return v;
  }
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
    async ohlcv(pool, { timeframe = 'minute', aggregate = 1, limit = 1000, before = null, network = 'solana' } = {}) {
      const q = new URLSearchParams({
        aggregate: String(aggregate),
        limit: String(Math.min(1000, limit)),
        currency: 'usd',
        token: 'base',
      });
      if (before) q.set('before_timestamp', String(before));
      const root = network === 'solana' ? GT : `${GT_ROOT}/networks/${network}`;
      const d = await get(`${root}/pools/${pool}/ohlcv/${timeframe}?${q}`, true);
      const rows = d?.data?.attributes?.ohlcv_list || [];
      return rows
        .map(([t, o, h, l, c, v]) => ({ t: t * 1000, o: +o, h: +h, l: +l, c: +c, v: +v }))
        .filter((b) => b.t > 0 && b.o > 0 && b.c > 0 && b.h >= b.l)
        .sort((a, b) => a.t - b.t);
    },
    async prices(tokens, chain = 'solana') {
      const out = {};
      for (let i = 0; i < tokens.length; i += 30) {
        const chunk = tokens.slice(i, i + 30);
        try {
          const pairs = await get(`${DS}/tokens/v1/${chain}/${chunk.join(',')}`);
          const best = {};
          for (const p of pairs) {
            const k = p.baseToken?.address; const l = p.liquidity?.usd || 0;
            if (k && chunk.includes(k) && num(p.priceUsd) && (!best[k] || l > best[k].l)) best[k] = { l, price: num(p.priceUsd) };
          }
          for (const k in best) out[k] = best[k].price;
        } catch (e) { /* fall through to Jupiter */ }
        const miss = chunk.filter((k) => !out[k]);
        if (miss.length && chain === 'solana') {
          try {
            const j = await get(`${JUP}?ids=${miss.join(',')}`);
            for (const k of miss) if (j[k]?.usdPrice) out[k] = j[k].usdPrice;
          } catch (e) { /* leave missing */ }
        }
      }
      return out;
    },
    // Frequent multi-chain scan. DexScreener does the wide pass. GeckoTerminal is one list, and only on even ticks.
    async discover(tick = 0) {
      const pools = [];
      const feed = [];
      const notes = [];
      try {
        const boosts = await cached('ds-boosts', 20000, () => get(`${DS}/token-boosts/latest/v1`));
        const rows = (Array.isArray(boosts) ? boosts : []).filter((r) => SCAN_CHAINS.includes(r.chainId) && r.tokenAddress);
        const byChain = new Map();
        for (const r of rows) {
          if (!byChain.has(r.chainId)) byChain.set(r.chainId, []);
          const list = byChain.get(r.chainId);
          if (list.length < 30 && !list.includes(r.tokenAddress)) list.push(r.tokenAddress);
        }
        const chains = [...byChain.keys()].slice((tick % Math.max(1, byChain.size)), (tick % Math.max(1, byChain.size)) + 3);
        const use = chains.length ? chains : [...byChain.keys()].slice(0, 3);
        for (const chain of use) {
          const addrs = byChain.get(chain) || [];
          if (!addrs.length) continue;
          try {
            const pairs = await get(`${DS}/tokens/v1/${chain}/${addrs.slice(0, 30).join(',')}`);
            for (const p of pairs || []) {
              const pool = pairToPool(p);
              if (!pool.pool || !pool.token) continue;
              pools.push(pool);
              feed.push({ chain: pool.chain, symbol: pool.symbol, liq: pool.liq, dex: pool.dex, via: 'boost' });
            }
          } catch (e) { notes.push(`${chain}: ${e.message}`); }
        }
      } catch (e) { notes.push(`boosts: ${e.message}`); }
      if (tick % 2 === 0) {
        const url = GT_LISTS[Math.floor(tick / 2) % GT_LISTS.length];
        try {
          const raw = await cached(url, 45000, () => get(url, true));
          for (const row of raw?.data || []) {
            const pool = normPool(row);
            if (!pool.pool) continue;
            pools.push(pool);
            feed.push({ chain: pool.chain, symbol: pool.symbol, liq: pool.liq, dex: pool.dex, via: 'gecko' });
          }
        } catch (e) { notes.push(`gecko: ${e.message}`); }
      }
      let predictions = [];
      try {
        predictions = await cached('predict', 60000, () => loadPredictions(get));
      } catch (e) { notes.push(`predict: ${e.message}`); }
      return { pools, feed: feed.slice(0, 16), predictions, note: notes.join(' · ') };
    },
  };
}

function pairToPool(p) {
  return {
    pool: p.pairAddress,
    token: p.baseToken?.address || null,
    symbol: p.baseToken?.symbol || '?',
    name: p.baseToken?.name || '',
    dex: p.dexId || null,
    chain: p.chainId || '?',
    createdAt: p.pairCreatedAt || null,
    priceUsd: num(p.priceUsd),
    liq: num(p.liquidity?.usd),
    fdv: num(p.fdv),
    pc: { m5: num(p.priceChange?.m5), h1: num(p.priceChange?.h1), h6: num(p.priceChange?.h6), h24: num(p.priceChange?.h24) },
    tx: {
      m5: p.txns?.m5 ? { b: p.txns.m5.buys, s: p.txns.m5.sells } : null,
      h1: p.txns?.h1 ? { b: p.txns.h1.buys, s: p.txns.h1.sells } : null,
    },
    vol: { m5: num(p.volume?.m5), h1: num(p.volume?.h1), h24: num(p.volume?.h24) },
  };
}

async function loadPredictions(get) {
  const out = [];
  try {
    const rows = await get(POLY);
    for (const m of (Array.isArray(rows) ? rows : []).slice(0, 8)) {
      let yes = null;
      try { yes = JSON.parse(m.outcomePrices || '[]')[0]; } catch { yes = null; }
      out.push({ venue: 'Polymarket', title: m.question || m.slug || 'market', price: yes, volume: m.volumeNum ?? m.volume ?? null });
    }
  } catch (e) {
    out.push({ venue: 'Polymarket', title: `unavailable (${e.message})`, price: null, volume: null });
  }
  try {
    const body = await get(KALSHI);
    for (const m of (body?.markets || []).slice(0, 6)) {
      out.push({ venue: 'Kalshi', title: m.title || m.ticker, price: m.yes_bid_dollars ?? m.yes_bid ?? null, volume: m.volume_fp ?? m.volume ?? null });
    }
    if (!(body?.markets || []).length) out.push({ venue: 'Kalshi', title: 'no open markets in this response', price: null, volume: null });
  } catch (e) {
    out.push({ venue: 'Kalshi', title: `refused or blocked (${e.message})`, price: null, volume: null });
  }
  return out;
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
