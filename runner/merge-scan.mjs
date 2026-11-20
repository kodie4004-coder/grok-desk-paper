// Keep both sides of a fast-scan / snapshot rebase. The newer early board
// wins. Jev verdicts and call batches are unioned. A mint is alerted once,
// at the earlier push. First sight keeps the earlier age.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mergeJevCacheDocs, mergeJevCalls } from '../engine/jev.js';
import { mergeAlertDocs } from '../engine/alerts.js';
import { mergeEarlyBoards, mergeSightDocs } from './fast-scan.mjs';

function gitShow(stage, file) {
  try { return execFileSync('git', ['show', `${stage}:${file}`], { encoding: 'utf8' }); }
  catch { return ''; }
}

function parseDoc(text, fallback) {
  try { return JSON.parse(text); } catch { return fallback; }
}

function mergeEarlySummaries(a, b) {
  const counts = { ...(a?.counts || {}) };
  for (const [key, n] of Object.entries(b?.counts || {})) counts[key] = Math.max(Number(counts[key]) || 0, Number(n) || 0);
  return {
    paper: true,
    liveExecution: false,
    keptEnters: Math.max(Number(a?.keptEnters) || 0, Number(b?.keptEnters) || 0),
    keptLatest: Math.max(Number(a?.keptLatest) || 0, Number(b?.keptLatest) || 0),
    dropped: Math.max(Number(a?.dropped) || 0, Number(b?.dropped) || 0),
    counts,
  };
}

const invoked = process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href;
if (invoked) {
  const unmerged = new Set(execFileSync('git', ['diff', '--name-only', '--diff-filter=U'], { encoding: 'utf8' }).split('\n').filter(Boolean));
  fs.mkdirSync('data', { recursive: true });
  const jobs = [
    ['data/early-board.json', (a, b) => mergeEarlyBoards(a, b), { coins: [] }],
    ['data/early-log-summary.json', (a, b) => mergeEarlySummaries(a, b), { counts: {} }],
    ['data/jev-cache.json', (a, b) => mergeJevCacheDocs(a, b), { verdicts: {} }],
    ['data/jev-calls.json', (a, b) => mergeJevCalls(a, b), { batches: [] }],
    ['data/phone-alerts.json', (a, b) => mergeAlertDocs(a, b), { sent: [] }],
    ['data/fast-scan.json', (a, b) => mergeSightDocs(a, b), { firstSight: {} }],
  ];
  for (const [file, merge, fallback] of jobs) {
    if (!unmerged.has(file)) continue;
    const doc = merge(parseDoc(gitShow(':2', file), fallback), parseDoc(gitShow(':3', file), fallback));
    fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
  }
}
