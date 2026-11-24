// Public Solana meme snapshot. Read-only: no wallet, no key, no order.
// Mint and freeze come from the mint account. Top 10 holders come from the
// largest token accounts. A slow or failed RPC is a failed check, not a hang.
// When a paper coin is open, kick-watch.sh starts the stop pass with
// gh workflow run. A GITHUB_TOKEN job does not emit workflow_run, so this
// call is the dispatch. The Kalshi workflow step calls the same script again.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { bestPair, candidateMints, lookupMints, openMemeCount, pricesForOpen, pricesFromDex, scoreCoin, stepMeme, stopSlippage } from '../engine/meme.js';
import { cacheDoc, cacheFromDoc, jevRunCap, noteJevCalls, prepareJevState, reviewCandidates, JEV_CALL_CAP } from '../engine/jev.js';
import {
  EARLY_SCAN, advanceEarlyExits, candidatesFromSources, decideCandidate, loadSources, needsChain, nextLog, openEarly, readRug, rollEarlyLog, withPair,
} from '../engine/early.js';
import { withShadowScores } from '../engine/upgrades.js';
import { loadRollingBench } from './rolling-bench.mjs';
import { parseTrending, stepTrend, TREND_URL } from '../engine/trend.js';

// Early and meme books on the rolling bench open no new paper lines.
loadRollingBench();
import { watchKickDecision } from './kick-watch.mjs';
import { writeTodayFile } from './write-today.mjs';
import { updateCoinWatch } from './coin-watch.mjs';

function dispatchMemeWatch() {
  let count = 0;
  try { count = openMemeCount(JSON.parse(fs.readFileSync('data/meme-open.json', 'utf8'))); } catch { count = 0; }
  const choice = watchKickDecision(count);
  console.log(`watch=${choice} open=${count}`);
  if (choice !== 'dispatch') return;
  if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
    console.log('watch dispatch waits for a step with actions: write');
    return;
  }
  try {
    const env = { ...process.env };
    delete env.TYPESAFE_API_KEY;
    delete env.NTFY_TOPIC;
    execFileSync('bash', ['runner/kick-watch.sh'], { stdio: 'inherit', env });
  } catch (e) {
    console.log('watch dispatch failed', e.status ?? e.message);
  }
}

function loadJevCache() {
  try { return cacheFromDoc(JSON.parse(fs.readFileSync('data/jev-cache.json', 'utf8'))); }
  catch { return new Map(); }
}

function saveJevCache(cache) {
  fs.mkdirSync('data', { recursive: true });
  const next = JSON.stringify(cacheDoc(cache), null, 2) + '\n';
  const prev = fs.existsSync('data/jev-cache.json') ? fs.readFileSync('data/jev-cache.json', 'utf8') : '';
  if (next !== prev) fs.writeFileSync('data/jev-cache.json', next);
}

function loadJevCalls() {
  try { return JSON.parse(fs.readFileSync('data/jev-calls.json', 'utf8')); }
  catch { return { paper: true, liveExecution: false, batches: [] }; }
}

function saveJevCalls(doc) {
  fs.mkdirSync('data', { recursive: true });
  const next = JSON.stringify(doc, null, 2) + '\n';
  const prev = fs.existsSync('data/jev-calls.json') ? fs.readFileSync('data/jev-calls.json', 'utf8') : '';
  if (next !== prev) fs.writeFileSync('data/jev-calls.json', next);
}

function saveSleeveScore(rows) {
  const path = 'data/research-upgrades.json';
  let doc = { paper: true, liveExecution: false };
  try { doc = { ...doc, ...JSON.parse(fs.readFileSync(path, 'utf8')) }; } catch { /* start a paper report */ }
  const nextDoc = withShadowScores(doc, rows);
  if (JSON.stringify(doc.jev) === JSON.stringify(nextDoc.jev) && JSON.stringify(doc.early) === JSON.stringify(nextDoc.early) && JSON.stringify(doc.earlyExits) === JSON.stringify(nextDoc.earlyExits) && fs.existsSync(path)) return;
  fs.writeFileSync(path, JSON.stringify(nextDoc, null, 2) + '\n');
}

