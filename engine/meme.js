// Solana meme signals. Thresholds are frozen in EVAL_PROTOCOL.md before any live pass.
// Paper only. This module cannot sign, connect a wallet, or send an order.

import { graduates } from './strategies.js';

export const MEME_SIZE = 2;
export const MEME_FEE = 0.0125;
export const MEME_SLIP = 0.01;
export const MEME_RULES = {
  minLiq: 20000,
  minVolH24: 5000,
  minAgeMin: 30,
  maxAgeDays: 14,
  maxTop10: 0.40,
  maxFdvToLiq: 50,
  maxH1: 400,
  minH1: -80,
  quotes: ['SOL', 'WSOL', 'USDC', 'USDT'],
  stop: 0.85,
  tp: 1.25,
  holdMs: 30 * 60 * 1000,
};

const num = (x) => {
  const n = typeof x === 'string' ? Number(x) : x;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

// Public read-only JSON-RPC. No key. Vibestation is first because the official
// mainnet endpoint answers getTokenLargestAccounts with 429 even on the first call.
export const SOLANA_RPCS = [
  'https://public.rpc.solanavibestation.com',
  'https://api.mainnet-beta.solana.com',
];
export const MEME_SCAN = 24;
const FRESH_SLOTS = 8;

function rawAmount(amount) {
  const text = typeof amount === 'bigint' ? amount.toString() : amount;
  return typeof text === 'string' && /^\d+$/.test(text) ? BigInt(text) : null;
}

function authorityFlag(info, key) {
  if (!Object.prototype.hasOwnProperty.call(info, key)) return null;
  const value = info[key];
  if (value == null) return 'no';
  if (typeof value === 'string' && value.length > 0) return 'yes';
  return null;
}

// jsonParsed mint account from getAccountInfo / getMultipleAccounts.
// A null authority is off. A pubkey is on. Anything else is unknown and fails.
export function parseMintAccount(value) {
  if (!value) return { mint: null, freeze: null, supply: null, decimals: null, detail: 'account missing' };
  const parsed = value.data?.parsed;
  if (!parsed || parsed.type !== 'mint' || !parsed.info) {
    return { mint: null, freeze: null, supply: null, decimals: null, detail: 'not a mint account' };
  }
  const info = parsed.info;
  const mint = authorityFlag(info, 'mintAuthority');
  const freeze = authorityFlag(info, 'freezeAuthority');
  const supply = rawAmount(info.supply) == null ? null : String(info.supply);
  const decimals = Number.isInteger(info.decimals) ? info.decimals : null;
  const detail = mint == null || freeze == null ? 'unreadable' : null;
  return { mint, freeze, supply, decimals, detail };
}

// Top 10 share of supply. The pool vault is excluded only when one account
// matches the pair's base reserve within 3% and no other account is that close,
// or when the account address is the pair address. Otherwise the vault stays in,
// which can only raise the share.
export function topHolderShare(accounts, supply, opts = {}) {
  const supplyRaw = rawAmount(supply);
  const usable = [];
  for (const row of accounts || []) {
    const raw = rawAmount(row?.amount);
    if (!row?.address || raw == null) continue;
    usable.push({ address: row.address, raw });
  }
  if (!usable.length) return { share: null, excluded: null, detail: 'no holder accounts' };
  if (supplyRaw == null || supplyRaw <= 0n) return { share: null, excluded: null, detail: 'supply missing' };
  let exclude = null;
  if (opts.pairAddress) {
    const owned = opts.owners ? usable.find((row) => opts.owners.get(row.address) === opts.pairAddress) : null;
    const named = usable.find((row) => row.address === opts.pairAddress);
    if (owned) exclude = owned.address;
    else if (named) exclude = named.address;
  }
  const baseUi = typeof opts.baseUi === 'number' ? opts.baseUi : Number(opts.baseUi);
  const decimals = opts.decimals;
  if (!exclude && Number.isFinite(baseUi) && baseUi > 0 && Number.isInteger(decimals) && decimals >= 0 && decimals <= 12) {
    const target = BigInt(Math.round(baseUi * (10 ** decimals)));
    if (target > 0n) {
      const ranked = usable.map((row) => {
        const diff = row.raw > target ? row.raw - target : target - row.raw;
        return { address: row.address, rel: Number(diff) / Number(target) };
      }).sort((a, b) => a.rel - b.rel);
      if (ranked[0] && ranked[0].rel <= 0.03 && !(ranked[1] && ranked[1].rel <= 0.03)) exclude = ranked[0].address;
    }
  }
  const kept = usable
    .filter((row) => row.address !== exclude)
    .sort((a, b) => (a.raw > b.raw ? -1 : a.raw < b.raw ? 1 : 0))
    .slice(0, 10);
  if (!kept.length) return { share: null, excluded: exclude, detail: 'no holder accounts' };
  const sum = kept.reduce((total, row) => total + row.raw, 0n);
  const share = Number(sum) / Number(supplyRaw);
  if (!Number.isFinite(share)) return { share: null, excluded: exclude, detail: 'supply missing' };
  return { share, excluded: exclude, detail: null };
}

export function poolMint(pool) {
  const id = pool?.relationships?.base_token?.data?.id || '';
  if (!id.startsWith('solana_')) return null;
  const mint = id.slice('solana_'.length);
  return mint || null;
}

function solMints(rows) {
  const out = [];
  const seen = new Set();
  for (const row of rows || []) {
    const addr = row?.tokenAddress;
    if (row?.chainId !== 'solana' || !addr || seen.has(addr)) continue;
    seen.add(addr);
    out.push(addr);
  }
  return out;
}

// Boosted mints first, with up to 8 slots kept for newer profiles and pools.
export function candidateMints({ boosts = [], profiles = [], pools = [] } = {}, limit = MEME_SCAN) {
  const boosted = solMints(boosts);
  const boostSet = new Set(boosted);
  const fresh = [];
  const seen = new Set();
  const addFresh = (addr) => {
    if (!addr || boostSet.has(addr) || seen.has(addr)) return;
    seen.add(addr);
    fresh.push(addr);
  };
  for (const row of profiles || []) {
    if (row?.chainId === 'solana') addFresh(row.tokenAddress);
  }
  for (const pool of pools || []) addFresh(poolMint(pool));
  const cap = Math.max(0, limit);
  const freshTake = Math.min(FRESH_SLOTS, fresh.length, cap);
  const boostTake = Math.min(boosted.length, cap - freshTake);
  const moreFresh = Math.min(fresh.length - freshTake, cap - boostTake - freshTake);
  return [...boosted.slice(0, boostTake), ...fresh.slice(0, freshTake + moreFresh)];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rateLimited(status, body) {
  if (status === 429) return true;
  const msg = String(body?.error?.message || '');
  return body?.error?.code === 429 || /too many requests/i.test(msg);
}

async function rpc(fetchImpl, urls, method, params, deadline, retryWaitMs) {
  let last = 'lookup failed';
  for (const url of urls) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (Date.now() >= deadline) return { error: 'lookup failed: timed out' };
      const left = Math.max(1, deadline - Date.now());
      try {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          signal: AbortSignal.timeout(Math.min(8000, left)),
        });
        const body = res.ok ? await res.json() : null;
        if (!res.ok || body?.error) {
          last = !res.ok
            ? `lookup failed: HTTP ${res.status}`
            : `lookup failed: ${String(body.error.message || 'rpc error').slice(0, 80)}`;
          if (attempt === 0 && rateLimited(res.status, body) && retryWaitMs > 0 && deadline - Date.now() > retryWaitMs + 400) {
            await sleep(Math.min(retryWaitMs, deadline - Date.now() - 200));
            continue;
          }
          break;
        }
        if (!body || !Object.prototype.hasOwnProperty.call(body, 'result')) {
          last = 'lookup failed';
          break;
        }
        return { result: body.result };
      } catch (e) {
        last = e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'lookup failed: timed out' : 'lookup failed';
        break;
      }
    }
  }
  return { error: last };
}

