// Public Solana meme snapshot. DexScreener allows any origin. GeckoTerminal is paced.
// pump.fun's API is not called: it answered 403 from this network.
import fs from 'node:fs';
import { bestPair, scoreCoin, stepMeme } from '../engine/meme.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url.split('?')[0]}`);
  return res.json();
}

const boosts = await get('https://api.dexscreener.com/token-boosts/latest/v1');
const sols = (Array.isArray(boosts) ? boosts : []).filter((b) => b.chainId === 'solana' && b.tokenAddress).slice(0, 8);
const book = sols.length ? await get('https://api.dexscreener.com/latest/dex/tokens/' + sols.map((b) => b.tokenAddress).join(',')) : { pairs: [] };
const now = Date.now();
const coins = [];
let safetyCalls = 0;
for (const b of sols) {
  const pair = bestPair(book.pairs, b.tokenAddress);
  let info = null;
  const rough = scoreCoin(pair, { holders: { distribution_percentage: { top_10: '0' } }, mint_authority: 'no', freeze_authority: 'no' }, now);
  const dexOk = rough.reasons.filter((r) => ['liquidity', 'volume', 'age', 'quote', '1h move'].includes(r.name)).every((r) => r.ok === true);
  if (dexOk && safetyCalls < 4) {
    safetyCalls += 1;
    try {
      const body = await get('https://api.geckoterminal.com/api/v2/networks/solana/tokens/' + b.tokenAddress + '/info');
      info = body?.data?.attributes || null;
    } catch (e) { console.log('info skip', e.message); }
    await sleep(1200);
  }
  const score = scoreCoin(pair, info, now);
  coins.push({
    ca: b.tokenAddress,
    symbol: pair?.baseToken?.symbol || '?',
    name: pair?.baseToken?.name || 'Unknown',
    priceUsd: Number(pair?.priceUsd),
    dexUrl: pair?.url || `https://dexscreener.com/solana/${b.tokenAddress}`,
    ...score,
  });
}
const prior = fs.existsSync('data/meme-journal.jsonl') ? fs.readFileSync('data/meme-journal.jsonl', 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
const openDoc = fs.existsSync('data/meme-open.json') ? JSON.parse(fs.readFileSync('data/meme-open.json', 'utf8')) : { entries: [] };
const next = stepMeme({ coins, open: openDoc.entries || [], now });
fs.mkdirSync('data', { recursive: true });
if (next.settled.length) fs.appendFileSync('data/meme-journal.jsonl', next.settled.map((row) => JSON.stringify(row)).join('\n') + '\n');
else if (!fs.existsSync('data/meme-journal.jsonl')) fs.writeFileSync('data/meme-journal.jsonl', '');
fs.writeFileSync('data/meme-open.json', JSON.stringify({ updatedAt: new Date(now).toISOString(), entries: next.open }, null, 2));
fs.writeFileSync('data/meme-board.json', JSON.stringify({ fetchedAt: new Date(now).toISOString(), source: 'dexscreener+geckoterminal', pumpFun: 'blocked', coins }, null, 2));
console.log('meme coins', coins.length, 'pass', coins.filter((c) => c.pass).length, 'settled', next.settled.length);
