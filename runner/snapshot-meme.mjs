// Public Solana meme snapshot. Read-only: no wallet, no key, no order.
// Mint and freeze come from the mint account. Top 10 holders come from the
// largest token accounts. A slow or failed RPC is a failed check, not a hang.
// When a paper coin is open, kick-watch.sh starts the stop pass with
// gh workflow run. A GITHUB_TOKEN job does not emit workflow_run, so this
// call is the dispatch. The Kalshi workflow step calls the same script again.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { bestPair, candidateMints, lookupMints, openMemeCount, scoreCoin, stepMeme, stopSlippage } from '../engine/meme.js';
import { cacheDoc, cacheFromDoc, describeCoin, jevShadow, reviewCandidates, JEV_CALL_CAP } from '../engine/jev.js';
import {
  EARLY_SCAN, candidatesFromSources, decideCandidate, earlyShadow, loadSources, needsChain, nextLog, openEarly, readRug, withPair,
} from '../engine/early.js';
import { watchKickDecision } from './kick-watch.mjs';

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

function saveSleeveScore(rows) {
  const path = 'data/research-upgrades.json';
  let doc = { paper: true, liveExecution: false };
  try { doc = { ...doc, ...JSON.parse(fs.readFileSync(path, 'utf8')) }; } catch { /* start a paper report */ }
  const jev = jevShadow(rows);
  const early = earlyShadow(rows);
  if (JSON.stringify(doc.jev) === JSON.stringify(jev) && JSON.stringify(doc.early) === JSON.stringify(early) && fs.existsSync(path)) return;
  doc.paper = true;
  doc.liveExecution = false;
  doc.jev = jev;
  doc.early = early;
  fs.writeFileSync(path, JSON.stringify(doc, null, 2) + '\n');
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
  const extra = nextLog(readEarlyLog(), decisions, at);
  if (extra.length) fs.appendFileSync('data/early-log.jsonl', extra.map((row) => JSON.stringify(row)).join('\n') + '\n');
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
    try {
      earlySources = await loadSources(fetch, {
        'dex-boosts': Array.isArray(boosts) ? boosts : [],
        'dex-profiles': Array.isArray(profiles) ? profiles : [],
        'gecko-new': poolsDoc || { data: [] },
      });
      let earlyRows = candidatesFromSources(earlySources, now);
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
    try {
      const reviewed = await reviewCandidates(coins, {
        cache: jevCache,
        now: new Date(now).toISOString(),
        describe: (coin) => describeCoin({ coin, pair: meta.get(coin.ca)?.pair, profile: blurbs.get(coin.ca) }),
      });
      coins = reviewed.coins;
      const enters = earlyDecisions.filter((row) => row.action === 'enter').map((row) => ({ ...row, pass: true }));
      const earlyReview = await reviewCandidates(enters, {
        cache: jevCache,
        cap: Math.max(0, JEV_CALL_CAP - reviewed.asked),
        now: new Date(now).toISOString(),
        describe: (coin) => describeCoin({ coin, pair: meta.get(coin.ca)?.pair, profile: blurbs.get(coin.ca) }),
      });
      const byCa = new Map(earlyReview.coins.map((row) => [row.ca, row.jev]));
      earlyDecisions = earlyDecisions.map((row) => (byCa.get(row.ca) ? { ...row, jev: byCa.get(row.ca) } : row));
      console.log('jev', `asked=${reviewed.asked + earlyReview.asked}`, `http=${reviewed.http + earlyReview.http}`, `skipped=${reviewed.skipped + earlyReview.skipped}`, `capped=${reviewed.capped + earlyReview.capped}`);
    } catch (e) {
      console.log('jev skipped', e.message);
    }
    saveJevCache(jevCache);
    const openDoc = fs.existsSync('data/meme-open.json') ? JSON.parse(fs.readFileSync('data/meme-open.json', 'utf8')) : { entries: [] };
    const history = fs.existsSync('data/meme-journal.jsonl')
      ? fs.readFileSync('data/meme-journal.jsonl', 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
      : [];
    const next = stepMeme({ coins, open: openDoc.entries || [], history, now });
    const earlyOpen = openEarly({ decisions: earlyDecisions, open: next.open, now });
    next.open.push(...earlyOpen);
    fs.mkdirSync('data', { recursive: true });
    if (next.settled.length) fs.appendFileSync('data/meme-journal.jsonl', next.settled.map((row) => JSON.stringify(row)).join('\n') + '\n');
    else if (!fs.existsSync('data/meme-journal.jsonl')) fs.writeFileSync('data/meme-journal.jsonl', '');
    fs.writeFileSync('data/meme-open.json', JSON.stringify({ updatedAt: new Date(now).toISOString(), entries: next.open }, null, 2));
    const slipRows = history.concat(next.settled);
    saveSleeveScore(slipRows);
    writeEarly(earlyDecisions, earlySources, new Date(now).toISOString());
    fs.writeFileSync('data/meme-stops.json', JSON.stringify({ ...stopSlippage(slipRows), updatedAt: new Date(now).toISOString() }, null, 2) + '\n');
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
} finally {
  dispatchMemeWatch();
}
