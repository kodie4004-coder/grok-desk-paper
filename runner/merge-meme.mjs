// When two paper jobs edit the meme book at once, keep every exit and do not
// leave a sold coin open. The earlier fill wins a duplicate id. That is the
// fill that saw the price first. Other snapshot files stay on the rebase rule
// in push-snapshot.sh.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

export function parseLines(text) {
  return String(text || '').split('\n').map((line) => line.trim()).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

export function mergeMemeJournal(ours, theirs) {
  const by = new Map();
  for (const row of [...parseLines(ours), ...parseLines(theirs)]) {
    if (!row?.id) continue;
    const prev = by.get(row.id);
    if (!prev) { by.set(row.id, row); continue; }
    const a = Date.parse(prev.settledAt || '');
    const b = Date.parse(row.settledAt || '');
    if (Number.isFinite(b) && (!Number.isFinite(a) || b < a)) by.set(row.id, row);
  }
  const rows = [...by.values()].sort((a, b) => String(a.settledAt || '').localeCompare(String(b.settledAt || '')));
  return rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '');
}

export function mergeEarlyLog(ours, theirs) {
  const seen = new Set();
  const rows = [];
  for (const row of [...parseLines(ours), ...parseLines(theirs)]) {
    const key = JSON.stringify([row.ca, row.action, row.reason, row.at]);
    if (!row?.ca || seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
  }
  rows.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')) || String(a.ca).localeCompare(String(b.ca)));
  return rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '');
}

export function mergeMemeOpen(ours, theirs, journalText) {
  const settled = new Set(parseLines(journalText).filter((row) => row.exit || row.pnl != null).map((row) => row.id));
  const map = new Map();
  for (const row of [...(ours?.entries || []), ...(theirs?.entries || [])]) {
    if (!row?.id || settled.has(row.id) || map.has(row.id)) continue;
    map.set(row.id, row);
  }
  const updated = [ours?.updatedAt, theirs?.updatedAt].filter(Boolean).sort().pop() || null;
  return { updatedAt: updated, entries: [...map.values()] };
}

function gitShow(stage, file) {
  try {
    return execFileSync('git', ['show', `${stage}:${file}`], { encoding: 'utf8' });
  } catch {
    return '';
  }
}

function parseDoc(text) {
  try { return JSON.parse(text); } catch { return { entries: [] }; }
}

const invoked = process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href;
if (invoked) {
  const unmerged = new Set(execFileSync('git', ['diff', '--name-only', '--diff-filter=U'], { encoding: 'utf8' }).split('\n').filter(Boolean));
  fs.mkdirSync('data', { recursive: true });
  const journalMerged = mergeMemeJournal(gitShow(':2', 'data/meme-journal.jsonl'), gitShow(':3', 'data/meme-journal.jsonl'));
  if (unmerged.has('data/meme-journal.jsonl')) fs.writeFileSync('data/meme-journal.jsonl', journalMerged);
  if (unmerged.has('data/early-log.jsonl')) {
    fs.writeFileSync('data/early-log.jsonl', mergeEarlyLog(gitShow(':2', 'data/early-log.jsonl'), gitShow(':3', 'data/early-log.jsonl')));
  }
  if (unmerged.has('data/meme-open.json')) {
    const journalText = unmerged.has('data/meme-journal.jsonl') || !fs.existsSync('data/meme-journal.jsonl')
      ? journalMerged
      : fs.readFileSync('data/meme-journal.jsonl', 'utf8');
    const open = mergeMemeOpen(
      parseDoc(gitShow(':2', 'data/meme-open.json')),
      parseDoc(gitShow(':3', 'data/meme-open.json')),
      journalText,
    );
    fs.writeFileSync('data/meme-open.json', JSON.stringify(open, null, 2) + '\n');
  }
}
