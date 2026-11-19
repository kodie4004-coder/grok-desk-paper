// Public Solana meme snapshot. Read-only: no wallet, no key, no order.
// Mint and freeze come from the mint account. Top 10 holders come from the
// largest token accounts. A slow or failed RPC is a failed check, not a hang.
import fs from 'node:fs';
import { bestPair, candidateMints, lookupMints, scoreCoin, stepMeme } from '../engine/meme.js';

async function get(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url.split('?')[0]}`);
  return res.json();
}

const now = Date.now();
let coins = [];
try {
  const [boosts, profiles, poolsDoc] = await Promise.all([
    get('https://api.dexscreener.com/token-boosts/latest/v1').catch((e) => { console.log('boosts', e.message); return []; }),
    get('https://api.dexscreener.com/token-profiles/latest/v1').catch((e) => { console.log('profiles', e.message); return []; }),
    get('https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=1').catch((e) => { console.log('new pools', e.message); return { data: [] }; }),
  ]);
  const mints = candidateMints({
    boosts: Array.isArray(boosts) ? boosts : [],
    profiles: Array.isArray(profiles) ? profiles : [],
    pools: poolsDoc?.data || [],
  });
  if (!mints.length) {
    console.log('meme scan empty, board left unchanged');
  } else {
    let pairs = [];
    try {
      const book = await get('https://api.dexscreener.com/latest/dex/tokens/' + mints.join(','));
      pairs = book?.pairs || [];
    } catch (e) { console.log('pairs', e.message); }
    const meta = new Map();
    for (const mint of mints) {
      const pair = bestPair(pairs, mint);
      const baseUi = Number(pair?.liquidity?.base);
      meta.set(mint, { baseUi: Number.isFinite(baseUi) ? baseUi : null, pairAddress: pair?.pairAddress || null, pair });
    }
    let safety = new Map();
    try {
      safety = await lookupMints(mints, meta, { budgetMs: 45000 });
    } catch (e) { console.log('rpc', e.message); }
    const missed = { mint: null, freeze: null, top10: null, mintDetail: 'lookup failed', freezeDetail: 'lookup failed', top10Detail: 'lookup failed' };
    coins = mints.map((mint) => {
      const pair = meta.get(mint)?.pair || null;
      const score = scoreCoin(pair, safety.get(mint) || missed, now);
      return {
        ca: mint,
        symbol: pair?.baseToken?.symbol || '?',
        name: pair?.baseToken?.name || 'Unknown',
        priceUsd: Number(pair?.priceUsd),
        liq: pair?.liquidity?.usd ?? null,
        vol: pair?.volume?.h24 ?? null,
        ageMin: score.features?.ageMin ?? null,
        imageUrl: pair?.info?.imageUrl || null,
        dexUrl: pair?.url || `https://dexscreener.com/solana/${mint}`,
        ...score,
      };
    });
    const openDoc = fs.existsSync('data/meme-open.json') ? JSON.parse(fs.readFileSync('data/meme-open.json', 'utf8')) : { entries: [] };
    const next = stepMeme({ coins, open: openDoc.entries || [], now });
    fs.mkdirSync('data', { recursive: true });
    if (next.settled.length) fs.appendFileSync('data/meme-journal.jsonl', next.settled.map((row) => JSON.stringify(row)).join('\n') + '\n');
    else if (!fs.existsSync('data/meme-journal.jsonl')) fs.writeFileSync('data/meme-journal.jsonl', '');
    fs.writeFileSync('data/meme-open.json', JSON.stringify({ updatedAt: new Date(now).toISOString(), entries: next.open }, null, 2));
    fs.writeFileSync('data/meme-board.json', JSON.stringify({ fetchedAt: new Date(now).toISOString(), source: 'dexscreener+solana-rpc', pumpFun: 'blocked', coins }, null, 2));
    const tally = {};
    for (const coin of coins) {
      for (const reason of coin.reasons) {
        const key = reason.ok === true ? 'pass' : reason.ok === false ? 'fail' : 'unknown';
        tally[reason.name] ??= { pass: 0, fail: 0, unknown: 0 };
        tally[reason.name][key] += 1;
      }
    }
    console.log('meme coins', coins.length, 'pass', coins.filter((coin) => coin.pass).length, 'open', next.open.length, 'settled', next.settled.length);
    console.log(JSON.stringify(tally));
  }
} catch (e) {
  console.log('meme snapshot failed', e.message);
}