function safetyRow(parsed, hold) {
  return {
    mint: parsed.mint,
    freeze: parsed.freeze,
    top10: hold.share,
    mintDetail: parsed.mint == null ? (parsed.detail || 'lookup failed') : undefined,
    freezeDetail: parsed.freeze == null ? (parsed.detail || 'lookup failed') : undefined,
    top10Detail: hold.share == null ? (hold.detail || 'lookup failed') : undefined,
  };
}

// One getMultipleAccounts for every mint, then getTokenLargestAccounts with a
// hard deadline so a slow RPC cannot stall the snapshot chain. Supply comes
// from the mint account, which is the amount getTokenSupply returns.
export async function lookupMints(mints, meta = new Map(), opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const rpcUrls = opts.rpcUrls || SOLANA_RPCS;
  const deadline = Date.now() + (opts.budgetMs ?? 45000);
  const gapMs = opts.gapMs ?? 700;
  const retryWaitMs = opts.retryWaitMs ?? 1200;
  const holderStop = deadline - (opts.ownerReserveMs ?? 5000);
  const out = new Map();
  const list = (mints || []).filter(Boolean);
  const timed = () => safetyRow(
    { mint: null, freeze: null, detail: 'lookup failed: timed out' },
    { share: null, detail: 'lookup failed: timed out' },
  );
  if (!list.length) return out;
  if (Date.now() >= deadline) {
    for (const mint of list) out.set(mint, timed());
    return out;
  }
  const accounts = await rpc(fetchImpl, rpcUrls, 'getMultipleAccounts', [list, { encoding: 'jsonParsed' }], deadline, retryWaitMs);
  const values = Array.isArray(accounts.result?.value) ? accounts.result.value : null;
  const largest = new Array(list.length);
  let cursor = 0;
  let started = false;
  async function worker() {
    for (;;) {
      const i = cursor++;
      if (i >= list.length) return;
      if (started && gapMs > 0) {
        const wait = Math.min(gapMs, deadline - Date.now());
        if (wait > 0) await sleep(wait);
      }
      started = true;
      if (Date.now() >= holderStop) {
        largest[i] = { error: 'lookup failed: timed out' };
        continue;
      }
      largest[i] = await rpc(fetchImpl, rpcUrls, 'getTokenLargestAccounts', [list[i]], holderStop, retryWaitMs);
    }
  }
  await worker();
  const owners = new Map();
  const want = [];
  const seen = new Set();
  list.forEach((mint, i) => {
    const pairAddress = meta.get(mint)?.pairAddress;
    const rows = largest[i]?.result?.value;
    if (!pairAddress || !Array.isArray(rows)) return;
    for (const row of rows.slice(0, 12)) {
      if (row?.address && !seen.has(row.address)) {
        seen.add(row.address);
        want.push(row.address);
      }
    }
  });
  for (let i = 0; i < want.length && Date.now() < deadline; i += 100) {
    const chunk = want.slice(i, i + 100);
    const got = await rpc(fetchImpl, rpcUrls, 'getMultipleAccounts', [chunk, { encoding: 'jsonParsed' }], deadline, 0);
    const rows = got.result?.value;
    if (!Array.isArray(rows)) continue;
    chunk.forEach((addr, j) => {
      const owner = rows[j]?.data?.parsed?.info?.owner;
      if (typeof owner === 'string') owners.set(addr, owner);
    });
  }
  list.forEach((mint, i) => {
    const info = meta.get(mint) || {};
    const parsed = accounts.error
      ? { mint: null, freeze: null, supply: null, decimals: null, detail: accounts.error }
      : parseMintAccount(values && i < values.length ? values[i] : null);
    const hold = !largest[i] || largest[i].error
      ? { share: null, detail: largest[i]?.error || 'lookup failed' }
      : topHolderShare(Array.isArray(largest[i].result?.value) ? largest[i].result.value : [], parsed.supply, {
        baseUi: info.baseUi,
        decimals: parsed.decimals,
        pairAddress: info.pairAddress,
        owners,
      });
    out.set(mint, safetyRow(parsed, hold));
  });
  return out;
}