function readEarlyLog() {
  if (!fs.existsSync('data/early-log.jsonl')) return [];
  return fs.readFileSync('data/early-log.jsonl', 'utf8').trim().split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function writeEarly(decisions, sources, at) {
  fs.mkdirSync('data', { recursive: true });
  const board = {
    fetchedAt: at,
    paper: true,
    liveExecution: false,
    sources: (sources || []).map((source) => ({ id: source.id, ok: !!source.ok, status: source.status ?? null })),
    coins: decisions,
  };
  fs.writeFileSync('data/early-board.json', JSON.stringify(board, null, 2) + '\n');
  const prev = readEarlyLog();
  const extra = nextLog(prev, decisions, at);
  let priorSummary = null;
  try { priorSummary = JSON.parse(fs.readFileSync('data/early-log-summary.json', 'utf8')); } catch { priorSummary = null; }
  const rolled = rollEarlyLog(prev, extra, priorSummary);
  if (rolled.rewritten) {
    const body = rolled.rows.map((row) => JSON.stringify(row)).join('\n');
    fs.writeFileSync('data/early-log.jsonl', body ? body + '\n' : '');
    fs.writeFileSync('data/early-log-summary.json', JSON.stringify(rolled.summary, null, 2) + '\n');
  } else if (extra.length) {
    fs.appendFileSync('data/early-log.jsonl', extra.map((row) => JSON.stringify(row)).join('\n') + '\n');
  }
  const tally = { enter: 0, pass: 0, kill: 0 };
  for (const row of decisions) if (tally[row.action] != null) tally[row.action] += 1;
  console.log('early', JSON.stringify(tally), 'sources', board.sources.map((source) => `${source.id}:${source.ok ? 'ok' : source.status}`).join(','));
}

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
    const blurbs = new Map();
    for (const row of Array.isArray(profiles) ? profiles : []) {
      if (row?.chainId === 'solana' && row.tokenAddress) blurbs.set(row.tokenAddress, row);
    }
    let earlyDecisions = [];
    let earlySources = [];
    let earlyRows = [];
    try {
      earlySources = await loadSources(fetch, {
        'dex-boosts': Array.isArray(boosts) ? boosts : [],
        'dex-profiles': Array.isArray(profiles) ? profiles : [],
        'gecko-new': poolsDoc || { data: [] },
      });
      earlyRows = candidatesFromSources(earlySources, now);
      const unseen = earlyRows.filter((row) => !meta.has(row.ca)).slice(0, 30);
      if (unseen.length) {
        try {
          const book = await get('https://api.dexscreener.com/latest/dex/tokens/' + unseen.map((row) => row.ca).join(','));
          for (const row of unseen) {
            const pair = bestPair(book?.pairs || [], row.ca);
            meta.set(row.ca, { pair, pairAddress: pair?.pairAddress || null, baseUi: Number(pair?.liquidity?.base) || null });
          }
        } catch (e) { console.log('early pairs', e.message); }
      }
      earlyRows = earlyRows.map((row) => withPair(row, meta.get(row.ca)?.pair, now));
      const wanted = earlyRows.filter((row) => needsChain(row)).sort((a, b) => a.ageMin - b.ageMin).slice(0, EARLY_SCAN);
      const wantedSet = new Set(wanted.map((row) => row.ca));
      const chain = wanted.filter((row) => !safety.has(row.ca));
      if (chain.length) {
        try {
          const extra = await lookupMints(chain.map((row) => row.ca), meta, { budgetMs: 20000 });
          for (const [ca, row] of extra) safety.set(ca, row);
        } catch (e) { console.log('early rpc', e.message); }
      }
      const rugs = new Map();
      for (const row of wanted) rugs.set(row.ca, await readRug(row.ca, fetch));
      earlyDecisions = earlyRows.map((row) => {
        const checked = wantedSet.has(row.ca);
        return decideCandidate(row, {
          checkedSafety: checked,
          safety: safety.get(row.ca),
          checkedLp: checked,
          lp: rugs.get(row.ca),
        });
      });
    } catch (e) {
      console.log('early scan failed', e.message);
    }
    const jevCache = loadJevCache();
    const callDoc = loadJevCalls();
    const day = new Date(now).toISOString().slice(0, 10);
    const runCap = jevRunCap(callDoc, day);
    const boards = [
      ...earlyRows.map((row) => ({ ca: row.ca, name: row.name, symbol: row.symbol })),
      ...coins.map((row) => ({ ca: row.ca, name: row.name, symbol: row.symbol })),
    ];
    const prepare = (coin) => prepareJevState(coin, {
      pair: meta.get(coin.ca)?.pair || null,
      profile: blurbs.get(coin.ca) || null,
      boards,
      fetchImpl: fetch,
      nowMs: now,
    });
    let askedTotal = 0;
    try {
      const reviewed = await reviewCandidates(coins, {
        cache: jevCache,
        cap: runCap,
        now: new Date(now).toISOString(),
        prepare,
      });
      coins = reviewed.coins;
      const enters = earlyDecisions.filter((row) => row.action === 'enter').map((row) => ({ ...row, pass: true }));
      const earlyCap = Math.max(0, Math.min(JEV_CALL_CAP - reviewed.asked, runCap - reviewed.asked));
      const earlyReview = await reviewCandidates(enters, {
        cache: jevCache,
        cap: earlyCap,
        now: new Date(now).toISOString(),
        prepare,
      });
      askedTotal = reviewed.asked + earlyReview.asked;
      const byCa = new Map(earlyReview.coins.map((row) => [row.ca, row.jev]));
      earlyDecisions = earlyDecisions.map((row) => (byCa.get(row.ca) ? { ...row, jev: byCa.get(row.ca) } : row));
      console.log('jev', `asked=${askedTotal}`, `http=${reviewed.http + earlyReview.http}`, `skipped=${reviewed.skipped + earlyReview.skipped}`, `capped=${reviewed.capped + earlyReview.capped}`, `dailyCap=${runCap}`);
    } catch (e) {
      console.log('jev skipped', e.message);
    }
    saveJevCache(jevCache);
    if (askedTotal > 0) {
      const id = `${new Date(now).toISOString()}#snapshot#${randomBytes(4).toString('hex')}`;
      saveJevCalls(noteJevCalls(callDoc, day, askedTotal, id, new Date(now).toISOString()));
    }
    const openDoc = fs.existsSync('data/meme-open.json') ? JSON.parse(fs.readFileSync('data/meme-open.json', 'utf8')) : { entries: [] };
    const history = fs.existsSync('data/meme-journal.jsonl')
      ? fs.readFileSync('data/meme-journal.jsonl', 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
      : [];
    const openEntries = openDoc.entries || [];
    const missing = openEntries.map((row) => row?.ca).filter((ca) => ca && !coins.some((coin) => coin.ca === ca));
    let priced = coins;
    if (missing.length) {
      const priceMap = {};
      for (let i = 0; i < missing.length; i += 30) {
        const slice = [...new Set(missing.slice(i, i + 30))];
        try {
          const book = await get('https://api.dexscreener.com/latest/dex/tokens/' + slice.join(','));
          Object.assign(priceMap, pricesFromDex(book, slice));
        } catch (e) { console.log('open prices', e.message); }
      }
      priced = pricesForOpen(coins, openEntries, priceMap);
    }
    const next = stepMeme({ coins: priced, open: openEntries, history, now, track: advanceEarlyExits });
    const earlyOpen = openEarly({ decisions: earlyDecisions, open: next.open, now, history });
    next.open.push(...earlyOpen);
    let trending = [];
    try {
      const raw = await get(TREND_URL);
      trending = parseTrending(raw);
    } catch (e) { console.log('trending skipped', e.message); }
    const prices = Object.fromEntries((priced || []).filter((c) => c?.ca && c.priceUsd > 0).map((c) => [c.ca, c.priceUsd]));
    const trendStep = stepTrend({ trending, open: next.open, history: history.concat(next.settled, next.shadows || []), now, prices });
    next.open = trendStep.open;
    if (trendStep.settled.length) next.settled.push(...trendStep.settled);
    fs.mkdirSync('data', { recursive: true });
    const journalRows = [...next.settled, ...(next.shadows || [])];
    if (journalRows.length) fs.appendFileSync('data/meme-journal.jsonl', journalRows.map((row) => JSON.stringify(row)).join('\n') + '\n');
    else if (!fs.existsSync('data/meme-journal.jsonl')) fs.writeFileSync('data/meme-journal.jsonl', '');
    fs.writeFileSync('data/meme-open.json', JSON.stringify({ updatedAt: new Date(now).toISOString(), entries: next.open }, null, 2));
    const slipRows = history.concat(next.settled, next.shadows || []);
    saveSleeveScore(slipRows);
    writeEarly(earlyDecisions, earlySources, new Date(now).toISOString());
    fs.writeFileSync('data/meme-stops.json', JSON.stringify({ ...stopSlippage(slipRows), updatedAt: new Date(now).toISOString() }, null, 2) + '\n');
    try {
      // Coins to watch: ideas for a hand trade, never an order. Safe coins only.
      await updateCoinWatch({ coins, meta, trending, now, fetchImpl: fetch, env: { NTFY_TOPIC: process.env.NTFY_TOPIC } });
    } catch (err) { console.log('coin watch skipped', err.message); }
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
    try { writeTodayFile({ now, memeFetchedAt: new Date(now).toISOString() }); } catch (err) { console.log('today header skipped', err.message); }
  }
} catch (e) {
  console.log('meme snapshot failed', e.message);
} finally {
  dispatchMemeWatch();
}
