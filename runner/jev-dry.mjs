// Dry Jev sample. Paper only. Does not write the cache, does not open a trade,
// and does not read a wallet. A missing TYPESAFE_API_KEY reports context only.
import fs from 'node:fs';
import { bestPair } from '../engine/meme.js';
import { jevKey, prepareJevState, reviewCandidates, xHandleFromUrls } from '../engine/jev.js';

function readJson(path, fallback) {
  try { return JSON.parse(fs.readFileSync(path, 'utf8')); } catch { return fallback; }
}

const board = readJson('data/meme-board.json', { coins: [] });
const early = readJson('data/early-board.json', { coins: [] });
const coins = Array.isArray(board.coins) ? board.coins : [];
const sample = coins.filter((row) => row?.pass).slice(0, 6);
const picked = sample.length ? sample : coins.slice(0, 6);
const boards = [...(early.coins || []), ...coins].map((row) => ({ ca: row.ca, name: row.name, symbol: row.symbol }));
let pairs = [];
const mints = picked.map((row) => row.ca).filter(Boolean);
if (mints.length) {
  try {
    const res = await fetch('https://api.dexscreener.com/latest/dex/tokens/' + mints.join(','), {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) pairs = (await res.json())?.pairs || [];
  } catch { pairs = []; }
}
const prepared = [];
for (const coin of picked) {
  const state = await prepareJevState({ ...coin, pass: true }, {
    pair: bestPair(pairs, coin.ca),
    boards,
    fetchImpl: fetch,
    nowMs: Date.now(),
  });
  prepared.push({ coin, state });
}
const context = {
  n: prepared.length,
  withDescription: prepared.filter((row) => row.state.description).length,
  withSocial: prepared.filter((row) => row.state.socials?.length).length,
  withHandle: prepared.filter((row) => xHandleFromUrls([...(row.state.socials || []).map((item) => item.url), ...(row.state.websites || [])])).length,
  withX: prepared.filter((row) => row.state.xProfile).length,
  withRug: prepared.filter((row) => row.state.rug && (row.state.rug.mint || row.state.rug.freeze || row.state.rug.topHolderPct != null)).length,
  withSimilar: prepared.filter((row) => row.state.similar?.length).length,
  rug: prepared.map((row) => row.state.rug).filter(Boolean),
};
const key = jevKey();
let model = { asked: 0, unknown: null, unknownRate: null, skipped: true };
if (key) {
  const reviewed = await reviewCandidates(prepared.map((row) => ({ ...row.coin, pass: true })), {
    cache: new Map(),
    key,
    cap: prepared.length,
    prepare: async (coin) => prepared.find((row) => row.coin.ca === coin.ca)?.state,
  });
  const verdicts = reviewed.coins.map((row) => row.jev?.verdict).filter(Boolean);
  const unknown = verdicts.filter((verdict) => verdict === 'unknown').length;
  model = {
    asked: reviewed.asked,
    unknown,
    unknownRate: verdicts.length ? unknown / verdicts.length : null,
    skipped: false,
    pass: verdicts.filter((verdict) => verdict === 'pass').length,
    flag: verdicts.filter((verdict) => verdict === 'flag').length,
  };
}
console.log(JSON.stringify({ paper: true, liveExecution: false, context, model }, null, 2));