function readSafety(info) {
  if (!info) return { top10: null, mint: null, freeze: null, mintDetail: null, freezeDetail: null, top10Detail: null };
  const chain = info.mint !== undefined || info.freeze !== undefined || info.top10 !== undefined || info.mintDetail || info.freezeDetail || info.top10Detail;
  if (chain) {
    return {
      top10: num(info.top10),
      mint: info.mint ?? null,
      freeze: info.freeze ?? null,
      mintDetail: info.mintDetail || null,
      freezeDetail: info.freezeDetail || null,
      top10Detail: info.top10Detail || null,
    };
  }
  const holders = info.holders?.distribution_percentage?.top_10;
  const raw = holders == null ? null : num(holders);
  return {
    top10: raw == null ? null : raw / (raw > 1 ? 100 : 1),
    mint: info.mint_authority ?? null,
    freeze: info.freeze_authority ?? null,
    mintDetail: null,
    freezeDetail: null,
    top10Detail: null,
  };
}

export function memePnl(entry, exit) {
  if (!(entry > 0) || !(exit > 0)) return null;
  const buy = entry * (1 + MEME_SLIP);
  const sell = exit * (1 - MEME_SLIP);
  const qty = MEME_SIZE / buy;
  const proceeds = qty * sell;
  const fees = MEME_SIZE * MEME_FEE + proceeds * MEME_FEE;
  return { pnl: proceeds - MEME_SIZE - fees, fees, sizeUsd: MEME_SIZE };
}

function check(name, ok, detail) {
  return { name, ok, detail };
}

export function scoreCoin(pair, info, now) {
  const reasons = [];
  const liq = num(pair?.liquidity?.usd);
  const vol = num(pair?.volume?.h24);
  const h1 = num(pair?.priceChange?.h1);
  const created = num(pair?.pairCreatedAt);
  const ageMin = created ? (now - created) / 60000 : null;
  const quote = String(pair?.quoteToken?.symbol || '').toUpperCase();
  const fdv = num(pair?.fdv);
  const ratio = liq > 0 && fdv > 0 ? fdv / liq : null;
  const safety = readSafety(info);
  const top10 = safety.top10;
  const mint = safety.mint;
  const freeze = safety.freeze;
  reasons.push(check('liquidity', liq != null && liq >= MEME_RULES.minLiq, liq == null ? 'missing' : `$${Math.round(liq).toLocaleString('en-US')}`));
  reasons.push(check('volume', vol != null && vol >= MEME_RULES.minVolH24, vol == null ? 'missing' : `$${Math.round(vol).toLocaleString('en-US')} / 24h`));
  reasons.push(check('age', ageMin != null && ageMin >= MEME_RULES.minAgeMin && ageMin <= MEME_RULES.maxAgeDays * 24 * 60, ageMin == null ? 'missing' : `${Math.round(ageMin)} min`));
  reasons.push(check('quote', MEME_RULES.quotes.includes(quote), quote || 'missing'));
  reasons.push(check('fdv / liquidity', ratio == null || ratio <= MEME_RULES.maxFdvToLiq, ratio == null ? 'missing, not blocking' : ratio.toFixed(1)));
  reasons.push(check('1h move', h1 == null || (h1 <= MEME_RULES.maxH1 && h1 >= MEME_RULES.minH1), h1 == null ? 'missing' : `${h1}%`));
  reasons.push(check('top 10 holders', top10 != null && top10 <= MEME_RULES.maxTop10, top10 == null ? (safety.top10Detail || 'missing') : `${(top10 * 100).toFixed(1)}%`));
  reasons.push(check('mint authority', mint === 'no', mint == null ? (safety.mintDetail || 'missing') : String(mint)));
  reasons.push(check('freeze authority', freeze === 'no', freeze == null ? (safety.freezeDetail || 'missing') : String(freeze)));
  reasons.push(check('dev wallet share', null, 'unknown, does not block'));
  const blocking = reasons.filter((r) => r.name !== 'dev wallet share' && r.name !== 'fdv / liquidity' && r.ok !== true);
  return {
    pass: blocking.length === 0,
    reasons,
    features: { liq, vol, h1, ageMin, top10, mint, freeze, ratio, quote },
  };
}

export function tokenMint(pair) {
  const mint = pair?.baseToken?.address || null;
  if (!mint || mint === pair?.pairAddress) return null;
  return mint;
}

export function bestPair(pairs, token) {
  const rows = (pairs || []).filter((p) => p?.chainId === 'solana' && tokenMint(p) === token);
  return rows.sort((a, b) => (num(b?.liquidity?.usd) || 0) - (num(a?.liquidity?.usd) || 0))[0] || null;
}

export function stepMeme({ coins, open = [], now }) {
  const settled = [];
  const still = [];
  const byCa = new Map((coins || []).map((c) => [c.ca, c]));
  for (const pos of open) {
    const live = byCa.get(pos.ca);
    const px = num(live?.priceUsd);
    const age = now - Date.parse(pos.openedAt);
    let exit = null;
    let why = null;
    if (px > 0 && px <= pos.entry * MEME_RULES.stop) { exit = px; why = 'stop'; }
    else if (px > 0 && px >= pos.entry * MEME_RULES.tp) { exit = px; why = 'take-profit'; }
    else if (age >= MEME_RULES.holdMs && px > 0) { exit = px; why = 'time-stop'; }
    if (exit) {
      const deal = memePnl(pos.entry, exit);
      if (deal && deal.sizeUsd === MEME_SIZE) settled.push({ ...pos, ...deal, exit: why, exitPx: exit, settledAt: new Date(now).toISOString(), won: deal.pnl > 0, paper: true });
    } else still.push(pos);
  }
  const known = new Set(still.map((p) => p.ca).concat(settled.map((p) => p.ca)));
  for (const coin of coins || []) {
    if (!coin.pass || known.has(coin.ca) || !(coin.priceUsd > 0)) continue;
    if (still.length >= 8) break;
    still.push({
      id: `meme:${coin.ca}`,
      ca: coin.ca,
      symbol: coin.symbol,
      name: coin.name,
      entry: coin.priceUsd,
      sizeUsd: MEME_SIZE,
      openedAt: new Date(now).toISOString(),
      variant: 'meme-safety',
      family: 'meme',
      allocated: true,
      paper: true,
      open: true,
    });
    known.add(coin.ca);
  }
  return { settled, open: still.filter((p) => p.pnl == null) };
}

export function memeGate(rows) {
  const groups = new Map();
  for (const row of rows || []) {
    const key = (row.settledAt || '').slice(0, 10);
    if (!key || row.pnl == null) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const windows = [...groups.entries()].map(([key, list]) => ({
    key,
    seen: false,
    n: list.length,
    mean: list.reduce((sum, row) => sum + row.pnl, 0) / list.length,
    lo: null,
  }));
  return { windows, graduated: graduates(windows), n: (rows || []).filter((row) => row.pnl != null).length };
}
